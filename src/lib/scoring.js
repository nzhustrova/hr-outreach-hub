// Programmatic fit×value scoring — Методология поиска лидов, блок 3 (2026-08-06).
// v1: rules only (no LLM). Unknown attribute = neutral, not zero (Blackstone calibration lesson).
// Detailed breakdowns power the per-row score card (аналог Dimension Scores в SupplierIQ).

import { titleQuery } from './dictionaries.js';

const ROLE_NOUNS = ['procurement', 'sourcing', 'purchasing', 'supply chain', 'buyer'];

function norm(s) {
  return (s || '').toLowerCase().trim();
}

// Title match: exact chip 100 · semantic neighbour (shares role noun) 70 · distant 40.
function titleMatch(r, selectedTitles) {
  const t = norm(r.title);
  if (!t) return { score: 40, kind: 'none', note: 'no title in profile' };
  if (!selectedTitles?.length) return { score: 60, kind: 'neutral', note: 'no titles selected — neutral' };
  // Сверяем и с чипом, и с развёрнутым названием: оператор выбрал «CPO», а в профиле стоит
  // «Chief Procurement Officer» — без разворота точный матч не срабатывал и человек падал в «distant».
  const wanted = selectedTitles.flatMap((s) => [norm(s), norm(titleQuery(s))]);
  if (wanted.some((w) => w && t.includes(w))) return { score: 100, kind: 'exact', note: 'exact match with a selected title' };
  if (ROLE_NOUNS.some((n) => t.includes(n))) return { score: 70, kind: 'neighbour', note: 'semantic neighbour (same role family)' };
  return { score: 40, kind: 'distant', note: 'distant title — semantic expansion' };
}

// Seniority from title text (for value axis and the "meetings — Head+" rule).
export function seniorityOf(title) {
  const t = norm(title);
  if (/\b(chief|cpo|coo|ceo|cfo|c-level|president)\b/.test(t)) return 'c_level';
  if (/\b(vp|vice president)\b/.test(t)) return 'vp';
  if (/\bhead of\b|\bhead,/.test(t)) return 'head';
  if (/\bdirector\b/.test(t)) return 'director';
  if (/\bmanager|supervisor|lead\b/.test(t)) return 'manager';
  return 'other';
}

const SENIORITY_VALUE = { c_level: 100, vp: 90, head: 75, director: 60, manager: 45, other: 30 };

// Ранги для сравнения «уровень роли vs выбранный seniority-фильтр» (наблюдение Ольги 06-07.08:
// менеджеры протекали в рекомендованные при C-Level фильтре).
const SENIORITY_RANK = { c_level: 5, vp: 4, head: 3.5, director: 3, manager: 2, other: 1 };
const TITLETYPE_RANK = { c_suite: 5, owner: 5, vp: 4, director: 3, manager: 2 };

// Parse company size strings: "10,001+" → [10001, Inf]; "501-1,000" → [501,1000]; 245 → [245,245].
export function parseSize(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return [s, s];
  const nums = String(s).replace(/,/g, '').match(/\d+/g);
  if (!nums) return null;
  const lo = Number(nums[0]);
  const hi = /\+/.test(String(s)) ? Infinity : Number(nums[1] ?? nums[0]);
  return [lo, hi];
}

function envelope(sizes) {
  if (!sizes?.length) return null;
  const bounds = sizes.map((s) => s.split(',').map(Number));
  return [Math.min(...bounds.map((b) => b[0])), Math.max(...bounds.map((b) => b[1]))];
}

// Company fit: per-row size/geo come in the Explee feed (raw fields, 2026-08-06).
function companyFit(r, form) {
  if (!r.company) return { score: 30, note: 'company unknown' };
  const checks = [];
  const notes = [];
  const env = envelope(form.sizes);
  const size = parseSize(r.companySize);
  if (env && size) {
    const ok = size[0] <= env[1] && size[1] >= env[0];
    checks.push(ok ? 100 : 20);
    notes.push(ok ? `size ${r.companySize} within selected range` : `size ${r.companySize} outside selected range`);
  }
  if (r.companyGeo && form.location === 'United States') {
    const ok = r.companyGeo === 'US';
    checks.push(ok ? 100 : 40);
    notes.push(ok ? 'company HQ in US' : `company HQ in ${r.companyGeo} — foreign HQ penalty`);
  }
  if (!checks.length) return { score: 60, note: 'size/geo unknown — neutral (not zero)' };
  return { score: Math.round(checks.reduce((a, b) => a + b, 0) / checks.length), note: notes.join('; ') };
}

