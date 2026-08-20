// Синхронизация LinkedIn-ячеек с GetSales (L3.3–L3.5): поллер markers → touch,
// маршрутизация ответов, оркестратор сообщений №1 и фоллоуапа.
//
// Почему поллер, а не только вебхуки: payload вебхуков GetSales ещё не снят (настройка в UI,
// хвост L0.5), а лестница должна быть видна в наших touch с первого дня. Вебхук, когда
// появится, станет быстрым триггером той же синхронизации — источник правды один.
//
// Дисциплина отправки (правила §1.2, критерий приёмки №3): сообщение уходит ТОЛЬКО лиду
// с принятой заявкой, от ТОГО ЖЕ профиля, что слал заявку, в рабочие часы ET и в пределах
// дневного лимита профиля. Холодный DM не-контакту невозможен как класс.
import { getPool } from './db/registry.js';
import { getState, setState } from './db/state.js';
import { classifyReply, NON_NEGATIVE, compressDetail } from './classify.js';
import { sendTelegram } from './notify.js';
import { kommoEnabled, moveLeadToInitialContact } from './kommo.js';
import { writeAudit } from './db/users.js';
import * as gs from './getsales.js';
import * as smartlead from './smartlead.js';

// --- Конфиг канала (Settings, ключи app_state) -------------------------------------------------
// getsales_sender_flows: {senderProfileUuid: flowUuid} — флоу-лестница КАЖДОГО отправителя
//   (разовое клонирование «Connect» в UI; ротацию GetSales не используем — распределение
//   по Value требует выбирать отправителя на лида, и это делается выбором флоу).
// getsales_limits: {default: {invites: 10, messages: 20}, <profileUuid>: {…}} — дневные потолки.
// getsales_accept_window: дней ожидания принятия заявки (решение 13.08: старт 21; параметр,
//   а не константа — снизим до 14, когда метрика поздних принятий покажет, что хвост пуст).
export async function channelConfig() {
  const flows = JSON.parse(await getState('getsales_sender_flows') || '{}');
  const limits = JSON.parse(await getState('getsales_limits') || '{}');
  return {
    senderFlows: flows, limits,
    defaultMessages: Number(limits.default?.messages) || 20,
    acceptWindowDays: Number(await getState('getsales_accept_window')) || 21,
  };
}

export async function saveChannelConfig({ senderFlows, limits, acceptWindowDays }) {
  if (senderFlows) await setState('getsales_sender_flows', JSON.stringify(senderFlows));
  if (limits) await setState('getsales_limits', JSON.stringify(limits));
  if (acceptWindowDays) await setState('getsales_accept_window', String(Math.max(1, Number(acceptWindowDays) || 21)));
  return channelConfig();
}

/**
 * Метрика поздних принятий (L5.4, решение Ольги 13.08): доля заявок, принятых ПОЗЖЕ 14 дней.
 * Это основание для снижения окна с 21 до 14: если хвост 14+ пуст на нескольких кампаниях —
 * неделя ожидания ничего не ловит. Импорт истории исключён: там нет пары «заявка → принятие».
 */
export async function lateAcceptStats() {
  const r = await getPool().query(
    `WITH sent AS (
       SELECT contact_id, min(occurred_at) AS at FROM touch
        WHERE channel = 'linkedin' AND event = 'connection_sent'
          AND COALESCE(meta->>'import', '') <> 'true'
        GROUP BY contact_id),
     acc AS (
       SELECT contact_id, min(occurred_at) AS at FROM touch
        WHERE channel = 'linkedin' AND event = 'accepted'
        GROUP BY contact_id)
     SELECT COUNT(*)::int AS accepted,
            COUNT(*) FILTER (WHERE acc.at - sent.at > interval '14 days')::int AS late
       FROM sent JOIN acc USING (contact_id)`,
  );
  const { accepted, late } = r.rows[0];
  return { accepted, late, share: accepted ? late / accepted : null };
}

/**
 * Ручная отметка «заявка принята» (17.08, нулевой прогон).
 *
 * Зачем: маркеры GetSales — единственный автоматический источник принятия, и они живут,
 * пока лид В ПОТОКЕ. Ветка «Connected → End Automation» завершает поток в тот же момент,
 * когда человек принял, — лид выходит из потока, `markers` и `flows` пустеют, и часовой
 * поллер физически не успевает увидеть `accepted`. Пока не подключены вебхуки (L0.5) или
 * не переделан хвост потока, человек видит принятие в GetSales глазами — и система обязана
 * уметь принять этот факт от него, а не молчать. Запись идёт тем же путём, что автомат:
 * touch `accepted` c gs_key, поэтому повтор идемпотентен, а последующий синк сам отправит №1.
 */
