// Соответствие индустрий (ТЗ п.38). Ось жёсткая: несовпадение уводит контакт ниже порога
// рекомендации, как уже работает seniority-дисквалификация.
//
// Почему LLM, а не словарь ключевых слов: в выпадашке двенадцать индустрий, а в справочнике
// `INDUSTRY_DEFINITIONS` руками заполнена одна. Писать одиннадцать наборов синонимов — работа
// без конца, потому что провайдеры возвращают формулировки вроде «Wholesale Building Materials».
//
// Почему пары, а не контакты: в выдаче из ста человек уникальных индустрий 15–25. Один вызов
// на весь список вместо ста, и вердикт кэшируется навсегда — пара «Industrial Manufacturing ×
// Retail Apparel and Fashion» не изменится. Со второй недели модель зовётся только для новых.
import { getPool, registryEnabled } from './db/registry.js';

const HAIKU = 'claude-haiku-4-5-20251001';

export const VERDICTS = ['fits', 'adjacent', 'mismatch'];

/** Достаёт из кэша всё, что уже решали. */
export async function cachedVerdicts(selected, companies = []) {
  if (!registryEnabled() || !companies.length) return {};
  const r = await getPool().query(
    `SELECT company, verdict, note FROM industry_match WHERE selected = $1 AND company = ANY($2::text[])`,
    [selected, companies],
  );
  return Object.fromEntries(r.rows.map((x) => [x.company, { verdict: x.verdict, note: x.note }]));
}

async function saveVerdicts(selected, rows) {
  if (!registryEnabled()) return;
  for (const r of rows) {
    await getPool().query(
      `INSERT INTO industry_match (selected, company, verdict, note) VALUES ($1,$2,$3,$4)
       ON CONFLICT (selected, company) DO NOTHING`,
      [selected, r.company, r.verdict, r.note || null],
    ).catch(() => {});
  }
}

/**
 * Вердикты по списку индустрий компаний. Сначала кэш, затем один вызов LLM на остаток.
 * @returns {Object} company → { verdict, note, from: 'cache' | 'llm' | 'fallback' }
 */
export async function judgeIndustries(selected, companies = []) {
  const uniq = [...new Set(companies.map((c) => String(c || '').trim()).filter(Boolean))];
  if (!selected || !uniq.length) return {};

  const cache = await cachedVerdicts(selected, uniq);
  const out = {};
  for (const [k, v] of Object.entries(cache)) out[k] = { ...v, from: 'cache' };
  const missing = uniq.filter((c) => !out[c]);
  if (!missing.length || !process.env.ANTHROPIC_API_KEY) {
    // Без ключа не гадаем: неизвестное — «смежное», а не «не подходит». Отсутствие данных
    // не должно резать контакт, это общий принцип (см. валидацию адресов).
    for (const c of missing) out[c] = { verdict: 'adjacent', note: 'not judged yet', from: 'fallback' };
    return out;
  }

  const prompt = `You judge whether a company's industry matches the industry a B2B salesperson selected as their target segment.

TARGET SEGMENT: "${selected}"

COMPANY INDUSTRIES TO JUDGE:
${missing.map((c, i) => `${i + 1}. ${c}`).join('\n')}

For each, return one of three verdicts:
- "fits" — clearly inside the target segment
- "adjacent" — related but not the core of it (e.g. a supplier to that industry, or a company that makes goods but sells them at retail)
- "mismatch" — clearly a different business (e.g. a logistics carrier when the target is manufacturing)

Be strict about "fits" and honest about "adjacent": a wrong "fits" puts the wrong person in a cold email campaign,
a wrong "mismatch" throws away a good company. When genuinely torn, choose "adjacent".

Return STRICT JSON only, no markdown:
{"verdicts":[{"company":"<exact string from the list>","verdict":"fits|adjacent|mismatch","note":"<max 12 words, why>"}]}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: HAIKU, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`anthropic ${r.status}`);
    const parsed = JSON.parse((data.content?.[0]?.text || '{}').replace(/^```json?\s*|\s*```$/g, ''));
    const rows = (parsed.verdicts || [])
      .filter((v) => VERDICTS.includes(v.verdict) && missing.includes(v.company));
    await saveVerdicts(selected, rows);
    for (const v of rows) out[v.company] = { verdict: v.verdict, note: v.note, from: 'llm' };
    // Что модель почему-то не вернула — тоже «смежное», молча терять нельзя.
    for (const c of missing) if (!out[c]) out[c] = { verdict: 'adjacent', note: 'not judged', from: 'fallback' };
  } catch (e) {
    console.error('[industry] вердикты не получены:', e.message);
    for (const c of missing) out[c] = { verdict: 'adjacent', note: 'judging failed', from: 'fallback' };
  }
  return out;
}
