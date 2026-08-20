// GetSales (LinkedIn-канал) — адаптер (этап L3.1). Все контракты подтверждены живыми
// вызовами 13.08 (сводка GetSales §5, §9; ТЗ этап L, L0.1–L0.6).
//
// Транспорт — по образцу kommo(), НЕ sl() из smartlead.js: ретраи на 429/5xx и сетевые
// сбои, таймаут 30 с. Отсутствие ретраев уже стреляло (сбой синхронизации барьера 13.08).
//
// Модель канала: наша ячейка = список GetSales (external_id кампании = list_uuid)
// + привязка лидов к флоу-лестнице. Флоу — «чистые касания» (заявка без записки → принял →
// лайк → отзыв), ПО ОДНОМУ НА ОТПРАВИТЕЛЯ: ротацию GetSales не используем — распределение
// по Value («сильных — Стэну», решение §1.5) требует назначать отправителя на каждого лида,
// и это делается выбором флоу при attach. Сообщения флоу НЕ шлёт — тексты только наши,
// через sendMessage (гибрид В3: флоу для касаний, наш код для сообщений).
const BASE = 'https://amazing.getsales.io';

export function getsalesEnabled() {
  return Boolean(process.env.GETSALES_API_TOKEN);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gs(path, { method = 'GET', body, attempts = 3 } = {}) {
  const token = process.env.GETSALES_API_TOKEN;
  if (!token) throw new Error('GETSALES_API_TOKEN не задан в .env');
  let lastErr = null;
  for (let a = 1; a <= attempts; a += 1) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await r.text();
      if (!r.ok) {
        const retryable = r.status === 429 || r.status >= 500;
        const err = new Error(`getsales ${method} ${path} → ${r.status}: ${text.slice(0, 200)}`);
        if (!retryable || a === attempts) throw err;
        lastErr = err;
      } else {
        if (!text) return null; // 204
        try { return JSON.parse(text); } catch { return { raw: text }; }
      }
    } catch (e) {
      if (a === attempts || /→ 4\d\d:/.test(String(e.message))) throw e;
      lastErr = e;
    }
    await sleep(a * 1500);
  }
  throw lastErr || new Error(`getsales ${method} ${path}: не удалось`);
}

// --- Списки и лиды ---------------------------------------------------------------------------

export const createList = (name) => gs('/leads/api/lists', { method: 'POST', body: { name } });

/**
 * Заливка лидов пачкой в список. ⚠️ GetSales НЕ валидирует поля (пустой {} создаёт пустого
 * лида — проверено пробой L0.1): pre-flight целиком наш, сюда приходит уже отобранное.
 * Формат лида: { linkedin: slug, first_name, last_name, company_name, position, work_email }.
 */
export const uploadLeads = (listUuid, leads) => gs('/leads/api/leads', {
  method: 'POST', body: { list_uuid: listUuid, leads },
});

export const deleteLead = (leadUuid) => gs(`/leads/api/leads/${leadUuid}`, { method: 'DELETE' });

/** Один лид со связями flows[] — нужен кросс-стопу, чтобы снять его с лестницы. */
export const getLead = async (leadUuid) => {
  const d = await gs(`/leads/api/leads/${leadUuid}`);
  return d?.data || d;
};

/**
 * Серверный поиск лидов: единственный способ фильтра по списку и обход лимита
 * Elasticsearch в 10 000 на offset-пагинацию (разведка L0.10). Возвращает все страницы.
 */
export async function leadsOfList(listUuid, { pageSize = 250 } = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const d = await gs('/leads/api/leads/search', {
      method: 'POST', body: { limit: pageSize, offset, filter: { list_uuid: listUuid } },
    });
    const rows = d?.data || [];
    out.push(...rows);
    if (!d?.has_more || !rows.length) break;
    offset += pageSize;
  }
  return out;
}

/**
 * Поиск лида по LinkedIn-slug во ВСЕЙ команде (проверено 18.08).
 *
 * Зачем: GetSales НЕ заводит второго лида на тот же профиль — повторная заливка человека,
 * который уже есть лидом (например, из импортированной истории на 2 433 человека), молча
 * ничего не создаёт. Без этого поиска такие люди тихо выпадали бы из волны: заливка
 * «прошла», в списке их нет, привязать не к чему.
 *
 * ⚠️ Этот фильтр, в отличие от query-параметров GET-эндпоинтов, РАБОТАЕТ: на заведомо
 * ложном slug возвращает ноль (проверено).
 */
