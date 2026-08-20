// Этап кампаний: библиотека заходов (message_angle) + кампании (ячейки матрицы) + выборка
// кандидатов из реестра. Решения 07.08: список рассылки — всегда из реестра; апрув текста —
// кнопкой в приложении (факт+дата, позже — email через Cloudflare Access).
import { getPool } from './registry.js';
import { identityFromSignature } from '../identities.js';

// --- Message angles (библиотека заходов) ---

// Бэкфилл личности для заходов, созданных до появления поля (иначе утверждённый A3 не запустится).
export async function backfillSenderIdentities() {
  const r = await getPool().query('SELECT id, sequence FROM message_angle WHERE sender_identity IS NULL');
  let filled = 0;
  for (const row of r.rows) {
    const id = identityFromSignature(row.sequence || [])?.id;
    if (!id) continue;
    await getPool().query('UPDATE message_angle SET sender_identity = $2 WHERE id = $1', [row.id, id]);
    filled += 1;
  }
  if (filled) console.log(`[angles] sender_identity backfilled for ${filled} angle(s)`);
  return filled;
}

export async function listMessageAngles() {
  const r = await getPool().query(
    `SELECT ma.*,
       (SELECT COUNT(*) FROM campaign c WHERE c.message_angle_id = ma.id) AS campaigns_count
     FROM message_angle ma ORDER BY ma.created_at DESC`,
  );
  return r.rows;
}

