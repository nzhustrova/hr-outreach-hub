import React from 'react';

// Цена кредита в долларах (задача Ольги 11.08: «в кредитах непонятно, нужны деньги»).
// Explee: $49 / 5 000 = $0.0098 · обогащение стоит 5 кредитов = $0.049 за почту.
// Apollo: $99/мес / 4 020 = $0.0246 · reveal стоит 1 кредит.
// Отсюда и порядок кнопок: Apollo вдвое дешевле, поэтому он первый, Explee — фолбэк по остатку.
const PRICE = { explee: 0.0098, apollo: 0.0246 };
const usd = (n) => (n < 1 ? `${(n * 100).toFixed(1)}¢` : `$${n.toFixed(2)}`);

// CSV-выгрузка переехала на вкладку Contacts (решение Ольги 08.08): в Smartlead лиды уходят
// по API, а файл — свойство реестра, где есть фильтры по сегменту и дате.
export default function Shortlist({
  items, onRemove, onClear, onEnrich, enriching,
  onFindEmails, findingEmails, onUniqueDetails, findingDetails,
  onRetryDetail, retryingDetailKey, keyOf, onSelectDetailVariant,
  onSave, saving, saveMsg,
}) {
  if (!items.length) return null;
  // Без почты либо с сомнительной Apollo-почтой (guessed) — добивается Explee-верификацией.
  const enrichable = items.filter(
    (r) => (!r.email || ['guessed', 'unverified', 'unavailable'].includes(r.emailStatus))
      && r.domain && r.firstName && r.lastName,
  ).length;
  // Apollo-добивка дешевле (1 кр) — идёт первой; not_found_apollo повторно не жжём.
  const emailFindable = items.filter(
    (r) => !r.email && r.emailStatus !== 'not_found_apollo'
      && (r.linkedin || (r.firstName && r.lastName && (r.domain || r.company))),
  ).length;
  const detailTargets = items.filter((r) => r.company && !r.uniqueDetail && !r.uniqueDetailChecked).length;

  const noEmail = items.filter((r) => !r.email).length;
  const busy = enriching || findingEmails || findingDetails;

  return (
    <div className="shortlist">
      <div className="results-head">
        <h2>Shortlist: {items.length}</h2>
        <button className="link" onClick={onClear}>clear</button>
      </div>
      <ul>
        {items.map((r, i) => (
          <li key={i}>
            <span>
              {r.name} — {r.title || '?'} @ {r.company || '?'}
              {r.fit != null && <em className="li-score"> · fit {r.fit}{r.value != null ? ` / value ${r.value}` : ''}</em>}
              {r.email && <em className="li-email"> · {r.email}{r.emailStatus ? ` (${r.emailStatus})` : ''}</em>}
              {!r.email && r.emailStatus === 'not_found_apollo' && <em className="li-miss"> · Apollo: no email</em>}
              {r.uniqueDetail && (
                <em className="li-detail">
                  {' '}· {r.uniqueDetailType === 'problem' ? '🔥' : r.uniqueDetailType === 'procurement' ? '📦' : '💡'} {r.uniqueDetail}
                  {r.uniqueDetailHook && <span className="detail-hook"> → {r.uniqueDetailHook}</span>}
                  {r.uniqueDetailSource && <> (<a href={r.uniqueDetailSource} target="_blank" rel="noreferrer">source</a>)</>}
                  {(r.uniqueDetailOptions?.length || 0) > 1 && (() => {
                    const opts = r.uniqueDetailOptions;
                    const cur = opts.findIndex((o) => o.detail === r.uniqueDetail);
                    return (
                      <span className="detail-variants" title={opts.map((o, i) => `${i + 1}. [${o.type || 'fact'}] ${o.detail}`).join('\n')}>
                        <button className="link" disabled={cur <= 0} onClick={() => onSelectDetailVariant(r, cur - 1)}>◀</button>
                        {' '}{cur + 1}/{opts.length}{' '}
                        <button className="link" disabled={cur >= opts.length - 1} onClick={() => onSelectDetailVariant(r, cur + 1)}>▶</button>
                      </span>
                    );
                  })()}
                  {onRetryDetail && (
                    <button
                      className="link retry-detail" title="Find one more fact (1 Serper query); previous ones stay available via ◀ ▶"
                      disabled={retryingDetailKey === keyOf(r)}
                      onClick={() => onRetryDetail(r)}
                    >
                      {retryingDetailKey === keyOf(r) ? '…' : '↻ another'}
                    </button>
                  )}
                </em>
              )}
              {!r.uniqueDetail && r.uniqueDetailChecked && <em className="li-miss"> · no distinctive detail found</em>}
            </span>
            {r.liveness === 'dead' && (
              <span
                className="reply-badge" style={{ background: '#fef2f2', color: '#b91c1c', marginRight: 6 }}
                title={`Signs the company no longer operates: ${r.livenessNote || 'found in recent news'}. Check before sending — a cold email to a closed company is a wasted touch and a bounce.`}
              >
                ⚠️ company may be closed
              </span>
            )}
            <button className="link" onClick={() => onRemove(r)}>remove</button>
          </li>
        ))}
      </ul>
      <div className="shortlist-actions">
        {emailFindable > 0 && (
          <button className="find-email" onClick={onFindEmails} disabled={busy}>
            {findingEmails ? 'Searching Apollo…' : `Find missing emails — Apollo (${emailFindable} × 1 cr ≈ ${usd(emailFindable * PRICE.apollo)})`}
          </button>
        )}
        {enrichable > 0 && (
          <button className="enrich" onClick={onEnrich} disabled={busy}>
            {enriching ? 'Enriching…' : `Enrich contacts (${enrichable} × 5 cr ≈ ${usd(enrichable * 5 * PRICE.explee)})`}
          </button>
        )}
        {detailTargets > 0 && (
          <button className="details" onClick={onUniqueDetails} disabled={busy}>
            {findingDetails ? 'Researching…' : `Company intel — Serper+AI (${detailTargets})`}
          </button>
        )}
        <button className="save-registry" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : `Save to registry (${items.length})`}
        </button>
        {saveMsg && <span className={saveMsg.startsWith('✓') ? 'ok' : 'warn'}>{saveMsg}</span>}
        {noEmail > 0 && !busy && (
          <span className="warn">⚠️ missing email: {noEmail} of {items.length}</span>
        )}
      </div>
    </div>
  );
}
