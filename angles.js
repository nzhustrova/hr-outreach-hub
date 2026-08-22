// Движок углов (методология, блоки 1 и 5): LLM формирует «идеального лида» и углы-вариации,
// углы выполняются параллельно (Explee) + угол №0 из реестра; union + дедуп по identity.
// Без ANTHROPIC_API_KEY деградирует мягко: один базовый угол + реестр.
import crypto from 'node:crypto';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5-20251001';
const MAX_ANGLES = 8;

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

/**
 * ⚠️ ЦЕНА ПОИСКА У EXPLEE — знание, купленное сожжённым балансом (20–21.08.2026).
 * Прочитай это до любой правки объёмов поиска.
 *
 * ЧТО СЛУЧИЛОСЬ. В коде стояло убеждение «поиск людей у Explee кредитов не тратит».
 * Оно было основано на честном замере: при `page_size` 5 и 10 провайдер отвечает
 * `credits_charged: 0.0`. На этом основании был построен постраничный обход всего пула.
 * За один день обход сжёг практически весь баланс.
 *
 * ИЗМЕРЕННЫЕ ФАКТЫ (живые вызовы, не документация):
 *   • `page_size` 1, 10, 100 → данные, `credits_charged: 0.0`;
 *   • `page_size` 150        → данные, `credits_charged: 50.0`;
 *   • одни и те же фильтры, три запроса подряд по 100:
 *       страница 1 → списано 0 · страница 2 → списано 100 · страница 3 → списано 100;
 *   • та же страница 1 ПОВТОРНО → 0 (перезапуск поиска бесплатен);
 *   • страница 1 при ДРУГИХ фильтрах → 0 (у каждого набора фильтров своя бесплатная сотня);
 *   • при нулевом балансе `page_size >= 200` → HTTP 402;
 *   • отдельно есть лимит частоты: 15 бесплатных запросов в минуту на организацию
 *     (тариф Starter), 2000 в сутки. Это 429, и он НЕ то же самое, что 402.
 *
 * ИСТИННАЯ МОДЕЛЬ: бесплатны первые 100 результатов НАБОРА ФИЛЬТРОВ, а не запроса.
 * Результат 101 и далее стоит 1 кредит — неважно, добран он большим `page_size`
 * или следующей страницей.
 *
 * ⚠️ ОТДЕЛЬНО: на нулевом балансе перестаёт работать и БЕСПЛАТНЫЙ поиск — документация
 * Explee требует положительный баланс для любого запроса. Баланс нельзя доводить до нуля,
 * даже если работаешь только в бесплатной зоне.
 *
 * ЧТО ИЗ ЭТОГО СЛЕДУЕТ ДЛЯ АРХИТЕКТУРЫ — главное:
 * объём берётся умножением НАБОРОВ ФИЛЬТРОВ, а не страниц. Каждый угол — свой набор
 * фильтров, значит своя бесплатная сотня. Восемь углов дают ~800 сырых строк бесплатно
 * (после дедупа ~490 уникальных) — этого хватает на волну в 300 контактов при нулевой
 * цене поиска. Постраничный добор — платный аварийный выход, а не способ набрать пул.
 *
 * ПРАВИЛО В КОДЕ, которое нельзя снимать не подумав:
 *   • `wanted` по умолчанию 100 — ровно одна страница на угол;
 *   • `pageSize` жёстко зажат в 100 (`EXPLEE_MAX_PAGE_SIZE`);
 *   • нужен объём — увеличивай ЧИСЛО УГЛОВ, а не глубину страниц;
 *   • граница API (`/api/explee/people`) отклоняет `page_size > 100` и `page > 1`.
 *     Ограничение живёт и в вызывающем коде, и на границе: только в вызывающем оно
 *     переживает ровно одну правку соседнего файла.
 *
 * УРОК, стоивший баланса: измерение на одном значении параметра ничего не говорит
 * о другом. Сначала «бесплатно при page_size=10» приняли за «бесплатно всегда»; потом
 * «бесплатно на первой странице» приняли за «бесплатно на каждой». Проверять надо
 * границу, а не точку.
 */
