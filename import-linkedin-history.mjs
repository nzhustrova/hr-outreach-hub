// Разовый загрузчик истории LinkedIn-касаний GetSales в реестр (L1.3).
// Файл выгрузки живёт в 02_specs (вне репо приложения), поэтому читаем его локально
// и шлём батчами в /api/registry/import/linkedin-history. Эндпоинт идемпотентен —
// прерванный прогон можно просто повторить целиком.
//
// Запуск:
//   node import-linkedin-history.mjs <путь к getsales_invited_2433.csv> <base url> <login:password>
// Пример (прод):
//   node import-linkedin-history.mjs "../../02_specs/Sales process/US/getsales_invited_2433.csv" \
//     https://outreach-hub-production-b1dc.up.railway.app olga:пароль
import fs from 'node:fs';

const [, , csvPath, base, auth] = process.argv;
if (!csvPath || !base || !auth) {
  console.error('usage: node import-linkedin-history.mjs <csv> <base url> <login:password>');
  process.exit(1);
}

// CSV простой (наша же выгрузка, без кавычек с запятыми в первых колонках ломаться нечему),
// но имя может содержать запятую («Lacey PMP, CPCM») — поэтому режем по известному числу колонок.
const HEAD = ['linkedin_slug', 'name', 'company', 'position', 'email', 'gs_list', 'invite_sent_at', 'accepted', 'msgs_out', 'msgs_in'];
function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    // Разбор с учётом кавычек: csv-модуль питона писал поля с запятыми в кавычках.
    const cells = [];
    let cur = ''; let quoted = false;
    for (const ch of line) {
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === ',' && !quoted) { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    rows.push(Object.fromEntries(HEAD.map((h, i) => [h, (cells[i] ?? '').trim()])));
  }
  return rows;
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
console.log(`строк в файле: ${rows.length}`);
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Basic ${Buffer.from(auth).toString('base64')}`,
};

// Батчи по 100 и повторы: 400 строк за запрос упирались в таймаут прокси Railway —
// она отвечала не-JSON «upstream error», и наивный r.json() ронял весь прогон
// (живой обрыв 13.08). Эндпоинт идемпотентен, поэтому повтор батча безопасен.
const BATCH = 100;
async function sendBatch(batch, attempts = 3) {
  for (let a = 1; a <= attempts; a += 1) {
    try {
      const r = await fetch(`${base}/api/registry/import/linkedin-history`, {
        method: 'POST', headers, body: JSON.stringify({ rows: batch }),
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 120) }; }
      if (r.ok) return data;
      if (r.status === 401) { console.error('неверный логин/пароль'); process.exit(1); }
      console.warn(`  попытка ${a}/${attempts}: HTTP ${r.status} ${data.error || data.raw || ''}`);
    } catch (e) {
      console.warn(`  попытка ${a}/${attempts}: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 3000 * a));
  }
  return null;
}

let totals = { contacts: 0, created: 0, touches: 0, skipped: 0 };
let failed = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const data = await sendBatch(batch);
  if (!data) { failed += batch.length; console.error(`батч ${i}: не прошёл после повторов — прогони скрипт ещё раз`); continue; }
  for (const k of Object.keys(totals)) totals[k] += data[k] || 0;
  console.log(`батч ${i}–${i + batch.length}: контактов ${data.contacts} (новых ${data.created}), касаний ${data.touches}`);
}
console.log('ИТОГО:', totals, failed ? `⚠️ не прошло строк: ${failed} — повтори прогон` : '✓ все батчи прошли');
