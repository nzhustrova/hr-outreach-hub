// Оперативные состояния волны (L5.13, первый слой — детекция без доставки).
//
// Отвечает не на вопрос «сломалось ли», а на вопрос «идёт ли работа». Волна может быть
// формально исправна и при этом стоять: аккаунт без пульса, принятие без ответа, фоллоуап
// просрочен, отправка не подтверждена провайдером.
//
// Доставка (кому и куда) сознательно отложена — сначала содержание и процесс отслеживания
// (решение Ольги 18.08). Поэтому здесь только вычисление состояний; экран и журналы
// показывают их списком, а Telegram подключится вторым шагом.
//
// ⚠️ Дисциплина L5.12: у каждого состояния названы ИСТОЧНИК факта и то, чего мы НЕ знаем.
// «Событий об отправке не пришло» — это не «отправок не было».
import { getPool } from './db/registry.js';
import { getState, setState } from './db/state.js';
import * as gs from './getsales.js';

// Пороги — параметры, а не константы в коде: на рамп-апе их двигают еженедельно.
const DEFAULTS = {
  stalled_hours: 24,        // ячейка запущена, а заявок нет
  accepted_silent_hours: 4, // принял, а сообщения нет
  followup_grace_hours: 12, // фоллоуап просрочен сверх своего срока
  reply_waiting_hours: 4,   // человек ждёт нашего ответа
  heartbeat_stale_days: 3,  // пульс аккаунта
  barrier_stale_hours: 36,  // возраст стоп-листа
  credits_min: 500,         // остаток кредитов валидатора
};

export async function thresholds() {
  const saved = JSON.parse((await getState('alert_thresholds')) || '{}');
  return { ...DEFAULTS, ...saved };
}

const LEVEL = { red: 'red', yellow: 'yellow', grey: 'grey' };

// Ключ состояния — то, по чему человек его «принимает в работу». Устроен так, чтобы
// пережить пересчёт: одно и то же состояние по тому же человеку/волне даёт тот же ключ.
export const problemKey = (x) => [x.code, x.contactId || '', x.campaignId || ''].join(':');

/**
 * Принятые в работу состояния (L5.13). Два механизма закрытия, и они разные:
 *   • само собой — состояние исчезает, когда исчезла причина (ответили, отправили, починили);
 *   • «принято в работу» — причина ещё есть, но человек её увидел и держит в руках.
 * Второе НЕ отменяет проблему, а прячет её на срок: если через сутки причина не ушла,
 * состояние возвращается. Иначе «принял» превращается в способ не делать.
 */
export async function acks() {
  return JSON.parse((await getState('problem_acks')) || '{}');
}

export async function ackProblem({ key, hours = 24, actor = 'unknown', note = '' }) {
  const all = await acks();
  all[key] = { until: new Date(Date.now() + Math.max(1, Number(hours) || 24) * 36e5).toISOString(), actor, note };
  await setState('problem_acks', JSON.stringify(all));
  return all[key];
}

/**
 * Все текущие состояния, требующие внимания. Каждое несёт: код, уровень, заголовок,
 * пояснение, источник факта и ссылку на объект (волна / человек).
 */
