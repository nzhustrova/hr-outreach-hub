// Kommo (CRM) — US-аккаунт. Доступ и id этапов подтверждены живым вызовом 08.08.
// Механика (решения Ольги): пакет при запуске кампании → New leads («свалка»);
// по кнопке «Meeting scheduled» лид переезжает в этап встреч и убирается из New leads.
import { linkedinSlug, linkedinUrlVariants } from './linkedin.js';

const BASE = 'https://zinitusa.kommo.com/api/v4';

export const PIPELINE_SALES = 12523387;          // Sales funnel (US) — единственная, куда мы ПИШЕМ
export const STAGE_NEW_LEADS = 96729675;         // New leads (sort 20)
export const STAGE_QUALIFIED = 96729679;         // Qualified leads (sort 30) — сюда пакет при Launch
export const STAGE_INITIAL_CONTACT = 96729855;   // Initial Contact (sort 40) — по первому ответу лида
export const STAGE_MEETING_SCHEDULED = 96729867; // Online meeting Scheduled (sort 70) — по кнопке

// --- Барьер: какие этапы считаем «уже трогали» (ТЗ п.28, разведка 11.08) --------------------
// Правило строится на ПОРЯДКЕ этапов (sort), а не на названиях: в двух US-воронках названия
// разные, а порядок сопоставим. Бразильская воронка и CSM в барьер не входят (решение Ольги).
//
//   Sales funnel: Incoming(10) New(20) Qualified(30) | Initial Contact(40) … Online meeting Sched(70) …
//   Pipeline:     Incoming(10) | Initial contact(20) IN process(30) Postphoned(40) Demo sched(50) …
//
// Qualified leads НЕ блокируем — с этими лидами контакта ещё не было, это наш рабочий пул.
export const US_PIPELINES = {
  12523387: { name: 'Sales funnel', blockFrom: 40, domainFrom: 70 },
  12265836: { name: 'Pipeline', blockFrom: 20, domainFrom: 50 },
};

// Kommo ставит закрытые статусы в самый конец порядка (sort 10000/11000), поэтому правило
// «sort ≥ порога встречи» затягивало их в доменный блок — 48 адресов попали туда ошибочно.
// Проигранная сделка не повод резать всю компанию.
//
// НО только проигранная. Статус 142 — это выигрыш: в Sales funnel он называется
// «Invoice paid», то есть клиент заплатил. Резать домен платящего клиента как раз НУЖНО:
// холодное письмо коллеге действующего заказчика — худший из возможных случаев
// (подтверждено Ольгой 13.08). Поэтому из доменного блока исключается только 143.
//
// ⚠️ 143 в двух воронках значит разное: Sales funnel — «Closed - Postponed» (отложили),
// Pipeline — «Closed - lost» (проиграли). Оба не выигрыш, поэтому правило для них одно.
export const CLOSED_STATUS_IDS = new Set([143]);

export function kommoEnabled() {
  return Boolean(process.env.KOMMO_API_TOKEN);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Запрос к Kommo с повтором при ВРЕМЕННЫХ сбоях.
 *
 * Зачем: полная пересборка стоп-листа — это ~60 запросов подряд примерно за минуту, и любой
 * из них может умереть с `fetch failed` (обрыв сокета, заминка DNS, TLS). Без повтора одна
 * такая заминка роняла весь прогон, и барьер оставался на вчерашних данных — ровно то,
 * что случилось 13.08 в 16:00.
 *
 * Повторяем только то, что имеет смысл повторять: сетевые ошибки, 429 и 5xx. На 401/403/404
 * повтор бесполезен — там причина не во времени.
 */
async function kommo(path, { method = 'GET', body, attempts = 3 } = {}) {
  const token = process.env.KOMMO_API_TOKEN;
  if (!token) throw new Error('KOMMO_API_TOKEN не задан в .env');
  let lastErr = null;
  for (let a = 1; a <= attempts; a += 1) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),   // без таймаута зависший сокет держит весь прогон
      });
      const text = await r.text();
      if (!r.ok) {
        const retryable = r.status === 429 || r.status >= 500;
        const err = new Error(`kommo ${method} ${path} → ${r.status}: ${text.slice(0, 200)}`);
        if (!retryable || a === attempts) throw err;
        lastErr = err;
      } else {
        if (!text) return null; // 204 на PATCH
        try { return JSON.parse(text); } catch { return { raw: text }; }
      }
    } catch (e) {
      // AbortError и `fetch failed` — транспорт, их повторяем. Ошибку с кодом статуса,
      // если она уже признана неповторяемой, пробрасываем сразу.
      if (a === attempts || /→ 4\d\d:/.test(String(e.message))) throw e;
      lastErr = e;
    }
    await sleep(a * 1500);   // 1.5 c, затем 3 c — заминке хватает
    console.warn(`[kommo] повтор ${a + 1}/${attempts}: ${path} (${lastErr?.message?.slice(0, 80)})`);
  }
  throw lastErr || new Error(`kommo ${method} ${path}: не удалось`);
}

/**
 * Поиск существующей карточки по адресу — ТОЛЬКО В SALES FUNNEL (решение Ольги 13.08).
 *
 * Вопрос «есть ли у лида карточка» на самом деле означает «есть ли карточка В РАБОЧЕЙ
 * ВОРОНКЕ». Pipeline мы используем исключительно как источник стоп-листа и не пишем туда
 * ничего. Раньше при единственной карточке в Pipeline мы цеплялись к ней — дописывали поля
 * и примечание в спящую воронку, а в Sales funnel лида так и не появлялось: наша работа
 * оставалась там, куда никто не смотрит.
 *
 * Теперь карточка в Pipeline на решение не влияет вовсе — заводим новую в Sales funnel.
 * Дублем это не будет: воронки разные и назначение у них разное.
 *
 * @returns null — контакта нет; {leadId} — есть карточка в Sales funnel;
 *          {leadId: null, contactId} — контакт есть, карточки в Sales funnel нет:
 *          лид создаём, но вешаем на СУЩЕСТВУЮЩИЙ контакт, чтобы не плодить людей.
 */
