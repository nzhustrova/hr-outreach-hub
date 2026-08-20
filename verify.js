// Валидация адресов через MillionVerifier (решение 10.08, см. «Методология валидации адресов»).
// Ключевое правило: ошибка НАШЕЙ инфраструктуры не хоронит контакт — любой сбой даёт `unknown`,
// а не `invalid`. `invalid` ставим, только когда сервер получателя явно сказал «ящика нет».
const BASE = 'https://api.millionverifier.com/api/v3';

export function verifyEnabled() {
  return Boolean(process.env.MILLIONVERIFIER_API_KEY);
}

// result → наш статус. `disposable` (одноразовые ящики) приравниваем к invalid: писать туда
// бессмысленно и вредно. `role` приходит отдельным флагом и перебивает всё — см. ниже.
const RESULT_MAP = {
  ok: 'valid',
  catch_all: 'catch_all',
  unknown: 'unknown',
  invalid: 'invalid',
  disposable: 'invalid',
  error: 'unknown',
};

export async function credits() {
  const key = process.env.MILLIONVERIFIER_API_KEY;
  if (!key) throw new Error('MILLIONVERIFIER_API_KEY не задан');
  const r = await fetch(`${BASE}/credits?api=${key}`);
  const data = await r.json();
  if (!r.ok) throw new Error(`millionverifier credits ${r.status}`);
  return { credits: Number(data.credits ?? 0), plan: data.plan ?? null };
}

/**
 * Проверка одного адреса.
 * @returns {{status:string, role:boolean, free:boolean, subresult:string, credits:number|null,
 *            transient:boolean, outOfCredits:boolean, raw:object}}
 *   transient = сбой на нашей стороне, имеет смысл ретраить.
 */
export async function verifyEmail(email, { timeoutSec = 20 } = {}) {
  const key = process.env.MILLIONVERIFIER_API_KEY;
  if (!key) return unknownResult(email, 'no_api_key', true);
  let data;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), (timeoutSec + 10) * 1000);
    const r = await fetch(
      `${BASE}/?api=${key}&email=${encodeURIComponent(email)}&timeout=${timeoutSec}`,
      { signal: ctl.signal },
    );
    clearTimeout(t);
    data = await r.json();
    if (!r.ok) return unknownResult(email, `http_${r.status}`, true);
  } catch (e) {
    return unknownResult(email, String(e.name === 'AbortError' ? 'timeout' : e.message), true);
  }

  // Их поле `error` непустое = запрос не отработал (кончились кредиты, кривой ключ и т.п.).
  if (data.error) {
    const out = /credit/i.test(String(data.error));
    return { ...unknownResult(email, String(data.error), true), outOfCredits: out };
  }

  const mapped = RESULT_MAP[String(data.result || '').toLowerCase()] || 'unknown';
  // Ролевой адрес блокируем жёстко, даже если ящик живой: их читают несколько человек,
  // оттуда прилетают жалобы на спам, а жалоба дороже потерянного лида (решение Ольги 10.08).
  const status = data.role === true ? 'role' : mapped;
  return {
    status,
    role: data.role === true,
    free: data.free === true,
    subresult: data.subresult || data.result || '',
    credits: data.credits ?? null,
    transient: mapped === 'unknown',
    outOfCredits: false,
    raw: data,
  };
}

function unknownResult(email, reason, transient) {
  return {
    status: 'unknown',
    role: false,
    free: false,
    subresult: reason,
    credits: null,
    transient,
    outOfCredits: false,
    raw: { email, error: reason },
  };
}

// Параллельная проверка пачки. Ограничение конкурентности — чтобы не упереться в их rate limit
// и не съесть весь пул соединений: проверка идёт фоном, спешить некуда.
export async function verifyMany(emails, { concurrency = 5, onResult } = {}) {
  const queue = [...emails];
  const results = [];
  async function worker() {
    while (queue.length) {
      const email = queue.shift();
      const res = await verifyEmail(email);
      results.push({ email, ...res });
      if (onResult) await onResult(email, res);
      if (res.outOfCredits) queue.length = 0; // кредиты кончились — остальное бессмысленно
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, emails.length) }, worker));
  return results;
}
