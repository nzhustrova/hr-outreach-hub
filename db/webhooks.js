// Обработка вебхук-событий Smartlead → event_log (сырые, идемпотентно) → touch + правила ЖЦ.
// Правила кросс-стопа/карантина — Дизайн-док (встречи 04.08) + ТЗ этап 2:
//   ответ → стоп автокасаний везде (LinkedIn-стоп станет активным с LI-кампаниями);
//   unsubscribe / DNC / hard bounce → suppressed_forever;
//   Not Interested → карантин +3 мес;
//   закрытие кампании → неответившим quarantine_until = now + 3 мес.
import crypto from 'node:crypto';
import pg from 'pg';
import { classifyReply, NON_NEGATIVE, bounceKind } from '../classify.js';
import { sendTelegram } from '../notify.js';
import { kommoEnabled, moveLeadToInitialContact } from '../kommo.js';

let pool = null;
export function setPool(p) { pool = p; }

const QUARANTINE_MONTHS = 3;
const SOFT_BOUNCE_DAYS = 30;   // карантин по soft-bounce (ТЗ п.32)
const SOFT_BOUNCE_LIMIT = 2;   // два soft подряд = адрес считаем мёртвым

/**
 * Общая обработка отскока для обоих путей: вебхука EMAIL_BOUNCE и NDR, прилетевшего «ответом».
 * hard → адрес мёртв навсегда. soft → карантин 30 дней и повторная попытка; но второй soft
 * по тому же контакту закрывает вопрос — иначе мы бесконечно бьём по репутации домена.
 */
async function handleBounce(client, contact, { text = '', campaignExtId = null, reason = '', fromEmail = null } = {}) {
  const kind = bounceKind(text);
  const prevSoft = kind === 'soft'
    ? Number((await client.query(
      `SELECT COUNT(*) AS n FROM touch
        WHERE contact_id = $1 AND event = 'bounced' AND meta->>'kind' = 'soft'`,
      [contact.id],
    )).rows[0].n)
    : 0;
  const final = kind === 'hard' || prevSoft + 1 >= SOFT_BOUNCE_LIMIT;

  await client.query(
    `INSERT INTO touch (contact_id, channel, campaign_ext_id, event, meta)
     VALUES ($1, 'email', $2, 'bounced', $3)`,
    [contact.id, campaignExtId, JSON.stringify({
      kind, reason, from_email: fromEmail, soft_seen: prevSoft + (kind === 'soft' ? 1 : 0),
    })],
  );
  await client.query(
    `UPDATE contact SET email_status = $2, updated_at = now() WHERE id = $1`,
    [contact.id, final ? 'invalid' : contact.email_status || null],
  );
  if (final) {
    await setLifecycle(client, contact.id, 'suppressed_forever', null,
      kind === 'hard' ? `hard bounce: ${reason || 'address not found'}` : `${SOFT_BOUNCE_LIMIT}× soft bounce`);
    return { kind, final: true, action: `bounce:${kind}; lifecycle:suppressed_forever` };
  }
  const until = new Date(Date.now() + SOFT_BOUNCE_DAYS * 864e5);
  await setLifecycle(client, contact.id, 'quarantined', until.toISOString(), `soft bounce: ${reason || 'temporary'}`);
  return { kind, final: false, action: `bounce:soft; quarantined until ${until.toISOString().slice(0, 10)}` };
}

// Живой формат 07.08 (пред-прогон): лид лежит в sl_lead_email; to_email в EMAIL_REPLY — это
// адрес, С КОТОРОГО ответили (может отличаться: Ольга ответила с report@ на письмо к o.zhulikova@).
function pickEmail(payload) {
  return (
    payload?.sl_lead_email || payload?.lead_email || payload?.lead?.email ||
    payload?.leadCorrespondence?.targetLeadEmail ||
    payload?.to_email || payload?.email || payload?.to?.email || null
  );
}

function pickEventType(payload) {
  return payload?.event_type || payload?.eventType || payload?.type || 'unknown';
}

// Находим контакт по email (identity через email — Smartlead живёт email-ами).
async function findContactByEmail(client, email) {
  if (!email) return null;
  const r = await client.query('SELECT id, lifecycle FROM contact WHERE lower(email) = lower($1) LIMIT 1', [email]);
  return r.rows[0] || null;
}

