import React, { useEffect, useState } from 'react';

// Лента событий по лиду (L5.11, задача Ольги 17.08). Один дом для вопроса «что, кому и когда
// ушло» — после инцидента 14–17.08, когда система показывала «сообщение отправлено», а человек
// не получал ничего. Поэтому здесь два разных факта разведены явно: что мы СДЕЛАЛИ и что
// ПОДТВЕРДИЛ провайдер. Оба канала в одной ленте: у человека один опыт общения с нами.

const EVENTS = {
  uploaded: { icon: '📥', label: 'added to the campaign list' },
  connection_sent: { icon: '📨', label: 'connection request sent' },
  accepted: { icon: '🤝', label: 'accepted the request' },
  message_sent: { icon: '💬', label: 'message #1' },
  message_followup: { icon: '💬', label: 'follow-up' },
  replied: { icon: '↩️', label: 'replied' },
  manual_reply: { icon: '✍️', label: 'we replied by hand' },
  sent: { icon: '✉️', label: 'email sent' },
  opened: { icon: '👁', label: 'opened the email' },
  clicked: { icon: '🖱', label: 'clicked a link' },
  bounced: { icon: '⛔', label: 'bounced' },
  unsubscribed: { icon: '🚫', label: 'unsubscribed' },
};

// Признак факта отправки. Ключевое различие ленты: «мы отправили» — это намерение,
// «провайдер подтвердил» — факт. До 17.08 система показывала только первое.
const DELIVERY = {
  confirmed: { text: '✓ delivery confirmed', color: '#047857', bg: '#ecfdf5' },
  pending: { text: '⏳ queued at the provider', color: '#b45309', bg: '#fffbeb' },
  missing: { text: '⚠️ provider has no such message — nothing reached the person', color: '#b91c1c', bg: '#fef2f2' },
};

const OUTGOING = new Set(['message_sent', 'message_followup', 'sent', 'manual_reply']);

const fmt = (v) => (v
  ? new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

export default function LeadTimeline({ contactId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!contactId) return;
    setData(null); setError('');
    fetch(`/api/registry/contacts/${contactId}/touches`)
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.error || r.status)))))
      .then(setData)
      .catch((e) => setError(String(e.message || e)));
  }, [contactId]);

  if (!contactId) return null;
  const c = data?.contact;

  // Провалы (ошибки отправки, отказы валидатора) вклеиваем в ту же ленту по времени:
  // «молчаливого отсева не бывает» — иначе пустая лента читается как «всё хорошо».
  const rows = [
    ...(data?.events || []).map((e) => ({ kind: 'event', at: e.occurred_at, e })),
    ...(data?.failures || []).map((f) => ({ kind: 'fail', at: f.created_at, f })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return (
    <div className="lead-timeline">
      <div className="reply-head">
        <b>{c?.full_name || `Contact #${contactId}`}</b>
        {c?.company && <span className="hint"> · {c.company}</span>}
        {c?.lifecycle && <span className={`lifecycle ${c.lifecycle}`} style={{ marginLeft: 8 }}>{c.lifecycle}</span>}
        {onClose && <button className="link" style={{ marginLeft: 'auto' }} onClick={onClose}>close</button>}
      </div>
      <div className="reply-summary">
        {c?.email || <span className="hint">no email</span>}
        {c?.linkedin_slug && <> · <a href={`https://www.linkedin.com/in/${c.linkedin_slug}`} target="_blank" rel="noreferrer">LinkedIn</a></>}
      </div>

      {error && <div className="error">{error}</div>}
      {!data && !error && <p className="hint">Loading…</p>}
      {data && rows.length === 0 && (
        <p className="hint">Nothing yet — this person has never been touched, in any channel.</p>
      )}

      {rows.map((row, i) => {
        if (row.kind === 'fail') {
          return (
            <div key={`f${row.f.id}`} className="preview-mail" style={{ background: '#fef2f2', borderColor: '#fecaca' }}>
              <div className="preview-subject" style={{ color: '#b91c1c' }}>
                ⛔ {fmt(row.at)} — failed ({row.f.kind}{row.f.provider ? ` · ${row.f.provider}` : ''})
              </div>
              <div className="hint">{row.f.result}</div>
            </div>
          );
        }
        const e = row.e;
        const meta = EVENTS[e.event] || { icon: '•', label: e.event };
        const d = OUTGOING.has(e.event) ? DELIVERY[e.delivery] : null;
        return (
          <div key={`e${e.id}${i}`} className="preview-mail">
            <div className="preview-subject">
              {meta.icon} {fmt(row.at)} — {meta.label}
              <span className="hint" style={{ marginLeft: 6 }}>
                {e.channel === 'linkedin' ? 'LinkedIn' : 'email'}
                {e.campaign_id ? ` · campaign #${e.campaign_id}` : ''}
                {e.by ? ` · ${e.by === 'orchestrator' ? 'by the system' : e.by === 'manual' ? `by hand${e.actor ? ` (${e.actor})` : ''}` : e.by}` : ''}
                {e.imported === 'true' ? ' · imported history' : ''}
              </span>
              {/* У исходящего без подтверждения провайдера статус ОБЯЗАН быть виден:
                  именно это состояние молчало 14–17.08. */}
              {OUTGOING.has(e.event) && (
                <span
                  className="reply-badge"
                  style={{ marginLeft: 8, background: (d || DELIVERY.pending).bg, color: (d || DELIVERY.pending).color }}
                  title={e.gs_message_uuid ? `provider message ${e.gs_message_uuid}` : ''}
                >
                  {d ? d.text : '⏳ delivery not verified yet'}
                </span>
              )}
            </div>
            {e.subject && <div className="hint"><b>{e.subject}</b></div>}
            {e.text && <pre className="preview-body">{e.text}</pre>}
          </div>
        );
      })}
    </div>
  );
}