export async function markAcceptedByHand({ leadUuid, actor = 'unknown' }) {
  if (!leadUuid) throw new Error('нужен lead_uuid');
  const camps = await openLinkedinCampaigns();
  for (const camp of camps) {
    const contactId = camp.meta?.getsales?.lead_map?.[leadUuid];
    if (!contactId) continue;
    const sender = camp.meta?.getsales?.assignment?.[contactId]
      || (await getPool().query(
        `SELECT meta->>'sender_profile_uuid' AS s FROM touch
          WHERE channel = 'linkedin' AND meta->>'lead_uuid' = $1 AND event = 'connection_sent' LIMIT 1`,
        [leadUuid],
      )).rows[0]?.s;
    if (!sender) throw new Error('не знаем, какой профиль слал заявку этому лиду');
    const written = await upsertTouch({
      contactId, listUuid: camp.external_id, event: 'accepted', at: null,
      meta: { lead_uuid: leadUuid, sender_profile_uuid: sender, by: 'manual', actor },
    });
    return { contactId, campaignId: camp.id, sender, written: Boolean(written) };
  }
  throw new Error('лид не найден ни в одной открытой LinkedIn-ячейке');
}

/**
 * Починка ложной записи об отправке (17.08). До исправления контракта мы писали
 * `message_sent` по факту ответа 201, а GetSales создавал пустую запись и ничего не слал —
 * в системе «отправлено», у человека в чате пусто. Два режима:
 *   • messageUuid передан — отправка ДЕЙСТВИТЕЛЬНО состоялась (проверена глазами или руками):
 *     переставляем время на сейчас и привязываем uuid сообщения GetSales;
 *   • messageUuid не передан — запись ложная: удаляем, и оркестратор отправит заново.
 * Время важно не меньше факта: от него считается пауза до фоллоуапа.
 */
export async function repairSendTouch({ leadUuid, event = 'message_sent', messageUuid = null, actor = 'unknown' }) {
  if (!leadUuid) throw new Error('нужен lead_uuid');
  if (!['message_sent', 'message_followup'].includes(event)) throw new Error('event: message_sent | message_followup');
  if (messageUuid) {
    const r = await getPool().query(
      `UPDATE touch SET occurred_at = now(),
              meta = meta || jsonb_build_object('gs_message_uuid', $3::text, 'repaired_by', $4::text)
        WHERE channel = 'linkedin' AND event = $2 AND meta->>'lead_uuid' = $1
        RETURNING id, occurred_at`,
      [leadUuid, event, messageUuid, actor],
    );
    return { mode: 'restamped', rows: r.rowCount, at: r.rows[0]?.occurred_at };
  }
  const r = await getPool().query(
    `DELETE FROM touch WHERE channel = 'linkedin' AND event = $2 AND meta->>'lead_uuid' = $1 RETURNING id`,
    [leadUuid, event],
  );
  return { mode: 'deleted', rows: r.rowCount };
}

// Рабочие часы канала: будни, 09–18 по Нью-Йорку (решение П9 — старт аккуратный).
export function withinWorkingHours(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = et.getDay();
  return dow >= 1 && dow <= 5 && et.getHours() >= 9 && et.getHours() < 18;
}

const gsKey = (leadUuid, event) => `gs:${leadUuid}:${event}`;

// Идемпотентная запись события лестницы (тот же принцип, что у импорта истории L1.3).
async function upsertTouch({ contactId, listUuid, event, at, meta = {} }) {
  const key = gsKey(meta.lead_uuid, event);
  const r = await getPool().query(
    `INSERT INTO touch (contact_id, channel, campaign_ext_id, event, occurred_at, meta)
     SELECT $1, 'linkedin', $2, $3, COALESCE($4::timestamptz, now()), $5::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM touch WHERE meta->>'gs_key' = $6)
     RETURNING id`,
    [contactId, listUuid, event, at || null, JSON.stringify({ ...meta, gs_key: key }), key],
  );
  return r.rowCount;
}

// Открытые LinkedIn-ячейки: external_id = list_uuid списка GetSales.
async function openLinkedinCampaigns() {
  const r = await getPool().query(
    `SELECT c.id, c.external_id, c.meta, c.message_angle_id, ma.linkedin AS angle_linkedin
       FROM campaign c LEFT JOIN message_angle ma ON ma.id = c.message_angle_id
      WHERE c.channel = 'linkedin' AND c.status = 'active' AND c.external_id IS NOT NULL`,
  );
  return r.rows;
}