async function setLifecycle(client, contactId, lifecycle, quarantineUntil = null, reason = '') {
  await client.query(
    `UPDATE contact SET lifecycle = $2, quarantine_until = $3, updated_at = now() WHERE id = $1`,
    [contactId, lifecycle, quarantineUntil],
  );
  await client.query(
    `INSERT INTO verification (contact_id, kind, result, provider) VALUES ($1, 'lifecycle', $2, 'webhook')`,
    [contactId, `${lifecycle}${reason ? `: ${reason}` : ''}`],
  );
}

// Категории Smartlead → классы маршрутизатора (ТЗ этап 3; здесь — только ЖЦ-часть).
const CATEGORY_RULES = {
  'not interested': { lifecycle: 'quarantined', months: QUARANTINE_MONTHS },
  'do not contact': { lifecycle: 'suppressed_forever' },
};

export async function processSmartleadEvent(rawPayload, { replay = false } = {}) {
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!replay) {
      const ins = await client.query(
        `INSERT INTO event_log (source, event_type, payload_hash, payload)
         VALUES ('smartlead', $1, $2, $3)
         ON CONFLICT (payload_hash) DO NOTHING RETURNING id`,
        [pickEventType(rawPayload), payloadHash, JSON.stringify(rawPayload)],
      );
      if (!ins.rows.length) { await client.query('COMMIT'); return { duplicate: true }; }
    }

    const eventType = pickEventType(rawPayload);
    const email = pickEmail(rawPayload);
    let contact = await findContactByEmail(client, email);
    // Реплей исторического события: контакта могло не быть на момент прихода (кейс пред-прогона
    // 07.08 — zero-run лиды тогда не сохранялись) → создаём минимальный, чтобы петля доработала.
    if (!contact && replay && email) {
      await client.query(
        `INSERT INTO contact (identity_key, full_name, email, email_status, sources)
         VALUES (lower($1), $2, $1, 'valid', '["zero-run"]')
         ON CONFLICT (identity_key) DO NOTHING`,
        [email, email.split('@')[0]],
      );
      contact = await findContactByEmail(client, email);
    }
    const campaignExtId = String(rawPayload?.campaign_id ?? rawPayload?.campaignId ?? '') || null;

    const actions = [];
    if (contact) {
      const touchEvent = {
        EMAIL_SENT: 'sent', FIRST_EMAIL_SENT: 'sent', EMAIL_OPEN: 'opened', EMAIL_LINK_CLICK: 'clicked',
        EMAIL_REPLY: 'replied', EMAIL_BOUNCE: 'bounced', LEAD_UNSUBSCRIBED: 'unsubscribed',
        LEAD_CATEGORY_UPDATED: 'category_updated',
      }[eventType] || eventType.toLowerCase();

      // Отскок пишет свой touch сам (с типом soft/hard в meta) — здесь не дублируем,
      // иначе bounce rate считался бы по удвоенному числителю.
      // Ящик-отправитель кладём в meta: без него bounce rate ПО ЯЩИКУ (ТЗ п.32) не посчитать,
      // а именно он говорит, какой домен получает урон. Имя поля у Smartlead плавает.
      const fromEmail = rawPayload?.from_email ?? rawPayload?.sent_message?.from
        ?? rawPayload?.sender_email ?? rawPayload?.email_account?.from_email ?? null;
      if (eventType !== 'EMAIL_BOUNCE') {
        await client.query(
          `INSERT INTO touch (contact_id, channel, campaign_ext_id, event, meta)
           VALUES ($1, 'email', $2, $3, $4)`,
          [contact.id, campaignExtId, touchEvent, JSON.stringify({ event_type: eventType, from_email: fromEmail })],
        );
        actions.push(`touch:${touchEvent}`);
      }

      if (eventType === 'EMAIL_REPLY') {
        // Кросс-стоп (L4.2): email-sequence Smartlead стопит сам, а LinkedIn-лестницу
        // глушим мы — после коммита, в routeReply (там уже отсеян NDR: отбойник — не ответ
        // человека, и лестницу он останавливать не должен).
        actions.push('cross-stop: linkedin stop queued');
      }
      if (eventType === 'LEAD_UNSUBSCRIBED') {
        await setLifecycle(client, contact.id, 'suppressed_forever', null, 'unsubscribed');
        actions.push('lifecycle:suppressed_forever');
      }
      if (eventType === 'EMAIL_BOUNCE') {
        // Причину собираем широко: точное имя поля у Smartlead не задокументировано,
        // а от текста зависит soft/hard — то есть карантин против вечной блокировки.
        const reason = [
          rawPayload?.bounce_reason, rawPayload?.reason, rawPayload?.error_message,
          rawPayload?.description, rawPayload?.bounce_type, rawPayload?.smtp_response,
        ].filter(Boolean).join(' ');
        const out = await handleBounce(client, contact, { text: reason, campaignExtId, reason, fromEmail });
        actions.push(out.action);
      }
      if (eventType === 'LEAD_CATEGORY_UPDATED') {
        const catName = (rawPayload?.lead_category?.new_name || rawPayload?.category_name || rawPayload?.category || '')
          .toString().toLowerCase();
        const rule = CATEGORY_RULES[catName];
        if (rule?.lifecycle === 'suppressed_forever') {
          await setLifecycle(client, contact.id, 'suppressed_forever', null, `category: ${catName}`);
          actions.push('lifecycle:suppressed_forever');
        } else if (rule?.lifecycle === 'quarantined') {
          const until = new Date(); until.setMonth(until.getMonth() + rule.months);
          await setLifecycle(client, contact.id, 'quarantined', until.toISOString(), `category: ${catName}`);
          actions.push(`lifecycle:quarantined until ${until.toISOString().slice(0, 10)}`);
        }
      }
    }

    await client.query('COMMIT');

    // Классификация ответа — ПОСЛЕ коммита (LLM-вызов не должен держать транзакцию).
    let classification = null;
    if (eventType === 'EMAIL_REPLY' && contact) {
      classification = await routeReply({ contact, rawPayload, campaignExtId }).catch((e) => {
        console.error('[webhook] reply classification failed:', e.message);
        return null;
      });
      if (classification) actions.push(`classified:${classification.label}`);
    }

    return { stored: true, eventType, matchedContact: contact?.id ?? null, actions, classification };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Чистый текст ответа: reply_message.text (без HTML и цитаты треда) → preview_text → reply_body.
