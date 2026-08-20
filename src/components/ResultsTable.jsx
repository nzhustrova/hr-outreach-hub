import React, { useState } from 'react';
import { fitBreakdown, valueBreakdown, SCORE_HELP } from '../lib/scoring.js';
// Та же нормализация slug, что на сервере, — ключи истории обязаны совпадать байт в байт.
import { linkedinSlug } from '../../linkedin.js';

function scoreClass(v, threshold = 70) {
  if (v >= threshold) return 'score good';
  if (v >= 50) return 'score mid';
  return 'score low';
}

function ScoreCard({ result, flags, form, industryVerdicts = {} }) {
  const fit = fitBreakdown(result, flags, form, industryVerdicts);
  const value = valueBreakdown(result, form);
  const Block = ({ title, data }) => (
    <div className="score-block">
      <h4>{title}: {data.total}</h4>
      {data.parts.map((p) => (
        <div key={p.label} className="score-part">
          <div className="score-part-head">
            <span>{p.label} <em>({p.weight}%)</em></span>
            <b className={scoreClass(p.score)}>{p.score}</b>
          </div>
          <div className="score-bar"><div className="score-bar-fill" style={{ width: `${p.score}%` }} /></div>
          <div className="score-note">{p.note}</div>
        </div>
      ))}
    </div>
  );
  return (
    <div className="score-card">
      <Block title="Fit" data={fit} />
      <Block title="Value" data={value} />
    </div>
  );
}

