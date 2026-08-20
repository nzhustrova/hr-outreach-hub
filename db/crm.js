// Барьер CRM: хранение стоп-листа и проверка контактов (ТЗ п.28).
// Задача Тони: лид на подписании контракта получил холодное письмо и счёл это бардаком.
// Барьер отвечает на вопрос «трогали ли этого человека», а не «работают ли с ним прямо сейчас»,
// поэтому спящая воронка Pipeline тоже читается — там 3 600 адресов, которым уже писали.
import { getPool, registryEnabled } from './registry.js';

// Блок протухает: контакт, которого не трогали три месяца, перестаёт быть «занятым»
// (решение Ольги 13.08). Срок тот же, что у нашего собственного карантина после кампании —
// одно правило на обе стороны: и своих, и чужих не трогаем три месяца.
// ⚠️ Тёплые этапы (встречи и дальше) не освобождаются НИКОГДА: писать холодное письмо тому,
// с кем обсуждали контракт, неловко и через год, а таких всего полторы сотни адресов.
export const BLOCK_STALE_MONTHS = 3;

const FRESH_SQL = (alias = 'b') => `(${alias}.is_warm
  OR ${alias}.last_activity_at IS NULL
  OR ${alias}.last_activity_at > now() - interval '${BLOCK_STALE_MONTHS} months')`;

