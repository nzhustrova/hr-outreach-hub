// Пользователи и журнал действий (ТЗ п.37). Механизм авторизации остаётся прежним — Basic,
// тот же адрес, тот же браузерный запрос пароля. Меняется одно: вместо общего пароля пары
// логин/пароль на человека, и логин, который браузер и так присылал, наконец используется.
//
// Самостоятельной регистрации нет намеренно: на внутреннем инструменте открытая регистрация —
// дыра, доступ получит любой обладатель ссылки. Пользователей заводит админ.
import crypto from 'node:crypto';
import { getPool, registryEnabled } from './registry.js';

const ITER = 64;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, ITER).toString('hex');
  return { salt, hash };
}

// Сравнение в постоянном времени: наивное === утекает длину совпадающего префикса.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Первичное заполнение из env: APP_USERS="olga:pass:Olga:o.zhulikova@zinit.com, stan:pass:Stan:s@…"
 * Пароли в базе лежат только хешами. Существующих не трогаем — env служит для заведения,
 * а не для перезаписи: иначе смена пароля в интерфейсе откатывалась бы при каждом деплое.
 */
export async function seedUsersFromEnv() {
  const raw = process.env.APP_USERS;
  if (!raw || !registryEnabled()) return 0;
  let created = 0;
  for (const chunk of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [login, password, name, email] = chunk.split(':').map((s) => (s || '').trim());
    if (!login || !password) continue;
    const exists = await getPool().query('SELECT 1 FROM app_user WHERE login = $1', [login]);
    if (exists.rows.length) continue;
    const { salt, hash } = hashPassword(password);
    await getPool().query(
      `INSERT INTO app_user (login, name, email, role, pass_salt, pass_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [login, name || login, email || null, 'operator', salt, hash],
    );
    created += 1;
  }
  if (created) console.log(`[users] заведено из APP_USERS: ${created}`);
  return created;
}

export async function anyUsers() {
  if (!registryEnabled()) return false;
  const r = await getPool().query('SELECT 1 FROM app_user WHERE active LIMIT 1');
  return r.rows.length > 0;
}

/** Проверка пары логин/пароль. Возвращает пользователя или null. */
export async function verifyUser(login, password) {
  if (!registryEnabled() || !login) return null;
  const r = await getPool().query(
    'SELECT id, login, name, email, role, pass_salt, pass_hash FROM app_user WHERE login = $1 AND active',
    [String(login)],
  );
  const u = r.rows[0];
  if (!u) return null;
  const { hash } = hashPassword(password, u.pass_salt);
  if (!safeEqual(hash, u.pass_hash)) return null;
  // last_seen обновляем без ожидания: это метрика, а не часть авторизации.
  getPool().query('UPDATE app_user SET last_seen_at = now() WHERE id = $1', [u.id]).catch(() => {});
  return { id: u.id, login: u.login, name: u.name, email: u.email, role: u.role };
}

export async function listUsers() {
  const r = await getPool().query(
    `SELECT id, login, name, email, role, active, created_at, last_seen_at
       FROM app_user ORDER BY active DESC, login`,
  );
  return r.rows;
}

export async function createUser({ login, password, name, email, role = 'operator' }) {
  if (!login || !password) throw new Error('нужны логин и пароль');
  const { salt, hash } = hashPassword(password);
  const r = await getPool().query(
    `INSERT INTO app_user (login, name, email, role, pass_salt, pass_hash)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, login, name, email, role, active`,
    [String(login).trim(), name || login, email || null, role, salt, hash],
  );
  return r.rows[0];
}

export async function setUserActive(id, active) {
  const r = await getPool().query(
    'UPDATE app_user SET active = $2 WHERE id = $1 RETURNING id, login, active',
    [Number(id), Boolean(active)],
  );
  return r.rows[0];
}

// --- Журнал ---------------------------------------------------------------------------------

/** Пишем best-effort: сбой журнала не должен ронять само действие. */
export async function writeAudit({ actor, action, entity = null, entityId = null, meta = null }) {
  if (!registryEnabled()) return;
  try {
    await getPool().query(
      `INSERT INTO audit_log (actor, action, entity, entity_id, meta)
       VALUES ($1,$2,$3,$4,$5)`,
      [actor || 'unknown', action, entity, entityId == null ? null : String(entityId), meta ? JSON.stringify(meta) : null],
    );
  } catch (e) {
    console.error('[audit] запись не удалась:', e.message);
  }
}

// Автоматические «исполнители»: ночная синхронизация, вебхуки Smartlead, фоновое обслуживание.
// Журнал сотрудников их не показывает — иначе «кто что делал» тонет в машинных строках.
export const ROBOT_ACTORS = ['cron', 'webhook', 'system'];

export async function listAudit({ limit = 200, actor = null, action = null, actions = null, humansOnly = false } = {}) {
  const params = [];
  const where = [];
  if (actor) { params.push(actor); where.push(`actor = $${params.length}`); }
  if (action) { params.push(`${action}%`); where.push(`action LIKE $${params.length}`); }
  // Несколько префиксов: журнал Kommo собирает и `kommo.*`, и `crm.*` — это одна тема,
  // разложенная по двум именам ещё до того, как барьер получил своё название.
  if (actions?.length) {
    const ors = actions.map((a) => { params.push(`${a}%`); return `action LIKE $${params.length}`; });
    where.push(`(${ors.join(' OR ')})`);
  }
  if (humansOnly) { params.push(ROBOT_ACTORS); where.push(`NOT (actor = ANY($${params.length}))`); }
  params.push(Math.min(Number(limit) || 200, 1000));
  const r = await getPool().query(
    `SELECT id, actor, action, entity, entity_id, meta, at FROM audit_log
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export async function auditActors() {
  const r = await getPool().query('SELECT DISTINCT actor FROM audit_log ORDER BY actor');
  return r.rows.map((x) => x.actor);
}