// Любая правка текста сбрасывает апрув — текст, ушедший в кампанию, всегда явно подтверждён.
// Это касается и LinkedIn-части (L2.4): заход един, апрув один на обе формы.
export async function saveMessageAngle({ id, name, description, sequence, variables, senderIdentity, linkedin }) {
  // Личность отправителя: берём явную, иначе выводим из подписи текста («…\n\nStan»).
  const identity = senderIdentity || identityFromSignature(sequence)?.id || null;
  const li = linkedin && (linkedin.message1?.body || linkedin.followup?.body) ? JSON.stringify(linkedin) : null;
  if (id) {
    const r = await getPool().query(
      `UPDATE message_angle SET name=$2, description=$3, sequence=$4, variables=$5, sender_identity=$6,
         linkedin=$7, status='draft', approved_by=NULL
       WHERE id=$1 RETURNING *`,
      [id, name, description || null, JSON.stringify(sequence || []), JSON.stringify(variables || []), identity, li],
    );
    if (!r.rows.length) throw new Error('angle not found');
    return r.rows[0];
  }
  const r = await getPool().query(
    `INSERT INTO message_angle (name, description, sequence, variables, sender_identity, linkedin)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, description || null, JSON.stringify(sequence || []), JSON.stringify(variables || []), identity, li],
  );
  return r.rows[0];
}

export async function approveMessageAngle(id, approvedBy = 'panel user') {
  const r = await getPool().query(
    `UPDATE message_angle SET status='approved', approved_by=$2 WHERE id=$1 RETURNING *`,
    [id, `${approvedBy} @ ${new Date().toISOString()}`],
  );
  if (!r.rows.length) throw new Error('angle not found');
  return r.rows[0];
}

// --- Сегменты и кандидаты ---

export async function listSegments() {
  const r = await getPool().query(
    `SELECT s.id, s.name, s.criteria, s.created_at,
       (SELECT COUNT(*) FROM contact_segment_match m WHERE m.segment_id = s.id) AS contacts
     FROM segment s ORDER BY s.created_at DESC`,
  );
  return r.rows;
}

// Кандидаты в кампанию: available + почта + pre-flight по статусу адреса.
//
// ФИКС 10.08 (ТЗ п.31): раньше условие было `IN ('verified','valid')` — с появлением статуса
// `catch_all` эти контакты МОЛЧА выпали бы из всех пакетов, а это заметная часть ICP.
// Теперь допускаются: valid, catch_all и «серая зона по исчерпании попыток» (unknown после
// 3 неудачных проверок — см. MAX_ATTEMPTS). Доля catch-all режется квотой отдельно, на сборке
// пакета, и всегда с пояснением — молчаливого отсева быть не должно.
//
// validatorOn=false (ключ валидатора не задан) — legacy-режим: верим заявке источника.
// Иначе первый же деплой без ключа обнулил бы все пакеты.
export const SENDABLE_STATUSES = ['valid', 'catch_all'];
export async function campaignCandidates({ segmentId, minFit = 0, requireVerified = true, validatorOn = true }) {
  const params = [];
  // Мёртвая компания — не суждение, а факт: законного повода писать туда холодное письмо нет.
  // Поэтому отсекаем на pre-flight, как invalid-адрес, а не «помечаем и оставляем» (12.08).
  const conds = [`c.lifecycle = 'available'`, `c.email IS NOT NULL`, `COALESCE(c.liveness, 'alive') <> 'dead'`];
  const sendable = validatorOn
    ? `(lower(c.email_status) IN ('valid','catch_all')
        OR (c.email_status = 'unknown' AND c.email_verify_attempts >= 3))`
    : `lower(COALESCE(c.email_status, c.source_email_status, '')) IN ('verified','valid')`;
  if (requireVerified) conds.push(sendable);
  if (segmentId) {
    params.push(Number(segmentId));
    conds.push(`m.segment_id = $${params.length}`);
  }
  if (minFit) {
    params.push(Number(minFit));
    conds.push(`COALESCE(m.fit_score, 0) >= $${params.length}`);
  }
  const r = await getPool().query(
    `SELECT DISTINCT ON (c.id) c.id, c.first_name, c.last_name, c.full_name, c.title, c.company,
        c.company_domain, c.location, c.email, c.email_status, c.unique_detail,
        c.email_verified_at, c.email_verify_attempts, c.last_deferred_at, c.sources,
        c.reserved_by, c.reserved_until,
        m.fit_score, m.value_score, m.segment_id
     FROM contact c
     LEFT JOIN contact_segment_match m ON m.contact_id = c.id
     WHERE ${conds.join(' AND ')}
     ORDER BY c.id, m.fit_score DESC NULLS LAST
     LIMIT 500`,
    params,
  );
  // Отдельно — отклонённые pre-flight'ом (для честного счётчика «кого не взяли и почему»).
  const rejParams = segmentId ? [Number(segmentId)] : [];
  const rej = await getPool().query(
    // Причины отсева разделены (ТЗ п.31): раньше catch_all, unknown и invalid сваливались
    // в одну кучу «unverified», и по счётчику нельзя было понять, база плохая или ещё не проверена.
    `SELECT COUNT(*) FILTER (WHERE c.email IS NULL) AS no_email,
        COUNT(*) FILTER (WHERE c.email IS NOT NULL AND c.email_verified_at IS NULL) AS unchecked,
        COUNT(*) FILTER (WHERE c.email_status = 'invalid') AS invalid,
        COUNT(*) FILTER (WHERE c.email_status = 'role') AS role,
        COUNT(*) FILTER (WHERE c.email_status = 'catch_all') AS catch_all,
        COUNT(*) FILTER (WHERE c.email_status = 'unknown' AND c.email_verify_attempts < 3) AS unknown_retrying,
        COUNT(*) FILTER (WHERE c.liveness = 'dead') AS company_closed,
        COUNT(*) FILTER (WHERE c.lifecycle <> 'available') AS not_available
     FROM contact c JOIN contact_segment_match m ON m.contact_id = c.id
     ${segmentId ? 'WHERE m.segment_id = $1' : ''}`,
    rejParams,
  );
  return { candidates: r.rows, rejected: rej.rows[0] };
}

// --- Кампании ---

export async function listCampaigns() {
  const r = await getPool().query(
    `SELECT c.*, s.name AS segment_name, ma.name AS angle_name, ma.status AS angle_status
     FROM campaign c
     LEFT JOIN segment s ON s.id = c.segment_id
     LEFT JOIN message_angle ma ON ma.id = c.message_angle_id
     ORDER BY c.created_at DESC`,
  );
  return r.rows;
}

export async function createCampaignRow({ segmentId, messageAngleId, channel = 'email', senders = [], meta = {} }) {
  const r = await getPool().query(
    `INSERT INTO campaign (segment_id, message_angle_id, channel, senders, meta)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [segmentId || null, messageAngleId || null, channel, JSON.stringify(senders), JSON.stringify(meta)],
  );
  return r.rows[0];
}

