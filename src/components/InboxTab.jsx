import React, { useEffect, useState } from 'react';
import LeadTimeline from './LeadTimeline.jsx';

// Inbox: нить переписки по лиду (решение Ольги 08.08). Входящие ответы лида и наши исходящие
// показаны последовательно и разными цветами; бейдж «answered / needs reply» — сразу видно статус.
// Полный поток для валидации классификатора — Master Inbox в Smartlead (ссылка сверху).

const NON_NEGATIVE = ['positive', 'question', 'neutral', 'not_now', 'unclear'];

const LABEL_STYLE = {
  positive: { bg: '#f0fdf4', color: '#15803d', label: 'positive' },
  question: { bg: '#eff6ff', color: '#1e40af', label: 'question' },
  neutral: { bg: '#f8fafc', color: '#475569', label: 'neutral' },
  not_now: { bg: '#fffbeb', color: '#b45309', label: 'not now' },
  unclear: { bg: '#faf5ff', color: '#7e22ce', label: 'unclear — needs a human' },
  negative: { bg: '#fef2f2', color: '#b91c1c', label: 'negative' },
  unsubscribe: { bg: '#fef2f2', color: '#b91c1c', label: 'unsubscribe' },
  ooo: { bg: '#f8fafc', color: '#94a3b8', label: 'out of office' },
  bounce_notification: { bg: '#fef2f2', color: '#b91c1c', label: 'bounce / NDR — address dead' },
};