export const findLeadBySlug = async (slug) => {
  if (!slug) return null;
  const d = await gs('/leads/api/leads/search', {
    method: 'POST', body: { limit: 1, offset: 0, filter: { linkedin: slug } },
  });
  const row = (d?.data || [])[0];
  return row ? (row.lead || row) : null;
};

// --- Флоу-лестница ---------------------------------------------------------------------------

export const listFlows = async () => {
  const d = await gs('/flows/api/flows');
  return d?.data || d || [];
};

/**
 * Привязка лидов к флоу — mass-action (контракт найден пробой L0.4):
 * PUT /leads/api/leads/mass-action, синхронный ответ {count}. contact_source_id — источник
 * внутри флоу-версии (у собранных руками флоу это 1).
 */
export const attachToFlow = (leadUuids, flowUuid, { contactSourceId = 1 } = {}) => gs(
  '/leads/api/leads/mass-action',
  {
    method: 'PUT',
    body: {
      type: 'contact_add_to_flow',
      filter: { all: false, ids: leadUuids, excludeIds: [] },
      payload: { flow_uuid: flowUuid, contact_source_id: contactSourceId },
    },
  },
);

/**
 * Стоп лида = снятие с флоу (контракт найден пробой L0.6): DELETE связи lead-flow → 204,
 * оставшиеся шаги автоматики не выполняются. uuid связи — из lead.flows[].uuid.
 * Проверено боевой чисткой 67 пересечений с Kommo (137 удалений, 0 ошибок).
 */
export const detachFromFlow = (relationUuid) => gs(`/flows/api/flows/leads/${relationUuid}`, { method: 'DELETE' });

/** Снять лида со ВСЕХ флоу — плечо кросс-стопа (L4.2): ответ по email глушит лестницу целиком. */
export async function stopLeadEverywhere(leadRow) {
  const rels = (leadRow?.flows || []).map((f) => f.uuid).filter(Boolean);
  let removed = 0;
  for (const uuid of rels) {
    try { await detachFromFlow(uuid); removed += 1; } catch (e) {
      console.warn(`[getsales] detach ${uuid} не удался: ${e.message}`);
    }
  }
  return removed;
}

// --- Сообщения и профили ---------------------------------------------------------------------

/**
 * Отправка сообщения от имени профиля (контракт из аудита 04.08, вживую не вызывался до
 * нулевого прогона — семантика linkedin_type уточняется первым вызовом, хвост L0).
 * ⚠️ Вызывать ТОЛЬКО после проверки принятой заявки: холодный DM не-контакту — главный
 * триггер бана (правило §1.2), проверка лежит на вызывающем оркестраторе.
 */
export const sendMessage = async (senderProfileUuid, leadUuid, message) => {
  // ⚠️ Поле текста называется `text`, а не `message`, и нужен `linkedin_type` (разбор 17.08).
  // Со старым именем GetSales отвечал 201 и создавал запись с ПУСТЫМ текстом, которая никогда
  // не доставлялась: Пётр принял заявку 14.08, система записала «сообщение отправлено»,
  // а в его чате не было ничего. Контракт был помечен «подтвердить при первом вызове» —
  // и не подтверждён; нулевой прогон ровно за этим и нужен.
  const r = await gs('/flows/api/linkedin-messages', {
    method: 'POST',
    body: { sender_profile_uuid: senderProfileUuid, lead_uuid: leadUuid, text: message, linkedin_type: 'message' },
  });
  // 201 сам по себе ничего не доказывает — проверяем ЭХО текста: именно его отсутствие
  // и отличало пустышку от настоящего сообщения.
  if (!r?.uuid || !String(r?.text || '').trim()) {
    throw new Error(`getsales не принял текст сообщения (uuid=${r?.uuid || '—'}, text=${JSON.stringify(r?.text)})`);
  }
  return r;
};

