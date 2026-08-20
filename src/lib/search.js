import { applySignal, INDUSTRY_DEFINITIONS, INDUSTRY_APOLLO_TAGS, titleQuery } from './dictionaries.js';

// Explee people_filters.geo ждёт ISO-коды (в ответах geo: "US"), company geo_include — названия.
const ISO = {
  'United States': 'US', Canada: 'CA', 'United Kingdom': 'GB',
  Germany: 'DE', France: 'FR', Netherlands: 'NL',
};

// Сборка запроса и нормализация ответа по провайдеру.
// v0: ищем ЛЮДЕЙ (стадии B3+B4 вместе); компании отдельно — позже.

import { US_REGIONS } from './dictionaries.js';

const regionByLabel = (label) => US_REGIONS.find((r) => r.label === label);

// Explee has no separate seniority filter; its job_titles are semantic.
// So: seniority acts as a FALLBACK title when no titles are selected (adding it alongside
// titles would OR-broaden the pool instead of narrowing it).
const SENIORITY_AS_TITLE = {
  c_suite: ['Chief Officer', 'C-level executive'],
  vp: ['Vice President', 'VP'],
  director: ['Director'],
  manager: ['Manager'],
  owner: ['Founder', 'Owner'],
};

export function buildExpleePayload(f, pageSize = 10, page = 1) {
  const company = {};
  // Первый заслон от мёртвых компаний (методология, блок 1). Задумывался 06.08, но в код не попал —
  // обнаружено сверкой 11.08. Прогон C показал цену пропуска: фильтр «traffic growth» прошли Fry's
  // и Century 21, обе закрытые. Поле у Explee есть (`is_alive`, `is_alive_min` — API-аудит §4),
  // ставится всегда и невидимо для оператора: это гигиена, а не настройка.
  company.is_alive = true;
  if (f.location) company.geo_include = [f.location];
  const region = regionByLabel(f.region);
  if (region?.codes?.length) company.geo_subdivision = region.codes; // ISO-3166-2, e.g. US-CA
  if (f.sizes?.length) {
    // Explee takes a single {min,max} range → use the envelope of selected ranges.
    const bounds = f.sizes.map((s) => s.split(',').map(Number));
    company.size = { min: Math.min(...bounds.map((b) => b[0])), max: Math.max(...bounds.map((b) => b[1])) };
  }
  if (f.industry) company.definition = INDUSTRY_DEFINITIONS[f.industry] || `${f.industry} companies`; // v0: semantic industry; NACE mapping later
  applySignal(company, f.signal);
  applySignal(company, f.signal2);
  // Advanced-поля: Apollo-сигнал «нанимает роль» для Explee аппроксимируется hiring_is (у него нет ролей);
  // technologies и revenue у Explee есть нативно.
  if (f.hiringRole) company.hiring_is = true;
  if (f.technologies) company.technologies = f.technologies.split(',').map((s) => s.trim()).filter(Boolean);
  if (f.revenueMin) company.revenue_annual = { min: Number(f.revenueMin) };

  const people = {};
  // Аббревиатуры разворачиваем: семантика Explee читает «CPO» как Chief Product Officer (ТЗ п.39).
  if (f.titles?.length) people.job_titles = f.titles.map(titleQuery);
  else if (f.titleType && SENIORITY_AS_TITLE[f.titleType]) people.job_titles = SENIORITY_AS_TITLE[f.titleType];
  // Стоп-роли (методология, блок 6): паразитные роли режем до выдачи; «Marketing»-гибриды — скорингом, не exclude.
  people.job_titles_exclude = 'Assistant, Intern, Student, Trainee, Coordinator';
  if (f.location) people.geo = [ISO[f.location] || f.location];
  people.people_per_company_limit = 2;

  return { people_filters: people, company_filters: company, page, page_size: pageSize };
}

export function buildApolloPayload(f, perPage = 10, page = 1) {
  const p = { per_page: perPage, page };
  const region = regionByLabel(f.region);
  const loc = region?.apollo || (region?.codes?.length ? null : f.location);
  p.person_locations = [loc || f.location].filter(Boolean);
  if (region?.codes?.length && !region.apollo) {
    // Macro-region → list of "State, US" strings for Apollo
    p.person_locations = region.codes.map((c) => `${c.slice(3)}, US`);
  }
  if (f.titles?.length) p.person_titles = f.titles.map(titleQuery);
  if (f.titleType) p.person_seniorities = [f.titleType];
  if (f.sizes?.length) p.organization_num_employees_ranges = f.sizes;
  if (f.industry) p.q_organization_keyword_tags = [INDUSTRY_APOLLO_TAGS[f.industry] || f.industry];
  // Advanced-поля (проверены живыми вызовами 07.08):
  if (f.hiringRole) {
    p.q_organization_job_titles = [f.hiringRole];
    const d = new Date(); d.setDate(d.getDate() - (Number(f.hiringPostedDays) || 30));
    p.organization_job_posted_at_range = { min: d.toISOString().slice(0, 10) };
  }
  if (f.verifiedEmailOnly) p.contact_email_status = ['verified'];
  if (f.technologies) p.currently_using_any_of_technology_uids = f.technologies.split(',').map((s) => s.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
  if (f.keywords) p.q_keywords = f.keywords;
  if (f.revenueMin) p.revenue_range = { min: Number(f.revenueMin) };
  return p;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o ? o[part] : undefined), obj);
    if (v) return v;
  }
  return '';
}