// Число сообщений, отправленных профилем сегодня (наши touch — источник правды).
async function sentTodayBySender(senderProfileUuid) {
  const r = await getPool().query(
    `SELECT COUNT(*) AS n FROM touch
      WHERE channel = 'linkedin' AND event IN ('message_sent', 'message_followup')
        AND meta->>'sender_profile_uuid' = $1
        AND occurred_at > date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'`,
    [senderProfileUuid],
  );
  return Number(r.rows[0].n) || 0;
}

// Подстановка переменных LinkedIn-шаблона (та же семантика, что в превью писем).
function renderTemplate(body, contact, detailShort = '') {
  const vars = {
    first_name: contact.first_name || (contact.full_name || '').split(' ')[0] || 'there',
    company_name: (contact.company || '').replace(/,?\s+(Inc\.?|LLC|Ltd\.?|Corp\.?)$/i, ''),
    unique_detail_short: detailShort,
  };
  return String(body || '')
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '')
    .replace(/\{([^{}|]+)\|[^{}]*\}/g, '$1')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Сверка отправок с провайдером (L5.11, урок 17.08).
 *
 * Наша запись «сообщение отправлено» — это НАМЕРЕНИЕ, а не факт: 14.08 система записала
 * отправку, GetSales ответил 201, и ничего не ушло. Поэтому каждую нашу отправку сверяем
 * со списком сообщений провайдера и проставляем в touch.meta признак факта:
 *   delivery = confirmed  — сообщение найдено у провайдера со статусом done;
 *   delivery = pending    — найдено, но ещё не доставлено (new/в очереди);
 *   delivery = missing    — у провайдера такого сообщения НЕТ (наш рапорт в пустоту).
 * `missing` — это алерт, а не статистика: он означает, что человек ничего не получил,
 * а система считает, что общение состоялось.
 */
export async function reconcileSends() {
  const out = { checked: 0, confirmed: 0, pending: 0, missing: [] };
  if (!gs.getsalesEnabled()) return out;
  const ours = await getPool().query(
    `SELECT id, contact_id, event, occurred_at, meta->>'lead_uuid' AS lead_uuid,
            meta->>'gs_message_uuid' AS msg_uuid, meta->>'delivery' AS delivery
       FROM touch
      WHERE channel = 'linkedin' AND event IN ('message_sent', 'message_followup')
        AND COALESCE(meta->>'delivery', '') <> 'confirmed'
        AND COALESCE(meta->>'import', '') <> 'true'`,
  );
  if (!ours.rows.length) return out;
  const provider = await gs.recentMessages({ depth: 600 }).catch(() => []);
  // ⚠️ Фильтры у эндпоинта декоративны (проверено ложным ключом) — сопоставляем сами.
  const byUuid = new Map(provider.map((m) => [m.uuid, m]));
  const byLead = new Map();
  for (const m of provider) {
    if (m.type !== 'outbox') continue;
    const list = byLead.get(m.lead_uuid) || [];
    list.push(m); byLead.set(m.lead_uuid, list);
  }
  for (const row of ours.rows) {
    out.checked += 1;
    const hit = (row.msg_uuid && byUuid.get(row.msg_uuid))
      || (byLead.get(row.lead_uuid) || []).find((m) => new Date(m.created_at) >= new Date(new Date(row.occurred_at).getTime() - 36e5));
    // Свежую отправку не объявляем потерянной: провайдер отдаёт её списком не мгновенно.
    const fresh = Date.now() - new Date(row.occurred_at).getTime() < 15 * 60e3;
    const state = hit ? (hit.status === 'done' ? 'confirmed' : 'pending') : (fresh ? 'pending' : 'missing');
    if (state === 'confirmed') out.confirmed += 1;
    else if (state === 'pending') out.pending += 1;
    else out.missing.push({ touchId: row.id, contactId: row.contact_id, event: row.event, at: row.occurred_at });
    await getPool().query(
      `UPDATE touch SET meta = meta || jsonb_build_object('delivery', $2::text, 'delivery_checked_at', now()::text,
              'gs_message_uuid', COALESCE(meta->>'gs_message_uuid', $3::text))
        WHERE id = $1`,
      [row.id, state, hit?.uuid || null],
    );
  }
  if (out.missing.length) {
    console.error(`[getsales:reconcile] ⚠️ ${out.missing.length} отправок нет у провайдера — люди ничего не получили`);
    await sendTelegram(`⚠️ LinkedIn: ${out.missing.length} сообщений записаны как отправленные, но провайдер их не знает — получатели ничего не получили. Проверьте ленту касаний.`).catch(() => {});
  }
  return out;
}

/**
 * Один проход синхронизации по всем открытым LinkedIn-ячейкам:
 *   1) markers → touch (connection_sent / accepted / message_sent);
 *   2) входящие ответы → классификация → пинг → Inbox → Kommo (канал 'linkedin');
 *   3) оркестратор: принявшим — сообщение №1; замолчавшим после №1 — фоллоуап.
 * Вызывается из dailyMaintenance (раз в час) и вебхуком GetSales как немедленный триггер.
 */
