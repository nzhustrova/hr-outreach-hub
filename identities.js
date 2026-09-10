// Личности отправителей (решение 08.08). Зачем нужно:
// текст подписан конкретным человеком («Stan»), а Smartlead раздаёт ящики round-robin В МОМЕНТ
// ОТПРАВКИ; кастомные переменные привязаны к лиду, а не к ящику, поэтому подставить подпись под
// фактический ящик невозможно. Вывод: одна кампания = одна личность, смешение блокируется.
//
// Карта строится по локальной части адреса: stan@… → Stan. Явные исключения — в OVERRIDES.

// signer: true — от этого человека мы шлём кампании (у него есть карточка sender_* в базе знаний).
// Остальные личности нужны только чтобы опознать их ящики и НЕ дать отправить с них чужой текст.
// Рекрутинговая конфигурация (Natalia, 2026-09-10): единственный подписант —
// Natalia. Ящики продаж опознаются, чтобы С НИХ ничего не ушло (signer: false
// = замок §2.3 их блокирует), но волны найма они не ведут.
const RULES = [
  { id: 'natalia', name: 'Natalia', match: /^natalia([._-]|$)/i, signer: true },
  { id: 'stan', name: 'Stan', match: /^stan([._-]|$)/i, signer: false },
  { id: 'anton', name: 'Anton', match: /^anton([._-]|$)/i, signer: false },
  { id: 'supplier', name: 'Supplier team', match: /^supplier/i, signer: false },
];

// Адреса, которые не выводятся из локальной части (например, t.urban@ → Tony).
const OVERRIDES = {
  'n.zhustrova@zinit.com': { id: 'natalia', name: 'Natalia', signer: true },
  't.urban@zinit.com': { id: 'tony', name: 'Tony', signer: false },
  'o.zhulikova@zinit.com': { id: 'olga', name: 'Olga', signer: false },
  's.moskovtsev@zinit.com': { id: 'stan', name: 'Stan', signer: false },
};

export const UNASSIGNED = { id: 'unassigned', name: 'Unassigned' };

// Известные подписанты — единый источник правды для фронта (подсказка о подписи не должна
// зависеть от того, ответил ли в этот момент Smartlead; кейс 08.08).
export function knownSigners() {
  const all = [...RULES.map((r) => ({ id: r.id, name: r.name, signer: r.signer })), ...Object.values(OVERRIDES)];
  return [...new Map(all.filter((i) => i.signer).map((i) => [i.id, { id: i.id, name: i.name }])).values()];
}

// Имя захода = «База · Отправитель»: в библиотеке сразу видно, чей текст, а аналитика
// сравнивает ячейки по базовой части (решение Ольги 08.08).
export const NAME_SEP = ' · ';
export function baseAngleName(name) {
  const idx = String(name || '').lastIndexOf(NAME_SEP);
  if (idx < 0) return String(name || '').trim();
  const tail = name.slice(idx + NAME_SEP.length).trim();
  const isSigner = knownSigners().some((s) => s.name.toLowerCase() === tail.toLowerCase());
  return isSigner ? name.slice(0, idx).trim() : String(name).trim();
}
export function angleNameFor(name, signerName) {
  return `${baseAngleName(name)}${NAME_SEP}${signerName}`;
}

export function identityOf(email) {
  const addr = String(email || '').trim().toLowerCase();
  if (OVERRIDES[addr]) return OVERRIDES[addr];
  const local = addr.split('@')[0] || '';
  const rule = RULES.find((r) => r.match.test(local));
  return rule ? { id: rule.id, name: rule.name } : UNASSIGNED;
}

// Личность из подписи текста: берём последнюю непустую строку письма («…\n\nStan»).
// Нужно, чтобы не заставлять оператора выбирать личность руками, когда она уже есть в тексте.
export function identityFromSignature(sequence = []) {
  const body = sequence[0]?.body || '';
  const lines = String(body).split('\n').map((l) => l.trim()).filter(Boolean);
  const last = (lines[lines.length - 1] || '').replace(/[.,!]$/, '');
  if (!last || last.length > 30) return null;
  const rule = RULES.find((r) => r.match.test(last)) || Object.values(OVERRIDES).find((o) => o.name.toLowerCase() === last.toLowerCase());
  return rule ? { id: rule.id, name: rule.name } : null;
}