export const EXPLEE_FREE_RESULTS = 100;
export const EXPLEE_MAX_PAGE_SIZE = 100;

// Выполнение углов: параллельные Explee-запросы (клон basePayload с подменой titles/definition).
// Каждый угол — ОТДЕЛЬНЫЙ поиск, а не слой скоринга: оператор видит объединение выдач
// всех углов с дедупом по личности.
export async function runAngles({ basePayload, angles, pageSize = 100, page = 1, wanted = EXPLEE_FREE_RESULTS }) {
  const EXPLEE = 'https://api.explee.com/public/api/v1';
  const key = process.env.EXPLEE_API_KEY;
  const size = Math.min(EXPLEE_MAX_PAGE_SIZE, Math.max(1, pageSize));

  const tasks = angles.map(async (angle) => {
    const base = JSON.parse(JSON.stringify(basePayload));
    if (angle.titles?.length) base.people_filters.job_titles = angle.titles;
    if (angle.definition) base.company_filters.definition = angle.definition;
    const people = [];
    let total = null;
    let balance = null;
    let charged = 0;
    const firstPage = Number(page) || 1;
    const maxPages = Math.max(1, Math.ceil(wanted / size));
    for (let i = 0; i < maxPages; i += 1) {
      const payload = { ...base, page_size: size, page: firstPage + i };
      try {
        const r = await fetch(`${EXPLEE}/search/people`, {
          method: 'POST',
          headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (!r.ok) {
          // Три РАЗНЫХ причины неудачи, и путать их нельзя: «угол ничего не нашёл» — свойство
          // сегмента, а 402 и 429 требуют действий, и разных.
          const detail = data?.detail || r.status;
          const outOfMoney = r.status === 402 || /insufficient balance/i.test(String(detail));
          const quotaHit = r.status === 429;
          return {
            angle: angle.label, people, total, charged,
            error: outOfMoney
              ? `нет баланса Explee (${detail}). На нуле не работает и бесплатный поиск — пополни баланс.`
              : quotaHit
                ? `исчерпана бесплатная квота Explee: 15 запросов в минуту и 2000 в сутки на тарифе Starter (${detail}). Подожди минуту — платные запросы этой квотой не ограничены.`
                : detail,
            outOfMoney, quotaHit, frameChanged: Boolean(angle.definition),
          };
        }
        const rows = data.people || [];
        people.push(...rows);
        total = data?.meta?.total ?? total;
        balance = data?.meta?.remaining_balance ?? balance;
        // `credits_charged` провайдер присылает В КАЖДОМ ответе. Раньше его выбрасывали и
        // читали только остаток — именно поэтому расход 20.08 пришлось восстанавливать
        // сопоставлением коммитов с кабинетом Explee. Это ИЗМЕРЕННАЯ цена, не оценка.
        charged += Number(data?.meta?.credits_charged || 0);
        if (rows.length < size) break;      // пул исчерпан
        if (people.length >= wanted) break; // набрали сколько просили
      } catch (e) {
        return { angle: angle.label, error: String(e.message || e), people, total, charged, frameChanged: Boolean(angle.definition) };
      }
    }
    return { angle: angle.label, people, total, balance, charged, frameChanged: Boolean(angle.definition) };
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
  // Суммарное СПИСАНИЕ по всем углам — измеренное провайдером, а не наша оценка.
  const charged = settled.reduce((n, r) => n + Number(r.charged || 0), 0);
  return {
    results: [...seen.values()],
    angleStats: settled.map(({ angle, total, error, people, frameChanged, outOfMoney, quotaHit, charged: c }) => ({
      angle, total, error: error || null, returned: people.length,
      frameChanged: Boolean(frameChanged),
      outOfMoney: Boolean(outOfMoney),
      quotaHit: Boolean(quotaHit),
      charged: Number(c || 0),
      // Есть ли у угла ещё люди сверх того, что мы забрали. Отвечает на «в сегменте ещё N».
      more: total != null ? Math.max(0, total - people.length) : null,
    })),
    balance,
    charged,
  };
}