export async function findLeadByEmail(email) {
  if (!email) return null;
  const found = await kommo(`/contacts?query=${encodeURIComponent(email)}&with=leads`).catch(() => null);
  for (const c of (found?._embedded?.contacts || [])) {
    // Сверяем адрес точно: query у Kommo нечёткий и вернёт соседей по подстроке.
    const emails = [];
    for (const f of (c.custom_fields_values || [])) {
      if (f.field_code === 'EMAIL') for (const v of (f.values || [])) if (v.value) emails.push(String(v.value).toLowerCase());
    }
    if (!emails.includes(String(email).toLowerCase())) continue;
    return salesFunnelLeadOf(c);
  }
  return null;
}

// Вложенные лиды приходят без `pipeline_id` — дочитываем каждый, пока не найдём карточку
// рабочей воронки. Общая половина findLeadByEmail и findLeadByLinkedin.
async function salesFunnelLeadOf(c) {
  const leads = c._embedded?.leads || [];
  let elsewhere = 0;
  for (const l of leads) {
    const full = await kommo(`/leads/${l.id}`).catch(() => null);
    if (Number(full?.pipeline_id) === PIPELINE_SALES) {
      return { leadId: l.id, contactId: c.id, elsewhere };
    }
    elsewhere += 1;
  }
  // Контакт есть, но в Sales funnel его нет — лид создаём на этом же контакте.
  return { leadId: null, contactId: c.id, elsewhere };
}

/**
 * Поиск карточки по LinkedIn — брат findLeadByEmail для LinkedIn-only контактов (L1.2).
 * Без него заливка создавала бы дубли: 1 194 контакта Kommo живут вовсе без почты.
 *
 * Особенность Kommo (проверено живьём, сводка GetSales §9.4): `query=` матчит поле
 * «Linkedin profile» только ПОЛНЫМ URL с точной схемой (хвостовой слэш не важен),
 * slug и частичный URL дают 204. Поэтому перебираем формы в порядке их частотности
 * в базе (94% — http://www.); совпадение сверяем строго по slug, не по подстроке.
 */
export async function findLeadByLinkedin(slugOrUrl) {
  const slug = linkedinSlug(slugOrUrl);
  if (!slug) return null;
  for (const url of linkedinUrlVariants(slug)) {
    const found = await kommo(`/contacts?query=${encodeURIComponent(url)}&with=leads`).catch(() => null);
    for (const c of (found?._embedded?.contacts || [])) {
      const hasSlug = (c.custom_fields_values || []).some((f) => f.field_id === F.contactLinkedin
        && (f.values || []).some((v) => linkedinSlug(v.value) === slug));
      if (!hasSlug) continue;
      return salesFunnelLeadOf(c);
    }
  }
  return null;
}

// --- Какие наши данные ложатся в поля Kommo ------------------------------------------------
// Id полей подтверждены живым вызовом /custom_fields 13.08.
const F = {
  contactPosition:    472213,  // text     — наш title
  contactLinkedin:    492594,  // url      — linkedin_url
  contactEmailStatus: 3100666, // select   — наша проверка адреса
  companyWeb:         472219,  // url      — company_domain
  companyAddress:     472221,  // textarea — location / company_geo
  companyIndustry:    3100846, // text     — «Industry (Radr)»
  companySize:        3100868, // select
  leadRevenue:        482746,  // text   — годовая выручка в млн $
  leadCity:           482748,  // text
  leadIndustry:       482750,  // text
  leadClientIndustry: 3098182, // select — закрытый список Kommo
};

const EMAIL_STATUS_ENUM = { valid: 2444688 /* verified */, catch_all: 2444686 /* risky */ };

// Наш фильтр индустрии — тоже закрытый список (12 значений), поэтому соответствие
// строится таблицей, а не угадыванием по свободному тексту (поправка Ольги 13.08).
// Источник — та индустрия, ПО КОТОРОЙ лид найден: это и есть отраслевая гипотеза сегмента.
// Общий «Manufacturing» намеренно не сопоставляем: у Kommo его нет, есть семь узких
// подкатегорий, и выбрать за оператора любую из них — соврать.
const CLIENT_INDUSTRY_ENUM = {
  'Industrial Manufacturing': 2442686, // Manufacturing - Equipment
  Retail: 2442652,                     // Retail & E-Commerce
  'E-commerce': 2442652,
  'Logistics & Supply Chain': 2442668,
  Construction: 2442658,               // Property & AEC
  'Food & Beverage': 2442682,          // Manufacturing - Food, Beverages & Agro
  'Consumer Goods': 2442684,           // Manufacturing - Consumer Goods
  Automotive: 2442670,                 // Manufacturing - Automotive and Rubber Products
  Healthcare: 2442654,                 // Healthcare (Hospitals) & Life Sciences
  'Financial Services': 2442666,       // Finance & insurance
  Hospitality: 2442656,
};

