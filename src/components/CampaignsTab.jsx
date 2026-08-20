import React, { useEffect, useState } from 'react';
import LeadTimeline from './LeadTimeline.jsx';

// Этап кампаний (решения 07.08): библиотека заходов + билдер кампании из реестра.
// Апрув текста — кнопкой (факт+дата), запуск блокируется без апрува; pre-flight Тони:
// только verified/valid; testMode = нулевой прогон по протоколу.

// Дефолтный заход: утверждённый Тони A3 (hiring) + каденс 0/3/7 (bump и break-up — драфты).
const A3_TEMPLATE = {
  name: 'A3-hiring',
  description: 'Signal-based angle: the company is actively hiring procurement roles (signal is mandatory and verified). Approved by Tony 08/07.',
  sequence: [
    {
      wait_days: 0,
      subject: '{Growing the|Your} procurement team?',
      body: 'Hi {{first_name}},\n\nNoticed {{company_name}} is hiring — usually that means volume has outgrown the process, not just the team.\n\n{Some|A number of} procurement groups we work with close that gap with software instead of headcount alone, especially on tail spend and supplier onboarding.\n\nWorth a 15-minute look before the new hires start? Happy to share what we’re seeing.\n\nStan',
    },
    {
      wait_days: 3,
      subject: '',
      body: 'Hi {{first_name}},\n\nFloating this back up — I know hiring season keeps procurement busy.\n\nIf closing the gap with software (not just headcount) is on your radar, happy to share what similar teams are doing. 15 minutes, no deck.\n\nStan',
    },
    {
      wait_days: 4,
      subject: '',
      body: 'Hi {{first_name}},\n\nClosing the loop on this. If tail spend and supplier onboarding aren’t a priority this quarter, no worries at all — I’ll leave you to it.\n\nIf it becomes one, I’m easy to find.\n\nStan',
    },
  ],
  variables: ['first_name', 'company_name', 'unique_detail_short'],
};

const ZERO_RUN_LEADS = [
  { email: 'o.zhulikova@zinit.com', first_name: 'Olga', last_name: 'Zhulikova', company_name: 'Scenario 0/6 — pre-run + neutral' },
  { email: 'tony.urban.lt@gmail.com', first_name: 'Tony', last_name: 'Urban', company_name: 'Scenario 1 — do not open' },
  { email: 't.urban@zinit.com', first_name: 'Tony', last_name: 'Urban', company_name: 'Scenario 2 — open, no reply' },
  { email: 'tony@vibedeck.io', first_name: 'Tony', last_name: 'Urban', company_name: 'Scenario 3 — gibberish reply' },
  { email: 'tony@origraph.dev', first_name: 'Tony', last_name: 'Urban', company_name: 'Scenario 4 — hard no + remove' },
  { email: 'tony@scrambleup.com', first_name: 'Tony', last_name: 'Urban', company_name: 'Scenario 5 — soft no' },
  { email: 'olgavech.julikova@gmail.com', first_name: 'Olga', last_name: 'Zhulikova', company_name: 'Scenario 7 — positive' },
  { email: 't.urban@changellenge.ru', first_name: 'Tony', last_name: 'Urban', company_name: 'Scenario 8 — not now (November)' },
  { email: 'tony.urban.swiss@gmail.com', first_name: 'Tony', last_name: 'Urban', company_name: 'Scenario 9 — OOO autoreply' },
  { email: 'nonexistent-zero-run@zinit.com', first_name: 'Bounce', last_name: 'Test', company_name: 'Scenario 10 — hard bounce' },
  { email: 's.moskovtsev@zinit.com', first_name: 'Stan', last_name: 'Moskovtsev', company_name: 'Scenario 11 — positive + in-app reply demo' },
  { email: 'peter-julikov@yandex.ru', first_name: 'Peter', last_name: 'Julikov', company_name: 'Scenario 12 — substantive question' },
];

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({ error: 'non-JSON response' }));
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}