export function fitBreakdown(r, flags, form, industryVerdicts = {}) {
  let title = titleMatch(r, form.titles);
  // Seniority-дисквалификация: роль ниже выбранного уровня → итог жёстко ниже порога рекомендации,
  // как бы хорошо ни матчился остальной профиль (протечка менеджеров, Ольга 06–07.08).
  const selRank = TITLETYPE_RANK[form.titleType];
  // Точный матч с явно выбранным чипом НЕ дисквалифицируется (пользователь этих людей попросил);
  // cap — только для семантических соседей/дальних, пришедших из расширения Explee или LLM-углов.
  const belowSeniority = selRank && title.kind !== 'exact' && SENIORITY_RANK[seniorityOf(r.title)] < selRank;
  if (belowSeniority) {
    title = { score: Math.min(title.score, 40), note: `${title.note}; role level below selected seniority` };
  }
  const company = companyFit(r, form);
  const quality = {
    score: Math.max(0, 100 - (flags?.length || 0) * 40),
    note: flags?.length ? `flags: ${flags.join('; ')}` : 'no data-quality flags',
  };
  const contact = r.linkedin && r.email
    ? { score: 100, note: 'LinkedIn + email' }
    : r.linkedin ? { score: 85, note: 'LinkedIn only (email via enrichment)' }
    : r.email ? { score: 70, note: 'email only' }
    : { score: 0, note: 'no contact channel' };

  // Ось «индустрия» (ТЗ п.38). Раньше её не было вовсе: Company fit смотрел только размер
  // и гео, поэтому DHL, притянутый семантикой в Manufacturing, получал нормальный скор —
  // штрафовать было нечем. Ось ЖЁСТКАЯ: mismatch уводит ниже порога рекомендации.
  // Применяется только при выбранной индустрии — как сигнал (правило Ольги 11.08).
  const industryPart = (() => {
    if (!form.industry) return null;
    const raw = String(r.companyIndustry || '').trim();
    // Индустрия неизвестна → «смежная», без вызова модели: отсутствие данных не режет контакт.
    if (!raw) return { score: 55, verdict: 'adjacent', note: 'company industry unknown — treated as adjacent' };
    const v = industryVerdicts[raw];
    if (!v) return { score: 55, verdict: 'adjacent', note: `«${raw}» — not judged yet` };
    if (v.verdict === 'fits') return { score: 100, verdict: 'fits', note: `«${raw}» — ${v.note || 'matches the segment'}` };
    if (v.verdict === 'mismatch') return { score: 0, verdict: 'mismatch', note: `«${raw}» — ${v.note || 'different business'}` };
    return { score: 55, verdict: 'adjacent', note: `«${raw}» — ${v.note || 'related but not the core'}` };
  })();
  const industryMismatch = industryPart?.verdict === 'mismatch';

  const parts = [
    { label: 'Title match', weight: 30, ...title },
    { label: 'Company fit', weight: 25, ...company },
  ];
  if (industryPart) parts.push({ label: 'Industry', weight: 20, ...industryPart });
  // Сигнал не выбран → критерий не применяется, его вес перераспределяется на остальные
  // (не «нейтральные 60», которые выглядели как фантомное соответствие — вопрос Ольги 07.08).
  if (form.signal || form.signal2) {
    parts.push({ label: 'Signal', weight: 20, score: 100, note: 'passed the selected signal filter' });
  }
  parts.push(
    { label: 'Data quality', weight: 15, ...quality },
    { label: 'Contact availability', weight: 10, ...contact },
  );
  const weightSum = parts.reduce((s, p) => s + p.weight, 0);
  let total = Math.round(parts.reduce((sum, p) => sum + (p.weight / weightSum) * p.score, 0));
  if (belowSeniority && total > 65) {
    total = 65; // дисквалификация: ниже порога рекомендации (70), в карточке видно почему
    parts[0].note += ' — capped below recommendation threshold';
  }
  // Жёсткая ось: несовпадение индустрии тоже уводит ниже порога, как бы хорош ни был остальной
  // профиль. Именно это отсекает DHL при фильтре Manufacturing — раньше отсекать было нечем.
  if (industryMismatch && total > 65) {
    total = 65;
    const ip = parts.find((p) => p.label === 'Industry');
    if (ip) ip.note += ' — capped below recommendation threshold';
  }
  return { total, parts, weightSum };
}

export function valueBreakdown(r, form) {
  let size = { score: 50, note: 'company size unknown — neutral' };
  const env = envelope(form?.sizes);
  const parsed = parseSize(r.companySize);
  if (parsed) {
    if (!env) size = { score: 60, note: `size ${r.companySize}, no range selected` };
    else if (parsed[0] > env[1]) size = { score: 40, note: `size ${r.companySize} — above segment range` };
    else if (parsed[1] < env[0]) size = { score: 30, note: `size ${r.companySize} — below segment range` };
    else {
      const mid = Math.min(parsed[1], env[1]);
      size = {
        score: Math.round(60 + 40 * ((mid - env[0]) / Math.max(1, env[1] - env[0]))),
        note: `size ${r.companySize} — larger within range = higher`,
      };
    }
  }
  const sen = seniorityOf(r.title);
  const role = { score: SENIORITY_VALUE[sen], note: `seniority: ${sen.replace('_', '-')}` };
  const channels = r.linkedin && r.email
    ? { score: 100, note: 'both channels → multichannel cadence' }
    : r.linkedin || r.email ? { score: 60, note: 'single channel' } : { score: 0, note: 'no channels' };

  const parts = [
    { label: 'Company size (in range)', weight: 40, ...size },
    { label: 'Role seniority', weight: 40, ...role },
    { label: 'Multichannel', weight: 20, ...channels },
  ];
  const total = Math.round(parts.reduce((sum, p) => sum + (p.weight / 100) * p.score, 0));
  return { total, parts };
}

export function scoreFit(r, flags, form, industryVerdicts) {
  return fitBreakdown(r, flags, form, industryVerdicts).total;
}

export function scoreValue(r, form) {
  return valueBreakdown(r, form).total;
}

export const FIT_RECOMMEND_THRESHOLD = 70;

export const SCORE_HELP = {
  fit: 'Fit (0–100): how well this person matches the segment — title match (30%), company fit: size/geo (25%), industry (20%, only when an industry is selected), signal (20%), data quality (15%), contact availability (10%). An industry mismatch caps the score below the recommendation threshold, however good the rest looks.',
  value: 'Value (0–100): how valuable a hit would be — company size within the segment range (40%), role seniority (40%), multichannel reach (20%). Sorts the queue among those who passed Fit.',
};