export async function syncLinkedinCampaigns({ send = true } = {}) {
  if (!gs.getsalesEnabled()) return { skipped: 'no token' };
  const campaigns = await openLinkedinCampaigns();
  const out = { campaigns: campaigns.length, touches: 0, replies: 0, sent: 0, errors: [], pending: [] };
  if (!campaigns.length) return out;
  const cfg = await channelConfig();

  // Свежие сообщения провайдера — один раз на проход. Из них берём и входящие ответы,
  // и подтверждение доставки. Фильтр по лиду эндпоинт игнорирует — раскладываем сами.
  const providerByLead = new Map();
  for (const m of await gs.recentMessages({ depth: 600 }).catch(() => [])) {
    const list = providerByLead.get(m.lead_uuid) || [];
    list.push(m); providerByLead.set(m.lead_uuid, list);
  }

  for (const camp of campaigns) {
    let leads;
    try { leads = await gs.leadsOfList(camp.external_id); } catch (e) {
      out.errors.push(`list ${camp.external_id}: ${e.message}`); continue;
    }
    const leadMap = camp.meta?.getsales?.lead_map || {}; // lead_uuid → contact_id

    for (const row of leads) {
      const lead = row.lead || row;
      const leadUuid = lead.uuid;
      const contactId = leadMap[leadUuid];
      if (!contactId) continue; // не наш лид (страховка: список наш, но правило явное)

      // 1) события лестницы из markers
      const events = gs.ladderEventsFromMarkers(row.markers || []);
      for (const ev of events) {
        out.touches += await upsertTouch({
          contactId, listUuid: camp.external_id, event: ev.event, at: ev.at,
          meta: { lead_uuid: leadUuid, sender_profile_uuid: ev.senderProfileUuid },
        });
      }

      // 1а) Подтверждение отправки МАРКЕРОМ провайдера. Список сообщений — не единственный
      // источник и, как выяснилось 19.08, ненадёжный для свежих: коллекция в 17 000+ записей
      // отсортирована не по времени, и сообщение, отправленное час назад, может не найтись
      // даже в хвосте из 2 000. Маркер `linkedin_first_message_sent_at` — собственная запись
      // GetSales о факте отправки, и она появляется сразу. Без этого сверка объявляла
      // доставленное сообщение «пропавшим» — ложная тревога хуже её отсутствия.
      if (events.some((e) => e.event === 'message_sent')) {
        await getPool().query(
          `UPDATE touch SET meta = meta || jsonb_build_object('delivery', 'confirmed',
                  'delivery_source', 'provider_marker', 'delivery_checked_at', now()::text)
            WHERE channel = 'linkedin' AND event = 'message_sent'
              AND meta->>'lead_uuid' = $1
              AND COALESCE(meta->>'delivery', '') <> 'confirmed'`,
          [leadUuid],
        ).catch(() => {});
      }

      // 2а) входящий ответ ИЗ СПИСКА СООБЩЕНИЙ провайдера — источник, не зависящий от того,
      // жив ли поток. Маркеры живут, пока лид в автоматизации: Пётр ответил 18.08, а его поток
      // завершился ещё при принятии заявки, счётчик входящих остался нулевым — ответ человека
      // система не увидела бы вовсе. Ответ клиента терять нельзя ни при каких условиях.
      const inboundMsgs = (providerByLead.get(leadUuid) || []).filter((m) => m.type === 'inbox');
      if (inboundMsgs.length) {
        const first = inboundMsgs
          .sort((a, b) => String(a.sent_at || a.created_at).localeCompare(String(b.sent_at || b.created_at)))[0];
        const isNew = await upsertTouch({
          contactId, listUuid: camp.external_id, event: 'replied', at: first.sent_at || first.created_at || null,
          meta: { lead_uuid: leadUuid, by: 'provider_inbox', text: String(first.text || '').slice(0, 500) },
        });
        if (isNew) { out.replies += 1; await routeLinkedinReply({ contactId, leadUuid, listUuid: camp.external_id }); }
      }

      // 2б) Долив текста в УЖЕ записанный ответ. Запись `replied` идемпотентна по gs_key,
      // поэтому первый проход (когда текста ещё не было видно) фиксировал пустую строку
      // навсегда, и классификатору было нечего читать — «текст не считался» и у Петра,
      // и у Ольги. Теперь текст доливается, а суждение пересчитывается: пустой ответ
      // классифицировать нельзя, и держать вечное `unclear` из-за нашей же гонки — враньё.
      if (inboundMsgs.length) {
        const newest = inboundMsgs
          .sort((a, b) => String(b.sent_at || b.created_at).localeCompare(String(a.sent_at || a.created_at)))[0];
        const body = String(newest?.text || '').trim();
        if (body) {
          const row = (await getPool().query(
            `SELECT id, meta->>'text' AS text, meta->>'classification' AS cls, meta->>'classified_by' AS by
               FROM touch WHERE channel = 'linkedin' AND event = 'replied'
                AND meta->>'lead_uuid' = $1 ORDER BY occurred_at DESC LIMIT 1`,
            [leadUuid],
          )).rows[0];
          if (row) {
            // Долив текста и пересчёт суждения — ДВА НЕЗАВИСИМЫХ условия. Сначала я связала
            // их одним `if`, и получилось: текст долился в первом проходе, а «unclear»,
            // вынесенный по пустоте, остался навсегда — ветка больше не выполнялась.
            if (!String(row.text || '').trim()) {
              await getPool().query(
                `UPDATE touch SET meta = meta || jsonb_build_object('text', $2::text, 'reply_text', $3::text,
                        'text_source', 'provider_inbox') WHERE id = $1`,
                [row.id, body.slice(0, 500), body.slice(0, 2000)],
              );
            }
            // Суждение, вынесенное по пустому тексту, ничего не стоит — пересчитываем,
            // если его не ставил человек.
            if (row.by !== 'human' && (!row.cls || row.cls === 'unclear')) {
              const contact = (await getPool().query('SELECT * FROM contact WHERE id = $1', [contactId])).rows[0];
              const verdict = await classifyReply({
                text: body, contactName: contact?.full_name || '', company: contact?.company || '',
              }).catch(() => null);
              // ⚠️ classifyReply возвращает поле `label`, а не `classification` — я написала
              // второе, условие никогда не выполнялось, и пересчёт молча не происходил.
              // Суждение оставалось «текст не считался» при уже считанном тексте.
              if (verdict?.label && verdict.label !== 'unclear') {
                await getPool().query(
                  `UPDATE touch SET meta = meta || jsonb_build_object('classification', $2::text,
                          'summary', $3::text, 'classified_by', 'model') WHERE id = $1`,
                  [row.id, verdict.label, String(verdict.summary || '').slice(0, 500)],
                );
                out.touches += 1;
              }
            }
          }
        }
      }

      // 2) входящий ответ: агрегатный маркер несёт inbox-счётчик
      const inbox = Math.max(0, ...(row.markers || []).map((m) => m?.linkedin_messages_inbox_count || 0));
      if (inbox > 0) {
        // Маркер несёт только СЧЁТЧИК входящих, без текста — классификатору нечего читать
        // («текст не считался», 18.08). Текст добираем из списка сообщений провайдера:
        // там он есть, и обе дороги ведут к одному факту.
        const inboundText = (providerByLead.get(leadUuid) || [])
          .filter((m) => m.type === 'inbox')
          .sort((a, b) => String(b.sent_at || b.created_at).localeCompare(String(a.sent_at || a.created_at)))[0]?.text || '';
        const isNew = await upsertTouch({
          contactId, listUuid: camp.external_id, event: 'replied', at: null,
          meta: { lead_uuid: leadUuid, inbox_count: inbox, by: 'marker_count',
            ...(inboundText ? { text: inboundText.slice(0, 500), reply_text: inboundText.slice(0, 2000) } : {}) },
        });
        if (isNew) { out.replies += 1; await routeLinkedinReply({ contactId, leadUuid, listUuid: camp.external_id }); }
      }

      // 3) оркестратор сообщений — только если у захода есть LinkedIn-часть.
      // Каждый отказ отправлять НАЗЫВАЕТ СЕБЯ (out.pending): «волна стоит и молчит»
      // — та же болезнь, что молчаливый отсев лидов (вопрос Ольги 17.08: «почему
      // не отправили, если он принял?»). Ответ обязан быть в ответе синка.
      const stall = (waiting) => out.pending.push({ lead: leadUuid, contact: contactId, waiting });
      if (!send) { stall('sync called in read-only mode'); continue; }
      if (!camp.angle_linkedin?.message1?.body) { stall('angle has no LinkedIn message #1 — draft it in the angle editor'); continue; }
      if (inbox > 0) { stall('lead replied — the orchestrator stands down, a human answers from Inbox'); continue; }

      // Принятие: сначала маркеры, затем наша история, затем фолбэк по диалогу.
      // Фолбэк добавлен 17.08 (нулевой прогон): GetSales может НЕ проставить маркер
      // accepted вовсе — флоу показывал «Accepted 1», а markers лида три дня пустые.
      // Надёжный признак принятия — существование треда: LinkedIn создаёт диалог
      // только между соединёнными людьми (InMail мы не используем).
      let accepted = events.find((e) => e.event === 'accepted');
      if (!accepted) {
        const prior = await getPool().query(
          `SELECT meta->>'sender_profile_uuid' AS sender, occurred_at FROM touch
            WHERE channel = 'linkedin' AND meta->>'lead_uuid' = $1 AND event = 'accepted' LIMIT 1`,
          [leadUuid],
        );
        if (prior.rows.length) {
          accepted = { event: 'accepted', at: prior.rows[0].occurred_at, senderProfileUuid: prior.rows[0].sender };
        }
        // ⚠️ Фолбэк «есть диалог → значит принял» ОТОЗВАН 17.08, прожив час на проде.
        // Проверка живым вызовом: `GET /flows/api/linkedin-conversations?lead_uuid=…`
        // ИГНОРИРУЕТ фильтр и возвращает все диалоги аккаунта (20 штук на любой uuid,
        // включая несуществующий). На боевой волне это пометило бы принявшими ВСЕХ,
        // кому ушла заявка, и разослало бы сообщения людям, которые нас не пускали.
        // Урок в копилку к «attach не сработал»: у GetSales параметр в query — не гарантия
        // фильтрации; любой новый источник события проверяем заведомо ложным ключом.
      }
      // критерий №3: без принятой заявки сообщений не бывает (холодный DM невозможен).
      // Формулировка обязана отражать то, что мы ЗНАЕМ: раньше здесь всегда писалось
      // «заявка отправлена, ждём принятия» — даже когда заявки ещё не было и лестница
      // только шла у GetSales. Система не имеет права утверждать факт, которого не знает
      // (поймано Ольгой 18.08: «по каким признакам ты решил, что запрос отправлен?»).
      if (!accepted) {
        const invited = events.some((e) => e.event === 'connection_sent')
          || (await getPool().query(
            `SELECT 1 FROM touch WHERE channel = 'linkedin' AND event = 'connection_sent'
              AND meta->>'lead_uuid' = $1 LIMIT 1`, [leadUuid],
          )).rowCount > 0;
        stall(invited
          ? 'invite sent, not accepted yet'
          : 'GetSales has not sent the invite yet — the ladder is still running on their side');
        continue;
      }
      if (!withinWorkingHours()) { stall('outside the sending window (Mon–Fri 9:00–18:00 New York)'); continue; }

      const sender = accepted.senderProfileUuid;
      const already = await getPool().query(
        `SELECT event, occurred_at FROM touch
          WHERE channel = 'linkedin' AND meta->>'lead_uuid' = $1
            AND event IN ('message_sent', 'message_followup')`,
        [leadUuid],
      );
      const hasM1 = already.rows.some((r) => r.event === 'message_sent');
      const hasFu = already.rows.some((r) => r.event === 'message_followup');

      try {
        if (!hasM1) {
          const cap = Number(cfg.limits[sender]?.messages) || cfg.defaultMessages;
          if (await sentTodayBySender(sender) >= cap) { stall(`daily message ceiling reached for this profile (${cap}/day) — resumes tomorrow`); continue; }
          const contact = (await getPool().query('SELECT * FROM contact WHERE id = $1', [contactId])).rows[0];
          const text = renderTemplate(camp.angle_linkedin.message1.body, contact);
          const msg = await gs.sendMessage(sender, leadUuid, text);
          await upsertTouch({
            contactId, listUuid: camp.external_id, event: 'message_sent', at: null,
            meta: { lead_uuid: leadUuid, sender_profile_uuid: sender, by: 'orchestrator',
              gs_message_uuid: msg?.uuid || null, text: text.slice(0, 500) },
          });
          out.sent += 1;
        } else if (!hasFu && camp.angle_linkedin.followup?.body) {
          const m1at = new Date(already.rows.find((r) => r.event === 'message_sent').occurred_at);
          const waitDays = Number(camp.angle_linkedin.followup.wait_days) || 3;
          const due = new Date(m1at.getTime() + waitDays * 864e5);
          if (Date.now() < due.getTime()) { stall(`message #1 sent — follow-up due ${due.toISOString().slice(0, 10)}`); continue; }
          const cap = Number(cfg.limits[sender]?.messages) || cfg.defaultMessages;
          if (await sentTodayBySender(sender) >= cap) { stall(`daily message ceiling reached for this profile (${cap}/day) — resumes tomorrow`); continue; }
          const contact = (await getPool().query('SELECT * FROM contact WHERE id = $1', [contactId])).rows[0];
          const detail = contact.unique_detail ? await compressDetail(contact.unique_detail).catch(() => '') : '';
          const text = renderTemplate(camp.angle_linkedin.followup.body, contact, detail);
          const msg = await gs.sendMessage(sender, leadUuid, text);
          await upsertTouch({
            contactId, listUuid: camp.external_id, event: 'message_followup', at: null,
            meta: { lead_uuid: leadUuid, sender_profile_uuid: sender, by: 'orchestrator',
              gs_message_uuid: msg?.uuid || null, text: text.slice(0, 500) },
          });
          out.sent += 1;
        } else {
          stall('message #1 and follow-up sent — waiting for a reply');
        }
      } catch (e) {
        // Ошибка отправки — факт для реестра (аналог валидации адресов, решение L5.5).
        out.errors.push(`send ${leadUuid}: ${e.message}`);
        await getPool().query(
          `INSERT INTO verification (contact_id, kind, result, provider) VALUES ($1, 'linkedin', $2, 'getsales')`,
          [contactId, `send failed: ${String(e.message).slice(0, 120)}`],
        ).catch(() => {});
      }
    }
  }
  // Сверка «намерение против факта» — в том же проходе: рапорт об отправке без подтверждения
  // провайдера ничего не стоит (урок 17.08).
  out.delivery = await reconcileSends().catch((e) => ({ error: String(e.message || e) }));
  if (out.touches || out.replies || out.sent || out.errors.length || out.pending.length) {
    console.log(`[getsales:sync] campaigns=${out.campaigns} touches=${out.touches} replies=${out.replies} sent=${out.sent} errors=${out.errors.length} pending=${out.pending.length}`);
    for (const p of out.pending) console.log(`[getsales:sync]   ждём: contact ${p.contact} — ${p.waiting}`);
  }
  return out;
}