// Normalized identity keys: primary (LinkedIn URL) + fallbacks for cross-base merging.
// Case found by Olga 07.08: Explee «Turner» vs Apollo «Turner Construction Company» —
// same person, different company strings → name+domain and name+company-prefix keys.
export function nameTokens(r) {
  return (r.name || '').toLowerCase().replace(/[.,]/g, '').split(/\s+/).filter(Boolean).sort().join(' ');
}

export function identityKey(r) {
  if (r.linkedin) return r.linkedin.toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');
  return `${nameTokens(r)}|${(r.company || '').toLowerCase()}`;
}

// Все ключи, по которым запись может совпасть с другой (для мержа двух баз).
export function identityKeys(r) {
  const keys = [identityKey(r)];
  const nt = nameTokens(r);
  if (nt) {
    if (r.domain) keys.push(`${nt}|dom:${r.domain.toLowerCase()}`);
    const firstWord = (r.company || '').toLowerCase().split(/\s+/)[0];
    if (firstWord && firstWord.length >= 4) keys.push(`${nt}|co:${firstWord}`);
  }
  return keys;
}

export function sameIdentity(a, b) {
  const ka = new Set(identityKeys(a));
  return identityKeys(b).some((k) => ka.has(k));
}

// Auto-flag rules — the "do NOT shortlist" checklist (ТЗ п.6a, decision 2026-08-06).
// Simple rules run in code and FLAG (not delete); complex ones (company type, non-DM) — LLM at scoring step.
export function flagResult(r, all, idx = -1) {
  const reasons = [];
  const dupCount = all.filter((x) => sameIdentity(x, r)).length;
  if (dupCount > 1) reasons.push('duplicate (same person, base variants)');
  const name = (r.name || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p.replace(/[^A-Za-zА-Яа-я]/g, '').length === 1 && p === parts[parts.length - 1]))
    reasons.push('broken name');
  if (/\b(former|ex-|retired|assistant to)\b/i.test(r.title || '')) reasons.push('not a decision maker');
  if (/#?opentowork/i.test(`${r.title} ${r.name}`)) reasons.push('open to work — likely leaving');
  // Больше 2 с одной компании: флагуем только 3-го и далее (первые два — легитимны),
  // а не всех разом (наблюдение Ольги 07.08: раньше выбрасывались оба).
  if (r.company && idx >= 0) {
    const occurrence = all.slice(0, idx + 1).filter((x) => x.company === r.company).length;
    if (occurrence > 2) reasons.push(`3rd+ person from ${r.company}`);
  }
  if (!r.linkedin && !r.email) reasons.push('no contact channel');
  // Гос-структуры (решение Ольги 07.08): закупки по тендерным регламентам, колд-аутрич не работает.
  // Флагуем (не выбрасываем): .gov/.mil в домене или почте, County/Authority/Command и пр. в названии.
  const govDomain = /\.(gov|mil)$/i.test(r.domain || '') || /\.(gov|mil)$/i.test((r.email || '').split('@')[1] || '');
  const govName = /\b(county|authority|command|municipal|federal|city of|state of|department of)\b/i.test(r.company || '');
  if (govDomain || govName) reasons.push('government entity — tender-driven procurement');
  return reasons;
}

export function normalizeResults(provider, data) {
  let items = [];
  if (provider === 'apollo') items = data.people || data.contacts || [];
  else items = data.items || data.results || data.people || data.data || (Array.isArray(data) ? data : []);

  return items.map((it) => ({
    name: pick(it, ['name', 'full_name']) || [pick(it, ['first_name']), pick(it, ['last_name'])].filter(Boolean).join(' '),
    firstName: pick(it, ['first_name']),
    lastName: pick(it, ['last_name']),
    title: pick(it, ['title', 'job_title', 'position', 'headline']),
    company: pick(it, ['company', 'company_name', 'organization.name', 'organization_name', 'company.name']),
    domain: pick(it, ['company_domain', 'organization.primary_domain', 'organization.website_url']),
    companySize: pick(it, ['company_size', 'organization.estimated_num_employees']),
    // Годовая выручка приезжает от обоих источников и раньше выбрасывалась (найдено 13.08):
    // Explee отдаёт её прямо в поиске, Apollo — в reveal, за который мы и так платим.
    revenue: Number(pick(it, [
      'company_revenue_annual', 'organization.annual_revenue', 'organization.organization_revenue',
      'annual_revenue',
    ])) || null,
    companyGeo: pick(it, ['company_geo']),
    companyIndustry: pick(it, ['company_industry', 'organization.industry']),
    location: pick(it, ['location', 'geo', 'city', 'country', 'present_raw_address']) || [pick(it, ['city']), pick(it, ['state'])].filter(Boolean).join(', '),
    linkedin: pick(it, ['linkedin_url', 'linkedin', 'li_url', 'linkedin_profile_url']),
    email: pick(it, ['email', 'work_email']),
    emailStatus: pick(it, ['email_status']),
    uniqueDetail: pick(it, ['unique_detail']) || null, // угол №0: деталь из реестра приезжает бесплатно
    raw: it,
  }));
}
