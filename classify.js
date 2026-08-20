// LLM-классификатор входящих ответов (аналитика, решение Ольги 07.08).
// Классы согласованы: positive / question / neutral / not_now(+дата) / negative / ooo / unsubscribe / unclear.
// «Неотрицательный» = positive | question | neutral | not_now | unclear → пинг Стасу, разбирается человек
// (правило подтверждено на кейсе «билиберда»: не отказ — значит смотрит человек).
const HAIKU = 'claude-haiku-4-5-20251001';

export const NON_NEGATIVE = ['positive', 'question', 'neutral', 'not_now', 'unclear'];

// Системные уведомления почтовых серверов (NDR/delivery failure) приходят как EMAIL_REPLY.
// Живой кейс 08.08: два NDR на португальском получили метку unclear → ложные пинги Стасу.
// Дешёвый детект до LLM: многоязычные маркеры недоставки.
const NDR_PATTERNS = [
  /delivery (has failed|failed|status notification|incomplete)/i,
  /undeliverable|undelivered|mail delivery (failed|subsystem)/i,
  /address (could ?not|couldn't) be found|recipient .{0,20}not found/i,
  /não foi possível entregar|endereço .{0,20}desconhecid/i,          // pt
  /no se pudo entregar|dirección .{0,20}no existe/i,                  // es
  /nachricht konnte nicht zugestellt/i,                               // de
  /не доставлено|адрес не найден|доставка не удалась/i,               // ru
  /550 5\.\d\.\d|error code:? 5\d{2}|smtp error/i,
  /postmaster@|mailer-daemon/i,
];

export function looksLikeNdr(text = '', fromEmail = '') {
  const t = String(text).slice(0, 1500);
  if (/postmaster@|mailer-daemon|no-?reply@/i.test(String(fromEmail))) return true;
  return NDR_PATTERNS.filter((re) => re.test(t)).length >= 1;
}

// --- Soft vs hard bounce (ТЗ п.32, решение Ольги 10.08) -----------------------------------
// Ни Smartlead в вебхуке, ни NDR-детект их не различали, а разница принципиальная:
//   hard — «ящика нет», адрес мёртв, хоронить навсегда правильно;
//   soft — «ящик переполнен», «сервер временно недоступен», greylisting: человек живой.
// Хоронить по soft = систематически терять занятых руководителей с забитой почтой.
const HARD_PATTERNS = [
  /\b5\.[157]\.\d\b|\b55[0-4]\b/,                                   // 5.x.x / 55x — постоянный отказ
  /no ?such (user|mailbox|address|recipient)|user unknown/i,
  /recipient .{0,25}(not found|does not exist|unknown)/i,
  /address (could ?not|couldn't) be found|does not exist/i,
  /mailbox (unavailable|not found)|invalid recipient|unrouteable|unroutable/i,
  /no longer (with|works|employed)|has left the (company|organization)/i,
  /domain .{0,20}(not found|does not exist)|dns error/i,
  /endereço .{0,20}desconhecid|dirección .{0,20}no existe|адрес не найден/i,
];
const SOFT_PATTERNS = [
  /\b4\.\d\.\d\b|\b4[0-9]{2}\b.{0,20}(temporar|defer|try again)/i,  // 4xx — временный отказ
  /mailbox (is )?full|quota exceeded|over quota|insufficient (storage|system storage)/i,
  /temporar(y|ily) (unavailable|rejected|deferred|failed)|try again later/i,
  /greylist|grey ?listed/i,
  /rate limit|too many (messages|connections|recipients)|throttl/i,
  /server (is )?(busy|unavailable|too busy)|connection (timed out|refused)/i,
  /message .{0,20}(delayed|deferred)/i,
];

/**
 * Определяет тип отскока по тексту NDR / полям вебхука.
 * При неопределённости возвращает `soft` — сознательно: карантин на 30 дней обратим,
 * вечная блокировка живого лида нет. Защита от бесконечных ретраев — счётчик повторов
 * в вызывающем коде (два soft подряд = адрес считаем мёртвым).
 */
export function bounceKind(text = '') {
  const t = String(text).slice(0, 2000);
  if (HARD_PATTERNS.some((re) => re.test(t))) return 'hard';
  if (SOFT_PATTERNS.some((re) => re.test(t))) return 'soft';
  return 'soft';
}

export async function classifyReply({ text, subject = '', contactName = '', company = '', fromEmail = '' }) {
  // NDR ловим до LLM: это не ответ человека, пинговать некого.
  if (looksLikeNdr(text, fromEmail)) {
    return { label: 'bounce_notification', resumeDate: null, summary: 'Delivery failure notification (NDR) — not a human reply' };
  }
  if (!process.env.ANTHROPIC_API_KEY) return { label: 'unclear', reason: 'no LLM key' };
  const prompt = `You classify replies to a cold B2B outreach email (sender: procurement SaaS). Reply is from ${contactName || 'a prospect'}${company ? ` at ${company}` : ''}.

Subject: ${subject || '(same thread)'}
Reply text:
"""
${String(text || '').slice(0, 2000)}
"""

Classify into EXACTLY one label:
- "positive": interest, wants details/call/pricing
- "question": asks something substantive, unclear intent
- "neutral": acknowledges without commitment ("thanks, will look")
- "not_now": explicitly asks to come back later AND names a moment ("ping me in November", "after Q3"); extract the date/period
- "negative": declines, polite or hard — including "not looking at this right now" / "no need currently" WITHOUT naming a return moment; does NOT demand removal
- "unsubscribe": demands removal / stop contacting / legal threat
- "ooo": out-of-office auto-reply
- "bounce_notification": automated delivery-failure / NDR message from a mail server, not a human
- "unclear": gibberish or unparseable written BY A HUMAN — a human should look

Return STRICT JSON only:
{"label":"...","resume_date":"YYYY-MM-DD or null","summary":"<one line in English: the gist of the reply>"}
For not_now: resume_date = first day of the named period (e.g. "November" -> next November 1st). Today is ${new Date().toISOString().slice(0, 10)}.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: HAIKU, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`anthropic ${r.status}`);
  const parsed = JSON.parse((data.content?.[0]?.text || '{}').replace(/^```json?\s*|\s*```$/g, ''));
  return {
    label: parsed.label || 'unclear',
    resumeDate: parsed.resume_date || null,
    summary: parsed.summary || '',
  };
}

// Сжатие unique_detail для подстановки в шаблон письма.
// ВАЖНО (баг 08.08): раньше возвращался ОБРЫВОК («the Arcosa acquisition») — он ломал текст,
// если LLM ставила переменную отдельным предложением. Теперь — короткое ЗАКОНЧЕННОЕ предложение
// в голосе Стэна: читается в любой позиции шаблона, а пустое значение оставляет чистый пробел.
export async function compressDetail(detail) {
  if (!detail) return null;
  if (!process.env.ANTHROPIC_API_KEY) return detail;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: HAIKU,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Rewrite this company fact as ONE short standalone sentence for a cold email, in the sender's voice.
Rules: max 14 words; start with "Saw" or "Noticed"; no company name (the email already has it); end with a period; no marketing adjectives.
Fact: "${detail}"
Examples:
"CRH announced acquisition of Arcosa for $8.5 billion" -> "Saw the Arcosa deal went through."
"Company implemented surcharges to offset higher haulage costs" -> "Noticed you're absorbing higher haulage costs."
Return ONLY the sentence.`,
      }],
    }),
  });
  const data = await r.json();
  if (!r.ok) return detail;
  return (data.content?.[0]?.text || detail).trim().replace(/^["']|["']$/g, '');
}
