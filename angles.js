// Движок углов (методология, блоки 1 и 5): LLM формирует «идеального лида» и углы-вариации,
// углы выполняются параллельно (Explee) + угол №0 из реестра; union + дедуп по identity.
// Без ANTHROPIC_API_KEY деградирует мягко: один базовый угол + реестр.
import crypto from 'node:crypto';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5-20251001';
const MAX_ANGLES = 5;

const angleCache = new Map(); // hash(criteria) → {ideal_lead, angles} (память процесса — достаточно для сессии)

function criteriaHash(criteria) {
  return crypto.createHash('sha1').update(JSON.stringify(criteria)).digest('hex');
}

export function anglesEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function generateAngles(criteria) {
  const hash = criteriaHash(criteria);
  if (angleCache.has(hash)) return angleCache.get(hash);
  if (!anglesEnabled()) {
    const fallback = {
      ideal_lead: null,
      angles: [{ label: 'base', titles: criteria.titles || [], definition: criteria.industry ? `${criteria.industry} companies` : null }],
      llm: false,
    };
    return fallback;
  }

  // Человекочитаемые размеры для LLM (сырое «5001,1000000» рождало «1,000-1,000,000 employees» — Ольга, 07.08).
  const SIZE_LABELS = {
    '1,10': '1–10', '11,50': '11–50', '51,200': '51–200', '201,500': '201–500',
    '501,1000': '501–1,000', '1001,5000': '1,001–5,000', '5001,1000000': '5,000+ (enterprise)',
  };
  const humanSizes = (criteria.sizes || []).map((s) => SIZE_LABELS[s] || s).join(' / ') || 'any';

  // Advanced-фильтры — тоже часть жёсткой рамки: идеальный лид обязан их отражать (вопрос Ольги 07.08).
  const advanced = [
    criteria.hiringRole ? `company is actively hiring ${criteria.hiringRole} roles (job posted ≤ ${criteria.hiringPostedDays || 30} days ago)` : null,
    criteria.revenueMin ? `annual revenue ≥ $${(Number(criteria.revenueMin) / 1000000).toLocaleString('en-US')}M` : null,
    criteria.technologies ? `company uses: ${criteria.technologies}` : null,
    criteria.keywords ? `keyword context: "${criteria.keywords}"` : null,
    criteria.verifiedEmailOnly ? 'only people with a verified email' : null,
  ].filter(Boolean).join('; ') || 'none';

  const prompt = `You generate search angles for a B2B lead discovery tool (cold outreach, supplier-side SaaS).
Hard frame (do NOT change): location=${criteria.location}, region=${criteria.region || 'any'}, company size=${humanSizes} employees, signals=${[criteria.signal, criteria.signal2].filter(Boolean).join(', ') || 'none'}.
Advanced hard filters: ${advanced}. If a hiring filter is set, the ideal-lead description MUST mention that the company is hiring those roles right now.
Soft inputs to vary: industry="${criteria.industry || 'any'}", selected titles=${JSON.stringify(criteria.titles || [])}, minimum seniority=${criteria.titleType || 'as implied by selected titles'}.

Return STRICT JSON only (no markdown):
{
 "ideal_lead": "<2-3 sentence description of the ideal person to find, readable by a salesperson; state the company size exactly as given in the hard frame>",
 "angles": [
   {"label": "<short slug>", "titles": ["<title variant>", ...], "definition": "<company definition phrase for semantic search, e.g. 'industrial manufacturing companies'>"}
 ]
}
Rules: 3-${MAX_ANGLES} angles. Each angle = different title formulations (synonyms, adjacent role names) and/or different industry definition phrasing.
SENIORITY FLOOR (strict): every generated title must be AT OR ABOVE the seniority level of the selected titles / minimum seniority. If the selected titles are C-level, VP or Head — do NOT generate Manager-, Specialist- or Coordinator-level titles.
Angles must be meaningfully different from each other.`;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: HAIKU,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const text = data.content?.[0]?.text || '{}';
  const parsed = JSON.parse(text.replace(/^```json?\s*|\s*```$/g, ''));
  const result = {
    ideal_lead: parsed.ideal_lead || null,
    angles: (parsed.angles || []).slice(0, MAX_ANGLES).map((a) => ({
      label: a.label || 'angle',
      titles: Array.isArray(a.titles) ? a.titles : [],
      definition: a.definition || null,
    })),
    llm: true,
  };
  if (!result.angles.length) throw new Error('LLM returned no angles');
  angleCache.set(criteriaHash(criteria), result);
  return result;
}

// Нормализованный identity-ключ (зеркало клиентского identityKey).
export function identityKeyServer(p) {
  const li = p.linkedin_url || p.linkedin;
  if (li) return li.toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.full_name || p.name || '';
  const tokens = name.toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
  return `${tokens}|${(p.company_name || p.company || '').toLowerCase()}`;
}

// Выполнение углов: параллельные Explee-запросы (клон basePayload с подменой titles/definition).
export async function runAngles({ basePayload, angles, pageSize = 10 }) {
  const EXPLEE = 'https://api.explee.com/public/api/v1';
  const key = process.env.EXPLEE_API_KEY;

  const tasks = angles.map(async (angle) => {
    const payload = JSON.parse(JSON.stringify(basePayload));
    if (angle.titles?.length) payload.people_filters.job_titles = angle.titles;
    if (angle.definition) payload.company_filters.definition = angle.definition;
    payload.page_size = pageSize;
    try {
      const r = await fetch(`${EXPLEE}/search/people`, {
        method: 'POST',
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return { angle: angle.label, error: data?.detail || r.status, people: [], total: null };
      return {
        angle: angle.label,
        people: data.people || [],
        total: data?.meta?.total ?? null,
        balance: data?.meta?.remaining_balance ?? null,
      };
    } catch (e) {
      return { angle: angle.label, error: String(e.message || e), people: [], total: null };
    }
  });

  const settled = await Promise.all(tasks);

  // Union + дедуп; первый источник побеждает, дубль добавляет угол в meta.
  const seen = new Map();
  for (const res of settled) {
    for (const p of res.people) {
      const k = identityKeyServer(p);
      if (seen.has(k)) seen.get(k)._angles.push(res.angle);
      else seen.set(k, { ...p, _angles: [res.angle], _source: 'explee' });
    }
  }
  const balance = settled.map((s) => s.balance).filter((b) => b != null).pop() ?? null;
  return {
    results: [...seen.values()],
    angleStats: settled.map(({ angle, total, error, people }) => ({ angle, total, error: error || null, returned: people.length })),
    balance,
  };
}