// Гарантия подписи: последняя строка письма — имя отправителя, одна и без лишнего.
// Нужна потому, что LLM периодически забывает подписать, а без подписи заход не запускается.
export function ensureSignature(body, signerName) {
  const text = String(body || '').trimEnd();
  const lines = text.split('\n');
  const last = (lines[lines.length - 1] || '').trim().replace(/[.,!]$/, '');
  if (last.toLowerCase() === String(signerName).toLowerCase()) return text;
  // Модель могла подписать другим именем — заменяем, иначе просто дописываем.
  const known = RULES.map((r) => r.name.toLowerCase()).concat(Object.values(OVERRIDES).map((o) => o.name.toLowerCase()));
  if (known.includes(last.toLowerCase())) {
    lines[lines.length - 1] = signerName;
    return lines.join('\n');
  }
  return `${text}\n\n${signerName}`;
}

// Проверка кампании: все ящики принадлежат личности захода?
// Возвращает {ok, identity, offenders:[{email, identity}]}.
export function validateSenders(angleIdentityId, accounts = []) {
  const offenders = accounts
    .map((a) => ({ email: a.from_email, identity: identityOf(a.from_email) }))
    .filter((a) => a.identity.id !== angleIdentityId);
  return { ok: offenders.length === 0, offenders };
}

// --- LinkedIn-часть захода (L2.4) -----------------------------------------------------------
//
// У email подпись ОБЯЗАТЕЛЬНА (одна кампания = одна личность, ящики round-robin).
// У LinkedIn всё наоборот: отправитель назначается НА КАЖДОГО лида (sender_profile_uuid),
// значит текст обязан быть ОБЕЗЛИЧЕН — имя подставляет профиль, а не шаблон. Подпись или
// чужая строка доверия («ex-McKinsey») в шаблоне = сообщение от Dalia с биографией Стэна.
const LINKEDIN_VARS = ['first_name', 'company_name', 'unique_detail_short'];
const PERSONAL_MARKERS = /mckinsey|hbs\b|harvard|co-?founder|my (team|company|background)|i founded/i;

export function validateLinkedinTexts(linkedin) {
  const errors = [];
  const warnings = [];
  if (!linkedin || !linkedin.message1?.body?.trim()) {
    return { ok: false, errors: ['LinkedIn part has no message #1 — nothing to send after the invite is accepted'], warnings };
  }
  const parts = [
    ['message #1', linkedin.message1?.body || '', { detailAllowed: false, softLimit: 60 }],
    ['follow-up', linkedin.followup?.body || '', { detailAllowed: true, softLimit: 90 }],
  ];
  for (const [label, body, opts] of parts) {
    if (!body.trim()) continue;
    // Переменные — та же дисциплина, что в письмах (ТЗ п.36): у каждой должен быть источник.
    for (const m of body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      if (!LINKEDIN_VARS.includes(m[1])) errors.push(`${label}: unknown variable {{${m[1]}}} — no data source will fill it`);
      if (m[1].startsWith('sender_')) errors.push(`${label}: {{${m[1]}}} — sender is assigned per lead in LinkedIn, the template must not reference one`);
    }
    if (!opts.detailAllowed && /\{\{\s*unique_detail_short\s*\}\}/.test(body)) {
      errors.push(`${label}: {{unique_detail_short}} belongs in the follow-up — message #1 is too short a format for it`);
    }
    if (/\[[^\]]+\]/.test(body)) errors.push(`${label}: [square brackets] — Smartlead-style placeholders do not work here either`);
    // Подпись именем подписанта в конце — ошибка (текст пойдёт от семи разных людей).
    const lines = body.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const last = (lines[lines.length - 1] || '').replace(/[.,!]$/, '');
    if (last.length <= 30 && (RULES.some((r) => r.match.test(last))
      || Object.values(OVERRIDES).some((o) => o.name.toLowerCase() === last.toLowerCase()))) {
      errors.push(`${label}: ends with a signature («${last}») — LinkedIn templates are unsigned, the sending profile is the signature`);
    }
    if (PERSONAL_MARKERS.test(body)) {
      errors.push(`${label}: contains a personal credibility line — it would be sent from several different profiles`);
    }
    const words = body.replace(/\{\{[^}]+\}\}/g, 'x').split(/\s+/).filter(Boolean).length;
    if (words > opts.softLimit) warnings.push(`${label}: ${words} words — LinkedIn reads short; aim under ${opts.softLimit}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
