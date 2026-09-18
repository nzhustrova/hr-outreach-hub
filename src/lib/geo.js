// CANONICAL geography for outreach/sourcing search — the single list behind
// both the hub's own search panel and SerenZi's "Find candidates" bridge.
// The SerenZi copy is zinit-headliner/apps/web/src/lib/sourcing-geo.ts; the two
// files must stay identical in data (separate deploys, so it is a mirrored copy
// rather than a shared import). Change here first.
//
// Provider formats this feeds:
//   Explee  people_filters.geo      → ISO-3166-1 alpha-2 codes
//   Explee  company geo_include     → country names
//   Explee  company geo_subdivision → ISO-3166-2 (US states only, see US_REGIONS)
//   Apollo  person_locations        → country names / "State, US"
//
// Scope rule: countries where ZINIT actually hires or sells, not the world.
// Grounded 2026-09-18 in the SerenZi candidate base (519 records) + open vacancies.

export const COUNTRIES = [
  // Americas
  { name: 'United States', iso: 'US', aliases: ['usa', 'us', 'united states of america', 'america'] },
  { name: 'Canada', iso: 'CA' },
  { name: 'Mexico', iso: 'MX', aliases: ['méxico'] },
  { name: 'Brazil', iso: 'BR', aliases: ['brasil'] },
  { name: 'Argentina', iso: 'AR' },
  { name: 'Colombia', iso: 'CO' },
  { name: 'Chile', iso: 'CL' },
  { name: 'Peru', iso: 'PE', aliases: ['perú'] },
  { name: 'Uruguay', iso: 'UY' },
  { name: 'Ecuador', iso: 'EC' },
  { name: 'Costa Rica', iso: 'CR' },
  { name: 'Panama', iso: 'PA', aliases: ['panamá'] },
  { name: 'Guatemala', iso: 'GT' },
  { name: 'Dominican Republic', iso: 'DO' },
  { name: 'Puerto Rico', iso: 'PR' },
  // Balkans
  { name: 'Serbia', iso: 'RS' },
  { name: 'Croatia', iso: 'HR' },
  { name: 'Bosnia and Herzegovina', iso: 'BA', aliases: ['bosnia'] },
  { name: 'Montenegro', iso: 'ME' },
  { name: 'North Macedonia', iso: 'MK', aliases: ['macedonia'] },
  { name: 'Albania', iso: 'AL' },
  { name: 'Slovenia', iso: 'SI' },
  { name: 'Bulgaria', iso: 'BG' },
  { name: 'Romania', iso: 'RO' },
  { name: 'Greece', iso: 'GR' },
  // Rest of Europe
  { name: 'United Kingdom', iso: 'GB', aliases: ['uk', 'england', 'britain', 'great britain'] },
  { name: 'Germany', iso: 'DE' },
  { name: 'France', iso: 'FR' },
  { name: 'Netherlands', iso: 'NL' },
  { name: 'Poland', iso: 'PL' },
  { name: 'Spain', iso: 'ES' },
  { name: 'Portugal', iso: 'PT' },
  { name: 'Lithuania', iso: 'LT' },
  { name: 'Cyprus', iso: 'CY' },
  // Caucasus / Central Asia / CIS
  { name: 'Georgia', iso: 'GE' },
  { name: 'Armenia', iso: 'AM' },
  { name: 'Kazakhstan', iso: 'KZ' },
  { name: 'Uzbekistan', iso: 'UZ', aliases: ['tashkent'] },
  { name: 'Russia', iso: 'RU' },
  // Asia / MENA
  { name: 'Indonesia', iso: 'ID', aliases: ['jakarta'] },
  { name: 'India', iso: 'IN' },
  { name: 'Vietnam', iso: 'VN' },
  { name: 'United Arab Emirates', iso: 'AE', aliases: ['uae', 'dubai'] },
]

const LATAM = ['MX', 'BR', 'AR', 'CO', 'CL', 'PE', 'UY', 'EC', 'CR', 'PA', 'GT', 'DO', 'PR']

// Region words HR types into a vacancy's location. Expanding one costs nothing:
// the hub bills per filter SET, not per country in it (HANDOVER, «как Explee
// считает деньги»), so a 15-country geo array is the same price as one country.
export const REGIONS = {
  Americas: { aliases: ['americas', 'the americas'], codes: ['US', 'CA', ...LATAM] },
  LatAm: { aliases: ['latam', 'latin america', 'south america'], codes: LATAM },
  Balkans: { aliases: ['balkans', 'balkan', 'ex-yugoslavia'], codes: ['RS', 'HR', 'BA', 'ME', 'MK', 'AL', 'SI', 'BG', 'RO', 'GR'] },
  CIS: { aliases: ['cis', 'caucasus', 'central asia'], codes: ['GE', 'AM', 'KZ', 'UZ', 'RU'] },
}