function pickReplyText(payload) {
  return payload?.reply_message?.text || payload?.preview_text || payload?.reply_body
    || payload?.message || payload?.reply || '';
}

// Маршрутизация ответа по классу (решения 07.08): unsubscribe → suppress; negative → карантин 3 мес;
// not_now → карантин до названной даты; неотрицательные → ТГ-пинг, разбирается человек.
async function routeReply({ contact, rawPayload, campaignExtId }) {
  const text = String(pickReplyText(rawPayload)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
  const info = (await pool.query(
    'SELECT full_name, title, company, email, conversation_state, conversation_outcome, conversation_closed_at FROM contact WHERE id = $1',
    [contact.id],
  )).rows[0] || {};

  // ⚠️ ЛЮБОЙ входящий ответ ПЕРЕОТКРЫВАЕТ разговор (вопрос Ольги 11.08).
  // Дыра, которую это закрывает: кампания закрывается через 7 дней после последней отправки,
  // а лид может ответить на 10-й или 15-й. Ответ приходил, пинг в Телеграм уходил — но карточка
  // в Inbox НЕ появлялась, потому что список по умолчанию скрывает закрытые разговоры.
  // Оператор получал уведомление и не находил, о чём оно. Ответ по определению = живой разговор.
  // Первый ответ лида двигает карточку в Kommo на «Initial Contact» (ТЗ п.28).
  // Цепочка была описана 11.08, но в коде отсутствовала целиком — найдено аудитом 13.08.
  // Движение только вперёд: если карточка уже на встрече, поздний ответ её не утащит назад.
  if (kommoEnabled()) {
    const k = (await pool.query('SELECT kommo_lead_id FROM contact WHERE id = $1', [contact.id])).rows[0];
    if (k?.kommo_lead_id) {
      // Канал ответа передаём явно. Сегодня сюда приходят только вебхуки Smartlead, то есть
      // всегда email, но зашивать это в текст примечания нельзя: с LinkedIn-кампаниями
      // CRM молча получила бы неверную запись об источнике ответа (вопрос Ольги 13.08).
      moveLeadToInitialContact(k.kommo_lead_id, { channel: 'email', campaign: campaignExtId || null })
        .then(async (r) => {
          console.log(`[kommo] ответ лида → ${r.moved ? `Initial Contact (было «${r.from}»)` : `не двигаем: ${r.reason}`}`);
          // Пишем в журнал и автоматические переводы: иначе лог показывает только то,
          // что делали руками, и выглядит так, будто система сама ничего не трогает.
          const { writeAudit } = await import('./users.js');
          await writeAudit({
            actor: 'webhook', action: 'kommo.move', entity: 'contact', entityId: contact.id,
            meta: { lead: k.kommo_lead_id, to: 'Initial Contact', moved: Boolean(r.moved), reason: r.reason || null, trigger: 'lead replied', channel: 'email' },
          }).catch(() => {});
        })
        .catch((e) => console.error('[kommo] перевод на Initial Contact не удался:', e.message));
    }
  }

  const wasClosed = info.conversation_state === 'closed';
  if (wasClosed) {
    await pool.query(
      `UPDATE contact SET conversation_state = 'open', conversation_outcome = NULL, updated_at = now()
       WHERE id = $1`,
      [contact.id],
    );
    console.log(`[reply] поздний ответ: разговор с ${info.full_name || contact.id} переоткрыт (был закрыт как ${info.conversation_outcome})`);
  }
  const cls = await classifyReply({
    text,
    subject: rawPayload?.subject || '',
    contactName: info.full_name || '',
    company: info.company || '',
    fromEmail: rawPayload?.to_email || '', // в EMAIL_REPLY это адрес, С КОТОРОГО пришёл ответ
  });

  // Кросс-стоп L4.2: человеческий ответ по email глушит LinkedIn-лестницу лида, включая
  // неотправленную заявку. NDR — не ответ человека: отбойник лестницу не трогает.
  // Динамический импорт — защита от цикла (getsales-sync → registry → webhooks).
  if (cls.label !== 'bounce_notification') {
    import('../getsales-sync.js')
      .then((m) => m.stopLinkedinForContact(contact.id, { trigger: 'email reply' }))
      .catch((e) => console.error('[cross-stop] linkedin stop failed:', e.message));
  }

  await pool.query(
    `UPDATE touch SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
     WHERE id = (SELECT id FROM touch WHERE contact_id = $1 AND event = 'replied' ORDER BY occurred_at DESC LIMIT 1)`,
    [contact.id, JSON.stringify({
      classification: cls.label,
      summary: cls.summary,
      resume_date: cls.resumeDate,
      reply_text: text.slice(0, 1500),
      // Поздний ответ: пришёл после того, как кампанию закрыли. В карточке это надо видеть —
      // иначе непонятно, почему лид «из ниоткуда» и к какой волне он относится.
      late_reply: wasClosed ? { reopened_from: info.conversation_outcome, closed_at: info.conversation_closed_at } : undefined,
      subject: rawPayload?.subject || null,
      // Идентификаторы треда Smartlead — для ответа из приложения (reply-email-thread).
      // Поля собираем широко: точный формат подтверждается живым событием нулевого прогона.
      sl: {
        stats_id: rawPayload?.stats_id ?? rawPayload?.email_stats_id ?? rawPayload?.sl_email_lead_id ?? null,
        message_id: rawPayload?.message_id ?? rawPayload?.reply_message?.message_id ?? null,
        time: rawPayload?.reply_message?.time ?? rawPayload?.event_timestamp ?? null,
        campaign_id: rawPayload?.campaign_id ?? null,
        lead_email: rawPayload?.to_email ?? rawPayload?.lead_email ?? null,
      },
    })],
  );

  if (cls.label === 'bounce_notification') {
    // NDR пришёл обычным «ответом» в тред (кейс 07.08 — Smartlead засчитал его как reply).
    // Разбираем текст: «ящик переполнен» и «такого адреса нет» — разные приговоры.
    await handleBounce(pool, contact, { text, campaignExtId, reason: 'NDR' });
  } else if (cls.label === 'unsubscribe') {
    await setLifecycle(pool, contact.id, 'suppressed_forever', null, 'reply: unsubscribe demand');
  } else if (cls.label === 'negative') {
    const until = new Date(); until.setMonth(until.getMonth() + QUARANTINE_MONTHS);
    await setLifecycle(pool, contact.id, 'quarantined', until.toISOString(), 'reply: negative');
  } else if (cls.label === 'not_now') {
    let until;
    if (cls.resumeDate && !Number.isNaN(Date.parse(cls.resumeDate))) until = new Date(cls.resumeDate);
    else { until = new Date(); until.setMonth(until.getMonth() + QUARANTINE_MONTHS); }
    await setLifecycle(pool, contact.id, 'quarantined', until.toISOString(), `reply: not_now until ${until.toISOString().slice(0, 10)}`);
  }

  if (NON_NEGATIVE.includes(cls.label)) {
    await sendTelegram([
      `📨 Non-negative reply (${cls.label})`,
      `${info.full_name || '—'} — ${info.title || '?'} @ ${info.company || '?'}`,
      info.email || '',
      text ? `"${text.slice(0, 300)}"` : '(reply text not captured)',
      cls.summary ? `Gist: ${cls.summary}` : '',
      `Campaign: ${campaignExtId || '—'} · reply from the app: Inbox tab`,
    ].filter(Boolean).join('\n'));
  }
  return cls;
}

// Закрытие кампании: все контакты кампании без ответа → карантин +3 мес (механика Тони «497 → через 3 месяца»).
//
// Модель волны (L2.1): ячейка знает свой пакет через campaign.meta.batch_id. Пока у волны
// жива другая ячейка (email закрыт, LinkedIn-заявки ещё ждут принятия) — карантинить НЕЛЬЗЯ:
// «не ответил» ещё не наступил, второй канал работает. Карантин уходит только с последней
// ячейкой — и тогда по контактам ВСЕХ ячеек волны, с ответами, учтёнными по любому каналу.
// Кампания без batch_id (все нынешние email-кампании) ведёт себя ровно как раньше.
export async function closeCampaign(campaignExtId) {
  const camp = (await pool.query(
    `SELECT id, meta->>'batch_id' AS batch_id FROM campaign WHERE external_id = $1 LIMIT 1`,
    [String(campaignExtId)],
  )).rows[0] || null;
  const batchId = camp?.batch_id ? Number(camp.batch_id) : null;

  let extIds = [String(campaignExtId)];
  if (batchId) {
    const cells = await pool.query(
      `SELECT id, external_id, closed_at, status FROM campaign
        WHERE (meta->>'batch_id')::int = $1 AND external_id IS NOT NULL`,
      [batchId],
    );
    const openSiblings = cells.rows.filter((c) => String(c.external_id) !== String(campaignExtId)
      && !c.closed_at && !['draft', 'error'].includes(c.status));
    if (openSiblings.length) {
      return { quarantined: 0, deferredToWave: true, openCells: openSiblings.length };
    }
    extIds = cells.rows.map((c) => String(c.external_id));
  }

  const r = await pool.query(
    `WITH campaign_contacts AS (
       SELECT DISTINCT contact_id FROM touch WHERE campaign_ext_id = ANY($1::text[])
     ), responded AS (
       SELECT DISTINCT contact_id FROM touch WHERE campaign_ext_id = ANY($1::text[]) AND event = 'replied'
     )
     UPDATE contact SET lifecycle = 'quarantined',
       quarantine_until = now() + interval '${QUARANTINE_MONTHS} months',
       active_batch_id = NULL,
       -- Исход отличается от «замолчал после диалога» (autoCloseStaleConversations).
       -- Смешивать их нельзя: «не ответил вовсе» и «ответил, а потом остыл» — разные
       -- события, и аналитика на общем ярлыке начнёт врать (замечание Ольги 11.08).
       conversation_state = 'closed', conversation_outcome = 'no_reply',
       conversation_closed_at = now(),
       updated_at = now()
     WHERE id IN (SELECT contact_id FROM campaign_contacts)
       AND id NOT IN (SELECT contact_id FROM responded)
       AND lifecycle NOT IN ('suppressed_forever')
     RETURNING id`,
    [extIds],
  );
  // Ответившие остаются в своём ЖЦ (их ведёт разговор), но замок волны с них снимается.
  await pool.query(
    `UPDATE contact SET active_batch_id = NULL
      WHERE active_batch_id IS NOT NULL AND id IN (
        SELECT DISTINCT contact_id FROM touch WHERE campaign_ext_id = ANY($1::text[]))`,
    [extIds],
  );
  return { quarantined: r.rowCount, cells: extIds.length };
}
