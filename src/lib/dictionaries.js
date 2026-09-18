// Dropdown dictionaries for the search panel (v0).
// Sources: Explee OpenAPI enums (captured 2026-08-04, see 02_specs/.../API-аудит) + base values.
// TODO: full Apollo dictionaries (industry tags, seniority) — task 4.1.

// Countries and regions live in geo.js — one list shared with SerenZi's bridge.
export { LOCATION_OPTIONS as LOCATIONS } from './geo.js';

// Explee geo_subdivision requires ISO-3166-2 codes (verified 2026-08-06: 'California' → 0, 'US-CA' → results).
// Macro-regions expand to state code sets (US Census definitions, main states).
export const US_REGIONS = [
  { label: 'Any', codes: [], apollo: '' },
  { label: 'Northeast', codes: ['US-CT', 'US-ME', 'US-MA', 'US-NH', 'US-RI', 'US-VT', 'US-NJ', 'US-NY', 'US-PA'], apollo: '' },
  { label: 'Midwest', codes: ['US-IL', 'US-IN', 'US-MI', 'US-OH', 'US-WI', 'US-IA', 'US-KS', 'US-MN', 'US-MO', 'US-NE'], apollo: '' },
  { label: 'South', codes: ['US-FL', 'US-GA', 'US-MD', 'US-NC', 'US-SC', 'US-VA', 'US-AL', 'US-KY', 'US-TN', 'US-AR', 'US-LA', 'US-OK', 'US-TX'], apollo: '' },
  { label: 'West', codes: ['US-AZ', 'US-CO', 'US-NV', 'US-NM', 'US-UT', 'US-AK', 'US-CA', 'US-HI', 'US-OR', 'US-WA'], apollo: '' },
  { label: 'California', codes: ['US-CA'], apollo: 'California, US' },
  { label: 'New York', codes: ['US-NY'], apollo: 'New York, US' },
  { label: 'Texas', codes: ['US-TX'], apollo: 'Texas, US' },
  { label: 'Florida', codes: ['US-FL'], apollo: 'Florida, US' },
  { label: 'Illinois', codes: ['US-IL'], apollo: 'Illinois, US' },
  { label: 'Georgia', codes: ['US-GA'], apollo: 'Georgia, US' },
  { label: 'Pennsylvania', codes: ['US-PA'], apollo: 'Pennsylvania, US' },
  { label: 'Ohio', codes: ['US-OH'], apollo: 'Ohio, US' },
];

export const COMPANY_SIZES = [
  { label: 'Any', value: '' },
  { label: '1–10', value: '1,10' },
  { label: '11–50', value: '11,50' },
  { label: '51–200', value: '51,200' },
  { label: '201–500', value: '201,500' },
  { label: '501–1000', value: '501,1000' },
  { label: '1001–5000', value: '1001,5000' },
  { label: '5000+ (Enterprise)', value: '5001,1000000' },
];

// «Manufacturing» семантически включает LVMH/L'Oréal/Levi's (они формально производители) —
// наблюдение Тони 07.08. Для тяжёлой промышленности — отдельный, более узкий пункт.
export const INDUSTRIES = [
  '', 'Manufacturing', 'Industrial Manufacturing',
  'Retail', 'E-commerce', 'Logistics & Supply Chain', 'Construction',
  'Food & Beverage', 'Consumer Goods', 'Automotive', 'Healthcare', 'Financial Services', 'Hospitality',
];

// Точные семантические определения для Explee там, где `${industry} companies` слишком широк.
export const INDUSTRY_DEFINITIONS = {
  'Industrial Manufacturing': 'industrial manufacturing companies (machinery, equipment, industrial components — not consumer fashion, luxury or cosmetics)',
};

// Apollo keyword-теги там, где label не совпадает с тегом Apollo.
export const INDUSTRY_APOLLO_TAGS = {
  'Industrial Manufacturing': 'manufacturing',
};

export const TITLE_TYPES = [
  { label: 'Any', value: '' },
  { label: 'C-Level (Executive)', value: 'c_suite' },
  { label: 'VP', value: 'vp' },
  { label: 'Director', value: 'director' },
  { label: 'Manager', value: 'manager' },
  { label: 'Owner/Founder', value: 'owner' },
];

