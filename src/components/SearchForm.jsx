import React from 'react';
import { LOCATIONS, US_REGIONS, COMPANY_SIZES, INDUSTRIES, TITLE_TYPES, TITLES, SIGNALS, HIRING_ROLES, POSTED_WINDOWS, REVENUE_MINS } from '../lib/dictionaries.js';

function Field({ label, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

// Multi-select as toggle chips (e.g. sizes 201–500 + 501–1000, titles HoP + PM).
function ChipSelect({ options, values, onChange }) {
  const toggle = (v) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          className={`chip ${values.includes(o.value) ? 'on' : ''}`}
          onClick={() => toggle(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function SearchForm({ value, onChange, onSearch, loading, provider, setProvider, shortlistCount = 0 }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const setArr = (k) => (arr) => onChange({ ...value, [k]: arr });

  return (
    <form
      className="search-form"
      onSubmit={(e) => { e.preventDefault(); onSearch(); }}
    >
      <h2 className="panel-title">Lead Discovery</h2>
      <p className="panel-sub">Define your target segment, then search for matching people.</p>

      <Field label="Location (country)">
        <select value={value.location} onChange={set('location')}>
          {LOCATIONS.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </Field>
      <Field label="Region (state/area)">
        <select value={value.region} onChange={set('region')}>
          {US_REGIONS.map((x) => <option key={x.label} value={x.label}>{x.label}</option>)}
        </select>
      </Field>

      <div className="field">
        <span className="field-label">Company size (multi-select)</span>
        <ChipSelect
          options={COMPANY_SIZES.filter((x) => x.value)}
          values={value.sizes}
          onChange={setArr('sizes')}
        />
      </div>

      <Field label="Industry">
        <select value={value.industry} onChange={set('industry')}>
          {INDUSTRIES.map((x) => <option key={x} value={x}>{x || 'Any'}</option>)}
        </select>
      </Field>
      <Field label={
        <span title={'Seniority level filter.\n• Apollo: hard filter.\n• Explee: no native seniority filter — used as a semantic title fallback when no titles are selected.\n• Scoring: roles BELOW this level get a Title match penalty and drop out of recommendations.'}>
          Title type (seniority) ⓘ
        </span>
      }>
        <select value={value.titleType} onChange={set('titleType')}>
          {TITLE_TYPES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
      </Field>

      <div className="field">
        <span className="field-label">Titles (multi-select)</span>
        <ChipSelect
          options={TITLES.filter(Boolean).map((t) => ({ label: t, value: t }))}
          values={value.titles}
          onChange={setArr('titles')}
        />
        {!value.titles.length && !value.titleType && (
          <span className="title-warn">⚠️ No titles selected — search will return people in any role, expect noisy results.</span>
        )}
        {!value.titles.length && value.titleType && (
          <span className="title-warn soft">Seniority will be used as a semantic title fallback for Explee.</span>
        )}
      </div>

      <Field label="Signal (Explee)">
        <select value={value.signal} onChange={set('signal')}>
          {SIGNALS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
      </Field>
      <Field label="Signal 2 (Explee)">
        <select value={value.signal2} onChange={set('signal2')}>
          {SIGNALS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
      </Field>

      <details className="advanced">
        <summary>Advanced filters (hiring signal, tech, revenue)</summary>
        <Field label="Hiring signal (Apollo: live job postings by role)">
          <select value={value.hiringRole} onChange={set('hiringRole')}>
            {HIRING_ROLES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </Field>
        {value.hiringRole && (
          <Field label="Job posted within">
            <select value={value.hiringPostedDays} onChange={set('hiringPostedDays')}>
              {POSTED_WINDOWS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="Technologies (Explee + Apollo; comma-separated)">
          <input value={value.technologies} onChange={set('technologies')} placeholder="sap, oracle, netsuite" />
        </Field>
        <Field label="Keywords (Apollo only, free-text)">
          <input value={value.keywords} onChange={set('keywords')} placeholder="e.g. tail spend, MRO" />
        </Field>
        <Field label="Revenue (Explee + Apollo)">
          <select value={value.revenueMin} onChange={set('revenueMin')}>
            {REVENUE_MINS.map((x) => <option key={String(x.value)} value={x.value}>{x.label}</option>)}
          </select>
        </Field>
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={value.verifiedEmailOnly}
            onChange={(e) => onChange({ ...value, verifiedEmailOnly: e.target.checked })}
          />
          Only people with verified email (Apollo width & top-up)
        </label>
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={value.apolloOnly}
            onChange={(e) => onChange({ ...value, apolloOnly: e.target.checked })}
          />
          Apollo-only search (skip Explee) — exact hiring / keywords / verified-email filters
        </label>
        <p className="hint">Hiring signal: Explee gets the boolean approximation (hiring_is); Apollo filters by role and posting date exactly.</p>
      </details>

      {/* Источник выдачи — Explee (решение блока 5 методологии: Apollo = ширина-индикатор + платный добор,
          его обфусцированная выдача в списке бесполезна). Переключатель остаётся как debug: ?debug в URL. */}
      {window.location.search.includes('debug') && (
        <div className="provider">
          <span className="field-label">Data source (debug)</span>
          <label><input type="radio" checked={provider === 'explee'} onChange={() => setProvider('explee')} /> Explee</label>
          <label><input type="radio" checked={provider === 'apollo'} onChange={() => setProvider('apollo')} /> Apollo</label>
        </div>
      )}

      {/* Канал кампании (предложение Тони, уточнено 11.08). Постановку пришлось поправить:
          «не искать LinkedIn» денег не экономит — адрес приходит бесплатно и у Explee,
          и у Apollo. Платная операция — добыча ПОЧТЫ. Поэтому экономит обратное: кампания
          только в LinkedIn = не тратим кредиты на обогащение. Отсюда не «искать только email»,
          а требование к контакту: какой канал обязателен. */}
      <div className="field">
        <span className="field-label">
          Campaign channel
          <span className="hint" style={{ marginLeft: 6, cursor: 'help' }} title="LinkedIn URLs come free from both providers; revealing an email costs credits. So a LinkedIn-only campaign saves money by skipping enrichment, while an email-only campaign just filters out people without an address.">
            — what it changes
          </span>
        </span>
        <select value={value.channel || ''} onChange={(e) => onChange({ ...value, channel: e.target.value })}>
          <option value="">Any — show everyone</option>
          <option value="email">Email campaign — needs an address</option>
          <option value="linkedin">LinkedIn campaign — needs a profile (no email credits spent)</option>
          <option value="both">Multichannel — needs both</option>
        </select>
      </div>

      <button type="submit" className="cta" disabled={loading}>
        {loading ? 'Searching…' : 'Find People'}
      </button>
      {/* Предупреждаем ДО, а не сообщаем после: новый поиск очищает шорт-лист, и молча
          потерять отобранное нельзя. Диалогов подтверждения не ставим (решение 08.08). */}
      {shortlistCount > 0 && (
        <p className="hint" style={{ color: '#b45309' }}>
          ⚠️ A new search clears the shortlist ({shortlistCount} selected). Save them to the registry first
          if you want to keep them.
        </p>
      )}
      <p className="hint">
        Search runs on Explee; Apollo shows segment width and will join as a paid top-up angle.
        Non-adjacent size ranges are merged to their envelope.
      </p>
    </form>
  );
}