/**
 * Отправленные/полученные сообщения аккаунта. ⚠️ Параметр `lead_uuid` эндпоинт ИГНОРИРУЕТ
 * (проверено ложным ключом 17.08) — фильтруем на нашей стороне. Нужен для проверки факта
 * доставки: `status: done` + непустой `linkedin_conversation_uuid`.
 */
export const linkedinMessages = async ({ limit = 200 } = {}) => {
  const d = await gs(`/flows/api/linkedin-messages?limit=${limit}`);
  return d?.data || [];
};

/**
 * Свежие сообщения аккаунта.
 *
 * ⚠️ История заблуждения (19.08), потому что она стоила нам ложных тревог: сначала мы читали
 * ХВОСТ коллекции по offset, решив, что она отсортирована по времени. Она не отсортирована —
 * в хвосте лежали записи 2012 года, свежая отправка не находилась даже в 2 000 последних,
 * и сверка объявляла доставленное сообщение «пропавшим». Оказалось, эндпоинт **поддерживает
 * сортировку**: `sort=-created_at` отдаёт свежее первым. Проверять надо было это, а не строить
 * обход.
 *
 * Урок в копилку к «фильтры декоративны»: у GetSales отсутствие фильтрации на одном параметре
 * не означает её отсутствия на другом. Каждый параметр проверяется отдельно.
 */
export const recentMessages = async ({ depth = 200 } = {}) => {
  const out = [];
  const page = 200;
  for (let off = 0; off < depth; off += page) {
    const d = await gs(`/flows/api/linkedin-messages?limit=${page}&offset=${off}&sort=-created_at`);
    const rows = d?.data || [];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
};

/**
 * Здоровье LinkedIn-аккаунтов. Прямого признака «разлогинен» у GetSales нет, зато есть ПУЛЬС:
 * `last_tasks_heartbeat_at` / `last_messages_heartbeat_at`. Живые аккаунты бьются ежедневно,
 * у неработающих пульс замирает на недели при формальном статусе `enabled`. Оттуда же
 * `last_connection_weekly_limit_at` — когда аккаунт упёрся в недельный лимит заявок LinkedIn.
 *
 * ⚠️ Эта функция уже один раз пропадала (19.08): я переписывала соседний блок и снесла её
 * вместе с ним. Панель состояний упала с 500, а защита «аккаунт без пульса нельзя выбрать
 * в волну» молча отключилась — вызов там обёрнут в catch и деградировал в тишину.
 */
export const linkedinAccounts = async () => {
  const d = await gs('/flows/api/linkedin-accounts');
  return d?.data || [];
};

export const listSenderProfiles = async () => {
  const d = await gs('/flows/api/sender-profiles');
  return d?.data || d || [];
};

export const conversations = (leadUuid) => gs(`/flows/api/linkedin-conversations?lead_uuid=${encodeURIComponent(leadUuid)}`);

/** История mass-действий — сторож L3.6 видит здесь чужие запуски (add_to_flow и т.п.). */
export const massActionsHistory = async (limit = 50) => {
  const d = await gs(`/leads/api/mass-actions?limit=${limit}`);
  return d?.data || [];
};

// --- Разбор маркеров -------------------------------------------------------------------------

/**
 * Сводит markers лида (по каждому профилю-отправителю) в события лестницы для наших touch.
 * Агрегатный маркер (sender_profile_uuid=null) пропускаем — он дублирует по-профильные.
 * Возвращает [{event, at, senderProfileUuid}] в хронологии.
 */
export function ladderEventsFromMarkers(markers = []) {
  const events = [];
  for (const m of markers) {
    if (!m || !m.sender_profile_uuid) continue;
    if (m.linkedin_last_connection_sent_at) {
      events.push({ event: 'connection_sent', at: m.linkedin_last_connection_sent_at, senderProfileUuid: m.sender_profile_uuid });
    }
    if (m.linkedin_last_connection_accepted_at) {
      events.push({ event: 'accepted', at: m.linkedin_last_connection_accepted_at, senderProfileUuid: m.sender_profile_uuid });
    }
    if (m.linkedin_first_message_sent_at) {
      events.push({ event: 'message_sent', at: m.linkedin_first_message_sent_at, senderProfileUuid: m.sender_profile_uuid });
    }
  }
  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  return events;
}