export const TITLES = [
  '', 'CPO', 'Chief Procurement Officer', 'VP of Sourcing', 'VP of Procurement',
  'Head of Procurement', 'Procurement Manager', 'Sourcing Manager', 'Supply Chain Director',
  'Head of Supply Chain', 'Purchasing Manager', 'COO',
];

// Перевод аббревиатуры в запрос (ТЗ п.39, задача Ольги 11.08).
// У Explee job_titles — СЕМАНТИЧЕСКОЕ поле, и «CPO» он понимает как Chief PRODUCT Officer.
// Проверено живым запросом 11.08 на одинаковых фильтрах:
//   job_titles: ['CPO']                        → 0 закупочных из 15 (первым пришёл шеф-повар)
//   job_titles: ['Chief Procurement Officer']  → 15 закупочных из 15
// Чип оператору показываем прежний — он мыслит аббревиатурой; в API уходит развёрнутое.
export const TITLE_QUERY = {
  CPO: 'Chief Procurement Officer',
  COO: 'Chief Operating Officer',
  CSO: 'Chief Sourcing Officer',
  CCO: 'Chief Commercial Officer',
};

export const titleQuery = (label) => TITLE_QUERY[label] || label;

// Signals: Explee filter values (enums from OpenAPI).
export const SIGNALS = [
  { label: '— no signal —', value: '' },
  { label: 'Hiring now', value: 'hiring_now' },
  { label: 'Headcount growth: high', value: 'growth_high' },
  { label: 'Headcount growth: growing', value: 'growth_growing' },
  { label: 'Headcount declining', value: 'growth_declining' },
  { label: 'Funding ≤6mo: Seed', value: 'funding_seed_6m' },
  { label: 'Funding ≤6mo: Series A', value: 'funding_a_6m' },
  { label: 'Funding ≤6mo: Series B+', value: 'funding_b_6m' },
  { label: 'Bootstrapped (no funding)', value: 'no_funding' },
  { label: 'Website traffic growth: high', value: 'traffic_growth_high' },
];

// Apollo-сигнал «нанимает роль» (разведка API 07.08: q_organization_job_titles + posted_at_range).
export const HIRING_ROLES = [
  { label: '— no hiring signal —', value: '' },
  { label: 'Hiring: procurement roles', value: 'procurement' },
  { label: 'Hiring: sourcing roles', value: 'sourcing' },
  { label: 'Hiring: purchasing roles', value: 'purchasing' },
  { label: 'Hiring: supply chain roles', value: 'supply chain' },
];

export const POSTED_WINDOWS = [
  { label: 'posted ≤ 30 days', value: 30 },
  { label: 'posted ≤ 60 days', value: 60 },
  { label: 'posted ≤ 90 days', value: 90 },
];

export const REVENUE_MINS = [
  { label: 'any revenue', value: '' },
  { label: '$10M+', value: 10000000 },
  { label: '$50M+', value: 50000000 },
  { label: '$100M+', value: 100000000 },
  { label: '$500M+', value: 500000000 },
  { label: '$1B+', value: 1000000000 },
];

// Apply a signal to Explee company_filters.
export function applySignal(filters, signal) {
  switch (signal) {
    case 'hiring_now': filters.hiring_is = true; break;
    case 'growth_high': filters.employees_growth = ['high']; break;
    case 'growth_growing': filters.employees_growth = ['high', 'growing']; break;
    case 'growth_declining': filters.employees_growth = ['declining']; break;
    case 'funding_seed_6m':
      filters.funding_last_round_stage = ['pre_seed_seed'];
      filters.funding_last_round_date = '6_months';
      break;
    case 'funding_a_6m':
      filters.funding_last_round_stage = ['series_a'];
      filters.funding_last_round_date = '6_months';
      break;
    case 'funding_b_6m':
      filters.funding_last_round_stage = ['series_b_plus'];
      filters.funding_last_round_date = '6_months';
      break;
    case 'no_funding': filters.funding_last_round_stage = ['no_funding']; break;
    case 'traffic_growth_high': filters.traffic_growth = ['high']; break;
    default: break;
  }
  return filters;
}