/** Dropdown options: regions first, then every country by name. */
export const LOCATION_OPTIONS = [...Object.keys(REGIONS), ...COUNTRIES.map((c) => c.name)]

// A search runs over ONE segment at a time. Explee's free 100 is per filter set,
// so two markets in one set share that hundred and the denser one takes it —
// put the US and the Balkans together and the Balkans never surface. Split into
// segments and each gets its own free hundred, at no extra cost.
// Segments cover every country above exactly once; grouping is by market, not
// by continent: same working hours, language and salary band.
export const MARKET_SEGMENTS = [
  { key: 'us-ca', label: 'US + Canada', codes: ['US', 'CA'] },
  { key: 'latam-north', label: 'LatAm North', codes: ['MX', 'GT', 'CR', 'PA', 'DO', 'PR'] },
  { key: 'latam-south', label: 'LatAm South', codes: ['BR', 'CO', 'AR', 'CL', 'PE', 'UY', 'EC'] },
  { key: 'balkans', label: 'Balkans', codes: ['RS', 'HR', 'BA', 'ME', 'MK', 'AL', 'SI', 'BG', 'RO', 'GR'] },
  { key: 'europe-west', label: 'Western Europe', codes: ['GB', 'DE', 'FR', 'NL', 'ES', 'PT', 'PL', 'LT', 'CY'] },
  { key: 'cis', label: 'CIS + Caucasus', codes: ['GE', 'AM', 'KZ', 'UZ', 'RU'] },
  { key: 'sea', label: 'South-East Asia', codes: ['ID', 'VN'] },
  { key: 'india-mena', label: 'India + UAE', codes: ['IN', 'AE'] },
]

/** Segments a geography touches, each narrowed to the countries it covers. */
export function segmentsFor(locations = []) {
  const { codes } = resolveGeo(locations)
  if (!codes.length) return []
  return MARKET_SEGMENTS
    .map((s) => ({ key: s.key, label: s.label, countries: s.codes.filter((c) => codes.includes(c)).map((c) => byIso(c).name) }))
    .filter((s) => s.countries.length > 0)
}

const norm = (s) => String(s || '').toLowerCase().replace(/\./g, ' ').trim()
const escape = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
// Word-boundary, never substring: `includes('us')` used to turn Cyprus, Belarus
// and Australia into the United States (found 2026-09-18).
const hasWord = (haystack, word) => new RegExp(`\\b${escape(word)}\\b`).test(haystack)

const byIso = (iso) => COUNTRIES.find((c) => c.iso === iso)

function matchCountry(text) {
  const t = norm(text)
  if (!t) return null
  return COUNTRIES.find((c) => [c.name, ...(c.aliases || [])].some((k) => hasWord(t, norm(k)))) || null
}

function matchRegion(text) {
  const t = norm(text)
  if (!t) return null
  for (const r of Object.values(REGIONS)) {
    if (r.aliases.some((a) => hasWord(t, a))) return r
  }
  return null
}

/**
 * Free-text locations → provider-ready geography.
 * Returns country `names` (Explee geo_include / Apollo person_locations),
 * ISO `codes` (Explee people_filters.geo), and whatever could not be resolved
 * ("Remote") so the caller can drop it instead of sending it as a fake country.
 *
 * "Jakarta, Indonesia" resolves on the LAST comma part first, so that
 * "Auburn, GA, USA" stays the United States rather than matching the country
 * Georgia.
 */
export function resolveGeo(locations = []) {
  const names = []
  const codes = []
  const unresolved = []
  const push = (iso) => {
    const c = byIso(iso)
    if (c && !codes.includes(c.iso)) { codes.push(c.iso); names.push(c.name) }
  }
  for (const raw of (Array.isArray(locations) ? locations : [locations]).map((s) => String(s || '').trim()).filter(Boolean)) {
    let matched = false
    const rest = []
    for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const region = matchRegion(part)
      if (region) { region.codes.forEach(push); matched = true } else rest.push(part)
    }
    // Country from the LAST resolving part, so "Georgia, USA" is the US and not
    // the country Georgia, while "Americas, Balkans" keeps both regions above.
    for (let i = rest.length - 1; i >= 0; i--) {
      const hit = matchCountry(rest[i])
      if (hit) { push(hit.iso); matched = true; break }
    }
    if (!matched && !unresolved.includes(raw)) unresolved.push(raw)
  }
  return { names, codes, unresolved }
}