const SIZE_ENUM = [
  [10, 2444844], [50, 2444846], [200, 2444848], [500, 2444850],
  [1000, 2444852], [5000, 2444854], [10000, 2444856], [Infinity, 2444858],
];
function sizeEnumId(raw) {
  // company_size приезжает и числом («1200»), и диапазоном («201-500»), и мусором.
  // Берём верхнюю границу: она и определяет корзину.
  const nums = String(raw ?? '').match(/\d[\d,]*/g);
  if (!nums) return null;
  const n = Number(nums[nums.length - 1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return SIZE_ENUM.find(([max]) => n <= max)[1];
}

const txt = (field_id, value) => (value ? { field_id, values: [{ value: String(value) }] } : null);
const sel = (field_id, enum_id) => (enum_id ? { field_id, values: [{ enum_id }] } : null);

function leadFields(c) {
  // Выручка в поле названа «Revenue (M, $)» — кладём миллионы, а не сырые доллары.
  const revM = Number(c.company_revenue) > 0 ? Math.round(Number(c.company_revenue) / 1e6) : null;
  return [
    txt(F.leadRevenue, revM),
    txt(F.leadCity, c.location || c.company_geo),
    txt(F.leadIndustry, c.company_industry),
    sel(F.leadClientIndustry, CLIENT_INDUSTRY_ENUM[c.segment_industry]),
  ].filter(Boolean);
}
function contactFields(c) {
  return [
    txt(F.contactPosition, c.title),
    txt(F.contactLinkedin, c.linkedin_url),
    sel(F.contactEmailStatus, EMAIL_STATUS_ENUM[c.email_status]),
  ].filter(Boolean);
}
function companyFields(c) {
  return [
    txt(F.companyWeb, c.company_domain),
    txt(F.companyAddress, c.location || c.company_geo),
    txt(F.companyIndustry, c.company_industry),
    sel(F.companySize, sizeEnumId(c.company_size)),
  ].filter(Boolean);
}

/**
 * Примечание-досье: всё, что мы знаем о контакте, включая то, для чего в Kommo поля нет
 * (деталь для угла №0, скоринг, сегмент, вердикт живости, источники). Примечание — единственный
 * канал, который ничего не затирает, поэтому пишем его всегда, даже когда все поля заполнены.
 */
function dossierNote(c) {
  const L = [];
  if (c.title) L.push(`Title: ${c.title}`);
  if (c.company_domain) L.push(`Domain: ${c.company_domain}`);
  if (c.company_industry) L.push(`Industry: ${c.company_industry}`);
  if (c.company_size) L.push(`Company size: ${c.company_size}`);
  if (Number(c.company_revenue) > 0) L.push(`Revenue: $${(Number(c.company_revenue) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })}M`);
  if (c.location || c.company_geo) L.push(`Location: ${c.location || c.company_geo}`);
  if (c.linkedin_url) L.push(`LinkedIn: ${c.linkedin_url}`);
  if (c.email_status) L.push(`Email check: ${c.email_status}`);
  if (c.liveness) L.push(`Company liveness: ${c.liveness}${c.liveness_note ? ` — ${c.liveness_note}` : ''}`);
  if (c.segment_name) L.push(`Segment: ${c.segment_name}`);
  if (c.fit_score != null || c.value_score != null) L.push(`Fit ${c.fit_score ?? '—'} / Value ${c.value_score ?? '—'}`);
  const src = Array.isArray(c.sources) ? c.sources : [];
  if (src.length) L.push(`Sources: ${src.join(', ')}`);
  if (c.unique_detail) L.push(`Detail: ${c.unique_detail}`);
  // Явно предупреждаем, что это не дубль: карточки в других воронках (спящая Pipeline)
  // на нашу работу не влияют, мы пишем только в Sales funnel (решение Ольги 13.08).
  if (Number(c.elsewhere) > 0) {
    L.push(`Note: this person also has ${c.elsewhere} card(s) in another funnel (we only work in Sales funnel).`);
  }
  return L.length ? `Outreach Hub — данные разведки\n${L.join('\n')}` : null;
}

async function addNote(leadId, text) {
  if (!leadId || !text) return;
  const stamp = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · Outreach Hub`;
  await kommo(`/leads/${leadId}/notes`, {
    method: 'POST',
    body: [{ note_type: 'common', params: { text: `${text}\n${stamp}` } }],
  }).catch((e) => console.warn('[kommo] примечание не записалось:', e.message));
}

const hasValue = (entity, fieldId) => (entity?.custom_fields_values || [])
  .some((f) => f.field_id === fieldId && (f.values || []).some((v) => v.value !== '' && v.value != null));

/**
 * Дозаполнение найденной карточки. Пишем ТОЛЬКО в пустые поля: если человек уже что-то внёс,
 * его запись надёжнее нашей — затирать нельзя. Ничего при этом не теряется: полный набор
 * наших данных всё равно уходит примечанием.
 */
async function fillEmptyFields(leadId, c) {
  const lead = await kommo(`/leads/${leadId}?with=contacts,companies`).catch(() => null);
  if (!lead) return { filled: 0, kept: 0 };
  const targets = [
    ['leads', lead.id, leadFields(c), lead],
    ['contacts', lead._embedded?.contacts?.[0]?.id, contactFields(c), null],
    ['companies', lead._embedded?.companies?.[0]?.id, companyFields(c), null],
  ];
  let filled = 0; let kept = 0;
  for (const [entity, id, fields, preloaded] of targets) {
    if (!id || !fields.length) continue;
    const current = preloaded || await kommo(`/${entity}/${id}`).catch(() => null);
    if (!current) continue;
    const empty = fields.filter((f) => !hasValue(current, f.field_id));
    kept += fields.length - empty.length;
    if (!empty.length) continue;
    await kommo(`/${entity}/${id}`, { method: 'PATCH', body: { custom_fields_values: empty } })
      .then(() => { filled += empty.length; })
      .catch((e) => console.warn(`[kommo] поля ${entity}/${id} не записались:`, e.message));
  }
  return { filled, kept };
}

/**
 * Заливка пакета при запуске кампании → Qualified leads (companies).
 * Именно этот этап, а не New leads: Qualified — «нашли и собираемся писать», и он же тот,
 * который стоп-лист НЕ блокирует. Класть в New leads значило бы прятать наших лидов в этап,
 * которым никто не пользуется (решения Ольги 11.08).
 *
 * Мэтч вместо дубля: если карточка уже есть — не создаём вторую, а берём существующую.
 */
export async function pushLeadsToQualified(contacts) {
  if (!contacts.length) return [];
  const out = [];
  const toCreate = [];
  for (const c of contacts) {
    // Мэтч по адресу, затем по LinkedIn (L1.2): у 1 194 контактов Kommo почты нет вовсе,
    // и без второго ключа мы плодили бы им дубли карточек.
    const hit = await findLeadByEmail(c.email).catch(() => null)
      || await findLeadByLinkedin(c.linkedin_slug || c.linkedin_url).catch(() => null);
    if (hit?.leadId) {
      // Карточка есть — двигаем её на Qualified общим правилом «только вперёд». Это и есть
      // смысл CRM: этап должен отражать, что с лидом происходит сейчас. Защита от отката
      // встроена в само правило — карточка, ушедшая дальше (встреча, сделка), останется на месте
      // и в ответе вернётся причина отказа (пересмотр решения по возражению Ольги 13.08).
      const mv = await moveLeadForward(hit.leadId, STAGE_QUALIFIED,
        'Qualified — контакт вошёл в пакет рассылки').catch(() => ({ moved: false, reason: 'error' }));
      const fill = await fillEmptyFields(hit.leadId, c).catch(() => null);
      await addNote(hit.leadId, dossierNote(c));
      if (!mv.moved) console.log(`[kommo] лид ${hit.leadId} оставлен на месте: ${mv.reason}`);
      out.push({
        contactId: c.id, kommoLeadId: hit.leadId, matched: true,
        moved: Boolean(mv.moved), stayReason: mv.moved ? null : mv.reason, filled: fill?.filled ?? 0,
      });
    } else {
      // Карточки в Sales funnel нет — создаём. Контакт при этом переиспользуем, если он
      // уже заведён: иначе получим второго человека с тем же адресом.
      // `elsewhere` — сколько карточек у этого человека в ДРУГИХ воронках (обычно спящая
      // Pipeline). На решение не влияет, но уходит в примечание, чтобы новая карточка
      // не выглядела дублем для того, кто её увидит.
      toCreate.push({ ...c, existingContactId: hit?.contactId || null, elsewhere: hit?.elsewhere || 0 });
    }
  }
  if (toCreate.length) {
    const payload = toCreate.map((c) => ({
      name: [c.company, c.full_name].filter(Boolean).join(' — ') || c.email,
      pipeline_id: PIPELINE_SALES,
      status_id: STAGE_QUALIFIED,
      custom_fields_values: leadFields(c),
      _embedded: {
        contacts: [c.existingContactId ? { id: c.existingContactId } : {
          first_name: c.first_name || (c.full_name || '').split(' ')[0] || '',
          last_name: c.last_name || (c.full_name || '').split(' ').slice(1).join(' ') || '',
          custom_fields_values: [
            ...(c.email ? [{ field_code: 'EMAIL', values: [{ value: c.email, enum_code: 'WORK' }] }] : []),
            ...contactFields(c),
          ],
        }],
        ...(c.company ? { companies: [{ name: c.company, custom_fields_values: companyFields(c) }] } : {}),
      },
    }));
    const res = await kommo('/leads/complex', { method: 'POST', body: payload });
    const rows = Array.isArray(res) ? res : [];
    for (const [i, c] of toCreate.entries()) {
      const leadId = rows[i]?.id ?? null;
      // Если лид повесили на СУЩЕСТВУЮЩИЙ контакт, его поля мы при создании не трогали —
      // в payload ушёл только `{id}`. Дозаполняем пустые отдельным проходом, иначе у такого
      // человека в карточке не будет ни должности, ни LinkedIn.
      let filled = 0;
      if (leadId && c.existingContactId) filled = (await fillEmptyFields(leadId, c).catch(() => null))?.filled ?? 0;
      await addNote(leadId, dossierNote(c));
      out.push({ contactId: c.id, kommoLeadId: leadId, matched: false, moved: true, filled });
    }
  }
  return out;
}

// Порядок этапов Sales funnel — чтобы двигать карточку ТОЛЬКО вперёд.
const SALES_STAGE_SORT = {
  [STAGE_NEW_LEADS]: 20, [STAGE_QUALIFIED]: 30, [STAGE_INITIAL_CONTACT]: 40,
  [STAGE_MEETING_SCHEDULED]: 70,
};

/**
 * Двигает карточку вперёд и оставляет в Kommo примечание с датой и причиной.
 * Назад не двигаем никогда: поздний ответ лида не должен утаскивать карточку с этапа встречи
 * обратно в «Initial Contact» (решение 11.08).
 */
export async function moveLeadForward(kommoLeadId, targetStatusId, note) {
  if (!kommoLeadId) return { moved: false, reason: 'no lead id' };
  const lead = await kommo(`/leads/${kommoLeadId}`).catch(() => null);
  if (!lead) return { moved: false, reason: 'lead not found' };
  // Двигаем только внутри Sales funnel. Найденная карточка может жить в спящей Pipeline,
  // и там «Incoming» (sort 10) ниже нашего Qualified (30) — правило «только вперёд» дало бы
  // добро и мы бы записали карточке чужой этап, то есть перетащили её между воронками.
  // Договорённость «пишем ТОЛЬКО в Sales funnel» это нарушает (найдено аудитом 13.08).
  if (Number(lead.pipeline_id) !== PIPELINE_SALES) {
    return { moved: false, reason: `lead lives in another funnel (pipeline ${lead.pipeline_id}) — we only write to Sales funnel` };
  }
  const current = await stageSortMap();
  const from = current.sort[lead.status_id] ?? 0;
  const to = current.sort[targetStatusId] ?? SALES_STAGE_SORT[targetStatusId] ?? 0;
  if (from >= to) return { moved: false, reason: `already at «${current.nameOf(lead.pipeline_id, lead.status_id)}» — forward only` };
  await kommo(`/leads/${kommoLeadId}`, { method: 'PATCH', body: { status_id: targetStatusId } });
  // Дата перевода фиксируется примечанием: сам Kommo хранит только текущий статус,
  // и без записи «когда и почему» история движения теряется.
  await addNote(kommoLeadId, note && `${note}\n${current.nameOf(lead.pipeline_id, lead.status_id)} → ${current.nameOf(PIPELINE_SALES, targetStatusId)}`);
  return { moved: true, from: current.nameOf(lead.pipeline_id, lead.status_id), to: current.nameOf(PIPELINE_SALES, targetStatusId) };
}

// Перенос лида на этап встреч.
// Перенос лида на этап встреч. Kommo не «убирает из New leads» отдельным действием —
// у лида один статус, смена статуса и есть перенос (карточка исчезает из прошлого этапа).
export async function moveLeadToMeeting(kommoLeadId) {
  return moveLeadForward(kommoLeadId, STAGE_MEETING_SCHEDULED, 'Meeting scheduled — moved by Outreach Hub');
}

/**
 * Первый ответ лида → Initial Contact. Раньше эта цепочка не была реализована вовсе.
 *
 * Канал передаём явно, а не подразумеваем. Раньше в примечании было жёстко зашито
 * «cold email»: сегодня это правда (вебхуки есть только у Smartlead), но с приходом
 * LinkedIn-кампаний CRM молча получала бы неверную запись о том, откуда пришёл ответ
 * (вопрос Ольги 13.08).
 */
const CHANNEL_LABEL = { email: 'email (Smartlead)', linkedin: 'LinkedIn (GetSales)' };

export async function moveLeadToInitialContact(kommoLeadId, { channel = 'email', campaign = null } = {}) {
  const where = CHANNEL_LABEL[channel] || channel;
  const note = [`Lead replied — moved by Outreach Hub`, `Reply channel: ${where}`,
    campaign ? `Campaign: ${campaign}` : null].filter(Boolean).join('\n');
  return moveLeadForward(kommoLeadId, STAGE_INITIAL_CONTACT, note);
}

// Лид, которого нет в Kommo (например, встречу назначили с контактом вне пакета), — создаём сразу
// на этапе встреч, чтобы кнопка работала в любом случае.
export async function createLeadAtMeetingStage(contact) {
  const c = contact;
  const res = await kommo('/leads/complex', {
    method: 'POST',
    body: [{
      name: [c.company, c.full_name].filter(Boolean).join(' — ') || c.email,
      pipeline_id: PIPELINE_SALES,
      status_id: STAGE_MEETING_SCHEDULED,
      // Поля заполняем так же, как при обычной заливке: карточка человека, с которым уже
      // назначена встреча, тем более не должна быть пустой (выравнено 13.08).
      custom_fields_values: leadFields(c),
      _embedded: {
        contacts: [{
          first_name: c.first_name || (c.full_name || '').split(' ')[0] || '',
          last_name: c.last_name || (c.full_name || '').split(' ').slice(1).join(' ') || '',
          custom_fields_values: [
            ...(c.email ? [{ field_code: 'EMAIL', values: [{ value: c.email, enum_code: 'WORK' }] }] : []),
            ...contactFields(c),
          ],
        }],
        ...(c.company ? { companies: [{ name: c.company, custom_fields_values: companyFields(c) }] } : {}),
      },
    }],
  });
  const leadId = Array.isArray(res) ? res[0]?.id ?? null : null;
  await addNote(leadId, dossierNote(c));
  return leadId;
}

/**
 * Решение «убрать из стоп-листа» пишем ПРЯМО В КАРТОЧКУ Kommo (вопрос Ольги 13.08).
 *
 * У нас эта история и так есть в двух местах — `crm_block_override` и `audit_log`. Но при
 * конфликте («почему вы написали моему лиду?») смотреть будут в CRM, а не в нашу админку,
 * и ответ должен лежать там же, где вопрос. Примечание именное и с датой, поэтому спорить
 * не о чем: видно, кто снял защиту и на каком основании.
 */
export async function noteStopListChange(leadId, { subject, action, reason, actor }) {
  if (!leadId) return false;
  const head = action === 'allow'
    ? '🔓 Removed from the Outreach Hub stop list'
    : '🔒 Added to the Outreach Hub stop list';
  await addNote(leadId, [head, `Address: ${subject}`, `Decision by: ${actor}`, `Reason: ${reason}`,
    action === 'allow' ? 'This person can now receive cold outreach again.' : null].filter(Boolean).join('\n'));
  return true;
}

// --- Выгрузка стоп-листа (ТЗ п.28) ----------------------------------------------------------
// Полная перезагрузка, не инкрементальная: лид переезжает между этапами, а нам важен ТЕКУЩИЙ
// этап, а не факт изменения. ~50 запросов, пара минут — для ночного прогона нормально.
const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|icloud|aol|proton|yandex|mail)\./i;

async function pagedAll(path, key, maxPages = 40) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const d = await kommo(`${path}${path.includes('?') ? '&' : '?'}limit=250&page=${page}`);
    const rows = d?._embedded?.[key] || [];
    out.push(...rows);
    if (rows.length < 250) break;
  }
  return out;
}

/**
 * Порядок этапов: id → sort, чтобы правило не зависело от названий.
 *
 * ⚠️ Системные статусы 142 и 143 ОБЩИЕ для всех воронок, а называются в каждой по-своему:
 * в Sales funnel это «Invoice paid» и «Closed - Postponed», в Pipeline — «Closed - won»
 * и «Closed - lost». Плоская карта их схлопывала, и 44 адреса Sales funnel показывались
 * как «Closed - lost», хотя это «Closed - Postponed» — отложенные, а не проигранные.
 * Решение «эти сделки проиграны год назад, можно трогать» принималось бы по ЧУЖОМУ ярлыку
 * (найдено сверкой документа с кодом 13.08). Поэтому имя всегда берём по паре воронка+статус.
 */
export async function stageSortMap() {
  const pl = await kommo('/leads/pipelines');
  const sort = {};
  const stage = {};
  const byPipeline = {};
  for (const p of (pl?._embedded?.pipelines || [])) {
    byPipeline[p.id] = {};
    for (const st of Object.values(p._embedded?.statuses || {})) {
      sort[st.id] = st.sort; stage[st.id] = st.name;
      byPipeline[p.id][st.id] = { name: st.name, sort: st.sort };
    }
  }
  const nameOf = (pipelineId, statusId) => byPipeline[pipelineId]?.[statusId]?.name || stage[statusId] || String(statusId);
  const sortOf = (pipelineId, statusId) => byPipeline[pipelineId]?.[statusId]?.sort ?? sort[statusId] ?? 0;
  return { sort, stage, byPipeline, nameOf, sortOf };
}

/**
 * Собирает стоп-лист: адреса, которым нельзя писать, и домены «тёплых» компаний.
 * @returns {{rows: Array, emails: number, domains: number}}
 */
/**
 * Сколько примечаний у каждого лида — одним махом, а не по карточке.
 * Массовая ручка `/leads/notes` отдаёт всё за 5 страниц и 6 секунд; поштучный обход тех же
 * карточек — две тысячи запросов. Сверено 13.08 на 18 карточках: числа совпали один в один.
 */
async function noteCountByLead() {
  const map = new Map();
  for (const n of await pagedAll('/leads/notes', 'notes', 60)) {
    const cur = map.get(n.entity_id) || { count: 0, authors: new Set() };
    cur.count += 1;
    // Кто ПИСАЛ в карточке — честнее, чем «кто ответственный»: ответственного 02.07
    // переназначили массово у 795 карточек, а автор записи не меняется никогда.
    if (n.created_by) cur.authors.add(n.created_by);
    map.set(n.entity_id, cur);
  }
  return map;
}

/** id → имя сотрудника Kommo: в выгрузке лежат только числовые id. */
async function userNames() {
  const out = {};
  const d = await kommo('/users?limit=250').catch(() => null);
  for (const u of (d?._embedded?.users || [])) out[u.id] = u.name;
  return out;
}

export async function buildCrmBlocklist() {
  const { sort, nameOf } = await stageSortMap();
  const leads = await pagedAll('/leads?with=contacts', 'leads');
  const contacts = await pagedAll('/contacts', 'contacts');
  // Есть ли в карточке хоть одна запись — единственный доступный признак «с человеком
  // разговаривали». Нужен, чтобы отделить живые карточки от мёртвого импорта: решение
  // «снять этап» принимают по мёртвым, а живые смотрят глазами (идея Ольги 13.08).
  const notes = await noteCountByLead();
  const names = await userNames();

  // Уровень блокировки на контакт: берём максимальный по всем его лидам.
  const RANK = { none: 0, email: 1, domain: 2 };
  const byContact = new Map();
  for (const l of leads) {
    const rule = US_PIPELINES[l.pipeline_id];
    if (!rule) continue;                                   // Бразилия и CSM — мимо барьера
    const s = sort[l.status_id] ?? 0;
    const closed = CLOSED_STATUS_IDS.has(Number(l.status_id));
    // «Тёплый» = дошёл до этапа встречи и не закрыт. Такие не освобождаются по давности никогда.
    const warmLevel = !closed && s >= rule.domainFrom;
    const level = warmLevel ? 'domain' : s >= rule.blockFrom ? 'email' : 'none';
    if (level === 'none') continue;
    for (const c of (l._embedded?.contacts || [])) {
      const prev = byContact.get(c.id);
      if (!prev || RANK[level] > RANK[prev.level]) {
        // Имя лида в Kommo — это, как правило, название компании («Kulicke & Soffa», «McDonald's»).
        byContact.set(c.id, {
          level, pipelineId: l.pipeline_id, pipelineName: rule.name,
          stageName: nameOf(l.pipeline_id, l.status_id), leadId: l.id, company: l.name || null,
          noteCount: notes.get(l.id)?.count || 0,
          // Владелец карточки и те, кто реально в ней писал: стоп-лист разбирают Стас
          // и Шикхар вдвоём, и каждый знает только своих (просьба Стаса 13.08).
          owner: names[l.responsible_user_id] || null,
          workedBy: [...(notes.get(l.id)?.authors || [])].map((id) => names[id]).filter(Boolean).join(', ') || null,
          // Дата последней активности карточки — якорь для правила «блок протухает через 3 месяца».
          // ⚠️ Это `updated_at` лида, то есть любое изменение карточки, а не обязательно разговор
          // с человеком. Массовая правка в CRM «омолодит» лид. Лучшего якоря нет: поле «Stage date»
          // заполнено у 255 лидов из полутора тысяч (проверено 13.08).
          lastActivityAt: l.updated_at ? new Date(l.updated_at * 1000).toISOString() : null,
          isWarm: warmLevel,
        });
      }
    }
  }

  const rows = [];
  const domains = new Set();
  const slugs = new Set();
  for (const c of contacts) {
    const m = byContact.get(c.id);
    if (!m) continue;
    const base = {
      contactName: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
      company: m.company,
      noteCount: m.noteCount || 0,
      owner: m.owner || null,
      workedBy: m.workedBy || null,
      lastActivityAt: m.lastActivityAt,
      isWarm: Boolean(m.isWarm),
      // ⚠️ level говорит, ДО КАКОГО уровня дошёл контакт по этапам, а domain — блокируется ли
      // домен фактически. Для бесплатной почты level='domain', но домен null: gmail.com
      // целиком блокировать нельзя. В интерфейсе показываем по domain, а не по level.
      level: m.level,
      pipelineId: m.pipelineId,
      pipelineName: m.pipelineName,
      stageName: m.stageName,
      leadId: m.leadId,
    };
    // Второй ключ (L1.2): LinkedIn-профиль контакта. У 96% контактов Kommo он заполнен,
    // а у 1 194 из них НЕТ почты — до этого ключа такие люди были невидимы для барьера
    // (206 из них — на блокирующих этапах; разведка L0.10 §5.1).
    let liSlug = null;
    for (const f of (c.custom_fields_values || [])) {
      if (f.field_id !== F.contactLinkedin) continue;
      for (const v of (f.values || [])) liSlug = linkedinSlug(v.value) || liSlug;
    }
    if (liSlug) slugs.add(liSlug);
    let emailRows = 0;
    for (const f of (c.custom_fields_values || [])) {
      if (f.field_code !== 'EMAIL') continue;
      for (const v of (f.values || [])) {
        const email = String(v.value || '').trim().toLowerCase();
        if (!email.includes('@')) continue;
        const domain = email.split('@')[1];
        // Доменный блок только для корпоративных: блокировать gmail.com целиком — абсурд.
        const blockDomain = m.level === 'domain' && domain && !FREE_MAIL.test(domain);
        if (blockDomain) domains.add(domain);
        rows.push({ ...base, email, domain: blockDomain ? domain : null, linkedinSlug: liSlug });
        emailRows += 1;
      }
    }
    // Почты нет, LinkedIn есть — запись барьера держится на одном slug.
    if (!emailRows && liSlug) rows.push({ ...base, email: null, domain: null, linkedinSlug: liSlug });
  }
  return {
    rows,
    emails: new Set(rows.map((r) => r.email).filter(Boolean)).size,
    domains: domains.size,
    slugs: slugs.size,
  };
}

/**
 * Тёплые карточки, которые барьер физически не может защитить: этап встречи и дальше,
 * но НИ ОДНОГО адреса ни у одного контакта. Стоп-лист строится из адресов, поэтому такая
 * карточка не даёт ни адресного блока, ни доменного — коллеге этого человека мы спокойно
 * напишем холодное письмо.
 *
 * Найдено 13.08 на Blackstone: карточка на «Commitment discussion» (sort 180), один контакт
 * Blake Vogt без адреса, компания к лиду не привязана. Защиты — ноль.
 *
 * Автоматически закрыть нечем: домен взять неоткуда. Поэтому просто показываем список —
 * ни одно исключение не должно молчать.
 */
export async function unprotectedWarmLeads() {
  const { sort, nameOf } = await stageSortMap();
  const withEmail = new Set();
  for (const c of await pagedAll('/contacts', 'contacts')) {
    for (const f of (c.custom_fields_values || [])) {
      if (f.field_code === 'EMAIL') for (const v of (f.values || [])) if (v.value) withEmail.add(c.id);
    }
  }
  const out = [];
  for (const l of await pagedAll('/leads?with=contacts', 'leads')) {
    const rule = US_PIPELINES[l.pipeline_id];
    if (!rule) continue;
    if (CLOSED_STATUS_IDS.has(Number(l.status_id))) continue;
    if ((sort[l.status_id] ?? 0) < rule.domainFrom) continue;      // только тёплые
    const cs = l._embedded?.contacts || [];
    if (cs.some((c) => withEmail.has(c.id))) continue;
    out.push({
      leadId: l.id, name: l.name || String(l.id),
      pipeline: rule.name, stage: nameOf(l.pipeline_id, l.status_id),
      contacts: cs.length,
    });
  }
  return out;
}

/**
 * Живая проверка перед запуском: между ночной синхронизацией и отправкой прошёл целый день.
 *
 * ⚠️ Возвращает СЫРЫЕ попадания — «этот адрес сейчас на блокирующем этапе». Правила снятия
 * (снятый этап, ручное разрешение, протухание через 3 месяца) применяет `filterLiveHits`
 * в `db/crm.js`, где они и живут для ночного списка. Иначе живая проверка оказывалась строже
 * ночного барьера и молча отменяла кнопку «release this stage» и правило давности
 * (найдено аудитом 13.08 по вопросу Ольги).
 */
export async function checkEmailsLive(emails = []) {
  const { sort, nameOf } = await stageSortMap();
  const hits = [];
  for (const email of emails) {
    const want = String(email).toLowerCase();
    const found = await kommo(`/contacts?query=${encodeURIComponent(email)}&with=leads`).catch(() => null);
    for (const c of (found?._embedded?.contacts || [])) {
      // Сверяем адрес точно — `query` у Kommo нечёткий и возвращает соседей по подстроке.
      // Без этой проверки живой барьер отсекал контакт из-за чужого похожего адреса.
      const emailsOfContact = [];
      for (const f of (c.custom_fields_values || [])) {
        if (f.field_code === 'EMAIL') for (const v of (f.values || [])) if (v.value) emailsOfContact.push(String(v.value).toLowerCase());
      }
      if (!emailsOfContact.includes(want)) continue;
      for (const l of (c._embedded?.leads || [])) {
        const lead = await kommo(`/leads/${l.id}`).catch(() => null);
        if (!lead) continue;
        const rule = US_PIPELINES[lead.pipeline_id];
        if (!rule) continue;
        const s = sort[lead.status_id] ?? 0;
        if (s < rule.blockFrom) continue;
        const closed = CLOSED_STATUS_IDS.has(Number(lead.status_id));
        hits.push({
          email: want,
          stage: nameOf(lead.pipeline_id, lead.status_id),
          pipeline: rule.name,
          isWarm: !closed && s >= rule.domainFrom,
          lastActivityAt: lead.updated_at ? new Date(lead.updated_at * 1000).toISOString() : null,
        });
      }
    }
  }
  return hits;
}

/**
 * Живая проверка LinkedIn-ключей перед запуском — зеркало checkEmailsLive для контактов
 * без почты (L1.2). Возвращает СЫРЫЕ попадания; правила снятия применяет filterLiveHits.
 * Перебор форм URL — как в findLeadByLinkedin (Kommo матчит только полную форму).
 */
export async function checkLinkedinLive(slugs = []) {
  const { sort, nameOf } = await stageSortMap();
  const hits = [];
  for (const raw of slugs) {
    const slug = linkedinSlug(raw);
    if (!slug) continue;
    let matched = null;
    for (const url of linkedinUrlVariants(slug)) {
      const found = await kommo(`/contacts?query=${encodeURIComponent(url)}&with=leads`).catch(() => null);
      matched = (found?._embedded?.contacts || []).find((c) => (c.custom_fields_values || [])
        .some((f) => f.field_id === F.contactLinkedin
          && (f.values || []).some((v) => linkedinSlug(v.value) === slug)));
      if (matched) break;
    }
    if (!matched) continue;
    for (const l of (matched._embedded?.leads || [])) {
      const lead = await kommo(`/leads/${l.id}`).catch(() => null);
      if (!lead) continue;
      const rule = US_PIPELINES[lead.pipeline_id];
      if (!rule) continue;
      const s = sort[lead.status_id] ?? 0;
      if (s < rule.blockFrom) continue;
      const closed = CLOSED_STATUS_IDS.has(Number(lead.status_id));
      hits.push({
        slug,
        stage: nameOf(lead.pipeline_id, lead.status_id),
        pipeline: rule.name,
        isWarm: !closed && s >= rule.domainFrom,
        lastActivityAt: lead.updated_at ? new Date(lead.updated_at * 1000).toISOString() : null,
      });
    }
  }
  return hits;
}

// --- Самоописание интеграции ---------------------------------------------------------------
// Таблица «триггер → что делаем в Kommo → какие поля» нужна и в документе, и в интерфейсе.
// Отдаём её ИЗ КОДА, а не пишем второй раз руками: переписанная таблица через месяц начинает
// врать, и хуже неточной документации только документация, которой верят (вопрос Ольги 13.08).
const FIELD_LABEL = {
  [F.contactPosition]: 'Position (contact)',
  [F.contactLinkedin]: 'Linkedin profile (contact)',
  [F.contactEmailStatus]: 'Email Status (contact)',
  [F.companyWeb]: 'Web (company)',
  [F.companyAddress]: 'Address (company)',
  [F.companyIndustry]: 'Industry (Radr) (company)',
  [F.companySize]: 'Company Size (company)',
  [F.leadRevenue]: 'Revenue (M, $) (lead)',
  [F.leadCity]: 'City (lead)',
  [F.leadIndustry]: 'Industry (lead)',
  [F.leadClientIndustry]: 'Client industry (lead)',
};

// Пример-пустышка со всеми полями — чтобы перечислить, что вообще заполняется.
const SAMPLE = {
  title: 'x', linkedin_url: 'x', email_status: 'valid', company_domain: 'x', location: 'x',
  company_industry: 'x', company_size: '100', company_revenue: 1e6, segment_industry: 'Hospitality',
};
const names = (fields) => fields.map((f) => FIELD_LABEL[f.field_id] || String(f.field_id));

export function integrationRules() {
  return {
    pipeline: { id: PIPELINE_SALES, name: 'Sales funnel', note: 'the only funnel we write to' },
    staleMonths: 3,
    triggers: [
      {
        trigger: 'Campaign launch (Launch button)',
        action: 'Look for a card by email address. None — create lead + contact + company on «Qualified leads (companies)». Found — move it to «Qualified leads», unless it has already gone further.',
        stage: 'Qualified leads (companies)',
        fields: [...names(leadFields(SAMPLE)), ...names(contactFields(SAMPLE)), ...names(companyFields(SAMPLE))],
      },
      {
        trigger: 'Lead replies (Smartlead webhook)',
        action: 'Move the card to «Initial Contact». The reply channel goes into a note — always email today, GetSales once LinkedIn campaigns start.',
        stage: 'Initial Contact',
        fields: [],
      },
      {
        trigger: '«Meeting scheduled» button in Inbox',
        action: 'Move the card to the meeting stage. No card yet (the meeting was booked outside a batch) — create it there straight away.',
        stage: 'Online meeting Scheduled',
        fields: [...names(leadFields(SAMPLE)), ...names(contactFields(SAMPLE)), ...names(companyFields(SAMPLE))],
      },
      {
        trigger: 'Nightly sync at 03:00 ET (and the «Sync now» button)',
        action: 'Read Sales funnel and Pipeline, rebuild the stop list. Nothing is written to Kommo.',
        stage: '—',
        fields: [],
      },
    ],
    always: [
      'A note «Outreach Hub — данные разведки» with a timestamp, on every push and on every card we create.',
      'Into an existing card we write ONLY where the field is empty — what a person filled in is never overwritten.',
      'Forward only: a card never moves back to an earlier stage.',
      'A card living in another funnel (Pipeline, Brazil, CSM) is not moved at all.',
    ],
    notFilled: [
      'Client industry for the generic «Manufacturing» — Kommo has no such value, only seven narrow sub-categories.',
      'The angle-0 detail, fit/value scores, the segment, the liveness verdict and the sources — no fields exist for these, they go into the note.',
    ],
  };
}