export default function ResultsTable({
  results, rawResponse, total, apolloTotal,
  isPicked, onToggle, flags, scores, form,
  onAddRecommended, recommendThreshold, crmBlocked = { emails: {}, domains: {} }, crmState = null,
  industryVerdicts = {}, registryState = {},
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [hideFlagged, setHideFlagged] = useState(false);
  const [sort, setSort] = useState({ key: null, dir: -1 });
  const [expanded, setExpanded] = useState(null);
  // Пагинация вместо «Load more»: выдача грузится целиком, а на экран отдаём страницами.
  // Сортировка при этом применяется ко ВСЕМУ набору, а не к странице — иначе «отсортировать
  // всё» превращается в «отсортировать видимое», а это ровно та ловушка, из-за которой на
  // экране оставались контакты от прошлого поиска (ТЗ п.39).
  const [pageSize, setPageSize] = useState(100);
  const [pageNum, setPageNum] = useState(1);
  const [plan, setPlan] = useState(null);

  if (!rawResponse) return null;

  const flaggedCount = results.filter((_, i) => flags[i]?.length).length;
  // Барьер CRM (ТЗ п.28): с этими людьми уже работают — выбрать их нельзя вообще, не «можно,
  // но pre-flight отсеет». Случай Тони: лид на подписании контракта получил холодное письмо.
  const blockOf = (r) => crmBlocked.emails?.[(r.email || '').toLowerCase()]
    || crmBlocked.domains?.[(r.domain || '').toLowerCase()] || null;
  const blockedCount = results.filter((r) => blockOf(r)).length;
  // Требование канала: контакт без нужного канала в кампанию всё равно не пойдёт,
  // поэтому в рекомендованные не берём и помечаем в таблице.
  const channelMiss = (r) => {
    const ch = form?.channel;
    if (!ch) return null;
    if (ch === 'email' && !r.email) return 'no email — needed for an email campaign';
    if (ch === 'linkedin' && !r.linkedin) return 'no LinkedIn — needed for a LinkedIn campaign';
    if (ch === 'both' && (!r.email || !r.linkedin)) return 'missing a channel — multichannel needs both';
    return null;
  };
  // Отбор рекомендованных (ТЗ п.39): порог по Fit → порядок по Fit → тай-брейк по Value →
  // не больше 2 человек из компании. Сортировать по Value нельзя: наверх всплывут гиганты,
  // которые хуже всех отвечают на холодные письма.
  function buildRecommended() {
    const pool = results
      .map((r, i) => ({ r, fit: scores[i]?.fit ?? -1, value: scores[i]?.value ?? -1, flagged: Boolean(flags[i]?.length), blocked: Boolean(blockOf(r)) }))
      .filter((x) => !isPicked(x.r));
    const passed = pool.filter((x) => !x.flagged && !x.blocked && !channelMiss(x.r) && x.fit >= recommendThreshold);
    const sorted = [...passed].sort((a, b) => (b.fit - a.fit) || (b.value - a.value));
    const perCompany = new Map();
    const taken = [];
    let droppedByCompany = 0;
    for (const x of sorted) {
      const key = (x.r.company || '').trim().toLowerCase() || `__${taken.length}`;
      const n = perCompany.get(key) || 0;
      if (n >= 2) { droppedByCompany += 1; continue; }
      perCompany.set(key, n + 1);
      taken.push(x.r);
    }
    return {
      taken,
      scanned: pool.length,
      belowThreshold: pool.filter((x) => !x.flagged && !x.blocked && x.fit < recommendThreshold).length,
      flagged: pool.filter((x) => x.flagged).length,
      blocked: pool.filter((x) => x.blocked).length,
      channelMiss: pool.filter((x) => channelMiss(x.r)).length,
      droppedByCompany,
    };
  }
  const recommendedCount = results.filter((r, i) => !flags[i]?.length && !blockOf(r) && scores[i]?.fit >= recommendThreshold && !isPicked(r)).length;

  let rows = results.map((r, i) => ({ r, i }));
  if (hideFlagged) rows = rows.filter(({ i }) => !flags[i]?.length);
  if (sort.key) {
    const get = ({ r, i }) => {
      if (sort.key === 'fit') return scores[i]?.fit ?? -1;
      if (sort.key === 'value') return scores[i]?.value ?? -1;
      return (r[sort.key] || '').toString().toLowerCase();
    };
    rows = [...rows].sort((a, b) => {
      const av = get(a); const bv = get(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
    });
  }

  const th = (key, label, help) => (
    <th
      className={`sortable ${sort.key === key ? 'sorted' : ''}`}
      title={help || `Sort by ${label}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}
    >
      {label}{help ? ' ⓘ' : ''}{sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  );

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(pageNum, totalPages);
  const visible = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div className="results">
      <div className="results-head">
        <h2>Results: {results.length}</h2>
        {total != null && <span className="segment-width">Explee: {Number(total).toLocaleString('en-US')}</span>}
        {apolloTotal != null && (
          <span
            className="segment-width apollo"
            title={`${Number(apolloTotal).toLocaleString('en-US')} people in Apollo match these filters — a free counter, nothing is revealed. Loaded ${results.length}; each loaded contact costs ~1 credit (email reveal), so the pool grows by the top-up buttons below, not automatically.`}
          >
            Apollo: {Number(apolloTotal).toLocaleString('en-US')} · loaded {results.length}
          </span>
        )}
        {/* Отсев обязан называть себя: молчаливо спрятанные строки — то же враньё экрана,
            из-за которого «в результатах остались DHL и 10000+» (ТЗ п.28). */}
        {blockedCount > 0 && (
          <span
            className="segment-width" style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c' }}
            title={`Matched against the Kommo stop list${crmState?.synced_at ? ` (snapshot from ${new Date(crmState.synced_at).toLocaleString('en-GB')})` : ''}. A live check runs again at launch. Hover a row to see the stage.`}
          >
            🔒 {blockedCount} blocked: in the CRM stop list
          </span>
        )}
        {crmState?.stale && crmState?.enabled && (
          <span
            className="segment-width" style={{ background: '#fffbeb', borderColor: '#fde68a', color: '#b45309' }}
            title="A barrier built on stale data gives a false sense of protection"
          >
            ⚠️ Kommo barrier last synced {crmState.age_hours ?? '?'}h ago
          </span>
        )}
        {recommendedCount > 0 && (
          <button
            className="add-recommended"
            onClick={() => setPlan(buildRecommended())}
            title="Fit ≥ threshold, ordered by Fit with Value as tie-break, max 2 people per company"
          >
            Add recommended ({recommendedCount}, fit ≥ {recommendThreshold})
          </button>
        )}
        {flaggedCount > 0 && (
          <label className="flag-toggle">
            <input type="checkbox" checked={hideFlagged} onChange={(e) => setHideFlagged(e.target.checked)} />
            hide flagged ({flaggedCount})
          </label>
        )}
        <button className="link" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? 'hide raw API response' : 'show raw API response'}
        </button>
      </div>

      {/* Кнопка сначала объясняет, потом делает — тот же принцип, что в предпросмотре пакета. */}
      {plan && (
        <div className="reply-card">
          <div className="reply-head">
            <b>Recommended: {plan.taken.length} of {plan.scanned} scanned</b>
          </div>
          <div className="reply-summary">
            Rule: <b>Fit ≥ {recommendThreshold}</b> → ordered by <b>Fit</b>, ties broken by <b>Value</b> →
            at most <b>2 people per company</b>.
            <div style={{ marginTop: 6 }}>
              Below the threshold: {plan.belowThreshold} · quality flags: {plan.flagged} ·
              already in the CRM: {plan.blocked} · wrong channel: {plan.channelMiss} ·
              dropped by the 2-per-company limit: {plan.droppedByCompany}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Sorting by Value would put the giants on top — and they answer cold emails worst of all.
              The shortlist is not capped by a number: it answers «who is worth considering», while the
              batch answers «who we send to this week».
            </div>
          </div>
          <div className="shortlist-actions">
            <button className="save-registry" onClick={() => { onAddRecommended(plan.taken); setPlan(null); }}>
              Add {plan.taken.length} to the shortlist
            </button>
            <button className="link" onClick={() => setPlan(null)}>cancel</button>
          </div>
        </div>
      )}

      {/* Панель появляется, как только строк больше самой мелкой страницы (50): иначе при 60
          результатах и странице по 100 селектор был бы скрыт, и выбрать «по 50» стало бы нечем
          (замечание Ольги 12.08). При 35 строках показывать нечего — пагинация не нужна. */}
      {rows.length > 50 && (
        <div className="contacts-actions">
          <span className="hint">
            Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, rows.length)} of {rows.length}.
            Sorting applies to the whole set, not just this page.
          </span>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPageNum(1); }}>
            {[50, 100, 200].map((n) => <option key={n} value={n}>{n} per page</option>)}
          </select>
          <button className="btn-small" disabled={currentPage <= 1} onClick={() => setPageNum(currentPage - 1)}>← prev</button>
          <span className="hint">page {currentPage} of {totalPages}</span>
          <button className="btn-small" disabled={currentPage >= totalPages} onClick={() => setPageNum(currentPage + 1)}>next →</button>
        </div>
      )}

      {results.length > 0 && (
        <table>
          <thead>
            <tr>
              <th className="pick">✓</th>
              {th('name', 'Name')}
              {th('title', 'Title')}
              {th('company', 'Company')}
              <th>Location</th><th>LinkedIn</th><th>Email</th>
              {th('fit', 'Fit', SCORE_HELP.fit)}
              {th('value', 'Value', SCORE_HELP.value)}
              <th>Checks</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ r, i }) => (
              <React.Fragment key={i}>
                <tr
                  className={`${isPicked(r) ? 'picked' : ''} ${flags[i]?.length ? 'flagged' : ''} ${blockOf(r) ? 'crm-blocked' : ''} clickable`}
                  onClick={() => setExpanded(expanded === i ? null : i)}
                  title="Click to see the score breakdown"
                >
                  <td className="pick" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox" checked={isPicked(r)} disabled={Boolean(blockOf(r))}
                      title={blockOf(r) ? `Blocked: ${blockOf(r).reason}` : ''}
                      onChange={() => onToggle(r)}
                    />
                  </td>
                  <td>
                    {r.name || '—'}
                    {(() => {
                      // История вместо голого «registry»: Стас спрашивал ровно это —
                      // «если им уже что-то отправили, зачем ты мне их показываешь».
                      // Ищем историю обоими ключами (L5.7): LinkedIn-only человек по email
                      // не находится, а канал ему может быть закрыт касанием трёхмесячной давности.
                      const st = registryState[(r.email || '').toLowerCase()]
                        || registryState[`li:${linkedinSlug(r.linkedin) || ''}`];
                      if (!st) return r.fromRegistry
                        ? <span className="registry-badge" title="From your contact registry">registry</span>
                        : null;
                      const bits = [];
                      if (st.last_sent) bits.push(`emailed ${new Date(st.last_sent).toLocaleDateString('en-US')}`);
                      if (st.replied) bits.push('replied');
                      if (st.last_linkedin) {
                        // Дата открытия канала = касание + 3 месяца (карантин П4а) — «когда снова можно».
                        const reopen = new Date(st.last_linkedin); reopen.setMonth(reopen.getMonth() + 3);
                        const verb = st.last_linkedin_event === 'message_sent' ? 'messaged' : 'invited';
                        bits.push(`LinkedIn ${verb} ${new Date(st.last_linkedin).toLocaleDateString('en-US')}${reopen > new Date() ? ` — channel reopens ${reopen.toLocaleDateString('en-US')}` : ''}`);
                      }
                      if (st.lifecycle === 'quarantined') bits.push(`quarantine until ${st.quarantine_until ? String(st.quarantine_until).slice(0, 10) : '—'}`);
                      if (st.lifecycle === 'active_in_campaign') bits.push('active in a campaign');
                      if (st.lifecycle === 'suppressed_forever') bits.push('suppressed');
                      const reserved = st.reserved_by && st.reserved_until && new Date(st.reserved_until) > new Date();
                      return (
                        <>
                          <span className="registry-badge" title={bits.length ? bits.join(' · ') : 'in the registry, never contacted'}>
                            {bits.length ? bits[0] : 'in registry'}
                          </span>
                          {reserved && (
                            <span
                              className="registry-badge" style={{ background: '#faf5ff', color: '#7e22ce' }}
                              title={`In ${st.reserved_by}'s batch until ${String(st.reserved_until).slice(0, 10)} — you can still take them, but you would both be writing to the same person`}
                            >
                              in {st.reserved_by}'s batch
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </td>
                  <td>{r.title || '—'}</td>
                  <td>{r.company || '—'}{r.companySize ? ` · ${r.companySize}` : ''}</td>
                  <td>{r.location || '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {r.linkedin ? <a href={r.linkedin} target="_blank" rel="noreferrer">profile</a> : '—'}
                  </td>
                  <td>{r.email || '—'}</td>
                  <td className={scoreClass(scores[i]?.fit ?? 0, recommendThreshold)}>{scores[i]?.fit ?? '—'}</td>
                  <td className={scoreClass(scores[i]?.value ?? 0, 60)}>{scores[i]?.value ?? '—'}</td>
                  <td className="flags">{flags[i]?.length ? `⚠️ ${flags[i].join('; ')}` : '✓'}</td>
                </tr>
                {expanded === i && (
                  <tr className="expanded-row">
                    <td colSpan={10}>
                      <ScoreCard result={r} flags={flags[i]} form={form} industryVerdicts={industryVerdicts} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}

      {results.length === 0 && (rawResponse?.mode === 'apollo-only'
        ? (
          <p>
            Apollo-only mode: the list stays empty by design — Apollo&apos;s free feed hides names.
            {apolloTotal != null && <> <b>{Number(apolloTotal).toLocaleString('en-US')}</b> people match your exact filters.</>}
            {' '}Use <b>Top up from Apollo</b> below to pull contacts (~1 credit each, with verified emails).
          </p>
        )
        : <p>No results. Check the raw response — field structure may differ, or the provider returned an error.</p>)}

      {showRaw && <pre className="raw">{JSON.stringify(rawResponse, null, 2)}</pre>}
    </div>
  );
}
