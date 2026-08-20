import React, { useEffect, useState } from 'react';

// Настройки и журнал (ТЗ п.37). Решение Ольги 11.08: не отдельная гугл-таблица и не внешняя
// админка, а вкладка внутри рабочего инструмента. Видимость журнала не ограничиваем —
// внутри команды прозрачность полезнее.
//
// Структура разделов — по референсу Ольги 13.08: слева список разделов, справа один раздел.
// Причина не в красоте: на одной простыне барьер Kommo, журнал и доступы читались как один
// поток, и найти нужное можно было только прокруткой.

const ACTION_LABEL = {
  'angle.approve': { icon: '✓', text: 'approved a text' },
  'batch.create': { icon: '📦', text: 'built a batch' },
  'campaign.launch': { icon: '🚀', text: 'launched a campaign' },
  'campaign.close': { icon: '🏁', text: 'closed a campaign' },
  'inbox.reply': { icon: '↩', text: 'replied to a lead' },
  'contact.lifecycle': { icon: '♻', text: 'changed contact lifecycle' },
  'user.create': { icon: '👤', text: 'added a user' },
  'user.active': { icon: '👤', text: 'enabled/disabled a user' },
  'kommo.push': { icon: '⬆', text: 'sent leads to Kommo' },
  'kommo.move': { icon: '➡', text: 'moved a lead to another stage' },
  'crm.sync': { icon: '↻', text: 'refreshed the stop list' },
  'crm.block': { icon: '🔒', text: 'added to the stop list by hand' },
  'crm.unblock': { icon: '🔓', text: 'removed from the stop list' },
  'crm.override_revoke': { icon: '↩', text: 'revoked a stop-list override' },
  'crm.stage_unblock': { icon: '🔓', text: 'released a whole stage from the stop list' },
  'crm.stage_reblock': { icon: '🔒', text: 'put a stage back into the stop list' },
  'crm.review_approve': { icon: '✓', text: 'confirmed their part of the stop list is reviewed' },
};

const PAGE = 100;   // размер страницы стоп-листа
// Тот же список, что в барьере на бэке: доменный блок для бесплатной почты бессмыслен.
const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|icloud|aol|proton|yandex|mail)\./i;
const ROBOTS = ['cron', 'webhook', 'system'];
const ROBOT_WHY = { cron: 'nightly schedule', webhook: 'Smartlead event', system: 'background job' };

// Порядок: сначала то, чем пользуются каждый день (стоп-лист, журнал), справка — последней
// (просьба Ольги 13.08).
// Навигация — по инструментам (просьба Ольги 14.08): у каждой интеграции свой блок,
// пользователь ищет настройку по имени системы, а не по нашему внутреннему названию канала.
const SECTIONS = [
  // «Как это всё работает» — первым: раздел для человека, который видит систему впервые
  // (передача Жене, решение Ольги 18.08). Остальные разделы отвечают «как настроить»,
  // этот — «что здесь вообще происходит и чему верить».
  { group: 'START HERE', id: 'how-it-works', icon: '🧭', label: 'How it all works' },
  { group: 'KOMMO (CRM)', id: 'kommo-barrier', icon: '🛡', label: 'Stop list' },
  { group: 'KOMMO (CRM)', id: 'kommo-log', icon: '🧾', label: 'Activity log' },
  { group: 'KOMMO (CRM)', id: 'kommo-rules', icon: '📘', label: 'What we write' },
  { group: 'GETSALES (LINKEDIN)', id: 'linkedin-channel', icon: '💬', label: 'Channel & limits' },
  { group: 'SMARTLEAD (EMAIL)', id: 'email-channel', icon: '✉️', label: 'How the channel works' },
  { group: 'PEOPLE', id: 'people-access', icon: '🔑', label: 'Access' },
  { group: 'PEOPLE', id: 'people-log', icon: '🧾', label: 'Activity log' },
];

const HEAD = {
  'kommo-rules': { title: 'Kommo — what we write', sub: 'Which action in this app changes what in the CRM. Generated from the code, so it cannot drift.' },
  'how-it-works': { title: 'How it all works', sub: 'The system in one page: what it does, what it never does, and what to look at every morning.' },
  'kommo-barrier': { title: 'Kommo — stop list', sub: 'Who cannot be written to, and why. Editable by hand.' },
  'kommo-log': { title: 'Kommo — activity log', sub: 'Everything that went into or moved inside the CRM: what, when, by whom, automatic or by hand.' },
  'linkedin-channel': { title: 'GetSales — LinkedIn channel', sub: 'How the ladder works, daily ceilings per profile, the acceptance window. Rendered from the code and live config, so it cannot drift.' },
  'email-channel': { title: 'Smartlead — email channel', sub: 'How the email cell works: cadence, maturation, bounce thresholds, mailboxes. Rendered from the code, so it cannot drift.' },
  'people-access': { title: 'Access', sub: 'Who can sign in to this workspace.' },
  'people-log': { title: 'Activity log', sub: 'What people did here. Machine actions live in the Kommo log.' },
};

