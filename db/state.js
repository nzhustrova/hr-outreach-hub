// Состояние, которое обязано пережить перезапуск процесса.
import { getPool, registryEnabled } from './registry.js';

export async function getState(key) {
  if (!registryEnabled()) return null;
  const r = await getPool().query('SELECT value FROM app_state WHERE key = $1', [key]);
  return r.rows[0]?.value ?? null;
}

export async function setState(key, value) {
  if (!registryEnabled()) return;
  await getPool().query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, value == null ? null : String(value)],
  );
}