const fmtTime = (v) => (v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function ReplyBox({ touchId, contactName, channel = 'email', onSent }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [sources, setSources] = useState([]);
  const [error, setError] = useState('');

  // Драфт из базы знаний Zinit — агент подбирает, что рассказать этому лиду.
  async function draft() {
    setDrafting(true); setError('');
    try {
      const r = await fetch(`/api/inbox/${touchId}/suggest`, { method: 'POST' });
      const data = await r.json().catch(() => ({ error: 'non-JSON response' }));
      if (!r.ok) throw new Error(data.error || r.status);
      setText(data.draft);
      setSources(data.sources || []);
      setOpen(true);
    } catch (e) { setError(String(e.message || e)); } finally { setDrafting(false); }
  }

  async function send() {
    if (!text.trim()) return;
    setSending(true); setError('');
    try {
      const r = await fetch(`/api/inbox/${touchId}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      const data = await r.json().catch(() => ({ error: 'non-JSON response' }));
      if (!r.ok) throw new Error(data.error || r.status);
      setText(''); setOpen(false);
      onSent();
    } catch (e) { setError(String(e.message || e)); } finally { setSending(false); }
  }

  return (
    <div className="reply-box">
      {!open && (
        <>
          <button className="btn-small" onClick={() => setOpen(true)}>
            ↩ Reply{channel === 'linkedin' ? ' in LinkedIn' : ''}
          </button>
          <button className="btn-small" onClick={draft} disabled={drafting} title="Draft an answer from the Zinit knowledge base">
            {drafting ? 'Drafting…' : '✨ Draft from Zinit KB'}
          </button>
        </>
      )}
      {open && (
        <>
          <textarea
            rows={6} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={channel === 'linkedin'
              ? `Reply to ${contactName} in LinkedIn — sent from the same profile that ran the conversation, immediately (a human reply does not wait for the sending window)`
              : `Reply to ${contactName} — sent in the same thread from the campaign mailbox`}
          />
          {sources.length > 0 && <p className="hint">Drafted from: {sources.join(' · ')} — edit before sending.</p>}
          <div className="shortlist-actions">
            <button className="save-registry" onClick={send} disabled={sending || !text.trim()}>
              {sending ? 'Sending…' : 'Send reply'}
            </button>
            <button className="btn-small" onClick={draft} disabled={drafting}>{drafting ? 'Drafting…' : '✨ Redraft'}</button>
            <button className="link" onClick={() => setOpen(false)}>cancel</button>
          </div>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export default function InboxTab() {
  const [threads, setThreads] = useState([]);
  const [onlyNonNegative, setOnlyNonNegative] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [showClosed, setShowClosed] = useState(false);  // закрытые разговоры скрыты
  const [showTest, setShowTest] = useState(false);      // тестовые треды нулевого прогона скрыты

  // Ссылка в историю общения (L5.11): перед ответом полезно видеть всю цепочку,
  // а не только последнее сообщение — особенно когда касания шли по двум каналам.
  const [historyId, setHistoryId] = useState(null);

  // Поправка классификации. Сознательно не откатываем уже сделанные действия:
  // тихий откат карантина — сюрприз хуже ошибки; человек меняет статус явно.
  async function reclassify(thread, value) {
    if (!value || !thread.reply_touch_id) return;
    setBusy(thread.contact_id);
    try {
      const r = await fetch(`/api/inbox/${thread.reply_touch_id}/classification`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification: value }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      await load();
    } catch (e) { setError(String(e.message || e)); } finally { setBusy(null); }
  }

  async function act(contactId, path, body) {
    setBusy(contactId);
    try {
      const r = await fetch(`/api/inbox/contact/${contactId}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.status);
      if (data.kommo) setNote(`✓ ${data.kommo}`);
      await load();
    } catch (e) { setError(String(e.message || e)); } finally { setBusy(null); }
  }

  async function load() {
    try {
      const params = new URLSearchParams();
      if (showClosed) params.set('includeClosed', '1');
      if (showTest) params.set('includeTest', '1');
      const r = await fetch(`/api/inbox?${params}`);
      const data = await r.json().catch(() => ({ error: 'non-JSON' }));
      if (r.status === 503 || r.status === 404) throw new Error('Inbox needs the database — works on the Railway deployment.');
      if (!r.ok) throw new Error(data.error || r.status);
      setThreads(data);
      setError('');
    } catch (e) { setError(String(e.message || e)); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [showClosed, showTest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ответ лида приходит в произвольный момент, а вкладка может быть открыта часами —
  // без опроса карточка появлялась только после ручного обновления (вопрос Ольги 10.08).
  // Раз в минуту: чаще не нужно, о срочном всё равно предупреждает пинг в Телеграм.
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(); }, 60 * 1000);
    return () => clearInterval(t);
  }, [showClosed, showTest]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = threads.filter((t) => (onlyNonNegative ? (!t.classification || NON_NEGATIVE.includes(t.classification)) : true));
  const waiting = rows.filter((t) => !t.answered).length;

  return (
    <div className="inbox-tab">
      <div className="results-head">
        <h2>Inbox — conversations</h2>
        {waiting > 0 && <span className="segment-width" style={{ background: '#fffbeb', borderColor: '#fde68a', color: '#b45309' }}>{waiting} waiting for a reply</span>}
        <label className="flag-toggle">
          <input type="checkbox" checked={onlyNonNegative} onChange={(e) => setOnlyNonNegative(e.target.checked)} />
          only non-negative ({rows.length})
        </label>
        <label className="flag-toggle">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          show closed
        </label>
        <label className="flag-toggle">
          <input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} />
          show test threads
        </label>
      </div>
      {note && <p className="ok">{note}</p>}
      <p className="hint">
        ⚠️ While the classifier is being validated: check the FULL reply stream in{' '}
        <a href="https://app.smartlead.ai/app/master-inbox" target="_blank" rel="noreferrer">Smartlead Master Inbox</a>{' '}
        and make sure everything that stayed there really is negative/OOO. Mismatches → tell Claude, the prompt gets tuned.
      </p>

      {error && <div className="error">{error}</div>}
      {!error && !loading && rows.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">💬</div>
          <h2>No replies yet</h2>
          <p>Replies land here automatically via the Smartlead webhook, each classified by the LLM. Non-negative ones also ping Telegram.</p>
        </div>
      )}

      {rows.map((t) => {
        const st = LABEL_STYLE[t.classification] || { bg: '#f8fafc', color: '#475569', label: t.classification || 'not classified' };
        const byHuman = t.classified_by === 'human';
        return (
          <div key={t.contact_id} className={`reply-card ${t.answered ? '' : 'needs-reply'}`}>
            <div className="reply-head">
              <b>{t.full_name || '—'}</b> — {t.title || '?'} @ {t.company || '?'}
              {t.channel === 'linkedin' && (
                <span className="reply-badge" style={{ background: '#eef2ff', color: '#4f46e5' }}
                  title="The LinkedIn profile that runs this conversation — your reply goes out under this name">
                  💬 via {t.sender_name || 'unknown profile'}
                </span>
              )}
              {/* Классификация — СУЖДЕНИЕ модели, а не наблюдаемый факт: на нём стоят
                  карантин, подавление и запись в CRM. Экран обязан называть происхождение
                  суждения и давать его поправить (L5.12). */}
              <span
                className="reply-badge" style={{ background: st.bg, color: st.color }}
                title={byHuman ? 'Set by a human' : 'Judged automatically by the model — correct it if it is wrong'}
              >
                {st.label} {byHuman ? '· by a human' : '· auto'}
              </span>
              {t.reply_touch_id && (
                <select
                  value={t.classification || ''} disabled={busy === t.contact_id}
                  title="Correct the classification. Actions already taken (quarantine, suppression, CRM record) are NOT undone automatically — change the contact status by hand if needed."
                  onChange={(e) => reclassify(t, e.target.value)}
                  style={{ marginLeft: 6, fontSize: 12 }}
                >
                  <option value="" disabled>correct…</option>
                  {Object.entries(LABEL_STYLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              )}
              {t.conversation_state === 'closed'
                ? <span className="reply-badge" style={{ background: '#f1f5f9', color: '#64748b' }}>closed · {t.conversation_outcome || '—'}</span>
                : (t.answered
                  ? (
                    // Источник факта — наша переписка: последнее ЗАПИСАННОЕ сообщение исходящее.
                    // Ответ, отправленный мимо системы, сюда не попадает (L5.12).
                    <span
                      className="reply-badge" style={{ background: '#eef2ff', color: '#4f46e5' }}
                      title="The last message we recorded is ours. A reply sent outside the system would not show up here."
                    >
                      ✓ we replied last
                    </span>
                  )
                  : <span className="reply-badge" style={{ background: '#fffbeb', color: '#b45309' }}>needs reply</span>)}
              {t.is_test && <span className="reply-badge" style={{ background: '#faf5ff', color: '#7e22ce' }}>test</span>}
              <button
                className="link" style={{ marginLeft: 8 }}
                onClick={() => setHistoryId(historyId === t.contact_id ? null : t.contact_id)}
              >
                🧾 {historyId === t.contact_id ? 'hide history' : 'full history with this person'}
              </button>
              {/* Поздний ответ: лид ответил уже после закрытия кампании. Без пометки непонятно,
                  откуда взялся лид и к какой волне относится (вопрос Ольги 11.08). */}
              {t.late_reply && (
                <span
                  className="reply-badge" style={{ background: '#eff6ff', color: '#1e40af' }}
                  title={`The campaign had already been closed as «${t.late_reply.reopened_from || '—'}» on ${t.late_reply.closed_at ? String(t.late_reply.closed_at).slice(0, 10) : '—'} — this reply reopened the conversation`}
                >
                  ⏰ late reply — campaign was closed
                </span>
              )}
              {t.deal_stage === 'meeting_scheduled' && (
                <span className="reply-badge" style={{ background: '#f0fdf4', color: '#15803d' }}>
                  📅 meeting{t.meeting_at ? ` ${new Date(t.meeting_at).toLocaleDateString('en-US')}` : ''}
                </span>
              )}
              <span className="reply-date">{fmtTime(t.last_at)}</span>
            </div>
            {historyId === t.contact_id && (
              <div style={{ margin: '8px 0', background: '#fafaf9', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
                <LeadTimeline contactId={t.contact_id} onClose={() => setHistoryId(null)} />
              </div>
            )}
            <div className="reply-meta">
              {t.email} · lifecycle: <span className={`lifecycle ${t.lifecycle}`}>{t.lifecycle}</span>
              {t.lifecycle === 'quarantined' && t.quarantine_until ? ` until ${new Date(t.quarantine_until).toLocaleDateString('en-US')}` : ''}
              {t.campaign_ext_id ? <> · <a href={`https://app.smartlead.ai/app/email-campaign/${t.campaign_ext_id}/analytics`} target="_blank" rel="noreferrer">campaign {t.campaign_ext_id}</a></> : ''}
            </div>
            {t.summary && <div className="reply-summary">Gist: {t.summary}</div>}

            <div className="thread">
              {t.messages.map((m) => (
                <div key={`${m.direction}-${m.id}`} className={`msg msg-${m.direction}`}>
                  <div className="msg-head">
                    {/* Подпись исходящего обязана называть РЕАЛЬНОГО отправителя. «Stan's mailbox»
                        было зашито с email-времён и в LinkedIn-переписке, которую ведёт Наташа,
                        прямо противоречило бейджу «via Natalia Zh» в шапке (замечание Ольги 19.08). */}
                    {m.direction === 'in'
                      ? (t.full_name || 'Lead')
                      : (t.channel === 'linkedin'
                        ? `You (as ${t.sender_name || 'the sending profile'})`
                        : 'You (campaign mailbox)')}
                    <span className="msg-time">{fmtTime(m.at)}</span>
                  </div>
                  <div className="msg-text">{m.text || <em className="li-miss">(text not captured)</em>}</div>
                </div>
              ))}
            </div>

            {t.reply_touch_id && t.conversation_state !== 'closed' && (
              <ReplyBox touchId={t.reply_touch_id} contactName={t.full_name || 'the lead'} channel={t.channel} onSent={load} />
            )}

            <div className="thread-actions">
              {t.conversation_state === 'closed' ? (
                <button className="btn-small" disabled={busy === t.contact_id} onClick={() => act(t.contact_id, 'reopen')}>
                  ↺ Reopen
                </button>
              ) : (
                <>
                  {t.deal_stage !== 'meeting_scheduled' && (
                    <button
                      className="btn-small approve" disabled={busy === t.contact_id}
                      title="Marks the meeting, closes the thread and moves the card in Kommo to «Online meeting Scheduled»"
                      onClick={() => {
                        const when = window.prompt('Meeting date (YYYY-MM-DD, optional):', '');
                        if (when === null) return; // Cancel
                        act(t.contact_id, 'meeting', { meetingAt: when || null });
                      }}
                    >
                      📅 Meeting scheduled
                    </button>
                  )}
                  <button className="btn-small" disabled={busy === t.contact_id} onClick={() => act(t.contact_id, 'close', { outcome: t.is_test ? 'test' : 'dead' })}>
                    ✕ Close
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