/**
 * Кросс-стоп L4.2: ответ по email глушит LinkedIn-лестницу лида — ВКЛЮЧАЯ ещё не
 * отправленную заявку (записано в скоуп явно: заявка уходит в день 0, ответ на письмо
 * приходит позже, стоп «только сообщений» опоздал бы). Механика — снятие лида со всех
 * флоу (DELETE связи lead-flow, проба L0.6). Оркестратор сообщений сам молчит после
 * replied-touch, так что этим закрыты и наши сообщения, и касания флоу.
 */
export async function stopLinkedinForContact(contactId, { trigger = 'email reply' } = {}) {
  if (!gs.getsalesEnabled()) return { stopped: 0 };
  const pool = getPool();
  const camps = (await pool.query(
    `SELECT external_id, meta FROM campaign
      WHERE channel = 'linkedin' AND status = 'active' AND external_id IS NOT NULL`,
  )).rows;
  let stopped = 0;
  for (const c of camps) {
    const map = c.meta?.getsales?.lead_map || {};
    const leadUuid = Object.keys(map).find((k) => Number(map[k]) === Number(contactId));
    if (!leadUuid) continue;
    try {
      // Точечный GET лида НЕ отдаёт flows (найдено живым запуском 13.08) — связи с лестницей
      // видит только серверный поиск. Список ячейки маленький, перечитать его дёшево.
      const rows = await gs.leadsOfList(c.external_id);
      const row = rows.find((r) => (r.lead || r).uuid === leadUuid);
      const removed = row ? await gs.stopLeadEverywhere({ ...(row.lead || row), flows: row.flows || [] }) : 0;
      stopped += removed;
      await writeAudit({ actor: 'cross-stop', action: 'crossstop.linkedin_stop', entity: 'contact', entityId: contactId,
        meta: { list: c.external_id, lead_uuid: leadUuid, flows_removed: removed, trigger } }).catch(() => {});
      console.log(`[cross-stop] ${trigger} → LinkedIn-лестница снята: контакт ${contactId}, связей ${removed}`);
    } catch (e) {
      console.error(`[cross-stop] снятие с лестницы не удалось (${leadUuid}):`, e.message);
      await sendTelegram(`⛔️ Cross-stop FAILED: contact ${contactId} replied (${trigger}), but the LinkedIn ladder could not be stopped (lead ${leadUuid}). Remove them from the flow by hand in GetSales.`).catch(() => {});
    }
  }
  return { stopped };
}

