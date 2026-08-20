// Smartlead API-клиент. Грабли из Урока 04.08 вшиты:
//   - Cloudflare режет не-браузерные клиенты → браузерный User-Agent обязателен;
//   - auth: query-параметр api_key;
//   - delay первого шага sequence ВСЕГДА 0 (иначе лиды виснут Scheduled/Overdue);
//   - при заливке лидов проверять total_leads (0 при upload_count>0 = флаг дублей).
const BASE = 'https://server.smartlead.ai/api/v1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function smartleadEnabled() {
  return Boolean(process.env.SMARTLEAD_API_KEY);
}

async function sl(path, { method = 'GET', body } = {}) {
  const key = process.env.SMARTLEAD_API_KEY;
  if (!key) throw new Error('SMARTLEAD_API_KEY не задан в .env');
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${BASE}${path}${sep}api_key=${key}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`smartlead ${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
  return data;
}

export const listEmailAccounts = () => sl('/email-accounts/?offset=0&limit=50');
export const createCampaign = (name) => sl('/campaigns/create', { method: 'POST', body: { name } });
export const setSequences = (id, sequences) => sl(`/campaigns/${id}/sequences`, { method: 'POST', body: { sequences } });
export const addEmailAccounts = (id, ids) => sl(`/campaigns/${id}/email-accounts`, { method: 'POST', body: { email_account_ids: ids } });
export const setSchedule = (id, schedule) => sl(`/campaigns/${id}/schedule`, { method: 'POST', body: schedule });
export const setStatus = (id, status) => sl(`/campaigns/${id}/status`, { method: 'POST', body: { status } });
export const campaignAnalytics = (id) => sl(`/campaigns/${id}/analytics`);
export const listCampaignLeads = (id) => sl(`/campaigns/${id}/leads?offset=0&limit=100`);

/**
 * Отслеживание в боевых кампаниях отключаем полностью — и открытия, и клики
 * (правило Тони 07.08, подтверждено решением Ольги 19.08).
 *
 * Почему обе настройки, а не только открытия: трекинг переписывает ссылки и вставляет
 * пиксель через ДОМЕН ОТСЛЕЖИВАНИЯ. Свой домен у нас не подтверждён (в Smartlead висит
 * «CNAME Not Verified»), значит всё идёт через общий домен, который делят сотни
 * отправителей и который регулярно попадает в чёрные списки. На seed-тесте 10–11.08
 * (3.1/10, Google 8 из 8 в спам) это вероятный второй фактор после отсутствия DKIM.
 *
 * Цена решения названа честно: метрику «открыто» мы теряем. Она и так самая ненадёжная —
 * Apple Mail Privacy и корпоративные сканеры «открывают» письма за получателя. Остаются
 * ответы и отскоки, а это то, по чему решения и принимаются.
 */
export async function disableTracking(id) {
  try {
    await sl(`/campaigns/${id}/settings`, {
      method: 'POST',
      body: { track_settings: ['DONT_TRACK_EMAIL_OPEN', 'DONT_TRACK_LINK_CLICK'] },
    });
    return { ok: true };
  } catch (e) {
    // ⚠️ НЕ проглатываем молча: если отключить не удалось, письма пойдут с пикселем
    // через общий домен, и мы должны об этом знать до, а не после волны (правило L5.12).
    console.warn(`[smartlead] disableTracking failed: ${e.message}`);
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
}

/** Старое имя — оставлено, чтобы не ломать вызовы, если где-то остались. */
export const disableOpenTracking = disableTracking;

export async function uploadLeads(id, leadList, { allowTestOverrides = false } = {}) {
  const data = await sl(`/campaigns/${id}/leads`, {
    method: 'POST',
    body: {
      lead_list: leadList,
      settings: {
        // Нулевой прогон шлёт на свои же адреса, встречавшиеся в старых кампаниях → игнорируем списки.
        ignore_global_block_list: allowTestOverrides,
        ignore_unsubscribe_list: allowTestOverrides,
        ignore_duplicate_leads_in_other_campaign: false, // false = добавить и тех, кто был в других кампаниях
      },
    },
  });
  const total = data?.total_leads ?? null;
  const uploaded = data?.upload_count ?? leadList.length;
  if (total === 0 && uploaded > 0) {
    throw new Error(`smartlead: залито 0 из ${uploaded} (total_leads=0) — проверь флаг дублей/блок-листы`);
  }
  return { uploaded, total, raw: data };
}

// Вебхуки — только per-campaign (API-аудит: account-level GET /webhooks не существует).
export const registerWebhook = (id, { name, url, eventTypes }) =>
  sl(`/campaigns/${id}/webhooks`, { method: 'POST', body: { id: null, name, webhook_url: url, event_types: eventTypes } });

// Ответ лиду в том же треде с ящика кампании (кнопка Reply в Inbox — запрос Ольги 07.08).
// Формат полей подтверждается живым событием нулевого прогона (сырой payload — в event_log).
export const replyToThread = (campaignId, payload) =>
  sl(`/campaigns/${campaignId}/reply-email-thread`, { method: 'POST', body: payload });

// Пауза ОДНОГО лида в кампании (кросс-стоп L4.1: ответ в LinkedIn останавливает email-фоллоуапы).
// До 13.08 этой функции не существовало вовсе — обработчик честно писал «linkedin stop pending».
// Документированный вызов Smartlead: пауза по паре кампания+лид; лид ищем по адресу.
export async function pauseLead(campaignId, email) {
  const found = await sl(`/leads/?email=${encodeURIComponent(email)}`);
  const leadId = found?.id ?? found?.lead?.id ?? (Array.isArray(found) ? found[0]?.id : null);
  if (!leadId) throw new Error(`smartlead: lead ${email} not found`);
  return sl(`/campaigns/${campaignId}/leads/${leadId}/pause`, { method: 'POST', body: {} });
}
