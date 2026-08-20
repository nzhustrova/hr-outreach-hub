// Слой БД для валидации адресов (ТЗ п.31). Сам вызов провайдера — в ../verify.js.
import { getPool } from './registry.js';

export const MAX_ATTEMPTS = 3;      // после трёх неудач `unknown` уходит в серую зону
export const STALE_DAYS = 90;       // ре-верификация в момент сборки пакета

// Кого проверять: почта есть, нашим валидатором ещё не проверен ЛИБО завис в `unknown`
// с неисчерпанными попытками. Похороненных не трогаем — не тратим кредиты.
//
// ⚠️ Чистый импорт истории GetSales НЕ проверяем (инцидент 13.08): фоновый обход подхватил
// ~1 400 адресов импорта, которые никто не собирался рассылать, и сжёг остаток пробных
// кредитов MillionVerifier в минус. Правило то же, что у карантина: платим за проверку
// только того, что реально собираемся отправлять. Если импортный контакт сольётся с
// поисковым (второй источник) — он перестаёт быть «чистым импортом» и проверится.
export async function contactsToVerify(limit = 50) {
  const r = await getPool().query(
    `SELECT id, email FROM contact
     WHERE email IS NOT NULL AND email <> ''
       AND lifecycle <> 'suppressed_forever'
       AND sources <> '["getsales-import"]'::jsonb
       AND (email_verified_at IS NULL
            OR (email_status = 'unknown' AND email_verify_attempts < $1))
     ORDER BY email_verified_at NULLS FIRST, id
     LIMIT $2`,
    [MAX_ATTEMPTS, limit],
  );
  return r.rows;
}

// Устаревшие проверки среди конкретных контактов — для видимого шага pre-flight
// (замечание Ольги 10.08: состав пакета не должен меняться после подтверждения).
export async function staleContacts(contactIds = [], days = STALE_DAYS) {
  if (!contactIds.length) return [];
  const r = await getPool().query(
    `SELECT id, email, email_status, email_verified_at FROM contact
     WHERE id = ANY($1::int[]) AND email IS NOT NULL
       AND (email_verified_at IS NULL OR email_verified_at < now() - ($2 || ' days')::interval)`,
    [contactIds, String(days)],
  );
  return r.rows;
}

// Запись результата. Счётчик попыток растёт ТОЛЬКО на `unknown` — иначе успешная проверка
// после двух сбоев оставила бы контакт на грани исчерпания попыток.
export async function applyVerification(contactId, res) {
  const bump = res.status === 'unknown' ? 1 : 0;
  await getPool().query(
    `UPDATE contact SET
       email_status = $2,
       email_verified_at = now(),
       email_verify_attempts = CASE WHEN $3 = 1 THEN email_verify_attempts + 1 ELSE 0 END,
       email_role = $4, email_free = $5, email_verify_note = $6,
       updated_at = now()
     WHERE id = $1`,
    [contactId, res.status, bump, res.role, res.free, res.subresult || null],
  );
  await getPool().query(
    `INSERT INTO verification (contact_id, kind, result, provider)
     VALUES ($1, 'email', $2, 'millionverifier')`,
    [contactId, `${res.status}${res.subresult ? ` (${res.subresult})` : ''}`],
  );
}

// Счётчики для шапки Списка контактов.
export async function verifyCounters() {
  const r = await getPool().query(
    `SELECT
       COUNT(*) FILTER (WHERE email IS NOT NULL) AS with_email,
       COUNT(*) FILTER (WHERE email_status = 'valid') AS valid,
       COUNT(*) FILTER (WHERE email_status = 'catch_all') AS catch_all,
       COUNT(*) FILTER (WHERE email_status = 'invalid') AS invalid,
       COUNT(*) FILTER (WHERE email_status = 'role') AS role,
       COUNT(*) FILTER (WHERE email_status = 'unknown' AND email_verify_attempts >= $1) AS unresolved,
       -- pending обязан считать по ТЕМ ЖЕ правилам, что очередь contactsToVerify:
       -- чистый импорт исключён (инцидент кредитов 13.08), иначе шапка вечно
       -- обещает «проверяется 770», которые никто проверять не собирается.
       COUNT(*) FILTER (WHERE email IS NOT NULL
             AND sources <> '["getsales-import"]'::jsonb
             AND (email_verified_at IS NULL
             OR (email_status = 'unknown' AND email_verify_attempts < $1))) AS pending
     FROM contact WHERE lifecycle <> 'suppressed_forever'`,
    [MAX_ATTEMPTS],
  );
  return r.rows[0];
}

// Качество источников (ТЗ п.31): меряет ТОЛЬКО живость адресов и надёжность источников данных.
// К релевантности лида и к проверке гипотезы отношения не имеет — подпись обязательна в UI.
export async function sourceQuality() {
  const r = await getPool().query(
    `SELECT
       (SELECT string_agg(s, '+' ORDER BY s) FROM jsonb_array_elements_text(c.sources) AS s) AS source,
       COUNT(*) AS found,
       COUNT(*) FILTER (WHERE c.email_status = 'valid') AS valid,
       COUNT(*) FILTER (WHERE c.email_status = 'catch_all') AS catch_all,
       COUNT(*) FILTER (WHERE c.email_status = 'invalid') AS invalid,
       COUNT(*) FILTER (WHERE c.email_status = 'role') AS role,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM touch t WHERE t.contact_id = c.id AND t.event = 'bounced'
       )) AS bounced
     FROM contact c
     WHERE c.email IS NOT NULL
     GROUP BY 1
     HAVING COUNT(*) > 0
     ORDER BY found DESC`,
  );
  return r.rows;
}