export async function currentProblems() {
  const t = await thresholds();
  const p = getPool();
  const out = [];
  const push = (x) => out.push(x);

  // 1. Ячейка запущена, а заявок нет. Источник: наши touch. Не знаем: могли ли заявки уйти
  //    и не долететь событием — поэтому формулировка про СОБЫТИЯ, а не про заявки.
  const stalled = await p.query(
    `SELECT c.id, c.external_id, c.started_at FROM campaign c
      WHERE c.channel = 'linkedin' AND c.status = 'active'
        AND c.started_at < now() - ($1 || ' hours')::interval
        AND NOT EXISTS (SELECT 1 FROM touch t WHERE t.campaign_ext_id = c.external_id AND t.event = 'connection_sent')`,
    [String(t.stalled_hours)],
  );
  for (const r of stalled.rows) {
    push({
      code: 'cell_stalled', level: LEVEL.yellow, campaignId: r.id,
      title: `Волна #${r.id}: за ${t.stalled_hours} ч ни одного события об отправке заявки`,
      detail: 'Лестница, похоже, стоит на стороне GetSales. Проверить: пульс аккаунта, удержание задач, дневной лимит, включён ли флоу.',
      source: 'наши записи касаний (событий connection_sent нет)',
    });
  }

  // 2. Принял, но мы не написали. Источник: пара наших touch. Самое дорогое состояние:
  //    человек пустил нас к себе и ждёт, а мы молчим.
  // ⚠️ Только живая работа: импортированная история (2 433 записи) содержит принятия
  // без наших сообщений по определению — она про прошлое, а не про сегодняшнюю волну.
  // Без этого фильтра детектор выдал 664 «срочных» состояния на первом же запуске;
  // алерт, который всегда горит, — не алерт (проверка 18.08).
  const silent = await p.query(
    `SELECT a.contact_id, c.full_name, a.occurred_at, camp.id AS campaign_id
       FROM touch a
       JOIN contact c ON c.id = a.contact_id
       JOIN campaign camp ON camp.external_id = a.campaign_ext_id AND camp.status = 'active'
      WHERE a.channel = 'linkedin' AND a.event = 'accepted'
        AND COALESCE(a.meta->>'import', '') <> 'true'
        AND a.occurred_at < now() - ($1 || ' hours')::interval
        AND NOT EXISTS (SELECT 1 FROM touch m WHERE m.contact_id = a.contact_id
                          AND m.event IN ('message_sent', 'replied'))`,
    [String(t.accepted_silent_hours)],
  );
  for (const r of silent.rows) {
    push({
      code: 'accepted_no_message', level: LEVEL.red, contactId: r.contact_id, campaignId: r.campaign_id,
      title: `${r.full_name || `#${r.contact_id}`}: принял заявку, сообщение не ушло`,
      detail: `Принятие ${new Date(r.occurred_at).toLocaleString('ru-RU')}. Причины бывают: вне окна отправки, потолок сообщений профиля, ошибка отправки.`,
      source: 'наши записи: есть accepted, нет message_sent',
    });
  }

  // 3. Фоллоуап просрочен. Срок берём из захода (wait_days), сверх него — льгота.
  const fu = await p.query(
    `SELECT m.contact_id, c.full_name, m.occurred_at,
            COALESCE((ma.linkedin->'followup'->>'wait_days')::int, 3) AS wait_days,
            camp.id AS campaign_id
       FROM touch m
       JOIN contact c ON c.id = m.contact_id
       JOIN campaign camp ON camp.external_id = m.campaign_ext_id
       LEFT JOIN message_angle ma ON ma.id = camp.message_angle_id
      WHERE m.channel = 'linkedin' AND m.event = 'message_sent' AND camp.status = 'active'
        AND COALESCE(m.meta->>'import', '') <> 'true'
        AND ma.linkedin->'followup'->>'body' IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM touch f WHERE f.contact_id = m.contact_id AND f.event = 'message_followup')
        AND NOT EXISTS (SELECT 1 FROM touch r WHERE r.contact_id = m.contact_id AND r.event = 'replied')
        AND m.occurred_at < now() - (COALESCE((ma.linkedin->'followup'->>'wait_days')::int, 3) || ' days')::interval
                                  - ($1 || ' hours')::interval`,
    [String(t.followup_grace_hours)],
  );
  for (const r of fu.rows) {
    push({
      code: 'followup_overdue', level: LEVEL.yellow, contactId: r.contact_id, campaignId: r.campaign_id,
      title: `${r.full_name || `#${r.contact_id}`}: фоллоуап просрочен`,
      detail: `Сообщение №1 ушло ${new Date(r.occurred_at).toLocaleString('ru-RU')}, пауза захода — ${r.wait_days} дн.`,
      source: 'наши записи: есть message_sent, нет message_followup и нет ответа',
    });
  }

  // 4. Окно принятия истекло, заявка не отозвана.
  const windowDays = Number(await getState('getsales_accept_window')) || 21;
  const expired = await p.query(
    `SELECT s.contact_id, c.full_name, s.occurred_at, camp.id AS campaign_id
       FROM touch s JOIN contact c ON c.id = s.contact_id
       JOIN campaign camp ON camp.external_id = s.campaign_ext_id
      WHERE s.channel = 'linkedin' AND s.event = 'connection_sent' AND camp.status = 'active'
        AND COALESCE(s.meta->>'import', '') <> 'true'
        AND s.occurred_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM touch a WHERE a.contact_id = s.contact_id AND a.event = 'accepted')`,
    [String(windowDays)],
  );
  for (const r of expired.rows) {
    push({
      code: 'window_expired', level: LEVEL.yellow, contactId: r.contact_id, campaignId: r.campaign_id,
      title: `${r.full_name || `#${r.contact_id}`}: окно принятия (${windowDays} дн.) истекло`,
      detail: 'Заявку пора отзывать, а человека — в канальный карантин.',
      source: 'наши записи: connection_sent старше окна, accepted нет',
    });
  }

  // 5. Отправка не подтверждена провайдером — то самое состояние, что молчало 14–17.08.
  const missing = await p.query(
    `SELECT t.contact_id, c.full_name, t.event, t.occurred_at, camp.id AS campaign_id
       FROM touch t JOIN contact c ON c.id = t.contact_id
       LEFT JOIN campaign camp ON camp.external_id = t.campaign_ext_id
      WHERE t.channel = 'linkedin' AND t.meta->>'delivery' = 'missing'
        AND COALESCE(t.meta->>'delivery_source', '') <> 'provider_marker'`,
  );
  for (const r of missing.rows) {
    push({
      code: 'delivery_missing', level: LEVEL.red, contactId: r.contact_id, campaignId: r.campaign_id,
      title: `${r.full_name || `#${r.contact_id}`}: мы записали отправку, провайдер её не знает`,
      detail: 'Получатель, скорее всего, не получил ничего. Отправить заново после проверки.',
      source: 'сверка наших записей со списком сообщений GetSales',
    });
  }

  // 6. Человек ждёт нашего ответа. Считаем по последнему сообщению в переписке.
  // Сверено с Inbox 18.08 — три расхождения, которые пришлось убрать:
  //  • закрытые разговоры Inbox прячет, а панель кричала о них;
  //  • автоответы и отбойники (NDR, out-of-office, отписка, отказ) НИКОГО не ждут —
  //    называть их «человек ждёт ответа» было прямым враньём экрана;
  //  • тестовые контакты нулевого прогона Inbox прячет чекбоксом — теперь и панель умеет.
  // Два экрана об одном и том же обязаны говорить одно и то же, иначе доверия нет ни одному.
  const SILENT_CLASSES = ['bounce_notification', 'ooo', 'unsubscribe', 'negative'];
  const waiting = await p.query(
    `SELECT r.contact_id, c.full_name, max(r.occurred_at) AS at,
            bool_or(c.sources @> '["zero-run"]'::jsonb) AS is_test
       FROM touch r JOIN contact c ON c.id = r.contact_id
      WHERE r.event = 'replied' AND r.occurred_at < now() - ($1 || ' hours')::interval
        AND COALESCE(r.meta->>'import', '') <> 'true'
        AND COALESCE(c.conversation_state, 'open') <> 'closed'
        AND COALESCE(r.meta->>'classification', '') <> ALL($2::text[])
        AND EXISTS (SELECT 1 FROM campaign camp WHERE camp.external_id = r.campaign_ext_id)
        AND NOT EXISTS (SELECT 1 FROM touch o WHERE o.contact_id = r.contact_id
                          AND o.occurred_at > r.occurred_at
                          AND o.event IN ('manual_reply', 'message_sent', 'message_followup', 'sent'))
      GROUP BY r.contact_id, c.full_name`,
    [String(t.reply_waiting_hours), SILENT_CLASSES],
  );
  for (const r of waiting.rows) {
    push({
      code: 'reply_waiting', level: LEVEL.red, contactId: r.contact_id, isTest: r.is_test,
      title: `${r.full_name || `#${r.contact_id}`}: ждёт нашего ответа`,
      detail: `Последнее входящее ${new Date(r.at).toLocaleString('ru-RU')}, исходящего после него нет.`,
      source: 'наши записи переписки (ответ мимо системы сюда не попадёт)',
    });
  }

  // 7. Модель не поняла ответ — нужен человек.
  const unclear = await p.query(
    `SELECT t.contact_id, c.full_name, t.occurred_at,
            (c.sources @> '["zero-run"]'::jsonb) AS is_test
       FROM touch t JOIN contact c ON c.id = t.contact_id
      WHERE t.event = 'replied' AND t.meta->>'classification' = 'unclear'
        AND COALESCE(t.meta->>'import', '') <> 'true'
        AND COALESCE(c.conversation_state, 'open') <> 'closed'
        AND COALESCE(t.meta->>'classified_by', 'model') <> 'human'`,
  );
  for (const r of unclear.rows) {
    push({
      code: 'reply_unclear', level: LEVEL.yellow, contactId: r.contact_id, isTest: r.is_test,
      title: `${r.full_name || `#${r.contact_id}`}: модель не поняла ответ`,
      detail: 'Классификацию нужно поставить руками — от неё зависят карантин и запись в CRM.',
      source: 'суждение классификатора (не факт)',
    });
  }

  // 8. Барьер протух: стоп-лист на старых данных даёт ложное чувство защиты.
  const synced = await getState('crm_sync_day');
  const barrier = await p.query(
    `SELECT max(updated_at) AS at FROM crm_block`,
  ).catch(() => ({ rows: [{ at: null }] }));
  const barrierAt = barrier.rows[0]?.at ? new Date(barrier.rows[0].at) : null;
  if (barrierAt && Date.now() - barrierAt.getTime() > t.barrier_stale_hours * 36e5) {
    push({
      code: 'barrier_stale', level: LEVEL.red,
      title: `Стоп-лист Kommo не обновлялся ${Math.floor((Date.now() - barrierAt.getTime()) / 36e5)} ч`,
      detail: 'Барьер на протухших данных пропустит тёплого человека в холодную волну.',
      source: `время последней записи стоп-листа${synced ? ` (отметка дня: ${synced})` : ''}`,
    });
  }

  // 9–10. Здоровье аккаунтов — единственная часть, требующая живого вызова GetSales.
  //       Профили смотрим только те, что участвуют в открытых волнах: чужие нас не касаются.
  const active = await p.query(
    `SELECT DISTINCT jsonb_object_keys(COALESCE(meta->'getsales'->'sender_flows', '{}'::jsonb)) AS uuid
       FROM campaign WHERE channel = 'linkedin' AND status = 'active'`,
  ).catch(() => ({ rows: [] }));
  const used = new Set(active.rows.map((r) => r.uuid));
  if (used.size && gs.getsalesEnabled()) {
    const [profiles, accounts] = await Promise.all([
      gs.listSenderProfiles().catch(() => []),
      gs.linkedinAccounts().catch(() => []),
    ]);
    const nameOf = Object.fromEntries(profiles.map((x) => [x.uuid, [x.first_name, x.last_name].filter(Boolean).join(' ')]));
    for (const a of accounts) {
      if (!used.has(a.sender_profile_uuid)) continue;
      const beat = a.last_tasks_heartbeat_at || a.last_messages_heartbeat_at;
      const ageDays = beat ? Math.floor((Date.now() - new Date(beat).getTime()) / 864e5) : null;
      if (ageDays == null || ageDays > t.heartbeat_stale_days) {
        push({
          code: 'no_heartbeat', level: LEVEL.red,
          title: `${nameOf[a.sender_profile_uuid] || 'профиль'}: нет пульса автоматизации${ageDays != null ? ` ${ageDays} дн.` : ''}`,
          detail: 'Аккаунт выглядит отключённым в GetSales — касания с него не пойдут. Переподключить сессию LinkedIn.',
          source: 'last_tasks_heartbeat_at аккаунта в GetSales',
        });
      }
      const wl = a.last_connection_weekly_limit_at ? new Date(a.last_connection_weekly_limit_at) : null;
      if (wl && Date.now() - wl.getTime() < 7 * 864e5) {
        push({
          code: 'weekly_limit', level: LEVEL.red,
          title: `${nameOf[a.sender_profile_uuid] || 'профиль'}: упёрся в недельный лимит заявок LinkedIn`,
          detail: `Последний раз ${wl.toLocaleDateString('ru-RU')}. Снизить дневной потолок; вернуть прежний — через 7 дней без повторов.`,
          source: 'last_connection_weekly_limit_at аккаунта в GetSales',
        });
      }
    }
  }

  // Прячем принятые в работу — но только пока не истёк срок: причина никуда не делась.
  const taken = await acks();
  const now = Date.now();
  const visible = out.filter((x) => {
    const a = taken[problemKey(x)];
    return !(a && new Date(a.until).getTime() > now);
  }).map((x) => ({ ...x, key: problemKey(x) }));
  const order = { red: 0, yellow: 1, grey: 2 };
  return visible.sort((a, b) => order[a.level] - order[b.level]);
}
