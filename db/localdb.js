// Локальная база для разработки: PGlite — настоящий Postgres, собранный в WASM и живущий
// npm-пакетом. Нужен, чтобы проверять код, работающий с БД, ДО пуша: боевой Postgres живёт
// только на Railway, и до появления этого файла всё, что касалось реестра, проверялось уже
// после деплоя (вопрос Ольги 11.08).
//
// Почему не системный Postgres: на машине нет ни Homebrew, ни Docker, а ставить их ради
// разработки — тяжело и требует пароля админа. PGlite не требует ничего: тот же SQL,
// та же схема, файл с данными рядом с проектом.
//
// ВКЛЮЧАЕТСЯ ТОЛЬКО ЯВНО: `LOCAL_DB=1 npm run dev`. На проде DATABASE_URL задан и
// используется настоящий pg — этот модуль туда не попадает.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function localDbEnabled() {
  return process.env.LOCAL_DB === '1' && !process.env.DATABASE_URL;
}

/**
 * Фасад над PGlite с интерфейсом pg.Pool: тот же `query`, тот же `connect().release()`.
 * PGlite однопоточный, поэтому `connect` отдаёт сам объект, а `release` — пустышка;
 * транзакции (BEGIN/COMMIT/ROLLBACK в saveShortlist) от этого не страдают, запросы
 * и так идут последовательно.
 */
export async function createLocalPool({ dir = path.join(__dirname, '..', '.localdb') } = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dir);
  await db.waitReady;

  const pool = {
    async query(text, params = []) {
      const r = await db.query(text, params);
      return { rows: r.rows || [], rowCount: r.rows?.length ?? r.affectedRows ?? 0 };
    },
    async connect() {
      return {
        query: (text, params = []) => pool.query(text, params),
        release() {},
      };
    },
    async end() { await db.close(); },
    _pglite: db,
  };

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.exec(schema);
  console.log(`[localdb] PGlite готов, данные в ${dir}`);
  return pool;
}