/** Полная перезамена стоп-листа в одной транзакции: половинчатый список хуже отсутствующего. */
export async function replaceCrmBlocklist(rows) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM crm_block');
    for (const r of rows) {
      await client.query(
        `INSERT INTO crm_block (email, domain, level, pipeline_id, pipeline_name, stage_name, lead_id,
           contact_name, company, last_activity_at, is_warm, note_count, linkedin_slug, owner, worked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [r.email, r.domain, r.level, r.pipelineId, r.pipelineName, r.stageName, r.leadId,
         r.contactName || null, r.company || null, r.lastActivityAt || null, Boolean(r.isWarm),
         Number(r.noteCount) || 0, r.linkedinSlug || null, r.owner || null, r.workedBy || null],
      );
    }
    const emails = new Set(rows.map((r) => r.email).filter(Boolean)).size;
    const domains = new Set(rows.filter((r) => r.domain).map((r) => r.domain)).size;
    const slugs = new Set(rows.map((r) => r.linkedinSlug).filter(Boolean)).size;
    await client.query(
      `INSERT INTO crm_sync_state (id, last_ok_at, last_error, emails, domains, slugs)
       VALUES (1, now(), NULL, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET last_ok_at = now(), last_error = NULL, emails = $1, domains = $2, slugs = $3`,
      [emails, domains, slugs],
    );
    await client.query('COMMIT');
    return { rows: rows.length, emails, domains, slugs };
  } catch (e) {
    await client.query('ROLLBACK');
    await getPool().query(
      `INSERT INTO crm_sync_state (id, last_error) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET last_error = $1`,
      [String(e.message || e)],
    ).catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Ручное снятие адреса. Ровно то же условие, что и в `blockedContactIds`, — счётчик на экране
// обязан считать по тем же правилам, по которым отбор реально пропускает контакт.
const HAND_ALLOWED_SQL = (alias = 'b') => `EXISTS (
  SELECT 1 FROM crm_block_override o
   WHERE o.subject = ${alias}.email AND o.kind = 'email'
     AND o.action = 'allow' AND o.revoked_at IS NULL)`;

/**
 * Записать сбой синхронизации в состояние, которое читает интерфейс.
 * Отдельная функция, потому что упасть можно ДО записи в базу — на выгрузке из Kommo,
 * и тогда `replaceCrmBlocklist` со своим catch даже не начинал работать.
 */
export async function noteSyncFailure(err) {
  if (!registryEnabled()) return;
  await getPool().query(
    `INSERT INTO crm_sync_state (id, last_error) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_error = $1`,
    [String(err?.message || err).slice(0, 500)],
  );
}

/** Сколько записей блокирует ФАКТИЧЕСКИ — после правил этапа, давности и ручных снятий. */
export async function effectiveBlockCounts() {
  const r = await getPool().query(
    `SELECT COUNT(DISTINCT b.email) AS emails,
            COUNT(DISTINCT b.domain) FILTER (WHERE b.domain IS NOT NULL) AS domains,
            COUNT(DISTINCT b.linkedin_slug) FILTER (WHERE b.linkedin_slug IS NOT NULL) AS slugs,
            COUNT(DISTINCT b.email) FILTER (WHERE NOT ${FRESH_SQL('b')}) AS released_by_age,
            COUNT(DISTINCT b.email) FILTER (WHERE NOT ${stageAllowSql('b')}) AS released_by_stage,
            COUNT(DISTINCT b.email) FILTER (WHERE ${HAND_ALLOWED_SQL('b')}) AS released_by_hand
       FROM crm_block b`,
  );
  // ⚠️ Ручные снятия раньше здесь НЕ учитывались: человек убирал сорок адресов кнопкой,
  // а заголовок показывал прежнее число (найдено 13.08 при проверке массового снятия).
  const eff = await getPool().query(
    `SELECT COUNT(DISTINCT b.email) AS emails,
            COUNT(DISTINCT b.domain) FILTER (WHERE b.domain IS NOT NULL) AS domains,
            COUNT(DISTINCT b.linkedin_slug) FILTER (WHERE b.linkedin_slug IS NOT NULL) AS slugs
       FROM crm_block b
      WHERE ${stageAllowSql('b')} AND ${FRESH_SQL('b')} AND NOT ${HAND_ALLOWED_SQL('b')}`,
  );
  return {
    total_emails: Number(r.rows[0].emails), total_domains: Number(r.rows[0].domains),
    total_slugs: Number(r.rows[0].slugs),
    released_by_age: Number(r.rows[0].released_by_age), released_by_stage: Number(r.rows[0].released_by_stage),
    released_by_hand: Number(r.rows[0].released_by_hand),
    effective_emails: Number(eff.rows[0].emails), effective_domains: Number(eff.rows[0].domains),
    effective_slugs: Number(eff.rows[0].slugs),
    stale_months: BLOCK_STALE_MONTHS,
  };
}

export async function crmSyncState() {
  if (!registryEnabled()) return null;
  const r = await getPool().query('SELECT * FROM crm_sync_state WHERE id = 1');
  const s = r.rows[0] || null;
  if (!s) return { last_ok_at: null, stale: true, emails: 0, domains: 0 };
  const ageH = s.last_ok_at ? (Date.now() - new Date(s.last_ok_at)) / 36e5 : Infinity;
  // Барьер на устаревших данных даёт ложное чувство защиты — это хуже, чем его отсутствие.
  return { ...s, stale: ageH > 24, age_hours: Math.round(ageH) };
}

/**
 * Проверка набора адресов и доменов против стоп-листа.
 * Домены проверяем только против записей уровня `domain` — то есть только «тёплых» компаний,
 * где идёт живой разговор. Расширять доменный блок на ранние этапы нельзя: это 2 451 домен,
 * половина американского ICP из-за одной старой карточки.
 */
/** Снятые этапы: «Pipeline / IN process» → правило. Применяется на лету, поэтому переживает
 *  синхронизацию и остаётся верным, даже когда состав этапа полностью сменится. */
export async function activeStageRules() {
  if (!registryEnabled()) return [];
  const r = await getPool().query(
    `SELECT id, pipeline_name, stage_name, action, reason, actor, created_at
       FROM crm_block_rule WHERE revoked_at IS NULL`,
  );
  return r.rows;
}

function stageAllowSql(alias = 'b') {
  return `NOT EXISTS (SELECT 1 FROM crm_block_rule r
            WHERE r.revoked_at IS NULL AND r.action = 'allow'
              AND r.pipeline_name = ${alias}.pipeline_name AND r.stage_name = ${alias}.stage_name)`;
}

export async function setStageRule({ pipelineName, stageName, action = 'allow', reason, actor }) {
  if (!pipelineName || !stageName || !reason) throw new Error('нужны воронка, этап и причина');
  const r = await getPool().query(
    `INSERT INTO crm_block_rule (pipeline_name, stage_name, action, reason, actor)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (pipeline_name, stage_name) DO UPDATE SET action = $3, reason = $4, actor = $5,
       created_at = now(), revoked_at = NULL, revoked_by = NULL
     RETURNING *`,
    [pipelineName, stageName, action, String(reason).trim(), actor || 'unknown'],
  );
  return r.rows[0];
}

export async function revokeStageRule(id, actor) {
  const r = await getPool().query(
    `UPDATE crm_block_rule SET revoked_at = now(), revoked_by = $2 WHERE id = $1 RETURNING *`,
    [Number(id), actor || 'unknown'],
  );
  return r.rows[0];
}

/** Разбивка по этапам — чтобы этап можно было снять целиком, видя, скольких это касается. */
export async function blocklistByStage() {
  const r = await getPool().query(
    // Считаем ЛЮДЕЙ, а не строки: у части людей в Kommo несколько карточек, и число на
    // кнопке «show these N» иначе не сходилось бы с длиной открывшегося списка.
    // Разрез по ВЛАДЕЛЬЦУ (L5.10): стоп-лист разбирают Стас и Шикхар, каждый — своё
    // («я свои контакты знаю и легко отмечу, а контакты Шикхара я не знаю»).
    // Ключ человека — адрес, а для LinkedIn-only записей (email NULL) — slug. Тот же ключ,
    // что в listBlocklist: иначе счётчик на кнопке («42 to review») расходился с открывшимся
    // списком (45), потому что людей без адреса COUNT(DISTINCT email) просто не видел.
    `SELECT b.pipeline_name, b.stage_name, COALESCE(b.owner, '—') AS owner,
            COUNT(DISTINCT COALESCE(b.email, 'linkedin:' || b.linkedin_slug)) AS n,
            COUNT(DISTINCT b.domain) FILTER (WHERE b.domain IS NOT NULL) AS domains,
            -- Разрез по наличию переписки: этап целиком снимают, глядя на «немых»,
            -- а карточки с записями смотрят глазами (идея Ольги 13.08).
            COUNT(DISTINCT COALESCE(b.email, 'linkedin:' || b.linkedin_slug)) FILTER (WHERE b.note_count > 0) AS with_notes,
            COUNT(DISTINCT b.lead_id) FILTER (WHERE b.note_count > 0) AS cards_with_notes,
            (SELECT r.id FROM crm_block_rule r
              WHERE r.revoked_at IS NULL AND r.action='allow'
                AND r.pipeline_name=b.pipeline_name AND r.stage_name=b.stage_name) AS allow_rule_id,
            (SELECT r.reason FROM crm_block_rule r
              WHERE r.revoked_at IS NULL AND r.action='allow'
                AND r.pipeline_name=b.pipeline_name AND r.stage_name=b.stage_name) AS allow_reason,
            (SELECT r.actor FROM crm_block_rule r
              WHERE r.revoked_at IS NULL AND r.action='allow'
                AND r.pipeline_name=b.pipeline_name AND r.stage_name=b.stage_name) AS allow_actor
       FROM crm_block b GROUP BY b.pipeline_name, b.stage_name, COALESCE(b.owner, '—')
      -- Строки одного этапа держим РЯДОМ (просьба Ольги 14.08): сортируем этапы по их
      -- суммарному размеру, а внутри этапа — владельцев по убыванию. Иначе «IN process /
      -- Шикхар (3399)» и «IN process / Стас (3)» разъезжались в разные концы таблицы.
      ORDER BY SUM(COUNT(DISTINCT COALESCE(b.email, 'linkedin:' || b.linkedin_slug)))
                 OVER (PARTITION BY b.pipeline_name, b.stage_name) DESC,
               b.pipeline_name, b.stage_name, n DESC`,
  );
  return r.rows;
}

/** Активные ручные правки: subject → {action, reason, actor}. */
export async function activeOverrides(subjects = []) {
  if (!registryEnabled() || !subjects.length) return {};
  const r = await getPool().query(
    `SELECT subject, kind, action, reason, actor, created_at FROM crm_block_override
      WHERE revoked_at IS NULL AND subject = ANY($1::text[])`,
    [subjects.map((x) => String(x).trim().toLowerCase())],
  );
  return Object.fromEntries(r.rows.map((x) => [x.subject, x]));
}

export async function checkBlocked({ emails = [], domains = [], slugs = [] } = {}) {
  if (!registryEnabled() || (!emails.length && !domains.length && !slugs.length)) return { emails: {}, domains: {}, slugs: {} };
  const out = { emails: {}, domains: {}, slugs: {} };
  // Ручные правки применяются ПОВЕРХ машинного списка (вопрос Ольги 13.08): человек может
  // и снять блок («это не тот лид»), и поставить его руками («с ним идут переговоры вне CRM»).
  const ov = await activeOverrides([...emails, ...domains, ...slugs].map((x) => String(x).toLowerCase()));

  if (emails.length) {
    const r = await getPool().query(
      `SELECT DISTINCT ON (email) email, level, pipeline_name, stage_name
         FROM crm_block b WHERE email = ANY($1::text[]) AND ${stageAllowSql('b')} AND ${FRESH_SQL('b')}
         ORDER BY email, level DESC`,
      [emails.map((e) => String(e).trim().toLowerCase())],
    );
    for (const row of r.rows) out.emails[row.email] = { reason: `${row.stage_name} · ${row.pipeline_name}` };
  }
  for (const e of emails.map((x) => String(x).trim().toLowerCase())) {
    const o = ov[e];
    if (!o) continue;
    if (o.action === 'allow') delete out.emails[e];
    if (o.action === 'block') out.emails[e] = { reason: `added by ${o.actor}: ${o.reason}`, manual: true };
  }
  if (domains.length) {
    const r = await getPool().query(
      `SELECT DISTINCT ON (domain) domain, pipeline_name, stage_name
         FROM crm_block b WHERE domain = ANY($1::text[]) AND ${stageAllowSql('b')} AND ${FRESH_SQL('b')}
         ORDER BY domain`,
      [domains.map((d) => String(d).trim().toLowerCase())],
    );
    for (const row of r.rows) out.domains[row.domain] = { reason: `${row.stage_name} · ${row.pipeline_name}` };
  }
  for (const d of domains.map((x) => String(x).trim().toLowerCase())) {
    const o = ov[d];
    if (!o) continue;
    if (o.action === 'allow') delete out.domains[d];
    if (o.action === 'block') out.domains[d] = { reason: `added by ${o.actor}: ${o.reason}`, manual: true };
  }
  // Второй ключ (L1.2): проверка выдачи поиска по LinkedIn — единственный путь для людей без почты.
  if (slugs.length) {
    const r = await getPool().query(
      `SELECT DISTINCT ON (linkedin_slug) linkedin_slug, pipeline_name, stage_name
         FROM crm_block b WHERE linkedin_slug = ANY($1::text[]) AND ${stageAllowSql('b')} AND ${FRESH_SQL('b')}
         ORDER BY linkedin_slug`,
      [slugs.map((s) => String(s).trim().toLowerCase())],
    );
    for (const row of r.rows) out.slugs[row.linkedin_slug] = { reason: `${row.stage_name} · ${row.pipeline_name}` };
  }
  for (const s of slugs.map((x) => String(x).trim().toLowerCase())) {
    const o = ov[s];
    if (!o) continue;
    if (o.action === 'allow') delete out.slugs[s];
    if (o.action === 'block') out.slugs[s] = { reason: `added by ${o.actor}: ${o.reason}`, manual: true };
  }
  return out;
}

/** Отсев контактов реестра перед отправкой — используется pre-flight'ом. */
export async function blockedContactIds(contactIds = []) {
  if (!registryEnabled() || !contactIds.length) return [];
  // Машинный список минус снятые вручную плюс поставленные вручную — одним запросом,
  // чтобы pre-flight и экран показывали одно и то же.
  // Снятие вручную — по адресу, домену ИЛИ LinkedIn: «этого человека можно» и «эту компанию
  // можно» одинаково должны отпускать pre-flight.
  const ALLOWED = `EXISTS (SELECT 1 FROM crm_block_override o
      WHERE o.action = 'allow' AND o.revoked_at IS NULL
        AND ((o.kind = 'email'  AND o.subject = lower(c.email))
          OR (o.kind = 'domain' AND o.subject = split_part(lower(c.email), '@', 2))
          OR (o.kind = 'linkedin' AND o.subject = c.linkedin_slug)))`;
  const r = await getPool().query(
    `SELECT c.id, b.stage_name, b.pipeline_name, NULL AS manual_reason
       FROM contact c
       JOIN crm_block b ON b.email = lower(c.email) AND ${stageAllowSql('b')} AND ${FRESH_SQL('b')}
      WHERE c.id = ANY($1::int[]) AND NOT ${ALLOWED}
      UNION
     -- Доменный блок на pre-flight не проверялся вовсе (найдено 13.08). Дыра реальная:
     -- коллегу тёплого лида не пускает поиск, но контакт, попавший в реестр РАНЬШЕ блокировки,
     -- доходил до отправки. Ручной доменный блок по той же причине ничего не давал.
     SELECT c.id, b.stage_name, b.pipeline_name, NULL AS manual_reason
       FROM contact c
       JOIN crm_block b ON b.domain = split_part(lower(c.email), '@', 2)
                       AND ${stageAllowSql('b')} AND ${FRESH_SQL('b')}
      WHERE c.id = ANY($1::int[]) AND NOT ${ALLOWED}
      UNION
     -- Второй ключ (L1.2): контакт ловится и по LinkedIn — обязательное условие для
     -- LinkedIn-only людей (у них email NULL, и обе ветки выше их не видят вовсе).
     SELECT c.id, b.stage_name, b.pipeline_name, NULL AS manual_reason
       FROM contact c
       JOIN crm_block b ON b.linkedin_slug = c.linkedin_slug
                       AND ${stageAllowSql('b')} AND ${FRESH_SQL('b')}
      WHERE c.id = ANY($1::int[]) AND c.linkedin_slug IS NOT NULL AND NOT ${ALLOWED}
      UNION
     SELECT c.id, 'manual' AS stage_name, o.actor AS pipeline_name, o.reason AS manual_reason
       FROM contact c
       JOIN crm_block_override o
              ON o.action = 'block' AND o.revoked_at IS NULL
             AND ((o.kind = 'email'  AND o.subject = lower(c.email))
               OR (o.kind = 'domain' AND o.subject = split_part(lower(c.email), '@', 2))
               OR (o.kind = 'linkedin' AND o.subject = c.linkedin_slug))
      WHERE c.id = ANY($1::int[])`,
    [contactIds.map(Number)],
  );
  return r.rows;
}

/**
 * Пропускает сырые попадания живой проверки через ТЕ ЖЕ правила снятия, что и ночной список:
 * снятый целиком этап, ручное разрешение, протухание блока через 3 месяца.
 *
 * Без этого шага живая проверка была строже ночного барьера и молча отменяла обе наши
 * поблажки: контакт, освобождённый кнопкой «release this stage» или правилом давности,
 * проходил отбор и умирал на запуске с сообщением «moved in the CRM today», хотя ничего
 * сегодня не двигалось (найдено аудитом 13.08).
 */
export async function filterLiveHits(hits = []) {
  if (!hits.length) return [];
  if (!registryEnabled()) return hits;
  const [rules, allows, cut] = await Promise.all([
    getPool().query(
      `SELECT pipeline_name, stage_name FROM crm_block_rule
        WHERE revoked_at IS NULL AND action = 'allow'`,
    ),
    getPool().query(
      // Оба вида ручного снятия: адрес (kind='email') и LinkedIn (kind='linkedin', L1.2).
      `SELECT subject FROM crm_block_override
        WHERE revoked_at IS NULL AND action = 'allow' AND kind IN ('email', 'linkedin')`,
    ),
    // Порог давности спрашиваем у БД тем же выражением, что и `FRESH_SQL`. Считать «90 дней»
    // в JS нельзя: `interval '3 months'` — календарные месяцы, и на границе два способа
    // расходились на пару суток, то есть один адрес был протухшим для живой проверки
    // и свежим для ночного списка (поймано тестом 13.08).
    getPool().query(`SELECT now() - interval '${BLOCK_STALE_MONTHS} months' AS cutoff`),
  ]);
  const released = new Set(rules.rows.map((r) => `${r.pipeline_name} :: ${r.stage_name}`));
  const allowed = new Set(allows.rows.map((r) => String(r.subject).toLowerCase()));
  const staleBefore = new Date(cut.rows[0].cutoff).getTime();
  return hits.filter((h) => {
    // Попадание живой проверки несёт email (checkEmailsLive) или slug (checkLinkedinLive).
    const key = h.email || h.slug;
    if (key && allowed.has(String(key).toLowerCase())) return false;
    if (released.has(`${h.pipeline} :: ${h.stage}`)) return false;
    // Тёплые этапы (встреча и дальше) не протухают никогда — это решение 13.08.
    if (!h.isWarm && h.lastActivityAt && new Date(h.lastActivityAt).getTime() < staleBefore) return false;
    return true;
  });
}

/** Просмотр самого стоп-листа с поиском и правками — вкладка Settings. */
export async function listBlocklist({ q = '', level = null, pipeline = null, stage = null, notes = null, owner = null, limit = 100, offset = 0 } = {}) {
  const params = [];
  const conds = [];
  // Фильтр «мои карточки» (L5.10): Стас и Шикхар разбирают каждый своё.
  if (owner) { params.push(owner); conds.push(`COALESCE(b.owner, '—') = $${params.length}`); }
  // Ищем и по имени с компанией: человек ищет «Novelis», а не адрес по буквам.
  if (q) {
    params.push(`%${String(q).toLowerCase()}%`);
    conds.push(`(b.email LIKE $${params.length} OR b.domain LIKE $${params.length}
                 OR b.linkedin_slug LIKE $${params.length}
                 OR lower(COALESCE(b.contact_name,'')) LIKE $${params.length}
                 OR lower(COALESCE(b.company,'')) LIKE $${params.length})`);
  }
  if (level) { params.push(level); conds.push(`b.level = $${params.length}`); }
  if (pipeline) { params.push(pipeline); conds.push(`b.pipeline_name = $${params.length}`); }
  // Фильтр по ЭТАПУ (просьба Ольги 13.08, добавлен 13.08 после её вопроса «где он?»).
  // Без него вопрос «кто у нас блокируется из-за Initial contact» приходилось решать
  // прокруткой сотни строк, а именно на этот вопрос отвечают, когда решают снять этап.
  if (stage) { params.push(stage); conds.push(`b.stage_name = $${params.length}`); }
  // «Только с перепиской» / «только без». Разрез, ради которого и заведён note_count.
  if (notes === 'yes') conds.push('b.note_count > 0');
  if (notes === 'no') conds.push('b.note_count = 0');
  params.push(Math.min(Number(limit) || 100, 500));
  params.push(Number(offset) || 0);
  // Схлопываем по человеку. В `crm_block` строка на КАЖДУЮ карточку Kommo, а у одного человека
  // карточек бывает несколько (в выгрузке 4215 строк на 4175 адресов — в CRM есть дубли).
  // Ключ группировки — адрес, а для LinkedIn-only записей (email NULL, L1.2) — slug:
  // иначе все «безадресные» люди схлопнулись бы в одну строку NULL.
  const KEY = `COALESCE(b.email, 'linkedin:' || b.linkedin_slug)`;
  const rows = await getPool().query(
    `SELECT MAX(b.email) AS email,
            MAX(b.owner) AS owner,
            MAX(b.worked_by) AS worked_by,
            MAX(b.linkedin_slug) AS linkedin_slug,
            MAX(b.domain) AS domain,
            MAX(b.contact_name) AS contact_name,
            MAX(b.company) AS company,
            MAX(b.last_activity_at) AS last_activity_at,
            MAX(b.note_count) AS note_count,
            bool_or(b.is_warm) AS is_warm,
            COUNT(*) AS cards,
            string_agg(DISTINCT b.stage_name || ' · ' || b.pipeline_name, '; ') AS places,
            -- Адрес освобождён давностью, только если протухли ВСЕ его карточки:
            -- одной живой достаточно, чтобы блокировка осталась.
            bool_and(NOT ${FRESH_SQL('b')}) AS released_by_age,
            MAX(o.action) AS override_action, MAX(o.reason) AS override_reason,
            MAX(o.actor) AS override_actor, MAX(o.created_at) AS override_at
       FROM crm_block b
       LEFT JOIN crm_block_override o
              ON o.revoked_at IS NULL
             AND ((o.kind = 'email' AND o.subject = b.email)
               OR (o.kind = 'linkedin' AND o.subject = b.linkedin_slug))
      ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      GROUP BY ${KEY}
      ORDER BY MAX(b.pipeline_name), MAX(b.stage_name), ${KEY}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = await getPool().query(
    `SELECT COUNT(DISTINCT ${KEY}) AS n FROM crm_block b ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}`,
    params.slice(0, params.length - 2),
  );
  // Ручные добавления показываем отдельно: их нет в машинном списке.
  const manual = await getPool().query(
    `SELECT id, subject, kind, action, reason, actor, created_at FROM crm_block_override
      WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 200`,
  );
  // Разбивка по воронкам — чтобы было видно, что список не состоит из одной Pipeline
  // (она просто идёт первой по алфавиту и занимает всю первую страницу).
  const byPipeline = await getPool().query(
    `SELECT pipeline_name, COUNT(DISTINCT email) AS n FROM crm_block GROUP BY 1 ORDER BY n DESC`,
  );
  return { rows: rows.rows, total: Number(total.rows[0].n), manual: manual.rows, byPipeline: byPipeline.rows };
}

export async function setOverride({ subject, kind = 'email', action, reason, actor }) {
  if (!subject || !reason) throw new Error('нужны адрес и причина');
  if (!['allow', 'block'].includes(action)) throw new Error('action: allow | block');
  const r = await getPool().query(
    `INSERT INTO crm_block_override (subject, kind, action, reason, actor)
     VALUES (lower($1), $2, $3, $4, $5)
     ON CONFLICT (subject, kind) DO UPDATE SET action = $3, reason = $4, actor = $5,
       created_at = now(), revoked_at = NULL, revoked_by = NULL
     RETURNING *`,
    [String(subject).trim(), kind, action, String(reason).trim(), actor || 'unknown'],
  );
  return r.rows[0];
}

/**
 * Массовое снятие по текущему фильтру списка (просьба Ольги 13.08).
 *
 * Отличается от правила этапа осознанно: правило переживает синхронизацию и подхватывает
 * НОВЫХ людей, попавших на тот же этап, а это — разовое решение про конкретных людей,
 * которых человек видел на экране. Для «Closed - lost» верно как раз второе: этап останется
 * значимым, а вот эти 44 проигранные сделки годичной давности трогать уже можно.
 *
 * Причина пишется каждому адресу отдельно, поэтому в списке ручных правок видно, кто и почему,
 * и любую строку можно отозвать по одной.
 */
export async function bulkOverride({ pipeline = null, stage = null, q = '', notes = null, owner = null, action = 'allow', reason, actor }) {
  if (!reason || !String(reason).trim()) throw new Error('нужна причина');
  if (!['allow', 'block'].includes(action)) throw new Error('action: allow | block');
  if (!pipeline && !stage && !String(q).trim()) throw new Error('нужен хотя бы один фильтр — «снять всех» кнопкой не делаем');
  const params = [];
  const conds = [];
  if (String(q).trim()) {
    params.push(`%${String(q).toLowerCase()}%`);
    conds.push(`(b.email LIKE $${params.length} OR b.domain LIKE $${params.length}
                 OR b.linkedin_slug LIKE $${params.length}
                 OR lower(COALESCE(b.contact_name,'')) LIKE $${params.length}
                 OR lower(COALESCE(b.company,'')) LIKE $${params.length})`);
  }
  if (pipeline) { params.push(pipeline); conds.push(`b.pipeline_name = $${params.length}`); }
  if (stage) { params.push(stage); conds.push(`b.stage_name = $${params.length}`); }
  // Массовое снятие обязано уметь исключать карточки с перепиской — иначе кнопка «снять
  // 3402» задела бы те 18, ради которых весь разрез и придуман.
  if (notes === 'yes') conds.push('b.note_count > 0');
  if (notes === 'no') conds.push('b.note_count = 0');
  if (owner) { params.push(owner); conds.push(`COALESCE(b.owner, '—') = $${params.length}`); }
  params.push(action, String(reason).trim(), actor || 'unknown');
  const r = await getPool().query(
    // Людей без адреса (LinkedIn-only записи, email NULL) снимаем по slug — иначе кнопка
    // «release N silent» молча пропускала бы их, хотя счётчик их обещал (найдено 14.08).
    `INSERT INTO crm_block_override (subject, kind, action, reason, actor)
     SELECT DISTINCT b.email, 'email', $${params.length - 2}, $${params.length - 1}, $${params.length}
       FROM crm_block b
      WHERE b.email IS NOT NULL AND ${conds.join(' AND ')}
     UNION
     SELECT DISTINCT b.linkedin_slug, 'linkedin', $${params.length - 2}, $${params.length - 1}, $${params.length}
       FROM crm_block b
      WHERE b.email IS NULL AND b.linkedin_slug IS NOT NULL AND ${conds.join(' AND ')}
     ON CONFLICT (subject, kind) DO UPDATE SET action = EXCLUDED.action, reason = EXCLUDED.reason,
       actor = EXCLUDED.actor, created_at = now(), revoked_at = NULL, revoked_by = NULL
     RETURNING subject`,
    params,
  );
  return { affected: r.rowCount, subjects: r.rows.map((x) => x.subject) };
}

export async function revokeOverride(id, actor) {
  const r = await getPool().query(
    `UPDATE crm_block_override SET revoked_at = now(), revoked_by = $2 WHERE id = $1 RETURNING *`,
    [Number(id), actor || 'unknown'],
  );
  return r.rows[0];
}