/**
 * Маршрутизация LinkedIn-ответа — зеркало email-пути (webhooks.js routeReply):
 * текст из диалога → классификация → карантин/suppress по классу → пинг на неотрицательный →
 * карточка Kommo на Initial Contact с каналом 'linkedin'. Ответ по определению = живой
 * разговор: закрытый тред переоткрывается.
 */
async function routeLinkedinReply({ contactId, leadUuid, listUuid }) {
  const pool = getPool();
  const info = (await pool.query(
    `SELECT full_name, title, company, email, kommo_lead_id, conversation_state, conversation_outcome
       FROM contact WHERE id = $1`, [contactId],
  )).rows[0] || {};

  // Текст последнего входящего — из диалога (счётчик маркера текст не несёт).
  let text = '';
  try {
    const conv = await gs.conversations(leadUuid);
    const msgs = conv?.data || conv?.messages || [];
    const inbound = msgs.filter((m) => m.direction === 'inbound' || m.is_inbound || m.incoming);
    text = String((inbound[inbound.length - 1] || {}).text || (inbound[inbound.length - 1] || {}).message || '').slice(0, 3000);
  } catch (e) { console.warn(`[getsales] диалог ${leadUuid} не прочитался: ${e.message}`); }

  if (info.conversation_state === 'closed') {
    await pool.query(
      `UPDATE contact SET conversation_state = 'open', conversation_outcome = NULL, updated_at = now() WHERE id = $1`,
      [contactId],
    );
  }

  const cls = await classifyReply({
    text: text || '(reply text not captured — see GetSales inbox)',
    subject: '', contactName: info.full_name || '', company: info.company || '', fromEmail: '',
  }).catch(() => ({ label: 'unclear', summary: null, resumeDate: null }));

  await pool.query(
    `UPDATE touch SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
      WHERE id = (SELECT id FROM touch WHERE contact_id = $1 AND event = 'replied' AND channel = 'linkedin'
                  ORDER BY occurred_at DESC LIMIT 1)`,
    [contactId, JSON.stringify({ classification: cls.label, summary: cls.summary, reply_text: text.slice(0, 1500) })],
  );

  if (cls.label === 'negative') {
    await pool.query(
      `UPDATE contact SET lifecycle = 'quarantined', quarantine_until = now() + interval '3 months', updated_at = now() WHERE id = $1`,
      [contactId],
    );
  } else if (cls.label === 'unsubscribe') {
    await pool.query(
      `UPDATE contact SET lifecycle = 'suppressed_forever', quarantine_until = NULL, updated_at = now() WHERE id = $1`,
      [contactId],
    );
  }

  if (kommoEnabled() && info.kommo_lead_id) {
    moveLeadToInitialContact(info.kommo_lead_id, { channel: 'linkedin', campaign: listUuid })
      .then((r) => writeAudit({
        actor: 'getsales-sync', action: 'kommo.move', entity: 'contact', entityId: contactId,
        meta: { lead: info.kommo_lead_id, to: 'Initial Contact', moved: Boolean(r.moved), trigger: 'linkedin reply', channel: 'linkedin' },
      }).catch(() => {}))
      .catch((e) => console.error('[kommo] перевод по LinkedIn-ответу не удался:', e.message));
  }

  // Кросс-стоп L4.1 (DoD этапа 2 ТЗ): ответ в LinkedIn ставит email-фоллоуапы лида на паузу.
  // Пауза не удалась → немедленный пинг «останови руками»: молчаливый провал кросс-стопа
  // означает письмо человеку, который уже разговаривает (правило автопаузы, ТЗ п.32).
  if (info.email) {
    const cells = (await pool.query(
      `SELECT DISTINCT c.external_id FROM campaign c
        WHERE c.channel = 'email' AND c.status = 'active' AND c.external_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM touch t WHERE t.contact_id = $1 AND t.campaign_ext_id = c.external_id)`,
      [contactId],
    )).rows;
    for (const cell of cells) {
      try {
        await smartlead.pauseLead(cell.external_id, info.email);
        await writeAudit({ actor: 'cross-stop', action: 'crossstop.email_pause', entity: 'contact', entityId: contactId,
          meta: { campaign: cell.external_id, trigger: 'linkedin reply' } }).catch(() => {});
        console.log(`[cross-stop] LinkedIn-ответ → email-пауза: контакт ${contactId}, кампания ${cell.external_id}`);
      } catch (e) {
        console.error(`[cross-stop] пауза лида не удалась (${cell.external_id}):`, e.message);
        await sendTelegram(`⛔️ Cross-stop FAILED: ${info.full_name || contactId} replied on LinkedIn, but the email follow-ups could not be paused (campaign ${cell.external_id}). Pause the lead by hand in Smartlead.`).catch(() => {});
      }
    }
  }

  if (NON_NEGATIVE.includes(cls.label)) {
    await sendTelegram([
      `📨 LinkedIn reply (${cls.label})`,
      `${info.full_name || '—'} — ${info.title || '?'} @ ${info.company || '?'}`,
      text ? `"${text.slice(0, 300)}"` : '(текст не считался — открой GetSales inbox)',
      cls.summary ? `Gist: ${cls.summary}` : '',
      'Reply from the app: Inbox tab',
    ].filter(Boolean).join('\n'));
  }
  return cls;
}