const fmt = (v) => (v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

// Читаемое описание строки журнала. Сырой JSON в таблице формально честен, но им
// невозможно пользоваться: «сколько лидов и чего именно» должно читаться глазами.
function describe(r) {
  const m = r.meta || {};
  if (r.action === 'kommo.push') {
    const created = m.created ?? Math.max(0, (m.pushed ?? 0) - (m.matched ?? 0));
    const bits = [`${m.pushed ?? 0} leads`];
    if (created) bits.push(`${created} new cards`);
    if (m.matched) bits.push(`${m.matched} matched to existing`);
    if (m.stayed) bits.push(`${m.stayed} left on their own stage`);
    return bits.join(' · ');
  }
  if (r.action === 'kommo.move') {
    return [m.to ? `→ ${m.to}` : null, m.lead ? `lead ${m.lead}` : null,
      m.moved === false ? `not moved: ${m.reason || 'already further'}` : null,
      m.trigger ? `trigger: ${m.trigger}` : null].filter(Boolean).join(' · ');
  }
  if (r.action === 'crm.sync') return `${m.emails ?? '—'} addresses · ${m.domains ?? '—'} domains in the export`;
  if (r.action === 'campaign.launch') return `${m.name || ''}${m.leads ? ` · ${m.leads} leads` : ''}`;
  return m && Object.keys(m).length ? JSON.stringify(m) : '';
}

function AuditRows({ rows, withType }) {
  return (
    <table>
      <thead>
        <tr>
          <th>When</th>{withType && <th>Type</th>}<th>Who</th><th>What</th><th>Details</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const a = ACTION_LABEL[r.action] || { icon: '·', text: r.action };
          const robot = ROBOTS.includes(r.actor);
          return (
            <tr key={r.id}>
              <td>{fmt(r.at)}</td>
              {withType && (
                <td>
                  {robot
                    ? <span className="reply-badge" style={{ background: '#f1f5f9', color: '#475569' }} title={ROBOT_WHY[r.actor] || ''}>automatic</span>
                    : <span className="reply-badge" style={{ background: '#eef2ff', color: '#3730a3' }}>by hand</span>}
                </td>
              )}
              <td>{robot ? <span className="hint">{r.actor}</span> : <b>{r.actor}</b>}</td>
              <td>{a.icon} {a.text}</td>
              <td><span className="hint">{describe(r)}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function SettingsTab() {
  const [section, setSection] = useState('kommo-barrier');
  const [rules, setRules] = useState(null);
  const [me, setMe] = useState(null);
  const [audit, setAudit] = useState({ rows: [], actors: [] });
  const [kommoLog, setKommoLog] = useState([]);
  const [users, setUsers] = useState([]);
  const [actor, setActor] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ login: '', password: '', name: '', email: '' });
  const [saving, setSaving] = useState(false);
  const [crm, setCrm] = useState(null);
  const [syncing, setSyncing] = useState(false);
  // Сам стоп-лист (вопрос Ольги 13.08): он должен быть видимым и проверяемым людьми,
  // а не чёрным ящиком, который молча решает, кому нельзя писать.
  const [list, setList] = useState(null);
  const [stages, setStages] = useState(null);   // разбивка по этапам + снятые этапы
  const [q, setQ] = useState('');
  const [pipeline, setPipeline] = useState('');
  const [stage, setStage] = useState('');
  const [page, setPage] = useState(0);
  const [bulk, setBulk] = useState(false);
  const [notesFilter, setNotesFilter] = useState('');   // '' | yes | no
  // Фильтр «чьи карточки» (L5.10): стоп-лист разбирают Стас и Шикхар, каждый — своё.
  const [owner, setOwner] = useState('');
  const [gaps, setGaps] = useState(null);
  const [gapBusy, setGapBusy] = useState(false);
  // Инструкция для Стаса и Шикхара: развёрнута по умолчанию, состояние живёт в браузере.
  const [guideOpen, setGuideOpen] = useState(() => {
    try { return localStorage.getItem('stoplistGuideOpen') !== 'no'; } catch { return true; }
  });
  // Раздел «LinkedIn — channel» (L5.4 + L5.6): конфиг канала GetSales, редактируемые потолки
  // и окно принятия, метрика поздних принятий.
  const [gsCfg, setGsCfg] = useState(null);
  const [gsLimits, setGsLimits] = useState({});
  const [gsFlows, setGsFlows] = useState({});   // профиль → флоу-лестница (редактируемая карта)
  const [gsWindow, setGsWindow] = useState('');
  const [gsSaving, setGsSaving] = useState(false);

  async function loadGsCfg() {
    try {
      const r = await fetch('/api/getsales/config');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      setGsCfg(d); setGsLimits(d.limits || {}); setGsFlows(d.senderFlows || {}); setGsWindow(String(d.acceptWindowDays || 21));
    } catch (e) { setError(String(e.message || e)); setGsCfg({ enabled: false, profiles: [], flows: [], senderFlows: {} }); }
  }
  useEffect(() => { if (section === 'linkedin-channel' && !gsCfg) loadGsCfg(); }, [section]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLimit = (uuid, field, v) => setGsLimits((prev) => ({
    ...prev, [uuid]: { ...(prev[uuid] || {}), [field]: v === '' ? undefined : Number(v) },
  }));

  // Раздел «Smartlead — email channel»: правила из констант кода + живые ящики. Read-only:
  // пороги меняются правкой кода, а не крутилкой — здесь они показаны, чтобы не разъезжаться.
  const [emailCh, setEmailCh] = useState(null);
  async function loadEmailCh() {
    try {
      const [rl, ac] = await Promise.all([
        fetch('/api/email-channel/rules').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/smartlead/email-accounts').then((r) => (r.ok ? r.json() : [])),
      ]);
      setEmailCh({ rules: rl, accounts: Array.isArray(ac) ? ac : [] });
    } catch (e) { setError(String(e.message || e)); setEmailCh({ rules: null, accounts: [] }); }
  }
  useEffect(() => { if ((section === 'email-channel' || section === 'how-it-works') && !emailCh) loadEmailCh(); }, [section]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveGsCfg() {
    setGsSaving(true); setError('');
    try {
      // Пустые значения не шлём: null в карте затирал бы профиль при мердже.
      const flows = Object.fromEntries(Object.entries(gsFlows).filter(([, v]) => v));
      const r = await fetch('/api/getsales/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderFlows: flows, limits: gsLimits, acceptWindowDays: Number(gsWindow) || 21 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      await loadGsCfg();
    } catch (e) { setError(String(e.message || e)); } finally { setGsSaving(false); }
  }
  const listRef = React.useRef(null);
  const [manualForm, setManualForm] = useState({ subject: '', reason: '' });

  // Номер последнего запроса: быстрые клики по этапам запускают несколько загрузок сразу,
  // и без этой отметки поздно пришедший СТАРЫЙ ответ перекрывал новый — фильтры показывали
  // одно, а список другое (поймано Ольгой 14.08 на клике «42 to review»).
  const listReq = React.useRef(0);
  async function loadList(query = q, pipe = pipeline, st = stage, pg = 0, nt = notesFilter, ow = owner) {
    const seq = ++listReq.current;
    try {
      const [r, sr] = await Promise.all([
        fetch(`/api/crm/blocklist?q=${encodeURIComponent(query)}&pipeline=${encodeURIComponent(pipe)}&stage=${encodeURIComponent(st)}&notes=${nt}&owner=${encodeURIComponent(ow)}&limit=${PAGE}&offset=${pg * PAGE}`),
        fetch('/api/crm/stages'),
      ]);
      const [rd, srd] = [r.ok ? await r.json() : null, sr.ok ? await sr.json() : null];
      if (seq !== listReq.current) return; // за время ответа кликнули ещё раз — этот ответ устарел
      setList(rd);
      setStages(srd);
      setPage(pg);
    } catch { if (seq === listReq.current) setList(null); }
  }

  // Показать список по конкретному этапу — кликом по строке таблицы этапов.
  // Прокручиваем к списку: иначе непонятно, что вообще что-то произошло — таблица
  // этапов длинная, и обновившийся список остаётся за пределами экрана.
  function showStage(pipelineName, stageName, nt = '', ow = '') {
    setPipeline(pipelineName); setStage(stageName); setQ(''); setNotesFilter(nt); setOwner(ow);
    loadList('', pipelineName, stageName, 0, nt, ow);
    setTimeout(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  }

  // Снять со стоп-листа всех, кто сейчас в фильтре. Отличается от «release this stage»:
  // правило этапа переживёт синхронизацию и подхватит новых людей, а это — разовое решение
  // по конкретным людям, которые видны на экране (просьба Ольги 13.08).
  // «✓ My part is reviewed»: владелец отмечает, что разобрал свою часть стоп-листа.
  // Отметка видна всем (гейт запуска боевых волн) и переснимается повторным нажатием.
  async function approveReview() {
    if (!owner || owner === '—') return;
    if (!window.confirm(`Mark the stop list part of «${owner}» as fully reviewed?\n\nThis tells the team cold outreach can launch without touching warm contacts. Recorded with your name; pressing again later just refreshes the date.`)) return;
    try {
      const r = await fetch('/api/crm/review-approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      await loadList(q, pipeline, stage, page, notesFilter, owner);
    } catch (e) { setError(String(e.message || e)); }
  }

  async function releaseFiltered() {
    const n = list?.total ?? 0;
    if (!n) return;
    const what = stage ? `stage «${stage}»` : pipeline ? `funnel «${pipeline}»` : 'the current filter';
    const scope = notesFilter === 'no' ? ' (cards with no correspondence only)'
      : notesFilter === 'yes' ? ' (cards WITH correspondence — are you sure?)' : '';
    const reason = window.prompt(
      `Remove all ${n} people in ${what}${scope} from the stop list?\n\n`
      + 'This is a one-off decision about these specific people. New people arriving at the same stage '
      + 'will be blocked again — use «release this stage» if the stage itself should stop blocking.\n\n'
      + 'Reason (recorded with your name, revocable):',
    );
    if (!reason || !reason.trim()) return;
    setBulk(true); setError('');
    try {
      const r = await fetch('/api/crm/override/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipeline, stage, q, notes: notesFilter || null, owner: owner || null, action: 'allow', reason }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      await Promise.all([loadList(q, pipeline, stage, 0), load()]);
    } catch (e) { setError(String(e.message || e)); } finally { setBulk(false); }
  }

  // «Снять молчаливых» одной кнопкой (идея Ольги 13.08 — «две строки»): убирает из
  // стоп-листа людей этапа, с которыми НИКТО НЕ ПЕРЕПИСЫВАЛСЯ, оставляя карточки
  // с перепиской на ручной разбор. Ручные подтверждения (📌) это снятие переживают.
  async function releaseSilent(st) {
    const silent = Number(st.n) - Number(st.with_notes);
    if (!silent) return;
    const reason = window.prompt(
      `Release ${silent} silent people from «${st.stage_name}» (${st.pipeline_name}${st.owner && st.owner !== '—' ? ` · ${st.owner}` : ''})?\n\n`
      + 'Silent = nobody ever wrote in their card. The ' + st.with_notes + ' with correspondence stay blocked for manual review.\n\n'
      + 'Reason (recorded with your name, revocable):',
    );
    if (!reason || !reason.trim()) return;
    setBulk(true); setError('');
    try {
      const r = await fetch('/api/crm/override/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipeline: st.pipeline_name, stage: st.stage_name, notes: 'no', owner: st.owner || null, action: 'allow', reason }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      await Promise.all([loadList(), load()]);
    } catch (e) { setError(String(e.message || e)); } finally { setBulk(false); }
  }

  // Снять или вернуть ЦЕЛЫЙ этап. Правило живёт отдельно от списка адресов, поэтому
  // переживает синхронизацию и остаётся верным, когда состав этапа сменится.
  async function stageRule(pipelineName, stageName, ruleId) {
    if (ruleId) {
      await fetch(`/api/crm/stage-rule/${ruleId}/revoke`, { method: 'POST' });
      await loadList();
      return;
    }
    const reason = window.prompt(`Release the whole stage «${stageName}» (${pipelineName}) from the stop list?\n\nThese people will become available for cold outreach. The reason is recorded with your name and can be revoked at any time.`);
    if (!reason || !reason.trim()) return;
    try {
      const r = await fetch('/api/crm/stage-rule', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineName, stageName, reason }),
      });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      await Promise.all([loadList(), load()]);
    } catch (e) { setError(String(e.message || e)); }
  }

  async function override(subject, action, kind = 'email') {
    const reason = window.prompt(
      action === 'allow'
        ? `Why should ${subject} be removed from the stop list? The reason is recorded with your name.`
        : `Why should ${subject} be added to the stop list? The reason is recorded with your name.`,
    );
    if (!reason || !reason.trim()) return;   // без причины не пишем: правка без объяснения бесполезна
    try {
      const r = await fetch('/api/crm/override', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, kind, action, reason }),
      });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      await Promise.all([loadList(), load()]);
    } catch (e) { setError(String(e.message || e)); }
  }

  async function revoke(id) {
    await fetch(`/api/crm/override/${id}/revoke`, { method: 'POST' });
    await Promise.all([loadList(), load()]);
  }

  // Живой обход Kommo (около минуты), поэтому по кнопке, а не при каждом открытии вкладки.
  async function loadGaps() {
    if (gaps) { setGaps(null); return; }
    setGapBusy(true); setError('');
    try {
      const r = await fetch('/api/crm/unprotected');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      setGaps(Array.isArray(d) ? d : []);
    } catch (e) { setError(String(e.message || e)); } finally { setGapBusy(false); }
  }

  async function syncCrm() {
    setSyncing(true); setError('');
    try {
      const r = await fetch('/api/crm/sync', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      await load();
    } catch (e) { setError(String(e.message || e)); } finally { setSyncing(false); }
  }

  async function load() {
    try {
      const params = new URLSearchParams({ humansOnly: '1' });
      if (actor) params.set('actor', actor);
      const [m, a, k, u, c, rl] = await Promise.all([
        fetch('/api/me').then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/audit?${params}`).then((r) => (r.ok ? r.json() : { rows: [], actors: [] })),
        // Журнал Kommo — своя выборка: сюда попадает и то, что сделала автоматика,
        // потому что вопрос здесь «что произошло с CRM», а не «кто из людей что нажал».
        fetch('/api/audit?actions=kommo.,crm.&limit=300').then((r) => (r.ok ? r.json() : { rows: [] })),
        fetch('/api/users').then((r) => (r.ok ? r.json() : [])),
        fetch('/api/crm/state').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/kommo/rules').then((r) => (r.ok ? r.json() : null)),
      ]);
      setMe(m); setAudit(a); setKommoLog(k.rows || []); setUsers(Array.isArray(u) ? u : []); setCrm(c); setRules(rl);
      setError('');
    } catch (e) { setError(String(e.message || e)); }
  }
  useEffect(() => { load(); }, [actor]); // eslint-disable-line react-hooks/exhaustive-deps
  // Стоп-лист подгружаем сразу при входе в раздел: прятать его за кнопкой больше незачем,
  // раздел теперь открывают именно ради него.
  useEffect(() => { if (section === 'kommo-barrier' && !list) loadList(); }, [section]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addUser(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const r = await fetch('/api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.status);
      setForm({ login: '', password: '', name: '', email: '' });
      await load();
    } catch (e) { setError(String(e.message || e)); } finally { setSaving(false); }
  }

  async function toggleUser(u) {
    await fetch(`/api/users/${u.id}/active`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !u.active }),
    });
    load();
  }

  const groups = [...new Set(SECTIONS.map((s) => s.group))];

  return (
    <div className="contacts-tab">
      <div className="results-head">
        <h2>Settings</h2>
        {me && <span className="segment-width">signed in as <b>{me.name || me.login}</b></span>}
      </div>
      {error && <div className="error">{error}</div>}

      <div className="settings-shell">
        <aside className="settings-nav">
          <div className="settings-nav-title">Settings</div>
          {groups.map((g) => (
            <div key={g}>
              <div className="settings-group">{g}</div>
              {SECTIONS.filter((s) => s.group === g).map((s) => (
                <button
                  key={s.id}
                  className={`settings-link ${section === s.id ? 'active' : ''}`}
                  onClick={() => setSection(s.id)}
                >
                  <span className="si">{s.icon}</span>{s.label}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <div className="settings-body">
          <div className="settings-head">
            <h3>{HEAD[section].title}</h3>
            <p>{HEAD[section].sub}</p>
          </div>

          {/* ---------------- Правила: триггер → что в Kommo → поля ---------------- */}
          {section === 'kommo-rules' && (
            <div className="reply-card">
              <div className="reply-summary">
                This page is built from the integration code itself, not written by hand — a copied table
                starts lying within a month, and a lying table is worse than none. We write only to
                <b> {rules?.pipeline?.name || 'Sales funnel'}</b>; the other funnels we only read.
              </div>
              {!rules ? <p className="hint">loading…</p> : (
                <>
                  <table>
                    <thead><tr><th style={{ width: '22%' }}>Trigger in the app</th><th style={{ width: '40%' }}>What happens in Kommo</th><th>Fields we fill</th></tr></thead>
                    <tbody>
                      {rules.triggers.map((t) => (
                        <tr key={t.trigger}>
                          <td><b>{t.trigger}</b></td>
                          <td>
                            {t.action}
                            {t.stage !== '—' && <div className="hint" style={{ marginTop: 4 }}>Stage: {t.stage}</div>}
                          </td>
                          <td>
                            {t.fields.length
                              ? <span className="hint">{t.fields.join(' · ')}</span>
                              : <span className="hint">— (only the stage and a note)</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="reply-head" style={{ marginTop: 16 }}><b>Always true</b></div>
                  <ul className="hint" style={{ marginTop: 6, lineHeight: 1.7 }}>
                    {rules.always.map((x) => <li key={x}>{x}</li>)}
                  </ul>

                  <div className="reply-head" style={{ marginTop: 12 }}><b>What we deliberately do not fill</b></div>
                  <ul className="hint" style={{ marginTop: 6, lineHeight: 1.7 }}>
                    {rules.notFilled.map((x) => <li key={x}>{x}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}

          {/* ---------------- Барьер Kommo (ТЗ п.28) ---------------- */}
          {section === 'kommo-barrier' && (crm ? (
            <div className="reply-card">
              <div className="reply-head">
                <b>State</b>
                {crm.enabled
                  ? <span className="reply-badge" style={{ background: crm.stale ? '#fffbeb' : '#f0fdf4', color: crm.stale ? '#b45309' : '#15803d' }}>
                      {crm.last_ok_at ? `synced ${crm.age_hours}h ago` : 'never synced'}
                    </span>
                  : <span className="reply-badge" style={{ background: '#fef2f2', color: '#b91c1c' }}>Kommo token missing</span>}
              </div>
              <div className="reply-summary">
                People already in the CRM cannot be picked in search at all — not «picked but dropped later».
                Blocked by address at every stage from «Initial contact» on; by company domain only from the
                meeting stage on, because a cold email to a colleague of someone signing a contract reads the
                same way. Nightly sync; a barrier on stale data gives a false sense of protection.
                <div style={{ marginTop: 6 }}>
                  {/* Показываем ФАКТИЧЕСКОЕ число блокировок, а не размер выгрузки: после правил
                      этапа и правила давности блокирует заметно меньше, и это надо видеть. */}
                  {crm.counts ? (
                    <>
                      <b>{crm.counts.effective_emails}</b> addresses blocking now
                      {' · '}<b>{crm.counts.effective_domains}</b> warm domains
                      {/* LinkedIn-ось барьера (L5.7): без счётчика казалось, что барьер знает
                          только адреса — а он блокирует и по профилю. */}
                      {' · '}<b>{crm.counts.effective_slugs ?? 0}</b> LinkedIn profiles
                      <div className="hint" style={{ marginTop: 4 }}>
                        out of {crm.counts.total_emails} in the CRM export ·
                        {' '}{crm.counts.released_by_age} released by age (older than {crm.counts.stale_months} months, warm stages never expire) ·
                        {' '}{crm.counts.released_by_stage} released by a stage rule ·
                        {' '}{crm.counts.released_by_hand ?? 0} released by hand
                      </div>
                    </>
                  ) : (
                    <><b>{crm.emails ?? 0}</b> addresses · <b>{crm.domains ?? 0}</b> warm domains</>
                  )}
                  {crm.last_error ? <span style={{ color: '#b91c1c' }}> · last error: {crm.last_error}</span> : ''}
                </div>
              </div>
              <div className="shortlist-actions">
                <button className="btn-small" disabled={syncing || !crm.enabled} onClick={syncCrm}>
                  {syncing ? 'Syncing… (takes about a minute)' : '↻ Sync now'}
                </button>
                <button className="btn-small" disabled={gapBusy} onClick={loadGaps}>
                  {gapBusy ? 'Checking…' : '⚠ Who the barrier cannot protect'}
                </button>
              </div>

              {/* Тёплые карточки без единого адреса — барьер их не видит. Автоматически закрыть
                  нечем: домен взять неоткуда, поэтому показываем список человеку. */}
              {gaps && (
                <div style={{ marginTop: 12 }}>
                  <div className="reply-head">
                    <b>Warm cards with no address at all</b>
                    <span className="reply-badge" style={{ background: '#fffbeb', color: '#b45309' }}>{gaps.length} cards</span>
                  </div>
                  <div className="reply-summary">
                    The stop list is built from email addresses. A card at the meeting stage or beyond whose
                    contacts have no address produces no block at all — neither by address nor by domain — so
                    a colleague of that person can still receive a cold email. Nothing to fix automatically:
                    there is no domain to take. Add an address to the contact in Kommo, or add the company
                    domain to the stop list by hand below.
                  </div>
                  {gaps.length === 0 ? <p className="hint">Nothing — every warm card has at least one address.</p> : (
                    <table>
                      <thead><tr><th>Company</th><th>Funnel</th><th>Stage</th><th>Contacts on the card</th></tr></thead>
                      <tbody>
                        {gaps.map((g) => (
                          <tr key={g.leadId}>
                            <td><b>{g.name}</b></td>
                            <td>{g.pipeline}</td>
                            <td>{g.stage}</td>
                            <td>{g.contacts === 0 ? <span className="hint">none</span> : `${g.contacts}, none with an address`}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Инструкция для разбора (просьба Ольги 14.08): живёт прямо на странице, потому что
                  Стас и Шикхар придут сюда без контекста наших обсуждений. Сворачивается, и выбор
                  запоминается в браузере — Ольге, которая видела её сто раз, не мешает. */}
              <details
                open={guideOpen}
                onToggle={(e) => { setGuideOpen(e.target.open); try { localStorage.setItem('stoplistGuideOpen', e.target.open ? 'yes' : 'no'); } catch { /* приватный режим */ } }}
                style={{ marginTop: 14, border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', background: '#fafaf9' }}
              >
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>📖 How to review the stop list — guide for Stan and Shikhar</summary>
                <div className="reply-summary" style={{ marginTop: 8 }}>
                  <p><b>Why this is worth an hour of your time.</b> Every card in Kommo currently blocks cold
                  outreach to that person — and from the meeting stage on, to their whole company. That is the
                  right default, but our funnels hold thousands of stale cards nobody ever wrote to. Until they
                  are released, the outreach system treats all those people as «warm» and will never contact
                  them. The goal: keep blocked only the people someone really talked to — release the rest.</p>
                  <p><b>How — work the table below, row by row, only rows with your name in Owner:</b></p>
                  <ol style={{ margin: '4px 0 8px 18px', padding: 0 }}>
                    <li><b>release N silent</b> — one click removes everyone with zero correspondence in that
                      stage. Nobody ever wrote to them, so there is nothing to protect. You will be asked for
                      a short reason; it is recorded with your name and can be undone.</li>
                    <li><b>N to review</b> — opens the people WITH correspondence in the list below. Go through
                      them one by one:
                      <ul style={{ margin: '2px 0 2px 18px', padding: 0 }}>
                        <li><b>📌 keep</b> — you really talked to this person, cold email would be embarrassing.
                          Keeps them blocked forever (survives syncs, age, everything).</li>
                        <li><b>remove from list</b> — the correspondence was noise, fine to contact them cold.</li>
                        <li><b>block domain</b> — the whole company is warm, block every address at their domain.</li>
                      </ul>
                    </li>
                    <li>Rows marked <b>⏳ expired</b> stopped blocking on their own (no activity for 3+ months) —
                      touch them only if they should stay blocked: press 📌 keep.</li>
                    <li><b>When you are done</b> — every stage row with your name shows 0 to review — select
                      yourself in the owner filter of the list below and press <b>✓ My part is reviewed</b>.
                      The mark (your name + date) appears next to the stage table and tells the team cold
                      outreach can launch without touching your warm contacts.</li>
                  </ol>
                  <p>«✍ name» under Owner shows who actually wrote the notes in the card — trust it more than
                  Owner itself: owners were mass-reassigned on 02.07. New cards that appear later are your live
                  deals — they block by default and need no cleanup.</p>
                </div>
              </details>

              {/* Этапы идут ПЕРВЫМИ (перестановка 13.08). Раньше эта таблица стояла под списком
                  из сотни адресов, то есть кнопка «release this stage» существовала, но найти её
                  можно было только долгой прокруткой — Ольга её и не нашла. Решение про этап
                  принимают ДО того, как копаться в адресах, значит и стоять оно должно раньше. */}
              {stages?.stages?.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div className="reply-head">
                    <b>By stage — release or block a whole stage at once</b>
                    {/* Отметки «часть разобрана»: видят все — это гейт запуска боевых волн. */}
                    {Object.entries(stages.approvals || {}).map(([ow, a]) => (
                      <span key={ow} className="reply-badge" style={{ background: '#ecfdf5', color: '#047857', marginLeft: 8 }}
                        title={`Confirmed by ${a.actor}`}>
                        ✓ {ow} reviewed · {new Date(a.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </span>
                    ))}
                  </div>
                  <div className="reply-summary">
                    A stage is a judgement about a process, not about a person: if «IN process» in an abandoned
                    funnel never meant a real contact, release the whole stage rather than picking addresses out
                    of it one by one. The rule lives separately from the address list, so it survives the nightly
                    sync and still holds when the stage fills with different people.
                  </div>
                  <table>
                    <thead><tr><th>Funnel</th><th>Stage</th><th>Owner</th><th>People</th><th>Correspondence</th><th>Status</th><th></th><th></th></tr></thead>
                    <tbody>
                      {stages.stages.map((st) => {
                        const active = pipeline === st.pipeline_name && stage === st.stage_name;
                        return (
                          <tr
                            key={`${st.pipeline_name}/${st.stage_name}/${st.owner}`}
                            // Вся строка кликабельна (просьба Ольги 13.08): смотреть, кто именно
                            // стоит за числом, хочется до решения, и кликать в маленькую кнопку
                            // ради этого не должно быть обязательным.
                            onClick={() => showStage(st.pipeline_name, st.stage_name, '', st.owner)}
                            style={{
                              cursor: 'pointer',
                              opacity: st.allow_rule_id ? 0.55 : 1,
                              background: active ? '#eef2ff' : undefined,
                            }}
                          >
                            <td>{st.pipeline_name}</td>
                            <td><b>{st.stage_name}</b></td>
                            {/* Владелец (L5.10): Стас и Шикхар разбирают каждый своё — «я свои
                                контакты знаю и легко отмечу, а контакты Шикхара я не знаю». */}
                            <td>{st.owner === '—' ? <span className="hint">—</span> : st.owner}</td>
                            <td>{st.n}{Number(st.domains) > 0 ? <span className="hint"> · {st.domains} with domain</span> : ''}</td>
                            {/* Разрез, ради которого всё затевалось: сколько людей стоит за
                                карточками, где ВООБЩЕ была переписка. Остальные — импорт,
                                с которым никто не говорил, и их можно снимать смело. */}
                            <td>
                              {Number(st.with_notes) > 0 ? (
                                <>
                                  <button
                                    className="btn-small"
                                    onClick={(e) => { e.stopPropagation(); showStage(st.pipeline_name, st.stage_name, 'yes', st.owner); }}
                                  >
                                    {st.with_notes} to review
                                  </button>
                                  <div className="hint" style={{ marginTop: 3 }}>
                                    from {st.cards_with_notes} card{Number(st.cards_with_notes) === 1 ? '' : 's'}
                                    {' · '}{st.n - st.with_notes} silent
                                  </div>
                                </>
                              ) : <span className="hint">none — nobody was ever written to</span>}
                            </td>
                            <td>
                              {st.allow_rule_id
                                ? <span className="hint">🔓 released by {st.allow_actor}: {st.allow_reason}</span>
                                : <span className="reply-badge" style={{ background: '#fef2f2', color: '#b91c1c' }}>blocking</span>}
                            </td>
                            <td>
                              <button className="btn-small" onClick={(e) => { e.stopPropagation(); showStage(st.pipeline_name, st.stage_name, '', st.owner); }}>
                                show these {st.n}
                              </button>
                              {Number(st.n) - Number(st.with_notes) > 0 && (
                                <button
                                  className="btn-small" style={{ marginLeft: 6 }} disabled={bulk}
                                  title="Release the people nobody ever wrote to; cards with correspondence stay for manual review. Pinned (📌) entries survive."
                                  onClick={(e) => { e.stopPropagation(); releaseSilent(st); }}
                                >
                                  🔓 release {Number(st.n) - Number(st.with_notes)} silent
                                </button>
                              )}
                            </td>
                            <td>
                              {/* stopPropagation: клик по кнопке не должен ещё и перерисовывать список. */}
                              <button className="btn-small" onClick={(e) => { e.stopPropagation(); stageRule(st.pipeline_name, st.stage_name, st.allow_rule_id); }}>
                                {st.allow_rule_id ? 'block again' : 'release this stage'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Сам список: видимый, с поиском и правками. Без этого барьер — чёрный ящик. */}
              {list && (
                <div style={{ marginTop: 18 }} ref={listRef}>
                  <div className="reply-head"><b>The list</b></div>
                  <form
                    className="contacts-filters"
                    onSubmit={(e) => { e.preventDefault(); loadList(); }}
                  >
                    <input placeholder="search by name, company, address or domain…" value={q} onChange={(e) => setQ(e.target.value)} />
                    <select
                      value={pipeline}
                      onChange={(e) => { setPipeline(e.target.value); setStage(''); loadList(q, e.target.value, ''); }}
                    >
                      <option value="">All funnels</option>
                      {(list.byPipeline || []).map((p) => (
                        <option key={p.pipeline_name} value={p.pipeline_name}>{p.pipeline_name} ({p.n})</option>
                      ))}
                    </select>
                    {/* Фильтр по этапу (просьба Ольги 13.08). Список этапов сужается выбранной
                        воронкой: названия этапов в двух воронках разные, и общий список путал бы. */}
                    <select value={stage} onChange={(e) => { setStage(e.target.value); loadList(q, pipeline, e.target.value); }}>
                      <option value="">All stages</option>
                      {/* Схлопываем владельцев: после разреза L5.10 у этапа несколько строк
                          (по одной на владельца), а фильтр здесь — по этапу целиком. */}
                      {Object.values((stages?.stages || [])
                        .filter((st) => !pipeline || st.pipeline_name === pipeline)
                        .reduce((acc, st) => {
                          const k = `${st.pipeline_name}/${st.stage_name}`;
                          acc[k] = acc[k]
                            ? { ...acc[k], n: Number(acc[k].n) + Number(st.n) }
                            : { ...st, n: Number(st.n) };
                          return acc;
                        }, {}))
                        .map((st) => (
                          <option key={`${st.pipeline_name}/${st.stage_name}`} value={st.stage_name}>
                            {st.stage_name} ({st.n}){pipeline ? '' : ` · ${st.pipeline_name}`}
                          </option>
                        ))}
                    </select>
                    {/* Разрез «была ли переписка» — тот же, что в таблице этапов. */}
                    <select value={notesFilter} onChange={(e) => { setNotesFilter(e.target.value); loadList(q, pipeline, stage, 0, e.target.value); }}>
                      <option value="">Any card</option>
                      <option value="yes">With correspondence</option>
                      <option value="no">Silent — never written to</option>
                    </select>
                    <select value={owner} onChange={(e) => { setOwner(e.target.value); loadList(q, pipeline, stage, 0, notesFilter, e.target.value); }}>
                      <option value="">Any owner</option>
                      {[...new Set((stages?.stages || []).map((s) => s.owner).filter(Boolean))].map((o) => (
                        <option key={o} value={o}>{o === '—' ? 'no owner' : o}</option>
                      ))}
                    </select>
                    <button type="submit" className="cta small">Search</button>
                    {owner && owner !== '—' && (
                      <button
                        type="button" className="btn-small"
                        style={{ background: '#ecfdf5', borderColor: '#a7f3d0', color: '#047857' }}
                        title="Press when every stage row with this name shows 0 to review"
                        onClick={approveReview}
                      >
                        ✓ My part is reviewed
                      </button>
                    )}
                    {(pipeline || stage || q || notesFilter || owner) && (
                      <button type="button" className="btn-small" onClick={() => { setQ(''); setPipeline(''); setStage(''); setNotesFilter(''); setOwner(''); loadList('', '', '', 0, '', ''); }}>
                        reset
                      </button>
                    )}
                    <span className="hint">
                      {list.total} {list.total === 1 ? 'person' : 'people'}
                      {list.total > PAGE ? ` · page ${page + 1} of ${Math.ceil(list.total / PAGE)}` : ` · showing ${list.rows.length}`}
                      {stage ? ` · stage «${stage}»` : ''}
                    </span>
                  </form>

                  <table>
                    <thead><tr><th>Person</th><th>Company</th><th>Address</th><th>Owner</th><th>Correspondence</th><th>Blocked</th><th>Where in Kommo</th><th>Manual override</th><th></th></tr></thead>
                    <tbody>
                      {/* Ключ обязан быть у КАЖДОЙ строки: у LinkedIn-only людей email пустой,
                          и десятки строк без ключа оставляли на экране «призраков» прошлого
                          фильтра — список показывал одно, счётчик другое (скрины Ольги 14.08). */}
                      {list.rows.map((r) => (
                        <tr key={r.email || `li:${r.linkedin_slug}`} style={{ opacity: r.override_action === 'allow' ? 0.5 : 1 }}>
                          <td>{r.contact_name || <span className="hint">—</span>}</td>
                          <td>{r.company || <span className="hint">—</span>}</td>
                          <td>{r.email}</td>
                          <td>
                            {r.owner || <span className="hint">—</span>}
                            {r.worked_by && r.worked_by !== r.owner && (
                              <div className="hint" title="Who actually wrote notes in the card — survives the mass reassignment of 02.07">✍ {r.worked_by}</div>
                            )}
                          </td>
                          <td>
                            {Number(r.note_count) > 0
                              ? <span className="reply-badge" style={{ background: '#fffbeb', color: '#b45309' }}>{r.note_count} notes</span>
                              : <span className="hint">silent</span>}
                          </td>
                          {/* Показываем по ФАКТУ блокировки домена, а не по уровню контакта: у бесплатной
                              почты уровень «domain», но gmail.com целиком мы, конечно, не блокируем. */}
                          <td>{r.domain ? <>address + <span title={r.domain}>domain</span></> : 'address'}</td>
                          <td>
                            <span className="hint">{r.places || `${r.stage_name} · ${r.pipeline_name}`}</span>
                            {Number(r.cards) > 1 && <span className="hint"> · {r.cards} cards in Kommo</span>}
                          </td>
                          <td>
                            {r.override_action === 'allow'
                              ? <span className="hint">🔓 unblocked by {r.override_actor}: {r.override_reason}</span>
                              : r.released_by_age
                                ? <span className="hint" title={r.last_activity_at ? `last activity ${String(r.last_activity_at).slice(0, 10)}` : ''}>
                                    ⏳ expired — no activity for over 3 months
                                  </span>
                                : '—'}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {r.override_action === 'allow'
                              ? <span className="hint">active</span>
                              : r.override_action === 'block'
                                ? <span className="hint">📌 kept</span>
                                : (
                                  <>
                                    <button className="btn-small" onClick={() => override(r.email, 'allow')}>remove from list</button>
                                    {/* «Ручное подтверждение» (Ольга 13.08): приколоть запись булавкой —
                                        она переживёт release этапа, «release silent», давность и синхронизацию. */}
                                    <button
                                      className="btn-small" style={{ marginLeft: 6 }}
                                      title="Pin this entry: it stays in the stop list even if the stage is released or the block expires by age"
                                      onClick={() => override(r.email, 'block')}
                                    >
                                      📌 keep
                                    </button>
                                  </>
                                )}
                            {/* Блокировка ЦЕЛОГО домена. Нужна там, где карточка тёплая, но защиты
                                нет: у Blackstone контакт на «Commitment discussion» без адреса,
                                и закрыть компанию можно только доменом (разбор 13.08).
                                Бесплатные почты не предлагаем — блокировать gmail целиком абсурдно. */}
                            {!r.domain && !FREE_MAIL.test(String(r.email).split('@')[1] || '') && (
                              <button
                                className="btn-small" style={{ marginLeft: 6 }}
                                title={`Block the whole ${String(r.email).split('@')[1]} domain`}
                                onClick={() => override(String(r.email).split('@')[1], 'block', 'domain')}
                              >
                                🔒 block domain
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Страницы: раньше показывались первые 100 и всё — «а что дальше» ответа
                      не было (просьба Ольги 13.08). */}
                  <div className="shortlist-actions" style={{ marginTop: 8, alignItems: 'center' }}>
                    <button
                      className="btn-small" disabled={page === 0}
                      onClick={() => loadList(q, pipeline, stage, page - 1)}
                    >
                      ← previous
                    </button>
                    <span className="hint">
                      {list.total
                        ? `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, list.total)} of ${list.total}`
                        : 'nothing here'}
                    </span>
                    <button
                      className="btn-small" disabled={(page + 1) * PAGE >= list.total}
                      onClick={() => loadList(q, pipeline, stage, page + 1)}
                    >
                      next →
                    </button>
                    {/* Массовое снятие по текущему фильтру. Кнопка появляется только когда
                        фильтр задан: «снять всех вообще» — не то решение, которое стоит
                        предлагать одним кликом. */}
                    {(stage || pipeline || q) && list.total > 0 && (
                      <button className="btn-small" disabled={bulk} onClick={releaseFiltered} style={{ marginLeft: 'auto' }}>
                        {bulk ? 'removing…' : `🔓 remove all ${list.total} from the stop list`}
                      </button>
                    )}
                  </div>

                  <div className="reply-head" style={{ marginTop: 16 }}><b>Added by hand</b></div>
                  <div className="reply-summary">
                    For people you are talking to outside the CRM. The reverse direction of the same barrier:
                    a lead can also be sent here from the Contacts tab.
                  </div>
                  {list.manual.length > 0 && (
                    <table>
                      <thead><tr><th>Subject</th><th>Action</th><th>Reason</th><th>Who</th><th>When</th><th></th></tr></thead>
                      <tbody>
                        {list.manual.map((m) => (
                          <tr key={m.subject}>
                            <td>{m.subject}</td>
                            <td>{m.action === 'block' ? '🔒 blocked' : '🔓 unblocked'}</td>
                            <td>{m.reason}</td>
                            <td>{m.actor}</td>
                            <td>{fmt(m.created_at)}</td>
                            <td><button className="btn-small" onClick={() => revoke(m.id)}>revoke</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <form
                    className="contacts-filters" style={{ marginTop: 8 }}
                    onSubmit={(e) => { e.preventDefault(); if (manualForm.subject) { override(manualForm.subject, 'block'); setManualForm({ subject: '', reason: '' }); } }}
                  >
                    <input
                      placeholder="email or domain to block" value={manualForm.subject}
                      onChange={(e) => setManualForm({ ...manualForm, subject: e.target.value })}
                    />
                    <button type="submit" className="cta small">Add to the stop list</button>
                  </form>
                </div>
              )}
            </div>
          ) : <p className="hint">Kommo is not configured — nothing to show.</p>)}

          {/* ---------------- Журнал Kommo ---------------- */}
          {section === 'kommo-log' && (
            <div className="reply-card">
              <div className="reply-summary">
                Two kinds of entry live here. <b>Leads going out:</b> when a batch was launched, how many cards
                were created, how many matched an existing card instead of making a duplicate, and how many
                stayed where they were because they had already moved further. <b>Stop list refreshes:</b> the
                nightly run and every manual one. «Automatic» means nobody pressed anything — the nightly
                schedule or a Smartlead event did it.
              </div>
              {kommoLog.length === 0
                ? <p className="hint">Nothing yet — the log fills up as leads move.</p>
                : <AuditRows rows={kommoLog} withType />}
            </div>
          )}

          {/* ---------------- LinkedIn-канал (L5.4 + L5.6) ---------------- */}
          {section === 'linkedin-channel' && (
            <div>
              {!gsCfg && <p className="hint">Loading channel config…</p>}
              {gsCfg && !gsCfg.enabled && <p className="hint">GetSales is not configured on the server (GETSALES_API_TOKEN) — the channel is off.</p>}
              {gsCfg?.enabled && (
                <>
                  {/* «Как устроено» рендерится из живого конфига и правил кода — принцип п.43:
                      документация, которая не может разъехаться с реальностью. */}
                  <div className="reply-head"><b>The ladder — what one lead experiences</b></div>
                  <div className="reply-summary">
                    <ol style={{ margin: '4px 0 8px 18px', padding: 0 }}>
                      <li>👍 <b>Like</b> on a recent post — a warm-up signal, no message.</li>
                      <li>⏱ <b>+4 hours: connection request</b>, deliberately without a note — texts begin
                        only after the person lets us in.</li>
                      <li>⏳ <b>Acceptance window: {gsCfg.acceptWindowDays} days</b> (parameter below).
                        No accept by then → the invite is withdrawn, outcome <i>no_accept</i>,
                        3-month channel quarantine.</li>
                      <li>💬 <b>Accepted → message #1</b> from the angle&apos;s LinkedIn form — sent by the SAME
                        profile that sent the invite, only Mon–Fri 9:00–18:00 New York time, under the
                        daily message ceiling. No InMail is ever used — we only write to connections.</li>
                      <li>⏳ <b>+3–4 days: follow-up</b> (the only place {'{{unique_detail_short}}'} is allowed).</li>
                      <li>↩ <b>Reply → Inbox</b> + Telegram ping, and the email cell of the same wave pauses
                        for that person (cross-stop). Silence for 7 days after the follow-up → <i>no_reply</i>,
                        3-month quarantine.</li>
                      <li>🔁 The cross-stop works both ways: an email reply stops LinkedIn touches too.</li>
                    </ol>
                    Templates are deliberately unsigned — the sending profile IS the identity, so one text
                    serves every sender and the experiment compares angles, not personalities.
                  </div>

                  <div className="reply-head" style={{ marginTop: 14 }}><b>Sender profiles — ladders and daily ceilings</b></div>
                  <div className="reply-summary">
                    Ceilings are Settings parameters, not code constants: during ramp-up they change weekly.
                    Empty cell = the default applies.
                  </div>
                  <table>
                    <thead><tr><th>Profile</th><th>Ladder flow</th><th>Invites/day</th><th>Messages/day</th></tr></thead>
                    <tbody>
                      <tr style={{ background: '#fafaf9' }}>
                        <td><i>default (any profile)</i></td>
                        <td className="hint">—</td>
                        <td>
                          <input
                            type="number" min="1" max="100" style={{ width: 70 }}
                            value={gsLimits.default?.invites ?? ''}
                            placeholder="10"
                            onChange={(e) => setLimit('default', 'invites', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="number" min="1" max="200" style={{ width: 70 }}
                            value={gsLimits.default?.messages ?? ''}
                            placeholder="20"
                            onChange={(e) => setLimit('default', 'messages', e.target.value)}
                          />
                        </td>
                      </tr>
                      {(gsCfg.profiles || []).map((p) => {
                        return (
                          <tr key={p.uuid}>
                            <td><b>{p.name}</b></td>
                            <td>
                              {/* Карта «профиль → флоу» редактируется здесь же (просьба Ольги 14.08):
                                  клонировала «Connect» в GetSales — выбрала клона — профиль запускаем. */}
                              <select
                                value={gsFlows[p.uuid] || ''}
                                onChange={(e) => setGsFlows((prev) => ({ ...prev, [p.uuid]: e.target.value }))}
                              >
                                <option value="">— no ladder (not selectable at launch) —</option>
                                {(gsCfg.flows || []).map((f) => (
                                  <option key={f.uuid} value={f.uuid}>{f.name}{f.status ? ` · ${f.status}` : ''}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <input
                                type="number" min="1" max="100" style={{ width: 70 }}
                                value={gsLimits[p.uuid]?.invites ?? ''}
                                placeholder={String(gsLimits.default?.invites ?? 10)}
                                onChange={(e) => setLimit(p.uuid, 'invites', e.target.value)}
                              />
                            </td>
                            <td>
                              <input
                                type="number" min="1" max="200" style={{ width: 70 }}
                                value={gsLimits[p.uuid]?.messages ?? ''}
                                placeholder={String(gsLimits.default?.messages ?? 20)}
                                onChange={(e) => setLimit(p.uuid, 'messages', e.target.value)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <div className="reply-head" style={{ marginTop: 14 }}><b>Acceptance window</b></div>
                  <div className="reply-summary">
                    How long we wait for a connection request to be accepted before withdrawing it.
                    Start at 21 days (decision of 13.08); the metric below is the basis for lowering it to 14 —
                    if accepts later than day 14 stay rare across several campaigns, the extra week catches nothing.
                  </div>
                  {/* Поле сделано НЕредактируемым (решение Ольги 19.08). Проверка показала, что оно
                      ничем не управляет: отзыв заявки выполняет узел «Wait for Connection» внутри
                      лестницы GetSales, а наш параметр использовался только как порог алерта
                      «окно истекло». Редактируемое поле создавало ложное ощущение управления —
                      ровно то, что мы правилом L5.12 и запретили. */}
                  <div className="shortlist-actions" style={{ alignItems: 'center' }}>
                    <span>
                      Window: <b>{gsCfg.acceptWindowDays} days</b>
                      <span className="hint" style={{ marginLeft: 8 }}>
                        set in the GetSales ladder (node «Wait for Connection»), shown here for cross-check —
                        if the numbers disagree, the ladder wins. This page only uses it as the threshold for
                        the «acceptance window expired» state.
                      </span>
                    </span>
                    <span className="hint">
                      {gsCfg.lateAccepts?.accepted
                        ? (
                          <>
                            late accepts (later than 14 days): <b>{gsCfg.lateAccepts.late}</b> of {gsCfg.lateAccepts.accepted}
                            {/* Долю показываем только на статистически осмысленном числе:
                                «0 of 1 (0%)» выглядит как измерение, хотя это шум (L5.12). */}
                            {gsCfg.lateAccepts.accepted >= 10
                              ? <> ({Math.round((gsCfg.lateAccepts.share || 0) * 100)}%)</>
                              : <span className="hint"> — too few observations for a percentage; the share appears from 10 accepts on</span>}
                          </>
                        )
                        : 'late-accept metric: no accepted invites recorded yet — it fills up as campaigns run'}
                    </span>
                  </div>

                  <div className="shortlist-actions" style={{ marginTop: 10 }}>
                    <button className="save-registry" onClick={saveGsCfg} disabled={gsSaving}>
                      {gsSaving ? 'Saving…' : 'Save channel settings'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ---------------- Как это всё работает (L5.6) ---------------- */}
          {section === 'how-it-works' && (
            <div>
              <div className="reply-head"><b>1 · What this system is</b></div>
              <div className="reply-summary">
                <p>It runs <b>cold outreach to the US market in two channels — email and LinkedIn</b> — as
                a series of experiments, not as a mailing tool. Every send belongs to a cell of a matrix:
                <b> who we write to</b> (segment) × <b>what we say</b> (angle) × <b>which channel</b> ×
                <b> who signs it</b> (sender). One wave = one batch of people going through up to two cells,
                one per channel. That is what makes results comparable: when a number moves, we know which
                single thing changed.</p>
                <p><b>The split of labour with GetSales:</b> their automation performs the LinkedIn
                touches — like, connection request, withdrawal, timers. <b>Messages are sent by our code</b>,
                only after the person accepted the request. Texts live here because they are the subject of
                approval and of the experiment; touches are routine mechanics not worth rewriting.</p>
              </div>

              <div className="reply-head" style={{ marginTop: 14 }}><b>2 · What happens to one person</b></div>
              <div className="reply-summary">
                <p><b>Email:</b> step 1 → +3 days step 2 → +4 days step 3 (a polite break-up). A reply
                pauses the sequence for that person. {emailCh?.rules?.replyMaturationDays ?? 7} days after the
                last email the cell closes, everyone touched goes into a 3-month quarantine.</p>
                <p><b>LinkedIn:</b> like a recent post → +4 h connection request without a note → the person
                accepts → our code sends message #1 from the same profile → +3 days follow-up → a reply lands
                in Inbox. No accept within the acceptance window → the invite is withdrawn, 3-month quarantine.</p>
                <p><b>Cross-stop, both ways:</b> a reply in one channel stops touches in the other. Nobody
                gets a cold email while they are already talking to us on LinkedIn.</p>
              </div>

              <div className="reply-head" style={{ marginTop: 14 }}><b>3 · What the system never does</b></div>
              <div className="reply-summary">
                <p>Boundaries matter more than features when you inherit a system:</p>
                <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                  <li><b>Never messages someone who has not accepted the connection request.</b> A cold DM is
                    the fastest way to lose a LinkedIn account; the check lives in our code, not in a setting.</li>
                  <li><b>Never contacts anyone the CRM says is warm.</b> Everyone in Kommo from the first
                    contact stage on is blocked by address, and from the meeting stage on by whole company domain.</li>
                  <li><b>Never sends text nobody approved.</b> Any edit resets the approval.</li>
                  <li><b>Never decides on a reply for you.</b> The classifier proposes, a human decides —
                    and its verdict is labelled «auto» so you can tell them apart.</li>
                  <li><b>Never touches the same person twice in a quarter</b> across channels.</li>
                </ul>
              </div>

              <div className="reply-head" style={{ marginTop: 14 }}><b>4 · What to look at every morning</b></div>
              <div className="reply-summary">
                <ol style={{ margin: '4px 0 0 18px', padding: 0 }}>
                  <li><b>Campaigns → «Needs attention».</b> Empty is the normal state. Anything there is
                    either a person waiting for us or a wave that has stalled.</li>
                  <li><b>Inbox.</b> «needs reply» means the last recorded message is theirs. Replying takes
                    priority over everything else on this list.</li>
                  <li><b>Wave breakdown</b> (click a campaign row): who is at which step, who sends to them,
                    and whether the last outgoing message was confirmed by the provider.</li>
                  <li><b>Stop list freshness</b> (Kommo section). A barrier built on stale data gives a false
                    sense of protection.</li>
                  <li><b>Validator credits</b> (Contacts). They burn silently.</li>
                </ol>
              </div>

              <div className="reply-head" style={{ marginTop: 14 }}><b>5 · What you can trust on screen</b></div>
              <div className="reply-summary">
                <p>A rule the system follows about itself: <b>every claim must name its source, and where
                there is no source it says so.</b> That is why you will see «no send <i>events</i> in 24h»
                rather than «no sends», and «✓ delivery confirmed» with the provider&apos;s message id next to
                messages that really left. If a line looks confident but vague, treat that as a bug and say so.</p>
                <p>Live configuration is rendered from the code and the provider, never retyped — the ladder,
                the ceilings, the thresholds. If a number here disagrees with GetSales or Smartlead, the
                provider wins and this page is the bug.</p>
              </div>

              <div className="reply-head" style={{ marginTop: 14 }}><b>6 · Before a real wave</b></div>
              <div className="reply-summary">
                <p>Run the pre-flight checklist in the acceptance criteria document: sender profiles alive
                (a profile with no automation heartbeat cannot be selected — the builder blocks it), texts
                approved, stop list synced today, seed test for spam placement not older than the last DNS
                change. Email deliverability is judged by a seed test, never by open rates — we do not even
                collect them any more.</p>
              </div>
            </div>
          )}

          {/* ---------------- Email-канал (Smartlead) ---------------- */}
          {section === 'email-channel' && (
            <div>
              {!emailCh && <p className="hint">Loading…</p>}
              {emailCh && (
                <>
                  <div className="reply-head"><b>The cell — what one lead experiences</b></div>
                  <div className="reply-summary">
                    <ol style={{ margin: '4px 0 8px 18px', padding: 0 }}>
                      <li>✉️ <b>Step 1 (day 0)</b> — the angle&apos;s first email, with a subject. Smartlead picks
                        a mailbox of the signing sender round-robin at send time — that is why every mailbox
                        of a campaign must belong to the person who signed the text.</li>
                      <li>✉️ <b>Step 2 (+3 days), step 3 (+4 more)</b> — replies into the same thread
                        (empty subject); step 3 is a polite break-up.</li>
                      <li>↩ <b>Reply → Inbox</b> + Telegram ping; the campaign pauses for that person, and the
                        LinkedIn cell of the same wave stops too (cross-stop both ways).</li>
                      <li>⏳ <b>Maturation: {emailCh.rules?.replyMaturationDays ?? 7} days</b> after the last
                        email before the cell closes — late replies keep arriving for days, and closing early
                        would mislabel people as «no reply».</li>
                      <li>🧊 Close → outcome per person (replied / no_reply / bounced) and a
                        <b> {emailCh.rules?.quarantineMonths ?? 3}-month quarantine</b> for everyone touched.</li>
                    </ol>
                  </div>

                  <div className="reply-head" style={{ marginTop: 14 }}><b>Protective thresholds — from the code</b></div>
                  <div className="reply-summary">
                    These are code constants, deliberately not editable here: each one was set after a real
                    incident. Wanting to tune one is the signal to turn it into a parameter.
                    <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                      <li>Bounce rate ≥ <b>{Math.round((emailCh.rules?.bounce?.alert ?? 0.05) * 100)}%</b> — alert;
                        ≥ <b>{Math.round((emailCh.rules?.bounce?.pause ?? 0.1) * 100)}%</b> — the campaign pauses itself
                        (below {Math.round((emailCh.rules?.bounce?.floor ?? 0.02) * 100)}% is background noise).</li>
                      <li>Catch-all addresses — at most <b>{Math.round((emailCh.rules?.catchAllQuota ?? 0.2) * 100)}%</b> of
                        a batch: they can&apos;t be verified, so their share is capped.</li>
                      <li>A batch reservation holds contacts for <b>{emailCh.rules?.reserveDays ?? 3} days</b> —
                        two operators can&apos;t cold-touch the same person at once.</li>
                    </ul>
                  </div>

                  <div className="reply-head" style={{ marginTop: 14 }}><b>Mailboxes — live from Smartlead</b></div>
                  {emailCh.accounts.length === 0
                    ? <p className="hint">Smartlead accounts unavailable (check SMARTLEAD_API_KEY on the server).</p>
                    : (
                      <table>
                        <thead><tr><th>Mailbox</th><th>Sender</th><th>Limit/day</th><th>Sent today</th></tr></thead>
                        <tbody>
                          {emailCh.accounts.map((a) => (
                            <tr key={a.id}>
                              <td>{a.from_email}</td>
                              <td>{a.identity?.name || <span className="hint">—</span>}</td>
                              <td>{a.message_per_day}</td>
                              <td>{a.daily_sent_count ?? 0}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  <p className="hint" style={{ marginTop: 6 }}>
                    Daily limits and warm-up live in Smartlead itself — this table is a window, not an editor.
                  </p>
                </>
              )}
            </div>
          )}

          {/* ---------------- Доступы ---------------- */}
          {section === 'people-access' && (
            <div className="reply-card">
              <div className="reply-summary">
                There is no self-registration on purpose — on an internal tool it would be a hole: anyone with the
                link would grant themselves access. Accounts are created here.
              </div>
              {users.length > 0 && (
                <table>
                  <thead><tr><th>Login</th><th>Name</th><th>Email</th><th>Role</th><th>Last seen</th><th></th></tr></thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                        <td><b>{u.login}</b></td>
                        <td>{u.name || '—'}</td>
                        <td>{u.email || '—'}</td>
                        <td>{u.role}</td>
                        <td>{fmt(u.last_seen_at)}</td>
                        <td>
                          <button className="btn-small" onClick={() => toggleUser(u)}>
                            {u.active ? 'disable' : 'enable'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <form className="contacts-filters" onSubmit={addUser} style={{ marginTop: 10 }}>
                <input placeholder="login" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required />
                <input placeholder="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
                <input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <input placeholder="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                <button type="submit" className="cta small" disabled={saving}>{saving ? '…' : 'Add person'}</button>
              </form>
              <p className="hint">
                The browser remembers Basic credentials until it is closed — there is no “log out” button. Acceptable
                for an internal tool; when it starts to hurt, we move to Cloudflare Access and the log carries over.
              </p>
            </div>
          )}

          {/* ---------------- Журнал сотрудников ---------------- */}
          {section === 'people-log' && (
            <div className="reply-card">
              <div className="reply-head">
                <b>Who</b>
                <select value={actor} onChange={(e) => setActor(e.target.value)} style={{ marginLeft: 10 }}>
                  <option value="">everyone</option>
                  {audit.actors.filter((a) => !ROBOTS.includes(a)).map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div className="reply-summary">
                Every action with consequences is recorded: approving a text, building a batch, launching a
                campaign, replying to a lead, changing a contact’s lifecycle, editing the stop list. Identity
                without a log is pointless.
              </div>
              {audit.rows.length === 0 ? (
                <p className="hint">Nothing yet — the log fills up as work happens.</p>
              ) : <AuditRows rows={audit.rows} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