function AngleEditor({ angle, onSaved, onCancel, segments, signers = [] }) {
  const [form, setForm] = useState(angle || A3_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  // Конструктор текста: сегмент (кому) + база знаний Zinit (что даём) → цепочка (что пишем).
  const [draftSegId, setDraftSegId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [kbSources, setKbSources] = useState([]);
  const [segLimit, setSegLimit] = useState(10); // сегменты копятся — показываем по 10
  const [draftSigner, setDraftSigner] = useState(signers[0]?.name || 'Stan');
  // Черновик от модели нельзя сохранить, пока его не тронули руками (решение Ольги 11.08).
  // Смысл не в бюрократии: LLM пишет гладко и правдоподобно, и именно поэтому текст легко
  // пропустить не читая. Обязательная правка заставляет прочитать — а на прочтении и ловятся
  // чужая биография в подписи, выдуманные цифры и переменные без источника.
  const [aiUntouched, setAiUntouched] = useState(false);
  // LinkedIn-форма захода (L2.5-UI): та же гипотеза в формате чата. Драфт конвертирует
  // СОХРАНЁННУЮ email-цепочку, поэтому для нового захода кнопка ждёт первого сохранения.
  const [liInstruction, setLiInstruction] = useState('');
  const [liDrafting, setLiDrafting] = useState(false);
  const [liValidation, setLiValidation] = useState(null);
  const [liSources, setLiSources] = useState([]);

  const wordsOf = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
  const setLinkedinField = (part, field, v) => {
    const li = { message1: { body: '' }, followup: { wait_days: 3, body: '' }, ...(form.linkedin || {}) };
    li[part] = { ...li[part], [field]: v };
    setForm({ ...form, linkedin: li });
    setAiUntouched(false);   // правка руками — запрет на сохранение снят
    setLiValidation(null);   // старый вердикт валидатора больше не про этот текст
  };

  async function draftLinkedin() {
    // Несохранённый заход тоже можно конвертировать: цепочка уезжает в теле запроса.
    const id = angle?.id || form.id || 'new';
    setLiDrafting(true); setErr('');
    try {
      const data = await jfetch(`/api/message-angles/${id}/draft-linkedin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: liInstruction,
          ...(id === 'new' ? { sequence: form.sequence, name: form.name, description: form.description } : {}),
        }),
      });
      setForm({ ...form, linkedin: data.linkedin });
      setLiValidation(data.validation || null);
      setLiSources(data.sources || []);
      setAiUntouched(true);  // черновик модели — прочитать и править, как и email-драфт
    } catch (e) { setErr(String(e.message || e)); } finally { setLiDrafting(false); }
  }

  async function draftFromSegment() {
    const seg = segments.find((s) => String(s.id) === String(draftSegId));
    if (!seg) { setErr('pick a segment to draft from'); return; }
    setDrafting(true); setErr('');
    try {
      const data = await jfetch('/api/message-angles/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ criteria: seg.criteria || {}, instruction, signedBy: draftSigner }),
      });
      setForm({
        ...form,
        name: data.name || form.name,
        description: data.description || form.description,
        sequence: data.sequence,
      });
      setKbSources(data.sources || []);
      setAiUntouched(true);
    } catch (e) { setErr(String(e.message || e)); } finally { setDrafting(false); }
  }

  // Подпись из последней строки первого письма. Сверяем со списком известных отправителей
  // (он приходит из ящиков Smartlead), чтобы подсказка не расходилась с проверкой на бэке.
  const signer = (() => {
    const lines = String(form.sequence?.[0]?.body || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const last = (lines[lines.length - 1] || '').replace(/[.,!]$/, '');
    if (!last || last.length > 30) return null;
    return signers.find((s) => s.name.toLowerCase() === last.toLowerCase())?.name || null;
  })();

  // Проверка переменных (ТЗ п.31, вопрос Ольги 10.08 по заготовке Тони). Две беды:
  //   — {{чтото_наше_неизвестное}} — Smartlead его не заполнит, у лида будет дыра в предложении;
  //   — [квадратные скобки] — для Smartlead это обычный текст, уедет лиду в таком виде.
  // Переменную нельзя «просто дописать»: у каждой должен быть источник данных, знающий значение
  // для КАЖДОГО лида. Придумать {{their_biggest_supplier}} легко, заполнить на двухстах — нет.
  const KNOWN_VARS = ['first_name', 'company_name', 'unique_detail_short'];
  const textIssues = (() => {
    const unknown = new Set();
    const brackets = new Set();
    for (const s of form.sequence || []) {
      const all = `${s.subject || ''}\n${s.body || ''}`;
      for (const m of all.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
        if (!KNOWN_VARS.includes(m[1])) unknown.add(m[1]);
      }
      // Спинтакс {a|b} — законен, его не трогаем. Ловим только квадратные скобки-заглушки.
      for (const m of all.matchAll(/\[([^\]\n]{2,40})\]/g)) brackets.add(m[1].trim());
    }
    return { unknown: [...unknown], brackets: [...brackets] };
  })();

  const setStep = (i, field, v) => {
    const seq = form.sequence.map((s, j) => (j === i ? { ...s, [field]: v } : s));
    setForm({ ...form, sequence: seq });
    setAiUntouched(false);   // текст тронули — запрет снят
  };

  async function save() {
    setSaving(true); setErr('');
    try {
      const saved = await jfetch('/api/message-angles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      onSaved(saved);
    } catch (e) { setErr(String(e.message || e)); } finally { setSaving(false); }
  }

  return (
    <div className="angle-editor">
      {/* У существующего захода (в т.ч. близнеца) генератор свёрнут — он путал: текст уже есть,
          и главное действие здесь «прочитать и утвердить», а не сгенерировать заново. */}
      <details className="draft-box" open={!angle}>
        <summary className="field-label" style={{ cursor: 'pointer' }}>
          ✨ {angle ? 'Regenerate from a segment (replaces the text below)' : 'Draft the sequence from a segment + the Zinit knowledge base'}
        </summary>
        <div className="draft-row">
          <select value={draftSigner} onChange={(e) => setDraftSigner(e.target.value)} title="Who signs this sequence — decides which mailboxes can send it">
            {(signers.length ? signers : [{ id: 'stan', name: 'Stan' }]).map((s) => (
              <option key={s.id} value={s.name}>✍️ from {s.name}</option>
            ))}
          </select>
          <select value={draftSegId} onChange={(e) => setDraftSegId(e.target.value)}>
            <option value="">— segment to write to —</option>
            {segments.slice(0, segLimit).map((s) => <option key={s.id} value={s.id}>#{s.id} {s.name}</option>)}
          </select>
          {segments.length > segLimit && (
            <button className="link" onClick={() => setSegLimit(segLimit + 10)}>
              show 10 more ({segments.length - segLimit} left)
            </button>
          )}
          <input
            value={instruction} onChange={(e) => setInstruction(e.target.value)}
            placeholder="optional: what to lean on — e.g. lead with the free GPO benchmark"
          />
          <button className="btn-small approve" onClick={draftFromSegment} disabled={drafting}>
            {drafting ? 'Drafting…' : 'Generate'}
          </button>
        </div>
        {kbSources.length > 0 && <p className="hint">Used knowledge: {kbSources.join(' · ')} — review and edit every line before approving.</p>}
      </details>

      <details className="rules-box">
        <summary>📋 What belongs in a cold sequence — and what does not</summary>
        <div className="rules-grid">
          <div>
            <b className="rules-yes">✅ Do</b>
            <ul>
              <li>60–110 words per email, plain text, one idea per message.</li>
              <li>One low-friction ask: a 15-minute call, or the free GPO benchmark (needs only supplier name, item, price).</li>
              <li>Personalize with {'{{unique_detail_short}}'} in step 1 only — one full sentence, and the text must read fine when it is empty.</li>
              <li>Spintax {'{a|b}'} in the subject and 1–2 phrases — it varies the fingerprint across recipients.</li>
              <li>Explain the mechanism, not just the number: 67% of awards stay with incumbents, at better prices.</li>
              <li>Steps 2–3 reply into the same thread (empty subject); step 3 is a polite break-up.</li>
            </ul>
          </div>
          <div>
            <b className="rules-no">🚫 Don&apos;t</b>
            <ul>
              <li><b>No attachments or a company deck in a cold email</b> — spam filters treat attachments from unknown senders as a strong negative signal. Materials belong in the <i>reply</i>, once the lead has answered.</li>
              <li>No links in the first touch (they cost deliverability the same way).</li>
              <li>No client names — references need permission from Stan.</li>
              <li>No setup fee, no waiver thresholds — those are call topics.</li>
              <li>No headcount-efficiency framing («do more with less») to procurement staff: they are the buyer and hear a threat.</li>
              <li>No claims of full autonomy — supplier engagement still involves people; sophisticated buyers punish overclaiming.</li>
              <li>No images, no unsubscribe footer of your own — Smartlead adds the required one.</li>
            </ul>
          </div>
        </div>
      </details>

      <div className="field">
        <span className="field-label">Angle name (matrix axis value)</span>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="field">
        <span className="field-label">Description</span>
        <input value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <p className={signer ? 'hint' : 'title-warn'}>
        {signer
          ? `✍️ Signed by ${signer} — detected from the signature. Only ${signer}'s mailboxes will be selectable at launch.`
          : '⚠️ No signature detected in step 1. End the email with the sender’s first name (e.g. "Stan") — the launch is blocked without a known signer, because Smartlead assigns mailboxes at send time.'}
      </p>
      {(textIssues.unknown.length > 0 || textIssues.brackets.length > 0) && (
        <p className="title-warn">
          {textIssues.unknown.length > 0 && (
            <>
              ⚠️ Unknown variable{textIssues.unknown.length === 1 ? '' : 's'}:{' '}
              <b>{textIssues.unknown.map((v) => `{{${v}}}`).join(', ')}</b>. We only fill{' '}
              {KNOWN_VARS.map((v) => `{{${v}}}`).join(', ')} — anything else leaves a hole in the sentence
              for every lead. A new variable needs a data source that knows the value for each contact,
              so it is a small task, not a text edit.<br />
            </>
          )}
          {textIssues.brackets.length > 0 && (
            <>
              ⚠️ Square brackets are <b>not</b> variables — Smartlead sends them verbatim:{' '}
              <b>{textIssues.brackets.map((v) => `[${v}]`).join(', ')}</b>. Either replace them with a real
              variable, or — if the value is the same for the whole campaign (a category, a calendar link) —
              just write it out.
            </>
          )}
        </p>
      )}
      {form.sequence.map((s, i) => (
        <div key={i} className="step-editor">
          <div className="step-head">
            Step {i + 1} {i === 0 ? '(day 0)' : `(+${s.wait_days} days${i === 1 ? ' — day 3' : i === 2 ? ' — day 7' : ''})`}
            {i > 0 && <span className="hint"> empty subject = same thread</span>}
          </div>
          {i > 0 && (
            <div className="field">
              <span className="field-label">Wait days after previous</span>
              <input type="number" min="1" max="14" value={s.wait_days} onChange={(e) => setStep(i, 'wait_days', Number(e.target.value))} style={{ width: 80 }} />
            </div>
          )}
          <div className="field">
            <span className="field-label">Subject {i === 0 ? '' : '(leave empty to reply in thread)'}</span>
            <input value={s.subject} onChange={(e) => setStep(i, 'subject', e.target.value)} />
          </div>
          <div className="field">
            <span className="field-label">Body — click a variable to insert; spintax {'{a|b}'} supported</span>
            <div className="chips" style={{ marginBottom: 4 }}>
              {['{{first_name}}', '{{company_name}}', '{{unique_detail_short}}', '{option A|option B}'].map((v) => (
                <button
                  key={v} type="button" className="chip"
                  title={v === '{{unique_detail_short}}' ? 'Compressed company fact from Serper+AI (empty if none found)' : ''}
                  onClick={(e) => {
                    const ta = e.target.closest('.field').querySelector('textarea');
                    const pos = ta.selectionStart ?? s.body.length;
                    setStep(i, 'body', s.body.slice(0, pos) + v + s.body.slice(pos));
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
            <textarea rows={7} value={s.body} onChange={(e) => setStep(i, 'body', e.target.value)} />
          </div>
        </div>
      ))}
      {/* LinkedIn-форма того же захода (L2.5-UI). Отдельного «LinkedIn-захода» не существует:
          гипотеза одна, форм несколько — так матрица сравнивает канал, а не случайно
          разные тексты. Сохраняется вместе с заходом и так же сбрасывает апрув. */}
      <details className="draft-box" open={!!form.linkedin} style={{ marginTop: 12 }}>
        <summary className="field-label" style={{ cursor: 'pointer' }}>
          💬 LinkedIn form of this angle {form.linkedin?.message1?.body ? '— filled' : '— empty (angle is email-only)'}
        </summary>
        <p className="hint">
          Message #1 lands in chat right after the connection request is accepted: under 40 words,
          one question, no pitch, no links, no pricing. Follow-up 3–4 days later, under 60 words,
          {' {{unique_detail_short}}'} allowed only there. UNSIGNED — the same template goes out from
          several profiles, so any «I&apos;m Stan» in the text is a bug, not a signature.
        </p>
        <div className="draft-row">
          <input
            value={liInstruction} onChange={(e) => setLiInstruction(e.target.value)}
            placeholder="optional: what to lean on in chat — e.g. open with the benchmark question"
          />
          <button
            className="btn-small approve" onClick={draftLinkedin}
            disabled={liDrafting || !(form.sequence || []).some((s) => (s.body || '').trim())}
            title="Converts the email sequence above into chat format"
          >
            {liDrafting ? 'Drafting…' : '✨ Draft from the email sequence'}
          </button>
          {!form.linkedin && (
            <button
              className="link" type="button"
              onClick={() => setForm({ ...form, linkedin: { message1: { body: '' }, followup: { wait_days: 3, body: '' } } })}
            >
              or write by hand
            </button>
          )}
          {form.linkedin && (
            <button
              className="link" type="button"
              title="The angle stays email-only; LinkedIn cells will not offer it"
              onClick={() => { setForm({ ...form, linkedin: null }); setLiValidation(null); }}
            >
              remove LinkedIn part
            </button>
          )}
        </div>
        {liValidation && !liValidation.ok && (
          <p className="title-warn">⚠️ The draft failed our LinkedIn checks: {liValidation.errors.join(' · ')} — fix by hand before saving.</p>
        )}
        {liValidation?.ok && liValidation.warnings?.length > 0 && <p className="hint">⚠ {liValidation.warnings.join(' · ')}</p>}
        {liSources.length > 0 && <p className="hint">Used knowledge: {liSources.join(' · ')} — review and edit before approving.</p>}
        {form.linkedin && (
          <>
            <div className="field">
              <span className="field-label">
                Message #1 — sent when the invite is accepted ·{' '}
                <b style={{ color: wordsOf(form.linkedin.message1?.body) > 40 ? '#b45309' : undefined }}>
                  {wordsOf(form.linkedin.message1?.body)} words
                </b> (keep under 40)
              </span>
              <textarea rows={3} value={form.linkedin.message1?.body || ''} onChange={(e) => setLinkedinField('message1', 'body', e.target.value)} />
            </div>
            <div className="field">
              <span className="field-label">
                Follow-up after{' '}
                <input
                  type="number" min="1" max="14" style={{ width: 60 }}
                  value={form.linkedin.followup?.wait_days ?? 3}
                  onChange={(e) => setLinkedinField('followup', 'wait_days', Number(e.target.value))}
                />{' '}
                days ·{' '}
                <b style={{ color: wordsOf(form.linkedin.followup?.body) > 60 ? '#b45309' : undefined }}>
                  {wordsOf(form.linkedin.followup?.body)} words
                </b> (keep under 60) · {'{{unique_detail_short}}'} allowed here as its own sentence
              </span>
              <textarea rows={4} value={form.linkedin.followup?.body || ''} onChange={(e) => setLinkedinField('followup', 'body', e.target.value)} />
            </div>
          </>
        )}
      </details>

      {err && <div className="error">{err}</div>}
      <div className="shortlist-actions">
        <button
          className="save-registry" onClick={save} disabled={saving || aiUntouched}
          title={aiUntouched ? 'Edit the AI draft before saving — read it through first' : ''}
        >
          {saving ? 'Saving…' : 'Save angle (as draft)'}
        </button>
        {aiUntouched && (
          <span className="hint" style={{ color: '#b45309' }}>
            ⚠️ AI draft — edit at least one line before saving. It reads well, and that is exactly why it
            is easy to skip: someone else's bio in the signature, invented numbers and variables without
            a data source are all caught by reading, not by trusting.
          </span>
        )}
        <button className="link" onClick={onCancel}>cancel</button>
        <span className="hint">Any edit resets approval — launched text is always explicitly approved.</span>
      </div>
    </div>
  );
}

function AnglePreview({ angle }) {
  const [contacts, setContacts] = useState([]);
  const [contactId, setContactId] = useState('');
  const [steps, setSteps] = useState(null);
  const [liSteps, setLiSteps] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    jfetch('/api/registry/contacts?limit=200').then(setContacts).catch(() => setContacts([]));
  }, []);

  useEffect(() => {
    setErr('');
    const c = contacts.find((x) => String(x.id) === String(contactId));
    if (!angle || !c) { setSteps(null); return; }
    // LinkedIn-тексты рендерим тем же /render: подстановка переменных и сжатие
    // unique_detail общие для каналов — прогоняем их как продолжение цепочки.
    const li = angle.linkedin?.message1?.body
      ? [{ subject: '', body: angle.linkedin.message1.body }, ...(angle.linkedin.followup?.body ? [{ subject: '', body: angle.linkedin.followup.body }] : [])]
      : [];
    jfetch('/api/message-angles/render', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sequence: [...angle.sequence, ...li], contact: c }),
    }).then((d) => {
      const emails = d.steps.slice(0, angle.sequence.length);
      setSteps(emails);
      setLiSteps(li.length ? d.steps.slice(angle.sequence.length) : null);
    }).catch((e) => setErr(String(e.message || e)));
  }, [contactId, angle, contacts]);

  return (
    <div className="angle-preview">
      <div className="field">
        <span className="field-label">Live preview on a real lead (pick anyone from the registry)</span>
        <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
          <option value="">— pick a lead —</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>{c.full_name} — {c.company}{c.unique_detail ? ' · 💡' : ''}</option>
          ))}
        </select>
      </div>
      {err && <div className="error">{err}</div>}
      {steps && steps.map((s, i) => (
        <div key={i} className="preview-mail">
          <div className="preview-subject">{i + 1}. {s.subject || <em>(same thread)</em>}</div>
          <pre className="preview-body">{s.body}</pre>
        </div>
      ))}
      {steps && liSteps && (
        <>
          <div className="field-label" style={{ marginTop: 10 }}>💬 LinkedIn form — chat after the invite is accepted</div>
          {liSteps.map((s, i) => (
            <div key={`li${i}`} className="preview-mail" style={{ background: '#eff6ff' }}>
              <div className="preview-subject">{i === 0 ? 'Message #1 — right after accept' : `Follow-up (+${angle.linkedin?.followup?.wait_days ?? 3} days)`}</div>
              <pre className="preview-body">{s.body}</pre>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default function CampaignsTab({ preselect }) {
  const [angles, setAngles] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [segments, setSegments] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [signers, setSigners] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | angle
  const [previewAngle, setPreviewAngle] = useState(null);
  const [error, setError] = useState('');
  const [notReady, setNotReady] = useState(false);

  // Билдер кампании
  const [segId, setSegId] = useState('');
  const [batches, setBatches] = useState([]);
  const [batchId, setBatchId] = useState('');
  const [pairMode, setPairMode] = useState(false);       // запустить пару текстов на одном пакете
  const [angleIdB, setAngleIdB] = useState('');          // второй текст пары
  const [senderIdsB, setSenderIdsB] = useState([]);      // ящики второго отправителя
  const [angleId, setAngleId] = useState('');
  const [senderIds, setSenderIds] = useState([]);
  const [candidates, setCandidates] = useState(null);
  const [pickedIds, setPickedIds] = useState(new Set());
  const [testMode, setTestMode] = useState(true);
  // Пред-нулевой прогон (идея Ольги 07.08): снять все галки кроме одного адреса → одно письмо
  // ловит реальный формат вебхука до полного прогона.
  const [pickedTestEmails, setPickedTestEmails] = useState(new Set(ZERO_RUN_LEADS.map((l) => l.email)));
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState(null);
  // Канал ячейки (L5.1): волна = до двух ячеек, по одной на канал. Email-ячейка идёт через
  // Smartlead-ящики, LinkedIn-ячейка — через профили GetSales с настроенной лестницей.
  // Статус волны по людям (L5.11): раскрытие строки кампании отвечает на вопрос
  // «что происходит прямо сейчас», которого не закрывают агрегаты «сколько».
  // «Что требует внимания» (L5.13): состояния волны, из-за которых работа стоит.
  // Живёт на экране, а не только в уведомлениях: алерт — способ узнать быстро,
  // таблица — способ не забыть.
  const [problems, setProblems] = useState(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  // Сворачиваемость и фильтр тестовых — по образцу Inbox (просьба Ольги 18.08):
  // два экрана об одном и том же должны и вести себя одинаково.
  const [panelOpen, setPanelOpen] = useState(() => {
    try { return localStorage.getItem('attentionPanelOpen') !== 'no'; } catch { return true; }
  });
  const [showTestProblems, setShowTestProblems] = useState(false);
  useEffect(() => {
    fetch('/api/health/problems').then((r) => (r.ok ? r.json() : [])).then(setProblems).catch(() => setProblems([]));
  }, []);
  // Тестовые нити прогона прячем так же, как в Inbox: они не про сегодняшнюю работу.
  const testCount = (problems || []).filter((x) => x.isTest).length;
  const shownProblems = (problems || []).filter((x) => showTestProblems || !x.isTest);

  async function ackProblem(x) {
    try {
      await jfetch('/api/health/ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: x.key, hours: 24 }),
      });
      setProblems((prev) => (prev || []).filter((y) => y.key !== x.key));
    } catch (e) { setError(String(e.message || e)); }
  }

  const problemsOf = (campaignId) => (problems || []).filter((x) => x.campaignId === campaignId);

  const [openCampaign, setOpenCampaign] = useState(null);
  const [campLeads, setCampLeads] = useState(null);
  const [leadTimeline, setLeadTimeline] = useState(null);

  async function toggleCampaign(id) {
    if (openCampaign === id) { setOpenCampaign(null); setCampLeads(null); return; }
    setOpenCampaign(id); setCampLeads(null); setLeadTimeline(null);
    try { setCampLeads(await jfetch(`/api/campaigns/${id}/leads`)); }
    catch (e) { setError(String(e.message || e)); setCampLeads({ leads: [] }); }
  }

  const [channel, setChannel] = useState('email');
  const [gs, setGs] = useState(null);          // конфиг GetSales: профили, лестницы, лимиты
  const [liSenders, setLiSenders] = useState([]); // uuid профилей В ПОРЯДКЕ приоритета (Value сверху)

  // Конфиг тянем лениво: /api/getsales/config ходит в живой GetSales, незачем делать это
  // при каждом открытии вкладки ради email-запусков.
  useEffect(() => {
    if ((channel === 'linkedin' || channel === 'both') && !gs) {
      jfetch('/api/getsales/config').then(setGs).catch(() => setGs({ enabled: false, profiles: [], senderFlows: {}, limits: {} }));
    }
  }, [channel]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadBatches() {
    try { setBatches(await jfetch('/api/batches')); } catch { /* пакетов может не быть */ }
  }

  async function loadAll() {
    setError('');
    try {
      const [a, c, s] = await Promise.all([
        jfetch('/api/message-angles'), jfetch('/api/campaigns'), jfetch('/api/registry/segments'),
      ]);
      setAngles(a); setCampaigns(c); setSegments(s);
    } catch (e) {
      if (String(e.message).includes('registry not configured')) setNotReady(true);
      else setError(String(e.message || e));
    }
    jfetch('/api/smartlead/email-accounts').then((d) => setAccounts(Array.isArray(d) ? d : d?.email_accounts || [])).catch(() => setAccounts([]));
    // Подписанты приходят с бэка, а не из списка ящиков: подсказка о подписи не должна зависеть
    // от доступности Smartlead (кейс 08.08 — предупреждение «нет подписи» при живой подписи).
    jfetch('/api/identities').then(setSigners).catch(() => setSigners([{ id: 'stan', name: 'Stan' }]));
  }
  useEffect(() => { loadAll(); loadBatches(); }, []);

  // Пакет, приехавший с вкладки Contacts, сразу выбирается в билдере.
  useEffect(() => {
    if (preselect?.id) { setTestMode(false); setBatchId(String(preselect.id)); loadBatches(); }
  }, [preselect]);

  // Загрузка контактов выбранного пакета.
  useEffect(() => {
    if (!batchId || testMode) { setCandidates(null); setPickedIds(new Set()); return; }
    jfetch(`/api/batches/${batchId}/contacts`)
      .then((rows) => {
        // Сегмент кампании берётся из пакета автоматически (поля выбора больше нет).
        const b = batches.find((x) => String(x.id) === String(batchId));
        setSegId(b?.segment_id ? String(b.segment_id) : '');
        setCandidates({ candidates: rows, rejected: null, fromBatch: true });
        // Предвыбираем только тех, кто ещё свободен — занятые в другой кампании всё равно отсеются.
        setPickedIds(new Set(rows.filter((c) => c.lifecycle === 'available').map((c) => c.id)));
      })
      .catch((e) => setError(String(e.message || e)));
  }, [batchId, testMode, batches]);

  // Близнец: тот же текст с другой подписью. Имя захода то же — это одна messaging-гипотеза,
  // а (name + подписант) = ячейка матрицы, поэтому Стэн и Антон сравнимы между собой.
  const [twinning, setTwinning] = useState(null);
  async function makeTwin(angle, signerName, signerId) {
    setTwinning(`${angle.id}-${signerId}`); setError('');
    try {
      const twin = await jfetch(`/api/message-angles/${angle.id}/twin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedBy: signerName }),
      });
      await loadAll();
      setEditing(twin); // открываем сразу: текст переписан под другого человека — перечитать и утвердить
    } catch (e) { setError(String(e.message || e)); } finally { setTwinning(null); }
  }

  async function removeAngle(angle) {
    try {
      await jfetch(`/api/message-angles/${angle.id}`, { method: 'DELETE' });
      if (editing && editing.id === angle.id) setEditing(null);
      if (previewAngle?.id === angle.id) setPreviewAngle(null);
      loadAll();
    } catch (e) { setError(String(e.message || e)); }
  }

  async function approve(angle) {
    try { await jfetch(`/api/message-angles/${angle.id}/approve`, { method: 'POST' }); loadAll(); } catch (e) { setError(String(e.message || e)); }
  }

  // Один запуск = одна кампания (ячейка). Для пары вызывается дважды на половинах пакета,
  // для двухканальной волны — дважды на ОДНОМ пакете с разными каналами.
  async function launchOne({ angle, senders, contactIds, testLeads, cellChannel }) {
    let draft = null;
    try {
      draft = await jfetch('/api/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segmentId: testMode ? null : Number(segId) || null, messageAngleId: angle.id, channel: cellChannel || channel }),
      });
      return await jfetch(`/api/campaigns/${draft.id}/launch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testMode, testLeads: testLeads || [], contactIds: contactIds || [],
          senderIds: senders, schedule: {}, batchId: testMode ? null : Number(batchId) || null,
        }),
      });
    } catch (e) {
      if (draft?.id) await fetch(`/api/campaigns/${draft.id}`, { method: 'DELETE' }).catch(() => {});
      throw e;
    }
  }

  async function launch() {
    const angle = angles.find((a) => String(a.id) === String(angleId));
    if (!angle) return setError('pick a message angle');
    if (angle.status !== 'approved') return setError('angle text is not approved');
    if (channel === 'linkedin' || channel === 'both') {
      if (!angle.linkedin?.message1?.body) return setError('this angle has no LinkedIn form — draft it in the angle editor first');
      if (!liSenders.length) return setError('pick at least one LinkedIn sender profile');
    }
    if ((channel === 'email' || channel === 'both') && !senderIds.length) return setError('pick at least one sender mailbox');

    const angleB = pairMode ? angles.find((a) => String(a.id) === String(angleIdB)) : null;
    if (pairMode) {
      if (!angleB) return setError('pick the second text of the pair');
      if (angleB.status !== 'approved') return setError('the second text is not approved');
      if (!senderIdsB.length) return setError('pick mailboxes for the second sender');
      if (angleB.sender_identity === angle.sender_identity) {
        return setError('both texts are signed by the same person — a pair must compare two senders');
      }
    }

    const testLeadsPicked = ZERO_RUN_LEADS.filter((l) => pickedTestEmails.has(l.email));
    const leadsN = testMode ? testLeadsPicked.length : pickedIds.size;
    if (!leadsN) return setError('no leads selected');
    if (pairMode && leadsN < 2) return setError('a pair needs at least 2 leads to split');

    setLaunching(true); setError(''); setLaunchResult(null);
    try {
      if (channel === 'both') {
        // Двухканальная волна (просьба Ольги 14.08): ОДИН пакет, ОДИН заход, две ячейки —
        // email сразу, LinkedIn лестницей. Кросс-стоп защищает от лишнего: ответ в одном
        // канале останавливает касания в другом.
        const ids = [...pickedIds];
        const em = await launchOne({ angle, senders: senderIds, contactIds: ids, cellChannel: 'email' });
        const li = await launchOne({ angle, senders: liSenders, contactIds: ids, cellChannel: 'linkedin' });
        setLaunchResult({ runs: [{ angle: `${angle.name} · email`, ...em }, { angle: `${angle.name} · LinkedIn`, ...li }] });
      } else if (!pairMode) {
        const result = await launchOne({
          angle, senders: channel === 'linkedin' ? liSenders : senderIds,
          contactIds: testMode ? [] : [...pickedIds],
          testLeads: testMode ? testLeadsPicked : [],
        });
        setLaunchResult({ runs: [{ angle: angle.name, ...result }] });
      } else {
        // Деление пакета пополам СЛУЧАЙНО: сравнение отправителей честно только на сопоставимых
        // группах. Обе кампании стартуют в один момент — условия одинаковые.
        const shuffled = [...pickedIds].sort(() => Math.random() - 0.5);
        const half = Math.ceil(shuffled.length / 2);
        const a = await launchOne({ angle, senders: senderIds, contactIds: shuffled.slice(0, half) });
        const b = await launchOne({ angle: angleB, senders: senderIdsB, contactIds: shuffled.slice(half) });
        setLaunchResult({ runs: [{ angle: angle.name, ...a }, { angle: angleB.name, ...b }] });
      }
      loadAll(); loadBatches();
    } catch (e) {
      setError(String(e.message || e));
      loadAll();
    } finally { setLaunching(false); }
  }

  if (notReady) {
    return <div className="empty-state"><div className="empty-icon">📮</div><h2>Campaigns need the database</h2><p>This environment has no DATABASE_URL (local dev). Campaigns work on the Railway deployment.</p></div>;
  }

  const toggleSender = (id) => setSenderIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Личность выбранного захода определяет, какие ящики разрешены (см. ТЗ п.21).
  const selectedAngle = angles.find((a) => String(a.id) === String(angleId));
  const angleIdentityId = selectedAngle?.sender_identity || null;
  const angleIdentity = angleIdentityId
    ? (accounts.find((a) => a.identity?.id === angleIdentityId)?.identity?.name || angleIdentityId)
    : null;
  const accountsByIdentity = accounts.reduce((acc, a) => {
    const key = a.identity?.name || 'Unassigned';
    (acc[key] = acc[key] || []).push(a);
    return acc;
  }, {});

  // Пара = тот же заход (базовое имя), но другой подписант, и оба утверждены.
  const baseName = (n) => String(n || '').split(' · ')[0].trim();
  const pairCandidates = selectedAngle
    ? angles.filter((a) => a.id !== selectedAngle.id
      && a.status === 'approved'
      && a.sender_identity && a.sender_identity !== selectedAngle.sender_identity
      && baseName(a.name) === baseName(selectedAngle.name))
    : [];
  const angleB = angles.find((a) => String(a.id) === String(angleIdB));
  // Пропускная способность ящиков (ТЗ п.34). Приложение позволяет собрать пакет любого размера,
  // не сверяясь с тем, сколько писем ящики физически отправят за день, — и часть волны молча
  // переезжает на следующие дни, а конверсия считается по неполной отправке. Найдено на живом
  // примере 10.08: seed-кампания из 30 адресов встала на 15, упёршись в лимит ящика.
  const capacity = (() => {
    const chosen = accounts.filter((a) => senderIds.includes(a.id) || senderIdsB.includes(a.id));
    if (!chosen.length) return null;
    const perDay = chosen.reduce((s, a) => s + (Number(a.message_per_day) || 0), 0);
    // Сегодня доступно меньше: прогрев в лимит не входит, а уже отправленное — входит.
    const today = chosen.reduce((s, a) => s + Math.max(0, (Number(a.message_per_day) || 0) - (Number(a.daily_sent_count) || 0)), 0);
    const leads = testMode ? pickedTestEmails.size : pickedIds.size;
    const exhausted = chosen.filter((a) => (Number(a.daily_sent_count) || 0) >= (Number(a.message_per_day) || 0));
    const days = perDay > 0 ? Math.max(1, Math.ceil(Math.max(0, leads - today) / perDay) + (today > 0 ? 1 : 0)) : 0;
    const lastDay = new Date(Date.now() + (days - 1) * 864e5);
    return { chosen, perDay, today, leads, exhausted, days, lastDay, fits: leads <= today };
  })();

  // Ёмкость LinkedIn-ячейки (L5.2): по ПРОФИЛЯМ, не суммой — блоки лидов режутся по Value
  // в порядке приоритета отправителей, и волна длится столько, сколько самый нагруженный
  // профиль шлёт заявки под своим дневным потолком. Лимиты — из Settings, не из кода.
  const invitesPerDay = (uuid) => Number(gs?.limits?.[uuid]?.invites ?? gs?.limits?.default?.invites) || 10;
  const liCapacity = (() => {
    if ((channel !== 'linkedin' && channel !== 'both') || !liSenders.length) return null;
    const leads = testMode ? pickedTestEmails.size : pickedIds.size;
    if (!leads) return null;
    const perSender = Math.ceil(leads / liSenders.length);
    const rows = liSenders.map((uuid, i) => {
      const block = Math.max(0, Math.min(perSender, leads - i * perSender));
      const perDay = invitesPerDay(uuid);
      return {
        uuid, name: gs?.profiles?.find((p) => p.uuid === uuid)?.name || uuid.slice(0, 8),
        block, perDay, days: block ? Math.ceil(block / perDay) : 0,
      };
    });
    const days = Math.max(...rows.map((r) => r.days), 0);
    return { leads, rows, days, lastDay: new Date(Date.now() + Math.max(0, days - 1) * 864e5) };
  })();
  const toggleLiSender = (uuid) => setLiSenders((prev) => (
    prev.includes(uuid) ? prev.filter((x) => x !== uuid) : [...prev, uuid]
  ));

  const angleBIdentityId = angleB?.sender_identity || null;
  const angleBIdentity = angleBIdentityId
    ? (accounts.find((a) => a.identity?.id === angleBIdentityId)?.identity?.name || angleBIdentityId)
    : null;
  const toggleSenderB = (id) => setSenderIdsB((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Какие сегменты реально представлены в пакете — считаем по контактам, а не по одному полю.
  const batchSegments = [...new Set((candidates?.candidates || []).flatMap((c) => c.segment_names || []))];

  return (
    <div className="campaigns-tab">
      {error && <div className="error">{error}</div>}

      <div className="results-head"><h2>Message angles (library)</h2>
        <button className="add-recommended" onClick={() => setEditing('new')}>+ New angle (A3 template)</button>
      </div>
      {angles.length === 0 && !editing && <p className="hint">Library is empty — create the first angle from the approved A3 template.</p>}
      {angles.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Description</th><th>Signed by</th><th>Steps</th><th>Status</th><th>Campaigns</th><th /></tr></thead>
          <tbody>
            {angles.map((a) => (
              <tr key={a.id}>
                <td><b>{a.name}</b></td>
                <td style={{ maxWidth: 380 }}>{a.description}</td>
                <td>
                  {a.sender_identity
                    ? <span className="lifecycle available">{a.sender_identity}</span>
                    : <span className="lifecycle suppressed_forever" title="No known signature — the angle cannot be launched">no signer</span>}
                </td>
                <td>
                  {(a.sequence || []).length}
                  {/* LinkedIn-форма — часть того же захода: бейдж показывает, какие каналы заход умеет. */}
                  {a.linkedin?.message1?.body
                    ? <span className="lifecycle available" style={{ marginLeft: 6 }} title="Has the LinkedIn form — can launch LinkedIn cells">💬 in</span>
                    : <span className="hint" style={{ marginLeft: 6 }} title="Email-only — draft the LinkedIn form in the editor to launch LinkedIn cells">✉ only</span>}
                </td>
                <td>
                  {a.status === 'approved'
                    ? <span className="lifecycle available" title={a.approved_by}>approved ✓</span>
                    : <span className="lifecycle quarantined">draft</span>}
                </td>
                <td>{a.campaigns_count}</td>
                <td className="angle-actions">
                  <button className="btn-small" onClick={() => setPreviewAngle(previewAngle?.id === a.id ? null : a)}>👁 Preview</button>
                  <button className="btn-small" onClick={() => setEditing(a)}>✏️ Edit</button>
                  {a.status !== 'approved' && <button className="btn-small approve" onClick={() => approve(a)}>✓ Approve text</button>}
                  {/* Близнец доступен всегда (запрос Ольги): текст переписывается под другого
                      отправителя, лишние черновики убираются кнопкой Delete. */}
                  {a.sender_identity && signers
                    .filter((s) => s.id !== a.sender_identity)
                    .map((s) => (
                      <button
                        key={s.id} className="btn-small"
                        disabled={twinning === `${a.id}-${s.id}`}
                        title={`Rewrites the same message from ${s.name}: their credibility line, their voice, their signature`}
                        onClick={() => makeTwin(a, s.name, s.id)}
                      >
                        {twinning === `${a.id}-${s.id}` ? 'Rewriting…' : `⧉ Twin for ${s.name}`}
                      </button>
                    ))}
                  {a.status === 'draft' && Number(a.campaigns_count) === 0 && (
                    <button className="btn-small danger" title="Delete this draft" onClick={() => removeAngle(a)}>🗑</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <AngleEditor
          angle={editing === 'new' ? null : editing}
          segments={segments}
          signers={signers}
          onSaved={() => { setEditing(null); loadAll(); }}
          onCancel={() => setEditing(null)}
        />
      )}
      {previewAngle && <AnglePreview angle={previewAngle} />}

      <div className="results-head" style={{ marginTop: 28 }}><h2>New campaign</h2></div>
      <div className="campaign-builder">
        <label className="checkbox-line">
          <input type="checkbox" checked={testMode} onChange={(e) => { setTestMode(e.target.checked); if (e.target.checked) setChannel('email'); }} />
          <b>Zero run</b> — protocol test to internal addresses (Tony + Olga + Stan + Peter), 24/7 window, open-tracking ON
        </label>
        {testMode && (
          <div className="candidates-list">
            <p className="hint" style={{ margin: '2px 0 6px' }}>
              Pre-run tip: keep only your own address checked → 1 email catches the live webhook format; then run the full set.
            </p>
            {ZERO_RUN_LEADS.map((l) => (
              <label key={l.email} className="checkbox-line">
                <input
                  type="checkbox" checked={pickedTestEmails.has(l.email)}
                  onChange={() => setPickedTestEmails((prev) => { const n = new Set(prev); n.has(l.email) ? n.delete(l.email) : n.add(l.email); return n; })}
                />
                {l.email} — {l.company_name}
              </label>
            ))}
          </div>
        )}
        {!testMode && (
          <div className="field">
            <span className="field-label">Lead batch — the list you selected in Contacts and sent here</span>
            <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">— pick a batch —</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}{b.segment_name ? ` · ${b.segment_name}` : ''}
                  {` — ${b.available} of ${b.total} still free`}
                  {Number(b.campaigns) > 0 ? ` · used in ${b.campaigns} campaign(s)` : ''}
                </option>
              ))}
            </select>
            {batches.length === 0 && (
              <span className="hint">No batches yet — go to Contacts, filter the list, select rows and press «→ Send to a campaign».</span>
            )}
          </div>
        )}

        {/* Выбора сегмента здесь больше нет (решение Ольги 08.08): таргетинг решён на шаге отбора,
            пакет его несёт. Атрибуция выводится из состава пакета и показывается фактом —
            в том числе честно, если сегментов несколько. */}
        {!testMode && batchId && (
          <p className="hint">
            <b>Matrix attribution:</b>{' '}
            {batchSegments.length === 0 && 'no segment recorded for these contacts'}
            {batchSegments.length === 1 && batchSegments[0]}
            {batchSegments.length > 1 && (
              <>mixed — {batchSegments.length} segments in this batch, attributed per contact
                {' '}({batchSegments.slice(0, 3).join(' · ')}{batchSegments.length > 3 ? ' …' : ''})</>
            )}
          </p>
        )}
        {/* Смешанный пакет × один текст (просьба Ольги 14.08): драфтер пишет под ОДИН сегмент,
            и текст под hiring-сигнал уедет и тем, у кого сигнала нет. Машина противоречий
            не видит — но обязана предупредить, что прочитать надо глазами универсальности. */}
        {!testMode && batchId && batchSegments.length > 1 && (
          <p className="title-warn">
            ⚠️ This batch mixes {batchSegments.length} segments, but one angle text goes to everyone.
            If the text leans on a segment-specific hook (a hiring signal, an industry), part of the batch
            won&apos;t recognize itself. Re-read the angle for universality — or split the batch by segment
            in Contacts and launch separate cells.
          </p>
        )}
        {/* Канал ячейки (L5.1). Волна несёт до двух ячеек — по одной на канал; вторая ячейка
            того же канала блокируется на бэке. Нулевой прогон остаётся email-инструментом. */}
        {!testMode && (
          <div className="field">
            <span className="field-label">Channel of this cell</span>
            <div className="chips">
              {[['email', '✉ Email — Smartlead mailboxes'], ['linkedin', '💬 LinkedIn — GetSales profiles'], ['both', '🌊 Both — one wave, two cells']].map(([ch, label]) => (
                <label key={ch} className="checkbox-line" style={{ display: 'inline-flex', marginRight: 12 }}>
                  <input
                    type="radio" name="cell-channel" checked={channel === ch}
                    onChange={() => { setChannel(ch); setSenderIds([]); setLiSenders([]); setPairMode(false); setAngleIdB(''); setSenderIdsB([]); }}
                  />
                  {label}
                </label>
              ))}
            </div>
            {channel === 'linkedin' && (
              <p className="hint" style={{ margin: '4px 0 0' }}>
                The ladder per lead: like → connection request (no note) → after accept, message #1 from
                the angle&apos;s LinkedIn form → follow-up. One wave = one LinkedIn cell; the same people can
                also get the email cell of this wave.
              </p>
            )}
          </div>
        )}
        <div className="field">
          <span className="field-label">Message angle (must be approved{channel === 'linkedin' ? ', with a LinkedIn form' : ''})</span>
          <select
            value={angleId}
            onChange={(e) => { setAngleId(e.target.value); setSenderIds([]); }} // у другой личности другие ящики
          >
            <option value="">— pick an angle —</option>
            {angles.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} {a.status === 'approved' ? '✓' : '(draft — not launchable)'}
                {channel === 'linkedin' ? (a.linkedin?.message1?.body ? ' · 💬' : ' · no LinkedIn form') : ''}
              </option>
            ))}
          </select>
        </div>
        {!testMode && channel === 'email' && pairCandidates.length > 0 && (
          <label className="checkbox-line" style={{ background: '#f5f3ff', border: '1px solid #c7d2fe', borderRadius: 8, padding: '8px 10px' }}>
            <input type="checkbox" checked={pairMode} onChange={(e) => { setPairMode(e.target.checked); setAngleIdB(e.target.checked ? String(pairCandidates[0].id) : ''); setSenderIdsB([]); }} />
            <span>
              <b>⚖️ Launch as a sender pair</b> — the batch is split randomly in half and two campaigns
              start at once: same message, two signers. That is the only honest way to compare senders.
            </span>
          </label>
        )}

        {/* LinkedIn-отправители (L5.1): профили с настроенной лестницей, ПОРЯДОК выбора = приоритет.
            Лиды сортируются по Value и режутся блоками: первый профиль получает самых ценных. */}
        {(channel === 'linkedin' || channel === 'both') && (
          <div className="field">
            <span className="field-label">
              LinkedIn sender profiles — click in priority order: the batch is sorted by Value and the
              first profile gets the most valuable block
            </span>
            {!gs && <span className="hint">Loading GetSales config…</span>}
            {gs && !gs.enabled && <span className="hint">GetSales is not configured on the server (GETSALES_API_TOKEN)</span>}
            {gs?.enabled && (gs.profiles || []).filter((p) => gs.senderFlows?.[p.uuid]).length === 0 && (
              <span className="hint">No profiles with a configured ladder flow — set getsales_sender_flows in Settings first.</span>
            )}
            {gs?.enabled && (gs.profiles || []).filter((p) => gs.senderFlows?.[p.uuid]).map((p) => {
              const pos = liSenders.indexOf(p.uuid);
              // Аккаунт без пульса выбрать нельзя: заявки с него просто не пойдут, и волна
              // молча встанет — ровно так вчера не ушла заявка (решение Ольги 18.08).
              // Пульс — признак живой автоматизации; формальный статус `enabled` при этом врёт.
              const dead = p.alive === false;
              const why = dead
                ? `No automation heartbeat for ${p.heartbeat_age_days} days (last beat ${p.heartbeat_at ? new Date(p.heartbeat_at).toLocaleDateString('en-GB') : '—'}). The account looks disconnected in GetSales — open it, re-connect the LinkedIn session, and check that tasks resume. Invites from this profile will not go out until then.`
                : '';
              return (
                <label key={p.uuid} className="checkbox-line" title={why} style={dead ? { opacity: 0.55 } : undefined}>
                  <input type="checkbox" checked={pos >= 0} disabled={dead} onChange={() => toggleLiSender(p.uuid)} />
                  {pos >= 0 && <b style={{ marginRight: 4 }}>#{pos + 1}</b>}
                  {p.name} · {invitesPerDay(p.uuid)} invites/day
                  {dead && <span className="warn"> · ⚠️ no heartbeat for {p.heartbeat_age_days} d — check the account in GetSales</span>}
                  {!dead && p.weekly_limit_at && (Date.now() - new Date(p.weekly_limit_at).getTime()) < 14 * 864e5 && (
                    <span className="hint"> · hit LinkedIn&apos;s weekly invite cap on {new Date(p.weekly_limit_at).toLocaleDateString('en-GB')}</span>
                  )}
                </label>
              );
            })}
            {gs?.enabled && (gs.profiles || []).some((p) => !gs.senderFlows?.[p.uuid]) && (
              <p className="hint" style={{ margin: '4px 0 0' }}>
                Without a ladder: {(gs.profiles || []).filter((p) => !gs.senderFlows?.[p.uuid]).map((p) => p.name).join(', ')} —
                clone the «Connect» flow for them and map it in Settings to make them selectable.
              </p>
            )}
          </div>
        )}

        {/* Срок LinkedIn-волны (L5.2): по профилям, не суммой — узкое место задаёт длительность. */}
        {liCapacity && (
          <div className="field">
            <span className="field-label">Throughput — LinkedIn invites</span>
            <p className="hint" style={{ margin: 0 }}>
              {liCapacity.leads} lead{liCapacity.leads === 1 ? '' : 's'} split by Value into {liCapacity.rows.length} block{liCapacity.rows.length === 1 ? '' : 's'} —
              the wave takes <b>{liCapacity.days} day{liCapacity.days === 1 ? '' : 's'}</b>, last invites around {liCapacity.lastDay.toLocaleDateString('en-US')}.
            </p>
            <ul className="hint" style={{ margin: '4px 0 0 18px' }}>
              {liCapacity.rows.map((r, i) => (
                <li key={r.uuid}>
                  #{i + 1} {r.name}: {r.block} lead{r.block === 1 ? '' : 's'} ÷ {r.perDay}/day = {r.days} day{r.days === 1 ? '' : 's'}
                  {i === 0 ? ' (highest-Value block)' : ''}
                </li>
              ))}
            </ul>
            <p className="hint" style={{ margin: '4px 0 0' }}>
              Daily ceilings live in Settings (getsales_limits) — raise them weekly during ramp-up, not in code.
            </p>
          </div>
        )}

        {(channel === 'email' || channel === 'both') && (
        <div className="field">
          <span className="field-label">
            {pairMode ? 'Sender A — mailboxes' : 'Sender mailboxes'}
            {angleIdentity
              ? <> — this angle is signed by <b>{angleIdentity}</b>, so only their mailboxes can be used</>
              : ' — pick an angle first (its signature decides which mailboxes are allowed)'}
          </span>
          {accounts.length === 0 && <span className="hint">Smartlead accounts unavailable (check SMARTLEAD_API_KEY on the server)</span>}
          {Object.entries(accountsByIdentity).map(([idName, list]) => {
            const allowed = angleIdentity && list[0]?.identity?.id === angleIdentityId;
            return (
              <div key={idName} className={`sender-group ${allowed ? 'allowed' : 'blocked'}`}>
                <div className="sender-group-head">
                  {idName}{!allowed && angleIdentity && ' — different signer, blocked'}
                </div>
                {list.map((acc) => (
                  <label key={acc.id} className={`checkbox-line ${allowed ? '' : 'muted'}`}>
                    <input
                      type="checkbox" checked={senderIds.includes(acc.id)} disabled={!allowed}
                      title={allowed ? '' : `The text is signed by ${angleIdentity}; Smartlead assigns mailboxes at send time, so this batch would go out with the wrong signature.`}
                      onChange={() => toggleSender(acc.id)}
                    />
                    {acc.from_email} · {acc.message_per_day}/day
                  </label>
                ))}
              </div>
            );
          })}
        </div>
        )}

        {/* Срок волны — не блокирует, но должен быть известен ДО запуска, а не по факту. */}
        {(channel === 'email' || channel === 'both') && capacity && capacity.leads > 0 && (
          <div className={`field ${capacity.fits ? '' : 'warn'}`}>
            <span className="field-label">Throughput</span>
            <p className="hint" style={{ margin: 0 }}>
              {capacity.leads} contact{capacity.leads === 1 ? '' : 's'} · daily capacity{' '}
              {capacity.perDay} ({capacity.chosen.length} mailbox{capacity.chosen.length === 1 ? '' : 'es'}),{' '}
              <b>{capacity.today} left today</b>.{' '}
              {capacity.fits
                ? 'The whole wave goes out today.'
                : <>The wave takes <b>{capacity.days} day{capacity.days === 1 ? '' : 's'}</b>, last emails around {capacity.lastDay.toLocaleDateString('en-US')}.</>}
            </p>
            {capacity.exhausted.length > 0 && (
              <p className="hint" style={{ margin: '4px 0 0', color: '#b45309' }}>
                ⚠️ {capacity.exhausted.map((a) => a.from_email).join(', ')} already hit the daily limit —
                their share starts tomorrow.
              </p>
            )}
            {!capacity.fits && (
              <p className="hint" style={{ margin: '4px 0 0' }}>
                Not an error: a wave spread over days is a normal mode. But reply rate for this cell is only
                meaningful once the whole batch has actually been sent.
              </p>
            )}
          </div>
        )}

        {pairMode && (
          <>
            <div className="field">
              <span className="field-label">Sender B — the twin text (same message, other signer)</span>
              <select value={angleIdB} onChange={(e) => { setAngleIdB(e.target.value); setSenderIdsB([]); }}>
                <option value="">— pick the second text —</option>
                {pairCandidates.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="field">
              <span className="field-label">
                Sender B — mailboxes
                {angleBIdentity ? <> — signed by <b>{angleBIdentity}</b></> : ''}
              </span>
              {Object.entries(accountsByIdentity).map(([idName, list]) => {
                const allowed = angleBIdentity && list[0]?.identity?.id === angleBIdentityId;
                if (!allowed) return null;
                return (
                  <div key={idName} className="sender-group allowed">
                    <div className="sender-group-head">{idName}</div>
                    {list.map((acc) => (
                      <label key={acc.id} className="checkbox-line">
                        <input type="checkbox" checked={senderIdsB.includes(acc.id)} onChange={() => toggleSenderB(acc.id)} />
                        {acc.from_email} · {acc.message_per_day}/day
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {!testMode && candidates && (
          <div className="preflight">
            <div className="field-label">Pre-flight (Tony's rules): verified/valid email only, available only</div>
            <p className="hint">
              ✅ passed: <b>{candidates.candidates.length}</b>
              {/* catch-all СЮДА НЕ ВХОДИТ: он проходит pre-flight, его долю режет квота
                  на сборке пакета — и всегда с пояснением. Показывать его как «отсеян»
                  значило бы врать оператору о причине. */}
              {candidates.rejected && <> · dropped — no email: {candidates.rejected.no_email},
                not checked yet: {candidates.rejected.unchecked}, invalid: {candidates.rejected.invalid},
                role address: {candidates.rejected.role}, company closed: {candidates.rejected.company_closed},
                not available (quarantine/active/suppressed): {candidates.rejected.not_available}
                {Number(candidates.rejected.catch_all) > 0 && <> · catch-all in scope: {candidates.rejected.catch_all} (not dropped — capped by quota when the batch is built)</>}</>}
              {candidates.fromBatch && ' · pre-flight runs again at launch and drops anyone unverified, quarantined or already active in another campaign'}
            </p>
            <div className="candidates-list">
              {candidates.candidates.map((c) => (
                <label key={c.id} className="checkbox-line">
                  <input
                    type="checkbox" checked={pickedIds.has(c.id)}
                    onChange={() => setPickedIds((prev) => { const n = new Set(prev); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })}
                  />
                  {c.full_name} — {c.title || '?'} @ {c.company} · {c.email} ({c.email_status}) · fit {c.fit_score ?? '—'}
                  {c.unique_detail ? ' · 💡' : ''}
                </label>
              ))}
            </div>
          </div>
        )}

        <button className="cta" onClick={launch} disabled={launching}>
          {launching ? 'Launching…' : (testMode
            ? `Launch ZERO RUN (${pickedTestEmails.size} test address${pickedTestEmails.size === 1 ? '' : 'es'})`
            : (pairMode
              ? `Launch pair — ${Math.ceil(pickedIds.size / 2)} to sender A, ${Math.floor(pickedIds.size / 2)} to sender B`
              : `Launch campaign (${pickedIds.size} contacts)`))}
        </button>
        {launchResult?.runs?.map((run, i) => (
          <div key={run.smartlead_id || i}>
            <p className="ok">
              ✓ {launchResult.runs.length > 1 ? `${i === 0 ? 'A' : 'B'} · ` : ''}<b>{run.angle}</b> — Smartlead #{run.smartlead_id}, uploaded {run.uploaded}.{' '}
              <a href={run.smartlead_url} target="_blank" rel="noreferrer">Open in Smartlead</a>
            </p>
            {run.rejected?.length > 0 && (
              <div className="preflight" style={{ background: '#fffbeb', borderColor: '#fde68a' }}>
                <b>⚠️ {run.rejected.length} dropped by pre-flight:</b>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
                  {run.rejected.map((r) => <li key={r.id}>{r.name || `#${r.id}`} — {r.reason}</li>)}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="results-head" style={{ marginTop: 28 }}>
        <h2>Campaigns</h2>
        {problems && shownProblems.length > 0 && (
          <label className="checkbox-line" style={{ marginLeft: 12 }}>
            <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
            only waves with problems
          </label>
        )}
      </div>
      {campaigns.length === 0 ? <p className="hint">No campaigns yet.</p> : (
        <table>
          <thead><tr><th>#</th><th>Segment</th><th>Angle</th><th>Channel</th><th>Status</th><th>Progress</th><th>Leads</th><th>Started</th><th /></tr></thead>
          <tbody>
            {campaigns.filter((c) => !onlyProblems || problemsOf(c.id).length > 0).map((c) => (
              <React.Fragment key={c.id}>
              <tr
                onClick={(e) => { if (!e.target.closest('a, button')) toggleCampaign(c.id); }}
                style={{ cursor: 'pointer', background: openCampaign === c.id ? '#eef2ff' : undefined }}
              >
                <td>
                  {openCampaign === c.id ? '▾' : '▸'} {c.id}
                  {problemsOf(c.id).length > 0 && (
                    <span className="warn" title={problemsOf(c.id).map((x) => x.title).join('\n')}> ⚠️{problemsOf(c.id).length}</span>
                  )}
                </td>
                <td style={{ maxWidth: 260 }}><span className="seg-names" title={c.segment_name}>{c.segment_name || '— zero run —'}</span></td>
                <td>{c.angle_name}</td>
                <td>{c.channel}</td>
                <td>
                  <span className={`lifecycle ${c.status === 'active' ? 'available' : c.status === 'error' ? 'suppressed_forever' : ''}`}>{c.status}</span>
                  {/* Знаем мы не «отправок не было», а «событий об отправке не пришло»: если
                      вебхуки Smartlead молчат, письма могут идти, а счётчик — нет. Формулировка
                      обязана называть источник (L5.12). */}
                  {c.no_sends_alert && (
                    <span className="warn" title="We have recorded no «sent» events for 24h after start. Either nothing was sent, or the events are not reaching us — check Smartlead.">
                      {' '}⚠️ no send events 24h
                    </span>
                  )}
                </td>
                <td>
                  {/* Лестница по людям (вопрос Ольги 14.08): на каком шаге волна прямо сейчас.
                      Email и LinkedIn считают разные события — показываем каждому каналу свои. */}
                  {(() => {
                    const p = c.progress || {};
                    const bits = c.channel === 'linkedin'
                      ? [['invited', p.connection_sent], ['accepted', p.accepted], ['msg #1', p.message_sent],
                        ['follow-up', p.message_followup], ['replied', p.replied]]
                      : [['sent', p.sent], ['opened', p.opened], ['replied', p.replied], ['bounced', p.bounced]];
                    const shown = bits.filter(([, n]) => n > 0);
                    if (!shown.length) return <span className="hint">nothing yet</span>;
                    return shown.map(([label, n], i) => (
                      <span key={label}>
                        {i > 0 && ' → '}
                        <b style={label === 'bounced' ? { color: '#b91c1c' } : label === 'replied' ? { color: '#047857' } : {}}>{n}</b> {label}
                      </span>
                    ));
                  })()}
                </td>
                <td>{c.leads_count ?? '—'}</td>
                <td>{c.started_at ? new Date(c.started_at).toLocaleDateString('en-US') : '—'}</td>
                <td>
                  {c.external_id && (
                    <a className="link" href={`https://app.smartlead.ai/app/email-campaign/${c.external_id}/analytics`} target="_blank" rel="noreferrer">
                      open in Smartlead
                    </a>
                  )}
                </td>
              </tr>
              {openCampaign === c.id && (
                <tr>
                  <td colSpan={9} style={{ background: '#fafaf9' }}>
                    {!campLeads && <span className="hint">Loading the wave…</span>}
                    {campLeads && campLeads.leads.length === 0 && <span className="hint">No leads recorded for this cell yet.</span>}
                    {campLeads && campLeads.leads.length > 0 && (
                      <table>
                        <thead><tr><th>Person</th><th>Company</th><th>Sender</th><th>Value</th><th title="The last event we recorded for this person — not a guarantee of their true state at the provider">Last recorded event</th><th>When</th><th>Last outgoing</th><th /></tr></thead>
                        <tbody>
                          {campLeads.leads.map((l) => (
                            <tr key={l.id}>
                              <td>{l.full_name || `#${l.id}`}</td>
                              <td>{l.company || <span className="hint">—</span>}</td>
                              {/* Отправитель и скор рядом: правило «лучших — Стэну» должно быть
                                  проверяемо глазами, иначе оно не правило, а обещание
                                  (запрос Ольги 18.08). */}
                              <td>{l.sender_name || <span className="hint">—</span>}</td>
                              <td title={l.fit_score != null ? `fit ${l.fit_score}` : ''}>
                                {l.value_score != null ? <b>{l.value_score}</b> : <span className="hint">—</span>}
                              </td>
                              <td>{l.last_event || <span className="hint">nothing yet</span>}</td>
                              <td>{l.last_at ? new Date(l.last_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                              <td>
                                {/* Доставка называет себя и здесь: «отправлено» без подтверждения
                                    провайдера — это ровно то состояние, что молчало 14–17.08. */}
                                {l.last_delivery === 'confirmed' && <span className="reply-badge" style={{ background: '#ecfdf5', color: '#047857' }}>✓ delivered</span>}
                                {l.last_delivery === 'pending' && <span className="reply-badge" style={{ background: '#fffbeb', color: '#b45309' }}>⏳ queued</span>}
                                {l.last_delivery === 'missing' && <span className="reply-badge" style={{ background: '#fef2f2', color: '#b91c1c' }}>⚠️ not at provider</span>}
                                {!l.last_delivery && <span className="hint">—</span>}
                              </td>
                              <td><button className="btn-small" onClick={() => setLeadTimeline(leadTimeline === l.id ? null : l.id)}>🧾 history</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {leadTimeline && (
                      <div style={{ marginTop: 10, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
                        <LeadTimeline contactId={leadTimeline} onClose={() => setLeadTimeline(null)} />
                      </div>
                    )}
                  </td>
                </tr>
              )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}

      {/* Панель обхода: с неё начинается утро владельца волны. */}
      {problems && shownProblems.length > 0 && (
        <div style={{ marginTop: 24, border: '1px solid #fecaca', borderRadius: 8, background: '#fef7f7', padding: 14 }}>
          <div className="reply-head">
            <button
              className="link" style={{ fontWeight: 600 }}
              onClick={() => { const v = !panelOpen; setPanelOpen(v); try { localStorage.setItem('attentionPanelOpen', v ? 'yes' : 'no'); } catch { /* приватный режим */ } }}
            >
              {panelOpen ? '▾' : '▸'} ⚠️ Needs attention: {shownProblems.length}
            </button>
            <span className="hint">
              {shownProblems.filter((x) => x.level === 'red').length} urgent ·
              {' '}{shownProblems.filter((x) => x.level === 'yellow').length} to review
            </span>
            {testCount > 0 && (
              <label className="checkbox-line" style={{ marginLeft: 'auto' }}>
                <input type="checkbox" checked={showTestProblems} onChange={(e) => setShowTestProblems(e.target.checked)} />
                show test threads ({testCount})
              </label>
            )}
          </div>
          {panelOpen && shownProblems.map((x, i) => (
            <div key={`${x.code}${x.contactId || ''}${x.campaignId || ''}${i}`} className="preview-mail" style={{ background: '#fff' }}>
              <div className="preview-subject">
                <span className="reply-badge" style={x.level === 'red'
                  ? { background: '#fef2f2', color: '#b91c1c' }
                  : { background: '#fffbeb', color: '#b45309' }}
                >
                  {x.level === 'red' ? 'urgent' : 'review'}
                </span>{' '}
                {x.title}
              </div>
              <div className="hint">{x.detail}</div>
              {/* Источник факта у каждого состояния — правило L5.12: система обязана
                  называть, на чём стоит её утверждение. */}
              <div className="hint" style={{ fontStyle: 'italic' }}>источник: {x.source}</div>
              {/* Закрыть состояние можно двумя способами, и они разные: устранить причину —
                  тогда оно исчезнет само при следующем пересчёте; либо «принять в работу» —
                  спрятать на сутки, пока держишь в руках. Второе не отменяет проблему:
                  если причина останется, состояние вернётся (решение 18.08). */}
              <button
                className="btn-small" style={{ marginTop: 6 }}
                title="Спрятать на сутки: причина остаётся, но вы её видели и держите в руках. Если через сутки она не ушла — состояние вернётся."
                onClick={() => ackProblem(x)}
              >
                ✓ принято в работу
              </button>
            </div>
          ))}
        </div>
      )}
      {problems && shownProblems.length === 0 && (
        <p className="hint" style={{ marginTop: 24 }}>✓ Nothing needs attention right now — every open wave is moving.</p>
      )}

    </div>
  );
}