export async function updateCampaignRow(id, fields) {
  const allowed = ['external_id', 'status', 'leads_count', 'started_at', 'closed_at', 'meta', 'senders'];
  const sets = [];
  const params = [id];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    params.push(k === 'meta' || k === 'senders' ? JSON.stringify(v) : v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return null;
  const r = await getPool().query(`UPDATE campaign SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return r.rows[0];
}

// active_in_campaign — при заливке (решение Ольги 07.08, E13).
// Канал и волна — параметрами (L2.1/L2.2): touch 'uploaded' раньше жёстко писал 'email',
// а active_batch_id привязывает замок к волне, чтобы вторая ячейка той же волны прошла.
export async function markContactsActive(contactIds, campaignExtId, { channel = 'email', batchId = null } = {}) {
  if (!contactIds.length) return 0;
  const r = await getPool().query(
    `UPDATE contact SET lifecycle = 'active_in_campaign',
        active_batch_id = COALESCE($2, active_batch_id),
        updated_at = now()
     WHERE id = ANY($1::int[]) RETURNING id`,
    [contactIds, batchId ? Number(batchId) : null],
  );
  await getPool().query(
    `INSERT INTO touch (contact_id, channel, campaign_ext_id, event, meta)
     SELECT unnest($1::int[]), $3, $2, 'uploaded', '{"note":"campaign upload"}'::jsonb`,
    [contactIds, String(campaignExtId), channel],
  );
  return r.rowCount;
}

// Zero run: тестовые лиды сохраняются в реестр (фикс 07.08: без контакта не работает петля
// «ответ → классификация → пинг → карточка Inbox»). Помечены source=zero-run — легко почистить.
export async function upsertZeroRunContacts(leads) {
  for (const l of leads) {
    await getPool().query(
      `INSERT INTO contact (identity_key, first_name, last_name, full_name, company, email, email_status, sources, lifecycle)
       VALUES (lower($1), $2, $3, $4, $5, $1, 'valid', '["zero-run"]', 'available')
       ON CONFLICT (identity_key) DO UPDATE SET company = EXCLUDED.company, updated_at = now()`,
      [l.email, l.first_name || null, l.last_name || null,
        `${l.first_name || ''} ${l.last_name || ''}`.trim() || l.email, l.company_name || null],
    );
  }
  return leads.length;
}

// --- Квота catch-all (ТЗ п.31, «Методология валидации адресов» §7) -------------------------
//
// Catch-all — домен, принимающий вообще всё: живость КОНКРЕТНОГО ящика не может установить
// ни один валидатор, это ограничение метода. Выбросить их целиком нельзя — у крупных
// американских корпораций так настроено 20–40% доменов (на нашей первой выборке — 35%).
// Поэтому не запрет, а доля: пакет уменьшается, но не добивается посторонними контактами.
//
// K/(V+K) ≤ q  ⟺  K ≤ V·q/(1−q). При q = 1/3 это ровно «на каждые два валидных — один серый».
export const CATCH_ALL_QUOTA = 1 / 3;

// Серая зона = catch-all И unknown, исчерпавший 3 попытки: трижды не ответивший сервер даёт
// то же знание, что catch-all («домен есть, про ящик не знаем»), значит и риск тот же.
export function isGreyZone(c) {
  const st = String(c.email_status || '').toLowerCase();
  return st === 'catch_all' || (st === 'unknown' && Number(c.email_verify_attempts || 0) >= 3);
}

const sourceCount = (c) => (Array.isArray(c.sources) ? c.sources.length : 0);

/**
 * Раскладывает выбранные контакты на «войдут» и «отложены квотой».
 * forceIds — контакты, которые оператор вернул руками. Это ЗАМЕНА, а не добавка (требование
 * Ольги: «принудительно заменить адреса, если выкинул важные, а неважные включил»): возвращённый
 * занимает место наименее подходящего серого, доля остаётся в пределах квоты. Если возвращённых
 * больше, чем помещается, — квота превышается, и об этом сказано явно (`overQuota`), а не молча.
 */
export function applyCatchAllQuota(contacts, { quota = CATCH_ALL_QUOTA, forceIds = [] } = {}) {
  const force = new Set(forceIds.map(Number));
  const solid = contacts.filter((c) => !isGreyZone(c));
  const grey = contacts.filter(isGreyZone);
  // +1e-9 не косметика: при quota=1/3 выражение quota/(1-quota) даёт 0.49999999999999994,
  // и на 22 валидных floor() отрезал бы 11-й серый контакт «из-за двоичной дроби».
  const maxGrey = Math.floor((solid.length * quota) / (1 - quota) + 1e-9);
  const forced = grey.filter((c) => force.has(Number(c.id)));
  // Отбрасываем наименее подходящих: сначала по fit_score, при равенстве — по числу
  // источников (контакт, найденный и Explee, и Apollo, надёжнее найденного в одном).
  const rest = grey.filter((c) => !force.has(Number(c.id)))
    .sort((a, b) => (Number(b.fit_score || 0) - Number(a.fit_score || 0)) || (sourceCount(b) - sourceCount(a)));
  const room = Math.max(0, maxGrey - forced.length);
  const kept = rest.slice(0, room);
  const deferred = rest.slice(room);
  const included = [...solid, ...forced, ...kept];
  const greyIn = forced.length + kept.length;
  return {
    included,
    deferred,
    quota,
    maxGrey,
    greyTotal: grey.length,
    greyIncluded: greyIn,
    solid: solid.length,
    // Доля серых В ИСХОДНОМ отборе — именно её оператор видит в пояснении («было 41%»).
    shareBefore: contacts.length ? grey.length / contacts.length : 0,
    shareAfter: included.length ? greyIn / included.length : 0,
    overQuota: included.length ? greyIn / included.length > quota + 1e-9 : false,
  };
}

// Отложенные остаются `available` и сами всплывут в следующем пакете (решение Ольги 10.08:
// без отдельной таблицы исключений). Колонка нужна только для бейджа и приоритета среди равных.
export async function markDeferred(contactIds = []) {
  if (!contactIds.length) return 0;
  const r = await getPool().query(
    `UPDATE contact SET last_deferred_at = now() WHERE id = ANY($1::int[])`,
    [contactIds.map(Number)],
  );
  return r.rowCount;
}

// Контакты для расчёта квоты: только то, что нужно правилу, но с полями сортировки.
export async function contactsForQuota(contactIds = []) {
  if (!contactIds.length) return [];
  const r = await getPool().query(
    `SELECT c.id, c.full_name, c.title, c.company, c.email, c.email_status, c.email_verify_attempts,
            c.sources, c.last_deferred_at,
            (SELECT MAX(m.fit_score) FROM contact_segment_match m WHERE m.contact_id = c.id) AS fit_score
     FROM contact c WHERE c.id = ANY($1::int[])`,
    [contactIds.map(Number)],
  );
  return r.rows;
}

// --- Доставляемость: bounce по СВОИМ данным (ТЗ п.29, п.32) --------------------------------
//
// Счётчик Smartlead не используем: на нулевом прогоне он показал 0 при фактических 17%,
// потому что засчитал NDR-уведомления как ответы. Числитель — наши touch с event='bounced'
// (оба пути: вебхук EMAIL_BOUNCE и NDR, распознанный в треде), знаменатель — event='sent'.
//
// Пороги привязаны к АБСОЛЮТНОМУ числу, а не к проценту: при 15–20 письмах в день 4% — это
// один отскок, и немедленный пинг на каждый шум обесценил бы все уведомления за неделю.
export const BOUNCE_FLOOR = 5;        // меньше — только утренний дайджест, что бы ни было в %
export const BOUNCE_ALERT = 0.04;     // сигнал «посмотри»
export const BOUNCE_PAUSE = 0.06;     // автопауза: шкала холодной рассылки — >5% домен режут
export const BOUNCE_MAILBOX = 0.04;   // порог по ящику за 7 дней (в дайджест)

export async function campaignBounceStats(campaignExtId) {
  const r = await getPool().query(
    `SELECT COUNT(*) FILTER (WHERE event = 'sent') AS sent,
            COUNT(*) FILTER (WHERE event = 'bounced') AS bounced,
            COUNT(*) FILTER (WHERE event = 'bounced' AND meta->>'kind' = 'hard') AS hard,
            COUNT(*) FILTER (WHERE event = 'bounced' AND meta->>'kind' = 'soft') AS soft
       FROM touch WHERE campaign_ext_id = $1`,
    [String(campaignExtId)],
  );
  const s = r.rows[0];
  const sent = Number(s.sent) || 0;
  const bounced = Number(s.bounced) || 0;
  const rate = sent ? bounced / sent : 0;
  return {
    sent, bounced, hard: Number(s.hard) || 0, soft: Number(s.soft) || 0, rate,
    // Уровень реакции. Ниже порога по числу отскоков — молчим до утреннего дайджеста.
    level: bounced < BOUNCE_FLOOR ? 'digest'
      : rate >= BOUNCE_PAUSE ? 'pause'
        : rate >= BOUNCE_ALERT ? 'alert' : 'digest',
  };
}

// Сводка за сутки для блока «Доставляемость за вчера» в дайджесте.
// Только email-канал (L2.3): touch LinkedIn-канала (заявки, принятия, импорт истории)
// не должны разбавлять знаменатель bounce rate — это гигиена ПОЧТЫ.
export async function deliverabilityDigest(hours = 24) {
  const p = getPool();
  const totals = (await p.query(
    `SELECT COUNT(*) FILTER (WHERE event = 'sent') AS sent,
            COUNT(*) FILTER (WHERE event = 'bounced') AS bounced,
            COUNT(*) FILTER (WHERE event = 'bounced' AND meta->>'kind' = 'hard') AS hard,
            COUNT(*) FILTER (WHERE event = 'bounced' AND meta->>'kind' = 'soft') AS soft
       FROM touch WHERE channel = 'email' AND occurred_at > now() - ($1 || ' hours')::interval`,
    [String(hours)],
  )).rows[0];
  // Худший ящик считаем за 7 дней: за сутки объёмы слишком малы, чтобы процент что-то значил.
  const worstMailbox = (await p.query(
    `SELECT meta->>'from_email' AS mailbox,
            COUNT(*) FILTER (WHERE event = 'sent') AS sent,
            COUNT(*) FILTER (WHERE event = 'bounced') AS bounced
       FROM touch
      WHERE channel = 'email' AND occurred_at > now() - interval '7 days' AND meta->>'from_email' IS NOT NULL
      GROUP BY 1 HAVING COUNT(*) FILTER (WHERE event = 'sent') > 0
      ORDER BY (COUNT(*) FILTER (WHERE event = 'bounced'))::float
               / NULLIF(COUNT(*) FILTER (WHERE event = 'sent'), 0) DESC NULLS LAST
      LIMIT 1`,
  )).rows[0] || null;
  const worstSource = (await p.query(
    `SELECT (SELECT string_agg(s, '+' ORDER BY s) FROM jsonb_array_elements_text(c.sources) AS s) AS source,
            COUNT(*) AS bounced
       FROM touch t JOIN contact c ON c.id = t.contact_id
      WHERE t.event = 'bounced' AND t.occurred_at > now() - interval '7 days'
      GROUP BY 1 ORDER BY bounced DESC LIMIT 1`,
  )).rows[0] || null;
  const buried = (await p.query(
    `SELECT COUNT(*) AS n FROM contact
      WHERE lifecycle = 'suppressed_forever' AND updated_at > now() - ($1 || ' hours')::interval`,
    [String(hours)],
  )).rows[0].n;
  const sent = Number(totals.sent) || 0;
  const bounced = Number(totals.bounced) || 0;
  return {
    sent, bounced, hard: Number(totals.hard) || 0, soft: Number(totals.soft) || 0,
    rate: sent ? bounced / sent : 0,
    worstMailbox, worstSource, buried: Number(buried) || 0,
  };
}

// --- Пакеты рассылки (Contacts → Campaigns) ---

export async function createBatch({ name, contactIds, segmentId, filters }) {
  const r = await getPool().query(
    `INSERT INTO batch (name, contact_ids, segment_id, filters) VALUES ($1, $2::int[], $3, $4) RETURNING *`,
    [name, contactIds, segmentId || null, JSON.stringify(filters || {})],
  );
  return r.rows[0];
}

// Пакеты с раскладом «сколько ещё свободно»: контакт, ушедший в кампанию, становится
// active_in_campaign и во второй кампании уже не пройдёт — билдер показывает это честно.
export async function listBatches({ limit = 20 } = {}) {
  const r = await getPool().query(
    `SELECT b.*, s.name AS segment_name,
       (SELECT COUNT(*) FROM contact c WHERE c.id = ANY(b.contact_ids)) AS total,
       (SELECT COUNT(*) FROM contact c WHERE c.id = ANY(b.contact_ids) AND c.lifecycle = 'available') AS available,
       (SELECT COUNT(*) FROM campaign cm WHERE (cm.meta->>'batch_id')::int = b.id) AS campaigns
     FROM batch b LEFT JOIN segment s ON s.id = b.segment_id
     ORDER BY b.created_at DESC LIMIT $1`,
    [Math.min(Number(limit) || 20, 50)],
  );
  return r.rows;
}

export async function getBatchContacts(batchId) {
  const r = await getPool().query(
    `SELECT c.id, c.first_name, c.last_name, c.full_name, c.title, c.company, c.company_domain,
            c.location, c.email, c.email_status, c.unique_detail, c.lifecycle,
            -- сегменты контакта: атрибуция ячейки матрицы точнее по КАЖДОМУ лиду,
            -- чем одним полем у кампании (пакет может смешивать сегменты) — решение Ольги 08.08
            (SELECT array_agg(DISTINCT s.name ORDER BY s.name)
               FROM contact_segment_match m JOIN segment s ON s.id = m.segment_id
              WHERE m.contact_id = c.id) AS segment_names
     FROM batch b JOIN contact c ON c.id = ANY(b.contact_ids)
     WHERE b.id = $1 ORDER BY c.id`,
    [Number(batchId)],
  );
  return r.rows;
}

// Inbox: нить переписки по контакту (решение Ольги 08.08 — «пирамидка последовательности»:
// входящие ответы лида и наши исходящие видны вместе, чтобы понимать, ответили уже или нет).
export async function listReplies({ includeClosed = false, includeTest = false } = {}) {
  const conds = [`t.event IN ('replied', 'manual_reply')`];
  // Закрытые разговоры и тестовые треды нулевого прогона по умолчанию скрыты (ТЗ п.25).
  if (!includeClosed) conds.push(`COALESCE(c.conversation_state, 'open') <> 'closed'`);
  if (!includeTest) conds.push(`NOT (c.sources @> '["zero-run"]'::jsonb)`);
  // Импортированная история (L1.3, getsales-import) — прошлое для карантина и аналитики,
  // а не работа для Стаса: 400 исторических `replied` без текста утопили бы ленту.
  conds.push(`COALESCE(t.meta->>'import', '') <> 'true'`);
  const r = await getPool().query(
    `SELECT t.id, t.occurred_at, t.campaign_ext_id, t.event, t.meta, t.channel,
        c.id AS contact_id, c.full_name, c.title, c.company, c.email, c.lifecycle, c.quarantine_until,
        c.conversation_state, c.conversation_outcome, c.deal_stage, c.meeting_at, c.kommo_lead_id,
        (c.sources @> '["zero-run"]'::jsonb) AS is_test
     FROM touch t JOIN contact c ON c.id = t.contact_id
     WHERE ${conds.join(' AND ')}
     ORDER BY t.occurred_at ASC LIMIT 500`,
  );

  const threads = new Map();
  for (const row of r.rows) {
    if (!threads.has(row.contact_id)) {
      threads.set(row.contact_id, {
        contact_id: row.contact_id,
        full_name: row.full_name,
        title: row.title,
        company: row.company,
        email: row.email,
        lifecycle: row.lifecycle,
        quarantine_until: row.quarantine_until,
        conversation_state: row.conversation_state,
        conversation_outcome: row.conversation_outcome,
        deal_stage: row.deal_stage,
        meeting_at: row.meeting_at,
        kommo_lead_id: row.kommo_lead_id,
        is_test: row.is_test,
        campaign_ext_id: row.campaign_ext_id,
        classification: null,
        classified_by: null,   // 'model' | 'human' — происхождение суждения
        channel: row.channel || 'email',   // куда уйдёт ответ (L5.3): email или LinkedIn
        sender_profile_uuid: null,        // чьим аккаунтом ведётся разговор (вопрос Ольги 19.08)
        summary: null,
        late_reply: null,   // ответ пришёл после закрытия кампании — надо видеть в карточке
        last_at: null,
        answered: false,      // последнее сообщение — наше
        reply_touch_id: null, // id последнего входящего: к нему привязана кнопка Reply
        messages: [],
      });
    }
    const th = threads.get(row.contact_id);
    if (row.channel) th.channel = row.channel;
    // Кто ведёт разговор: без этого человек отвечает, не зная, чьим именем он говорит.
    if (row.meta?.sender_profile_uuid) th.sender_profile_uuid = row.meta.sender_profile_uuid;
    const incoming = row.event === 'replied';
    if (row.meta?.late_reply) th.late_reply = row.meta.late_reply;
    th.messages.push({
      id: row.id,
      direction: incoming ? 'in' : 'out',
      at: row.occurred_at,
      text: incoming ? (row.meta?.reply_text || '') : (row.meta?.text || ''),
      classification: incoming ? (row.meta?.classification || null) : null,
    });
    if (incoming) {
      th.classification = row.meta?.classification || th.classification;
      // Кто вынес суждение: модель или человек. Классификация — не факт, а суждение,
      // и на экране обязана называть своё происхождение (L5.12).
      th.classified_by = row.meta?.classified_by || (row.meta?.classification ? 'model' : null);
      th.summary = row.meta?.summary || th.summary;
      th.reply_touch_id = row.id;
      th.campaign_ext_id = row.campaign_ext_id || th.campaign_ext_id;
    }
    th.last_at = row.occurred_at;
    th.answered = !incoming;
  }
  // Свежие треды сверху.
  return [...threads.values()].sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
}

// --- ЖЦ разговора (ТЗ п.25) ---

export async function closeConversation(contactId, outcome = 'dead') {
  const r = await getPool().query(
    `UPDATE contact SET conversation_state = 'closed', conversation_outcome = $2,
       conversation_closed_at = now(), updated_at = now()
     WHERE id = $1 RETURNING id, full_name`,
    [Number(contactId), outcome],
  );
  if (!r.rows.length) throw new Error('contact not found');
  return r.rows[0];
}

export async function reopenConversation(contactId) {
  const r = await getPool().query(
    `UPDATE contact SET conversation_state = 'open', conversation_outcome = NULL,
       conversation_closed_at = NULL, updated_at = now() WHERE id = $1 RETURNING id`,
    [Number(contactId)],
  );
  return r.rows[0] || null;
}

// Встреча назначена: разговор закрывается исходом meeting, контакт уходит из-под автоматики
// (in_conversation — с ним говорит человек), прогресс сделки пишется отдельной осью.
export async function markMeetingScheduled(contactId, { meetingAt = null, kommoLeadId = null }) {
  const r = await getPool().query(
    `UPDATE contact SET deal_stage = 'meeting_scheduled', meeting_at = $2,
       kommo_lead_id = COALESCE($3, kommo_lead_id),
       lifecycle = 'in_conversation',
       conversation_state = 'closed', conversation_outcome = 'meeting',
       conversation_closed_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [Number(contactId), meetingAt, kommoLeadId],
  );
  if (!r.rows.length) throw new Error('contact not found');
  return r.rows[0];
}

export async function setKommoLeadIds(pairs) {
  for (const p of pairs) {
    if (!p.kommoLeadId) continue;
    await getPool().query('UPDATE contact SET kommo_lead_id = $2 WHERE id = $1', [p.contactId, p.kommoLeadId]);
  }
}

// Авто-закрытие: мы ответили, лид молчит дольше N дней → закрываем и возвращаем в обычный ЖЦ
// (карантин 3 мес, как любому неответившему). Неделя выбрана под каденс 0/3/7.
export async function autoCloseStaleConversations(days = 7) {
  const r = await getPool().query(
    `WITH last_msg AS (
       SELECT DISTINCT ON (contact_id) contact_id, event, occurred_at
       FROM touch WHERE event IN ('replied', 'manual_reply')
       ORDER BY contact_id, occurred_at DESC
     )
     UPDATE contact c SET conversation_state = 'closed', conversation_outcome = 'no_reaction',
       conversation_closed_at = now(),
       lifecycle = CASE WHEN c.lifecycle IN ('suppressed_forever', 'in_conversation') THEN c.lifecycle ELSE 'quarantined' END,
       quarantine_until = CASE WHEN c.lifecycle IN ('suppressed_forever', 'in_conversation') THEN c.quarantine_until
                               ELSE now() + interval '3 months' END,
       updated_at = now()
     FROM last_msg m
     WHERE m.contact_id = c.id AND m.event = 'manual_reply'
       AND m.occurred_at < now() - ($1 || ' days')::interval
       AND COALESCE(c.conversation_state, 'open') <> 'closed'
     RETURNING c.id, c.full_name`,
    [String(days)],
  );
  return r.rows;
}

// Треды, ждущие ответа дольше N часов — основа утреннего дайджеста.
export async function waitingConversations(hours = 24) {
  const r = await getPool().query(
    `WITH last_msg AS (
       SELECT DISTINCT ON (contact_id) contact_id, event, occurred_at, meta
       FROM touch WHERE event IN ('replied', 'manual_reply')
         -- Импортированная история (getsales-import) — не «ждущий ответа» тред:
         -- иначе первый же дайджест закричал бы про 400 исторических диалогов.
         AND COALESCE(meta->>'import', '') <> 'true'
       ORDER BY contact_id, occurred_at DESC
     )
     SELECT c.id, c.full_name, c.company, c.email, m.occurred_at, m.meta->>'classification' AS classification
     FROM last_msg m JOIN contact c ON c.id = m.contact_id
     WHERE m.event = 'replied'
       AND COALESCE(c.conversation_state, 'open') <> 'closed'
       AND NOT (c.sources @> '["zero-run"]'::jsonb)
       AND m.occurred_at < now() - ($1 || ' hours')::interval
     ORDER BY m.occurred_at ASC`,
    [String(hours)],
  );
  return r.rows;
}

// Алерт «письма не уходят»: кампании active без единого touch sent спустя сутки после старта.
// Только email-ячейки (L2.3): у LinkedIn-лестницы события другие ('connection_sent'),
// её аналог алерта появится вместе с каналом (этап L3).
export async function campaignsWithoutSends() {
  const r = await getPool().query(
    `SELECT c.id, c.external_id, c.started_at FROM campaign c
     WHERE c.status = 'active' AND COALESCE(c.channel, 'email') = 'email'
       AND c.started_at < now() - interval '24 hours'
       AND NOT EXISTS (
         SELECT 1 FROM touch t WHERE t.campaign_ext_id = c.external_id AND t.event = 'sent'
       )`,
  );
  return r.rows;
}

// --- Мягкое резервирование контактов за оператором (ТЗ п.37, вопрос Стаса) ------------------
export const RESERVE_DAYS = 3;

/** Ставится при сборке пакета: пакет и есть «черновик кампании», отдельной сущности нет. */
/**
 * Кого НЕЛЬЗЯ класть в новый пакет. Жёсткая защита (решение Ольги 13.08): «кто первый
 * сформировал пакет, того и тапки». Раньше это была видимая пометка, но полагаться на то,
 * что операторы договорятся между собой, нельзя — цена ошибки слишком велика.
 *
 * Второй довод, не про вежливость: если контакт попал в два пакета, размер пакета перестаёт
 * сходиться с размером отправки, и аналитика по кампании врёт.
 *
 * Свой собственный резерв не мешает: пересобрать свой же пакет — нормально.
 */
export async function unavailableForBatch(contactIds = [], actor = null) {
  if (!contactIds.length) return [];
  const r = await getPool().query(
    `SELECT id, full_name, email, lifecycle, quarantine_until, reserved_by, reserved_until
       FROM contact
      WHERE id = ANY($1::int[])
        AND (lifecycle <> 'available'
             OR (reserved_by IS NOT NULL AND reserved_until > now() AND reserved_by IS DISTINCT FROM $2))`,
    [contactIds.map(Number), actor || '—'],
  );
  return r.rows.map((c) => ({
    id: c.id,
    name: c.full_name || c.email,
    reason: c.lifecycle === 'active_in_campaign' ? 'already active in another campaign'
      : c.lifecycle === 'in_conversation' ? 'a person is talking to them — a meeting is scheduled'
      : c.lifecycle === 'quarantined' ? `in quarantine until ${c.quarantine_until ? String(c.quarantine_until).slice(0, 10) : '—'}`
      : c.lifecycle === 'suppressed_forever' ? 'suppressed (unsubscribe / hard bounce)'
      : c.reserved_by ? `held in ${c.reserved_by}'s unsent batch until ${String(c.reserved_until).slice(0, 10)}`
      : `not available (${c.lifecycle})`,
  }));
}

export async function reserveContacts(contactIds = [], actor, batchId) {
  if (!contactIds.length) return 0;
  const r = await getPool().query(
    `UPDATE contact
        SET reserved_by = $2, reserved_until = now() + ($3 || ' days')::interval, reserved_batch_id = $4
      WHERE id = ANY($1::int[])`,
    [contactIds.map(Number), actor || 'unknown', String(RESERVE_DAYS), batchId ? Number(batchId) : null],
  );
  return r.rowCount;
}

/** Снимается при запуске: дальше контакт защищён статусом active_in_campaign. */
export async function releaseReservation(contactIds = []) {
  if (!contactIds.length) return 0;
  const r = await getPool().query(
    `UPDATE contact SET reserved_by = NULL, reserved_until = NULL, reserved_batch_id = NULL
      WHERE id = ANY($1::int[])`,
    [contactIds.map(Number)],
  );
  return r.rowCount;
}

/**
 * Состояние контактов реестра по адресам — для выдачи поиска (вопрос Стаса 11.08:
 * «как мне увидеть, что мы уже находили контакты» и «если им уже что-то отправили,
 * зачем ты мне их показываешь»). Зелёного бейджа «в реестре» мало: нужна история.
 */
export async function registryStateByEmail(emails = [], slugs = []) {
  if (!emails.length && !slugs.length) return {};
  // Матчим и по slug (L5.7): LinkedIn-only человек (в т.ч. весь импорт истории GetSales)
  // по email не находится — и его история молча не показывалась. Молчаливого отсева не бывает.
  const r = await getPool().query(
    `SELECT lower(c.email) AS email, c.linkedin_slug, c.id, c.lifecycle, c.quarantine_until, c.email_status,
            c.reserved_by, c.reserved_until,
            (SELECT max(t.occurred_at) FROM touch t WHERE t.contact_id = c.id AND t.event = 'sent') AS last_sent,
            EXISTS (SELECT 1 FROM touch t WHERE t.contact_id = c.id AND t.event = 'replied') AS replied,
            -- Последнее LinkedIn-касание: заявка/сообщение закрывают канал на 3 месяца (П4а),
            -- и выдача обязана показывать это ДО сборки пакета, а не на pre-flight.
            li.occurred_at AS last_linkedin, li.event AS last_linkedin_event
       FROM contact c
       LEFT JOIN LATERAL (
         SELECT t.occurred_at, t.event FROM touch t
          WHERE t.contact_id = c.id AND t.channel = 'linkedin'
            AND t.event IN ('connection_sent', 'message_sent')
          ORDER BY t.occurred_at DESC LIMIT 1
       ) li ON true
      WHERE lower(c.email) = ANY($1::text[]) OR c.linkedin_slug = ANY($2::text[])`,
    [emails.map((e) => String(e).trim().toLowerCase()), slugs.filter(Boolean)],
  );
  // Ключуем и по адресу, и по slug — выдача ищет тем ключом, который у строки есть.
  const out = {};
  for (const x of r.rows) {
    if (x.email) out[x.email] = x;
    if (x.linkedin_slug) out[`li:${x.linkedin_slug}`] = x;
  }
  return out;
}

// Окно дозревания ответов (решение Ольги 11.08). «Кампания завершена» ≠ «последнее письмо
// отправлено»: ответы на холодное письмо приходят в основном в первые 2–3 дня, хвост тянется
// до двух недель. Закрыть сразу после отправки значит пометить как «не ответил» человека,
// чей ответ ещё в пути, — и потом учить на этом рекомендательный слой.
// Ждать почти ничего не стоит: карантин всё равно 3 месяца, неделя роли не играет.
export const REPLY_MATURATION_DAYS = 7;

/**
 * Кампании, готовые к закрытию: запущены, ещё не закрыты, и с ПОСЛЕДНЕЙ ФАКТИЧЕСКОЙ отправки
 * прошло больше окна дозревания. Отсчёт от последнего письма, а не от статуса COMPLETED:
 * статус говорит «больше не пошлём», но дата ответа считается от письма.
 */
export async function openCampaignsToCheck(maturationDays = REPLY_MATURATION_DAYS) {
  const r = await getPool().query(
    `SELECT c.id, c.external_id, s.last_sent,
            EXTRACT(DAY FROM now() - s.last_sent)::int AS days_since_last_send
       FROM campaign c
       JOIN LATERAL (
         SELECT max(t.occurred_at) AS last_sent FROM touch t
          WHERE t.campaign_ext_id = c.external_id AND t.event = 'sent'
       ) s ON true
      WHERE c.external_id IS NOT NULL AND c.closed_at IS NULL
        AND s.last_sent IS NOT NULL
        AND s.last_sent < now() - ($1 || ' days')::interval
      ORDER BY s.last_sent LIMIT 50`,
    [String(maturationDays)],
  );
  return r.rows;
}
