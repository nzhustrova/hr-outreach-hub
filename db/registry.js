// Реестр контактов: Postgres-слой. Без DATABASE_URL работает как «не сконфигурирован» (503) —
// локальная разработка панели не требует БД; боевой реестр живёт на Railway.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPool as setWebhookPool } from './webhooks.js';
import { localDbEnabled, createLocalPool } from './localdb.js';
import { linkedinSlug } from '../linkedin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pool = null;

export function registryEnabled() {
  return Boolean(process.env.DATABASE_URL) || localDbEnabled();
}

export function getPool() {
  return pool;
}

export async function initRegistry() {
  if (!registryEnabled()) {
    console.log('[registry] DATABASE_URL not set — registry disabled (local mode)');
    return;
  }
  // Локальная разработка: LOCAL_DB=1 поднимает встроенный Postgres (PGlite) вместо Railway.
  // Схема применяется внутри createLocalPool, поэтому дальше идём общим путём.
  if (localDbEnabled()) {
    pool = await createLocalPool();
    setWebhookPool(pool);
    console.log('[registry] локальная база (PGlite), схема применена');
    return;
  }
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  setWebhookPool(pool);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[registry] schema ensured');
}

// Сохранение шорт-листа: сегмент + контакты (upsert по identity_key) + мэтчи со снапшотом сигналов.
export async function saveShortlist({ segmentName, criteria, signalsSnapshot, items }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Дедуп сегментов (08.08): повторное сохранение того же каркаса переиспользует запись,
    // иначе выпадашка сегментов в кампаниях забивается копиями одного и того же поиска.
    const existing = await client.query(
      `SELECT id FROM segment WHERE name = $1 AND criteria = $2::jsonb ORDER BY id LIMIT 1`,
      [segmentName, JSON.stringify(criteria)],
    );
    const segmentId = existing.rows.length
      ? existing.rows[0].id
      : (await client.query(
        'INSERT INTO segment (name, criteria) VALUES ($1, $2) RETURNING id',
        [segmentName, criteria],
      )).rows[0].id;
    let saved = 0;
    for (const it of items) {
      const c = await client.query(
        `INSERT INTO contact (identity_key, first_name, last_name, full_name, title, company,
           company_domain, company_size, company_geo, company_industry, location,
           linkedin_url, email, source_email_status, sources, raw, unique_detail,
           liveness, liveness_note, liveness_checked_at, company_revenue, linkedin_slug)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19, CASE WHEN $18::text IS NULL THEN NULL ELSE now() END, $20, $21)
         ON CONFLICT (identity_key) DO UPDATE SET
           email = COALESCE(EXCLUDED.email, contact.email),
           linkedin_url = COALESCE(EXCLUDED.linkedin_url, contact.linkedin_url),
           linkedin_slug = COALESCE(EXCLUDED.linkedin_slug, contact.linkedin_slug),
           -- Заявка источника («verified» от Apollo) — отдельно от нашего email_status:
           -- это разные знания (ТЗ п.31). Смена адреса сбрасывает нашу проверку.
           source_email_status = COALESCE(EXCLUDED.source_email_status, contact.source_email_status),
           email_verified_at = CASE WHEN EXCLUDED.email IS DISTINCT FROM contact.email
                                    THEN NULL ELSE contact.email_verified_at END,
           email_status = CASE WHEN EXCLUDED.email IS DISTINCT FROM contact.email
                               THEN NULL ELSE contact.email_status END,
           title = COALESCE(EXCLUDED.title, contact.title),
           unique_detail = COALESCE(EXCLUDED.unique_detail, contact.unique_detail),
           -- Вердикт живости не затираем пустым: разведка могла не запускаться.
           liveness = COALESCE(EXCLUDED.liveness, contact.liveness),
           liveness_note = COALESCE(EXCLUDED.liveness_note, contact.liveness_note),
           liveness_checked_at = COALESCE(EXCLUDED.liveness_checked_at, contact.liveness_checked_at),
           company_revenue = COALESCE(EXCLUDED.company_revenue, contact.company_revenue),
           sources = (
             SELECT jsonb_agg(DISTINCT s) FROM jsonb_array_elements_text(contact.sources || EXCLUDED.sources) AS s
           ),
           updated_at = now()
         RETURNING id`,
        [
          it.identityKey, it.firstName || null, it.lastName || null, it.name || null,
          it.title || null, it.company || null, it.domain || null,
          String(it.companySize ?? '') || null, it.companyGeo || null, it.companyIndustry || null,
          it.location || null, it.linkedin || null, it.email || null, it.emailStatus || null,
          JSON.stringify(it.sources || ['explee']), JSON.stringify(it.raw ?? null), it.uniqueDetail || null,
          it.liveness || null, it.livenessNote || null, Number(it.revenue) || null,
          linkedinSlug(it.linkedin),
        ],
      );
      const contactId = c.rows[0].id;
      await client.query(
        `INSERT INTO contact_segment_match (contact_id, segment_id, source, signals_snapshot, fit_score, value_score, shortlisted)
         VALUES ($1,$2,$3,$4,$5,$6,true)
         ON CONFLICT (contact_id, segment_id) DO UPDATE SET shortlisted = true, fit_score = EXCLUDED.fit_score, value_score = EXCLUDED.value_score`,
        [contactId, segmentId, it.source || 'explee', JSON.stringify(signalsSnapshot ?? {}), it.fit ?? null, it.value ?? null],
      );
      if (it.email && it.emailStatus) {
        await client.query(
          // kind='email_source' — это заявка источника, а не наша проверка (kind='email').
          'INSERT INTO verification (contact_id, kind, result, provider) VALUES ($1, $2, $3, $4)',
          [contactId, 'email_source', it.emailStatus, (it.sources || ['explee']).join('+')],
        );
      }
      // История деталей (решение Ольги 07.08 — прошлые не терять): contact.unique_detail хранит
      // актуальную, каждая найденная — строкой в verification (без дублей той же формулировки).
      if (it.uniqueDetail) {
        await client.query(
          `INSERT INTO verification (contact_id, kind, result, provider)
           SELECT $1, 'unique_detail', $2, 'serper+haiku'
           WHERE NOT EXISTS (
             SELECT 1 FROM verification WHERE contact_id = $1 AND kind = 'unique_detail' AND result = $2
           )`,
          [contactId, it.uniqueDetail],
        );
      }
      saved += 1;
    }
    await client.query('COMMIT');
    return { segmentId, saved };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Бэкфилл slug для контактов, записанных до появления колонки (L1.1). Нормализация живёт
// в JS — в SQL её не выразить, поэтому цикл. Однократно на старте, дальше пишется при записи.
export async function backfillLinkedinSlugs() {
  if (!pool) return 0;
  const r = await pool.query(
    `SELECT id, linkedin_url FROM contact WHERE linkedin_url IS NOT NULL AND linkedin_slug IS NULL`,
  );
  let filled = 0;
  for (const row of r.rows) {
    const slug = linkedinSlug(row.linkedin_url);
    if (!slug) continue;
    await pool.query('UPDATE contact SET linkedin_slug = $2 WHERE id = $1', [row.id, slug]);
    filled += 1;
  }
  if (filled) console.log(`[registry] linkedin_slug backfilled for ${filled} contact(s)`);
  return filled;
}

/**
 * Импорт истории LinkedIn-касаний из GetSales (L1.3, разведка L0.10): 2 433 человека уже
 * получали заявки ДО появления системы — карантин и дедуп обязаны их видеть.
 *
 * Идемпотентно: контакт upsert-ится по identity_key (формат LinkedIn-ключа тот же, что у
 * identityKeyServer — «linkedin.com/in/slug», чтобы будущие выдачи поиска дедупились с
 * импортом), касание не дублируется благодаря meta->>'import_key'.
 *
 * Жизненный цикл существующим контактам НЕ трогаем; новые — available: карантинить задним
 * числом не решали, защитой от повторного касания владеет барьер и стоп-политика (ТЗ L0.10).
 */
export async function importLinkedinHistory(rows = []) {
  const client = await pool.connect();
  const out = { contacts: 0, created: 0, touches: 0, skipped: 0 };
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const slug = linkedinSlug(r.linkedin_slug || r.linkedin);
      if (!slug || !r.invite_sent_at) { out.skipped += 1; continue; }
      const identityKey = `linkedin.com/in/${slug}`;
      const name = (r.name || '').trim();
      const c = await client.query(
        `INSERT INTO contact (identity_key, full_name, first_name, last_name, title, company, email,
           linkedin_url, linkedin_slug, sources, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'["getsales-import"]'::jsonb, NULL)
         ON CONFLICT (identity_key) DO UPDATE SET
           linkedin_slug = COALESCE(contact.linkedin_slug, EXCLUDED.linkedin_slug),
           linkedin_url = COALESCE(contact.linkedin_url, EXCLUDED.linkedin_url),
           email = COALESCE(contact.email, EXCLUDED.email),
           title = COALESCE(contact.title, EXCLUDED.title),
           company = COALESCE(contact.company, EXCLUDED.company),
           sources = (
             SELECT jsonb_agg(DISTINCT s)
               FROM jsonb_array_elements_text(contact.sources || '["getsales-import"]'::jsonb) AS s
           ),
           updated_at = now()
         RETURNING id, (xmax = 0) AS created`,
        [identityKey, name || slug, name.split(' ')[0] || null,
         name.split(' ').slice(1).join(' ') || null,
         r.position || null, r.company || null, (r.email || '').trim().toLowerCase() || null,
         `https://www.linkedin.com/in/${slug}`, slug],
      );
      const contactId = c.rows[0].id;
      out.contacts += 1;
      if (c.rows[0].created) out.created += 1;

      // События лестницы. Дата принятия/ответа в выгрузке отсутствует — ставим дату заявки
      // с пометкой approx: для карантина и дедупа важен факт и порядок, а не точный час.
      const events = [['connection_sent', true]];
      if (String(r.accepted).toLowerCase() === 'true') events.push(['accepted', false]);
      if (Number(r.msgs_in) > 0) events.push(['replied', false]);
      for (const [event, exact] of events) {
        const key = `getsales-import:${slug}:${event}`;
        const ins = await client.query(
          `INSERT INTO touch (contact_id, channel, event, occurred_at, meta)
           SELECT $1, 'linkedin', $2, $3::timestamptz, $4::jsonb
           WHERE NOT EXISTS (SELECT 1 FROM touch WHERE meta->>'import_key' = $5)
           RETURNING id`,
          [contactId, event, r.invite_sent_at,
           JSON.stringify({ import: true, import_key: key, list: r.gs_list || null, approx_time: !exact }),
           key],
        );
        out.touches += ins.rowCount;
      }
    }
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Чтение реестра с фильтрами (для вкладки Contacts).
export async function listContacts({ lifecycle, q, segmentId, since, emailStatus, hideImported, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (lifecycle) { params.push(lifecycle); where.push(`c.lifecycle = $${params.length}`); }
  // Импорт истории GetSales (2 433 контакта, L1.3) по умолчанию скрыт: у него сегодняшний
  // updated_at, и он вытесняет рабочие контакты с первого экрана (наводнение, вопрос Ольги
  // 13.08). Прячем только ЧИСТЫЙ импорт: контакт, слитый с поисковым (источников больше
  // одного), — рабочий, его видно.
  if (hideImported) where.push(`c.sources <> '["getsales-import"]'::jsonb`);
  // Фильтр по статусу адреса (ТЗ п.31). `unchecked` — те, до кого валидатор ещё не дошёл.
  if (emailStatus === 'unchecked') where.push(`c.email IS NOT NULL AND c.email_verified_at IS NULL`);
  else if (emailStatus) { params.push(emailStatus); where.push(`c.email_status = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(c.full_name ILIKE $${params.length} OR c.company ILIKE $${params.length})`); }
  // Фильтры вкладки Contacts (08.08): по сегменту и по дате добавления («только что добавленные»).
  if (segmentId) {
    params.push(Number(segmentId));
    where.push(`EXISTS (SELECT 1 FROM contact_segment_match m WHERE m.contact_id = c.id AND m.segment_id = $${params.length})`);
  }
  // По updated_at, а не created_at: повторное сохранение того же контакта делает UPDATE,
  // и по created_at «добавленные сегодня» вернули бы пусто (лид уже был в реестре со вчера).
  if (since) { params.push(since); where.push(`c.updated_at >= $${params.length}::timestamptz`); }
  // Страницы (задача Ольги 13.08): после импорта истории реестр вырос до 2 500 контактов,
  // и «первые 100 по свежести» перестали быть честным окном — нужен доступ ко ВСЕМ строкам.
  const total = Number((await pool.query(
    `SELECT COUNT(*) AS n FROM contact c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    [...params],
  )).rows[0].n);
  params.push(Math.min(Number(limit) || 100, 500));
  params.push(Math.max(Number(offset) || 0, 0));
  const rows = await pool.query(
    `SELECT c.id, c.identity_key, c.first_name, c.last_name, c.full_name, c.title, c.company,
       c.company_domain, c.company_size, c.company_geo, c.company_industry, c.location,
       c.linkedin_url, c.linkedin_slug, c.email, c.email_status, c.liveness, c.liveness_note,
       c.source_email_status, c.email_verified_at,
       c.email_verify_attempts, c.email_verify_note, c.email_free, c.last_deferred_at,
       c.sources, c.lifecycle, c.quarantine_until,
       -- Резерв: контакт лежит в чьём-то несобранном пакете (решение Ольги 11.08).
       -- Отдаём его и сюда: Список контактов — теперь главный путь сборки пакета
       -- из нескольких поисков, и вслепую собирать по нему нельзя.
       c.reserved_by, c.reserved_until,
       c.unique_detail, c.created_at, c.updated_at,
       (SELECT COUNT(*) FROM contact_segment_match m WHERE m.contact_id = c.id) AS segment_matches,
       (SELECT string_agg(s.name, ' | ' ORDER BY s.id) FROM contact_segment_match m
          JOIN segment s ON s.id = m.segment_id WHERE m.contact_id = c.id) AS segment_names,
       (SELECT COUNT(*) FROM touch t WHERE t.contact_id = c.id) AS touches,
       -- Последнее LinkedIn-касание (L5.7): заявка/сообщение закрывают канал на 3 месяца,
       -- и это должно быть видно в списке, а не только на pre-flight запуска.
       (SELECT max(t.occurred_at) FROM touch t WHERE t.contact_id = c.id
         AND t.channel = 'linkedin' AND t.event IN ('connection_sent', 'message_sent')) AS last_linkedin
     FROM contact c
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows: rows.rows, total };
}

// Угол №0: реестр как первый источник (методология, блок 2) — available-контакты, грубо
// матчащие каркас по титулам. Бесплатно, с готовыми контактами. Свежая проверка сигнала —
// обязанность вызывающего (сигнальные сегменты).
// Размер компании хранится строкой в формате провайдера: «51-200», «5001-10000», «10,001+».
// Разбираем в диапазон, чтобы сверять с каркасом поиска.
function parseCompanySize(v) {
  const t = String(v || '').replace(/[,\s]/g, '');
  if (!t) return null;
  const plus = t.match(/^(\d+)\+$/);
  if (plus) return [Number(plus[1]), Infinity];
  const range = t.match(/^(\d+)[–-](\d+)$/);
  if (range) return [Number(range[1]), Number(range[2])];
  const one = t.match(/^(\d+)$/);
  return one ? [Number(one[1]), Number(one[1])] : null;
}

export async function registryAngle({ titles = [], location = null, sizes = [], limit = 25 }) {
  if (!pool) return [];
  // Мёртвая компания исключается и здесь: иначе контакт, признанный «dead», продолжал бы
  // всплывать в КАЖДОМ будущем поиске как бесплатный реестровый кандидат (вопрос Ольги 12.08).
  const conds = [`lifecycle = 'available'`, `COALESCE(liveness, 'alive') <> 'dead'`];
  const params = [];
  if (titles.length) {
    params.push(titles.map((t) => `%${t}%`));
    conds.push(`title ILIKE ANY($${params.length})`);
  }
  if (location === 'United States') conds.push(`(location = 'US' OR location ILIKE '%united states%')`);
  // Размер компании — часть ЖЁСТКОГО каркаса, и реестровый угол обязан его уважать.
  // Баг, найденный Ольгой 12.08: угол фильтровал только по титулу и гео, поэтому под фильтром
  // «5000+» в выдачу приезжал контакт из компании на 51–200 человек. Методология обещала
  // «кандидаты, подходящие под каркас» — по факту каркас применялся наполовину.
  // Берём с запасом: размер отсеиваем уже в JS (формат строки разный, в SQL это месиво).
  params.push(Math.min(limit * 4, 200));
  const r = await pool.query(
    `SELECT id, first_name, last_name, full_name, title, company, company_domain, company_size,
            company_geo, company_industry, location, linkedin_url, email, email_status, unique_detail
     FROM contact WHERE ${conds.join(' AND ')}
     ORDER BY updated_at DESC LIMIT $${params.length}`,
    params,
  );
  if (sizes.length) {
    const bounds = sizes.map((x) => String(x).split(',').map(Number));
    const env = [Math.min(...bounds.map((b) => b[0])), Math.max(...bounds.map((b) => b[1]))];
    const rows = r.rows.filter((row) => {
      const p = parseCompanySize(row.company_size);
      // Размер неизвестен — не выбрасываем: отсутствие данных не должно резать контакт,
      // это общий принцип (тот же, что в валидации адресов и оси индустрии).
      if (!p) return true;
      return p[0] <= env[1] && p[1] >= env[0];   // пересечение диапазонов
    });
    return rows.slice(0, limit);
  }
  return r.rows.slice(0, limit);
}

// Ручная коррекция ЖЦ (вкладка Contacts): вернуть из карантина, снять ошибочный suppress и т.п.
export async function setContactLifecycle(contactId, lifecycle, quarantineUntil = null) {
  const allowed = ['available', 'active_in_campaign', 'quarantined', 'suppressed_forever'];
  if (!allowed.includes(lifecycle)) throw new Error(`bad lifecycle: ${lifecycle}`);
  const r = await pool.query(
    `UPDATE contact SET lifecycle = $2, quarantine_until = $3, updated_at = now() WHERE id = $1 RETURNING id, lifecycle`,
    [contactId, lifecycle, quarantineUntil],
  );
  if (!r.rows.length) throw new Error('contact not found');
  await pool.query(
    `INSERT INTO verification (contact_id, kind, result, provider) VALUES ($1, 'lifecycle', $2, 'manual')`,
    [contactId, lifecycle],
  );
  return r.rows[0];
}

export async function registryStats() {
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM contact) AS contacts,
       (SELECT COUNT(*) FROM segment) AS segments,
       (SELECT COUNT(*) FROM contact WHERE email IS NOT NULL) AS with_email`,
  );
  return r.rows[0];
}

/**
 * Всё, чем можно наполнить карточку Kommo. Один запрос на два места — заливку пакета
 * и кнопку «Meeting scheduled»: раньше кнопка тянула только имя с адресом и создавала
 * пустую карточку, хотя данные о компании у нас уже были (выравнено 13.08).
 *
 * `segment_industry` — индустрия ФИЛЬТРА, по которому лид найден. Это закрытый список,
 * и он ложится в «Client industry» Kommo; свободный текст источника идёт в «Industry».
 */
export async function contactsForKommo(ids = [], { onlyUnlinked = false } = {}) {
  if (!ids.length) return [];
  const r = await getPool().query(
    `SELECT c.id, c.first_name, c.last_name, c.full_name, c.company, c.email, c.kommo_lead_id,
            c.title, c.company_domain, c.company_size, c.company_geo, c.company_industry,
            c.location, c.linkedin_url, c.linkedin_slug, c.email_status, c.sources, c.unique_detail,
            c.liveness, c.liveness_note, c.company_revenue,
            m.fit_score, m.value_score, s.name AS segment_name,
            s.criteria->>'industry' AS segment_industry
       FROM contact c
       LEFT JOIN LATERAL (
         SELECT fit_score, value_score, segment_id FROM contact_segment_match
          WHERE contact_id = c.id ORDER BY matched_at DESC LIMIT 1
       ) m ON true
       LEFT JOIN segment s ON s.id = m.segment_id
      WHERE c.id = ANY($1::int[])
        ${onlyUnlinked ? 'AND c.kommo_lead_id IS NULL' : ''}`,
    [ids.map(Number)],
  );
  return r.rows;
}
