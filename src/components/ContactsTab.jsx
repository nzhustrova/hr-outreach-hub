import React, { useEffect, useState } from 'react';
import LeadTimeline from './LeadTimeline.jsx';

// «Только что добавленные» — окна по дате появления контакта в реестре.
// Значение опции — число дней (стабильно между рендерами); в ISO переводим при запросе.
const ADDED_WINDOWS = [
  { label: 'Saved: any time', days: 0 },
  { label: 'Saved: today', days: 1 },
  { label: 'Saved: last 3 days', days: 3 },
  { label: 'Saved: last 7 days', days: 7 },
  { label: 'Saved: last 30 days', days: 30 },
];

const LIFECYCLES = [
  { value: '', label: 'All statuses' },
  { value: 'available', label: 'Available (not quarantined)' },
  { value: 'active_in_campaign', label: 'Active in campaign' },
  { value: 'quarantined', label: 'Quarantined' },
  { value: 'suppressed_forever', label: 'Suppressed' },
];

// Статусы адреса от нашего валидатора (ТЗ п.31). `unchecked` — валидатор ещё не дошёл.
const EMAIL_STATUSES = [
  { value: '', label: 'Email: any status' },
  { value: 'valid', label: 'Email: valid' },
  { value: 'catch_all', label: 'Email: catch-all' },
  { value: 'unknown', label: 'Email: unknown' },
  { value: 'role', label: 'Email: role address' },
  { value: 'invalid', label: 'Email: invalid' },
  { value: 'unchecked', label: 'Email: not checked yet' },
];

const EMAIL_BADGE = {
  valid: { bg: '#f0fdf4', color: '#15803d', label: 'valid' },
  catch_all: { bg: '#fffbeb', color: '#b45309', label: 'catch-all' },
  unknown: { bg: '#f1f5f9', color: '#475569', label: 'unknown' },
  role: { bg: '#f1f5f9', color: '#475569', label: 'role' },
  invalid: { bg: '#fef2f2', color: '#b91c1c', label: 'invalid' },
};

// CSV переехал сюда из шорт-листа (решение Ольги 08.08): выгрузка контактов — свойство реестра,
// а не поиска; в Smartlead лиды уходят по API, файл нужен для ручной работы и обмена.
function toCsv(rows) {
  const header = ['first_name', 'last_name', 'email', 'email_status', 'title', 'company', 'company_domain',
    'linkedin_url', 'location', 'lifecycle', 'segments', 'unique_detail'];
  // Экранируем ведущие =+-@ — иначе Excel исполнит ячейку как формулу (CSV-инъекция).
  const esc = (v) => {
    const s = String(v ?? '');
    return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const body = rows.map((c) => [c.first_name, c.last_name, c.email, c.email_status, c.title, c.company,
    c.company_domain, c.linkedin_url, c.location, c.lifecycle, c.segment_names, c.unique_detail].map(esc).join(','));
  return [header.join(','), ...body].join('\n');
}

export default function ContactsTab({ onSendToCampaign }) {
  // Мостик в кампании (решение 08.08): отбор фильтрами здесь → кнопка → билдер кампании.
  // Лента событий по лиду (L5.11): открывается кликом по строке — история живёт там же,
  // где живёт человек, а не на отдельной вкладке со своим поиском.
  const [timelineId, setTimelineId] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [segments, setSegments] = useState([]);
  const [segmentId, setSegmentId] = useState('');
  const [since, setSince] = useState('0'); // дней назад; '0' = без ограничения
  const [contacts, setContacts] = useState([]);
  const [stats, setStats] = useState(null);
  const [q, setQ] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  // Кто вошёл — чтобы не блокировать человеку его же собственный резерв: пересобрать
  // свой пакет нормально, мешать должен только чужой.
  const [me, setMe] = useState(null);
  useEffect(() => { fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {}); }, []);
  // Резерв действует, пока не истёк срок: снимается при запуске кампании, а если её так
  // и не запустили — сам протухает через RESERVE_DAYS.
  const isReserved = (c) => Boolean(c.reserved_by && c.reserved_until && new Date(c.reserved_until) > new Date()
    && String(c.reserved_by) !== String(me?.name || me?.login || ''));
  // Человеческая причина, почему чекбокс недоступен: молчаливо недоступный чекбокс
  // раздражает сильнее, чем запрет с объяснением.
  const blockReason = (c) => {
    if (isReserved(c)) return `Held in ${c.reserved_by}'s unsent batch until ${fmtDate(c.reserved_until)} — first to build a batch keeps the contact`;
    if (c.lifecycle === 'active_in_campaign') return 'Already active in another campaign';
    if (c.lifecycle === 'in_conversation') return 'A person is talking to them — a meeting is scheduled';
    if (c.lifecycle === 'quarantined') return `In quarantine until ${fmtDate(c.quarantine_until)}`;
    if (c.lifecycle === 'suppressed_forever') return 'Suppressed (unsubscribe / hard bounce)';
    if (!c.email) return 'No email address';
    if (c.liveness === 'dead') return 'Company looks closed';
    return 'Address not verified yet — the campaign pre-flight would drop it';
  };
  const [emailStatus, setEmailStatus] = useState('');
  // Импорт истории GetSales (2 433 строки, L1.3) по умолчанию скрыт: он вытеснял рабочие
  // контакты с первого экрана (вопрос Ольги 13.08). Слитые с поисковыми — видны всегда.
  const [hideImported, setHideImported] = useState(true);
  // Страницы (задача Ольги 13.08): реестр вырос до ~2 500, «первые 100» — нечестное окно.
  const PAGE_SIZE = 100;
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [verify, setVerify] = useState(null);   // состояние валидатора: баланс + счётчики
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState({ key: 'updated_at', dir: -1 });

  const [sources, setSources] = useState(null);   // качество источников, по кнопке
  async function loadSources() {
    if (sources) { setSources(null); return; }     // повторный клик сворачивает
    try {
      const r = await fetch('/api/verify/sources');
      setSources(r.ok ? await r.json() : []);
    } catch { setSources([]); }
  }

  async function loadVerify() {
    try {
      const r = await fetch('/api/verify/state');
      setVerify(r.ok ? await r.json() : null);
    } catch { setVerify(null); }
  }
  // Обновляем вместе со списком, а не только при монтировании: иначе после деплоя/прогона
  // шапка врёт («валидатор выключен»), пока строки уже показывают новые статусы.
  useEffect(() => { loadVerify(); }, []);

  // Ручной прогон — им же делается разовая проверка накопленного реестра.
  async function runVerify() {
    setVerifying(true);
    try {
      const r = await fetch('/api/verify/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 200 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.status);
      await Promise.all([loadVerify(), load()]);
    } catch (e) { setError(String(e.message || e)); } finally { setVerifying(false); }
  }

  /**
   * @param keepPicked — сохранить выбор оператора. Фоновое обновление (возврат к вкладке,
   * очередь валидатора) НЕ имеет права стирать отмеченные строки: 13.08 из-за этого
   * пропадал уже собранный выбор, и «recalculate» падал с «no contacts». Сбрасываем
   * выбор только при смене фильтров — там он действительно перестаёт иметь смысл.
   */
  async function load({ keepPicked = false } = {}) {
    setLoading(true);
    setError('');
    if (!keepPicked) setPicked(new Set()); // иначе счётчик на кнопке врёт после смены фильтров
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (lifecycle) params.set('lifecycle', lifecycle);
      if (segmentId) params.set('segmentId', segmentId);
      if (emailStatus) params.set('emailStatus', emailStatus);
      if (Number(since) > 0) params.set('since', new Date(Date.now() - Number(since) * 864e5).toISOString());
      if (hideImported) params.set('hideImported', '1');
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String((page - 1) * PAGE_SIZE));
      const [cr, sr] = await Promise.all([
        fetch(`/api/registry/contacts?${params}`),
        fetch('/api/registry/stats'),
      ]);
      if (cr.status === 503 || cr.status === 404) {
        setError('Registry is not available here: no database in this environment (or the local API server needs a restart). It works on the Railway deployment.');
        setContacts([]);
        return;
      }
      const cd = await cr.json().catch(() => { throw new Error('unexpected non-JSON response — restart the local dev server'); });
      if (!cr.ok) throw new Error(cd.error || cr.status);
      const rows = Array.isArray(cd) ? cd : (cd.rows || []);
      setContacts(rows);
      setTotal(Array.isArray(cd) ? cd.length : Number(cd.total) || rows.length);
      // Из сохранённого выбора убираем тех, кто из выдачи ушёл (например, его успели
      // зарезервировать) — иначе кнопка обещает больше, чем реально уйдёт в пакет.
      if (keepPicked) {
        const alive = new Set(rows.map((c) => c.id));
        setPicked((prev) => new Set([...prev].filter((id) => alive.has(id))));
      }
      if (sr.ok) setStats(await sr.json());
      loadVerify(); // шапка и строки должны показывать одно и то же состояние
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [lifecycle, segmentId, since, emailStatus, hideImported, page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Автообновление, пока валидатор разгребает очередь (вопрос Ольги 10.08: экран не менялся
  // до ручного F5). Опрос идёт ТОЛЬКО пока есть непроверенные — как только pending дошёл
  // до нуля, таймер снимается и лишнего трафика нет.
  const pendingCount = Number(verify?.counters?.pending || 0);
  useEffect(() => {
    if (!verify?.enabled || pendingCount === 0) return undefined;
    const t = setInterval(() => { load({ keepPicked: true }); }, 10 * 1000);
    return () => clearInterval(t);
  }, [verify?.enabled, pendingCount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    fetch('/api/registry/segments').then((r) => (r.ok ? r.json() : [])).then(setSegments).catch(() => setSegments([]));
  }, []);

  // Перечитываем при возврате к вкладке. Резерв ставит ДРУГОЙ оператор, и узнать об этом
  // из открытой страницы иначе нельзя — до 13.08 список обновлялся только пока идёт
  // валидация адресов, то есть почти никогда. Постоянный опрос здесь не нужен: список
  // меняется редко, а «вернулся к экрану» — ровно тот момент, когда данные должны быть свежими.
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') load({ keepPicked: true }); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Отбор превращается в ПАКЕТ — сохраняемую сущность (решение Ольги 08.08).
  // Раньше выборка жила в памяти браузера и терялась при обновлении страницы.
  const [sending, setSending] = useState(false);
  const [plan, setPlan] = useState(null);      // предпросмотр состава пакета
  // Квота задаётся здесь, а не в Settings (решение Ольги 11.08): доля зависит от конкретного
  // пакета, а не от системы в целом. 33% — значение по умолчанию.
  const [quota, setQuota] = useState(33);
  const [forced, setForced] = useState(new Set()); // отложенные, возвращённые руками

  const [stale, setStale] = useState(null);      // адреса с протухшей проверкой
  const [rechecking, setRechecking] = useState(false);
  const [recheckReport, setRecheckReport] = useState(null);

  // Шаг 1: показать, что войдёт и что квота отложит. Состав пакета не должен меняться после
  // подтверждения — поэтому считаем ДО, а не молча отсекаем при создании.
  // Состав, по которому построен открытый предпросмотр. «Recalculate» пересчитывает ИМЕННО
  // его, а не текущий `picked`: иначе смена лимита молча меняла бы ещё и состав, а правило
  // «состав пакета не меняется после подтверждения» — одно из основных (решение Ольги 10.08).
  const [planIds, setPlanIds] = useState(null);

  async function planBatch(force = forced, ids = null) {
    const source = ids || planIds || [...picked];
    if (!source.length) { setError('Nothing is selected — tick the contacts you want in the batch.'); return; }
    setSending(true); setError('');
    try {
      const r = await fetch('/api/batches/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: source, forceIds: [...force], quota: Number(quota) / 100 }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.status);
      setPlan(data);
      // Ре-верификация ленивая — в момент сборки пакета, а не фоновым прогоном всего реестра:
      // платим только за то, что реально отправляем. Но результат обязан быть виден ДО
      // подтверждения, иначе множества разойдутся (замечание Ольги 10.08).
      const sr = await fetch('/api/verify/stale', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: [...picked], days: 90 }),
      });
      setStale(sr.ok ? await sr.json() : null);
      setRecheckReport(null);
    } catch (e) { setError(String(e.message || e)); } finally { setSending(false); }
  }

  async function recheckStale() {
    setRechecking(true); setError('');
    try {
      const r = await fetch('/api/verify/stale', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: [...picked], days: 90, apply: true }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.status);
      await planBatch(forced);   // состав мог измениться — пересчитываем на глазах
      setRecheckReport(data);    // строго после planBatch: он сбрасывает отчёт
      await Promise.all([load(), loadVerify()]);
    } catch (e) { setError(String(e.message || e)); } finally { setRechecking(false); }
  }

  // Шаг 2: создать пакет ровно из того состава, который оператор увидел.
  async function confirmBatch() {
    if (!plan) return;
    setSending(true); setError('');
    try {
      const r = await fetch('/api/batches', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactIds: plan.included,
          deferredIds: plan.deferred.map((c) => c.id),
          segmentId: segmentId ? Number(segmentId) : null,
          filters: { q, lifecycle, segmentId, sinceDays: Number(since) || 0, emailStatus },
        }),
      });
      const batch = await r.json();
      if (!r.ok) {
        // 409 — часть контактов заняли, пока оператор собирал пакет. Показываем поимённо:
        // «не удалось» без списка заставляет искать виноватого руками.
        if (r.status === 409 && Array.isArray(batch.blocked)) {
          await load({ keepPicked: true });
          throw new Error(`${batch.error}: ${batch.blocked.map((b) => `${b.name} — ${b.reason}`).join('; ')}`);
        }
        throw new Error(batch.error || r.status);
      }
      setPlan(null); setForced(new Set()); setPlanIds(null);
      // Список перечитываем СРАЗУ: контакты только что зарезервированы, и статус должен
      // появиться от действия, а не от того, что оператор догадался обновить страницу.
      await load();
      onSendToCampaign(batch);
    } catch (e) { setError(String(e.message || e)); } finally { setSending(false); }
  }

  function toggleForce(id) {
    const next = new Set(forced);
    next.has(id) ? next.delete(id) : next.add(id);
    setForced(next);
    planBatch(next);
  }

  function downloadCsv() {
    const rows = picked.size ? sorted.filter((c) => picked.has(c.id)) : sorted;
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `contacts_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Обратное направление барьера (вопрос Ольги 13.08): в реестре всплыл человек, с которым
  // уже идут переговоры вне CRM — его надо уметь отправить в стоп-лист прямо отсюда.
  async function toStopList(c) {
    if (!c.email) { setError('у контакта нет адреса — блокировать нечего'); return; }
    const reason = window.prompt(`Why should ${c.email} never get a cold email? The reason is recorded with your name.`);
    if (!reason || !reason.trim()) return;
    try {
      const r = await fetch('/api/crm/override', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: c.email, kind: 'email', action: 'block', reason }),
      });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      await load();
    } catch (e) { setError(String(e.message || e)); }
  }

  async function setAvailable(c) {
    await fetch(`/api/registry/contacts/${c.id}/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lifecycle: 'available' }),
    });
    load();
  }

  const sorted = [...contacts].sort((a, b) => {
    const get = (c) => {
      const v = c[sort.key];
      if (sort.key === 'touches' || sort.key === 'segment_matches') return Number(v) || 0;
      if (sort.key === 'updated_at' || sort.key === 'quarantine_until') return v ? new Date(v).getTime() : 0;
      return (v || '').toString().toLowerCase();
    };
    const av = get(a); const bv = get(b);
    return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
  });

  // Отправляемость по статусу адреса (ТЗ п.31): catch-all разрешён — его долю режет квота
  // на сборке пакета, а не молчаливый фильтр здесь. `unknown` после 3 неудачных попыток —
  // серая зона наравне с catch-all: трижды не ответивший сервер даёт то же знание.
  const isSendable = (c) => {
    if (c.lifecycle !== 'available' || !c.email) return false;
    // Чужой резерв — жёсткий запрет (решение Ольги 13.08): контакт, лежащий в чужом
    // несобранном пакете, в новый пакет не попадает вообще. Иначе размер пакета не сойдётся
    // с размером отправки и аналитика по кампании соврёт.
    if (isReserved(c)) return false;
    // Мёртвая компания: pre-flight такой контакт не пропустит, значит и «sendable» его считать
    // не должен — иначе счётчик на экране обещает больше, чем уйдёт в кампанию.
    if (c.liveness === 'dead') return false;
    const st = String(c.email_status || '').toLowerCase();
    if (!verify?.enabled) return ['verified', 'valid'].includes(String(c.email_status || c.source_email_status || '').toLowerCase());
    return st === 'valid' || st === 'catch_all' || (st === 'unknown' && (c.email_verify_attempts || 0) >= 3);
  };
  const mailable = sorted.filter(isSendable);

  const th = (key, label) => (
    <th
      className={`sortable ${sort.key === key ? 'sorted' : ''}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}
    >
      {label}{sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  );

  const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('en-US') : '');

  return (
    <div className="contacts-tab">
      <div className="results-head">
        <h2>Contact Registry</h2>
        {stats && (
          <span className="segment-width">
            {stats.contacts} contacts · {stats.with_email} with email · {stats.segments} segments
          </span>
        )}
      </div>

      {/* Качество адресов (ТЗ п.31). Счётчики показывают ЖИВОСТЬ адресов и надёжность источников —
          не релевантность лида и не качество гипотезы: это отдельный контур (отклик). */}
      {verify?.enabled && verify.counters && (
        <div className="contacts-actions">
          <span className="reply-badge" style={{ background: '#f0fdf4', color: '#15803d' }}>{verify.counters.valid} valid</span>
          <span className="reply-badge" style={{ background: '#fffbeb', color: '#b45309' }}>{verify.counters.catch_all} catch-all</span>
          <span className="reply-badge" style={{ background: '#fef2f2', color: '#b91c1c' }}>{verify.counters.invalid} invalid</span>
          <span className="reply-badge" style={{ background: '#f1f5f9', color: '#475569' }}>{verify.counters.role} role</span>
          {Number(verify.counters.unresolved) > 0 && (
            <span className="reply-badge" style={{ background: '#f1f5f9', color: '#475569' }} title="Checked 3 times, the server never answered — treated as a grey zone like catch-all">
              {verify.counters.unresolved} unresolved
            </span>
          )}
          {Number(verify.counters.pending) > 0 && (
            <button className="btn-small" disabled={verifying} onClick={runVerify}>
              {verifying ? 'Checking…' : `✓ Verify ${verify.counters.pending} unchecked`}
            </button>
          )}
          <button className="btn-small" onClick={loadSources}>
            {sources ? '× Source quality' : '📊 Source quality'}
          </button>
          {verify.balance && (
            <span className="hint">
              {verify.balance.credits} credits left
              {verify.outOfCredits && ' — ⚠️ ran out, addresses stay unchecked and are not sent'}
            </span>
          )}
        </div>
      )}

      {/* Качество источников (ТЗ п.31). Подпись обязательна: блок меряет ЖИВОСТЬ адресов и
          надёжность источников данных — не релевантность лида и не качество гипотезы.
          Кривой фильтр даёт прекрасные живые адреса не тех людей: bounce ноль, результат ноль. */}
      {sources && (
        <div className="reply-card">
          <div className="reply-head"><b>Source quality</b></div>
          <div className="reply-summary">
            This measures <b>address liveness</b> and how reliable each data source is. It says nothing about
            whether we are writing to the right people or with the right offer — that is a separate loop,
            measured by reply and positive rate.
          </div>
          {sources.length === 0 ? (
            <p className="hint">No data yet.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Source</th><th>Found</th><th>valid</th><th>catch-all</th><th>invalid</th><th>role</th><th>bounced</th></tr>
              </thead>
              <tbody>
                {sources.map((s) => {
                  const pct = (n) => (Number(s.found) ? `${Math.round((Number(n) / Number(s.found)) * 100)}%` : '—');
                  return (
                    <tr key={s.source || 'unknown'}>
                      <td><b>{s.source || '—'}</b></td>
                      <td>{s.found}</td>
                      <td>{s.valid} <span className="hint">({pct(s.valid)})</span></td>
                      <td>{s.catch_all} <span className="hint">({pct(s.catch_all)})</span></td>
                      <td>{s.invalid} <span className="hint">({pct(s.invalid)})</span></td>
                      <td>{s.role}</td>
                      <td>{s.bounced}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <p className="hint">
            Combinations are counted separately: «explee+apollo» behaves differently from either source alone,
            and that combination is our main way of getting addresses. Small samples say nothing — read this
            after a few hundred contacts, not a few dozen.
          </p>
        </div>
      )}
      {verify && !verify.enabled && (
        <p className="hint">⚠️ Email validator is off (no MILLIONVERIFIER_API_KEY) — pre-flight falls back to trusting the source’s own “verified” flag.</p>
      )}

      <form
        className="contacts-filters"
        onSubmit={(e) => { e.preventDefault(); load(); }}
      >
        <input
          placeholder="Search name or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={lifecycle} onChange={(e) => { setPage(1); setLifecycle(e.target.value); }}>
          {LIFECYCLES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
        <select value={segmentId} onChange={(e) => { setPage(1); setSegmentId(e.target.value); }} title="Filter by the segment the contact was found for">
          <option value="">All segments</option>
          {segments.map((s) => <option key={s.id} value={s.id}>#{s.id} {s.name}</option>)}
        </select>
        <select value={emailStatus} onChange={(e) => { setPage(1); setEmailStatus(e.target.value); }} title="Filter by what our validator said about the address">
          {EMAIL_STATUSES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
        <select value={since} onChange={(e) => { setPage(1); setSince(e.target.value); }} title="Filter by when the contact was added to the registry">
          {ADDED_WINDOWS.map((x) => <option key={x.days} value={x.days}>{x.label}</option>)}
        </select>
        <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
          title="2,433 people from the GetSales history import (L0.10). They exist for quarantine and dedup — they carry no search filters, no segments and no details, so they are hidden from batch building by default.">
          <input type="checkbox" checked={hideImported} onChange={(e) => { setPage(1); setHideImported(e.target.checked); }} />
          hide GetSales import
        </label>
        <button type="submit" className="cta small" disabled={loading}>{loading ? '…' : 'Search'}</button>
      </form>

      {total > PAGE_SIZE && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
          <button className="btn-small" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
          <span className="hint">{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}</span>
          <button className="btn-small" disabled={page * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Next ›</button>
        </div>
      )}

      {sorted.length > 0 && (
        <div className="contacts-actions">
          <button className="btn-small" onClick={() => setPicked(new Set(mailable.map((c) => c.id)))}>
            Select all sendable ({mailable.length})
          </button>
          {/* Деление базы между отправителями (вопрос Ольги 08.08): случайная половина — честный
              A/B по отправителю. Вторая половина остаётся available и уйдёт во вторую кампанию. */}
          {mailable.length > 1 && (
            <button
              className="btn-small"
              title="Random half — send it from one sender, then come back and send the rest from the other. Random (not by score) keeps the sender comparison honest."
              onClick={() => {
                const shuffled = [...mailable].sort(() => Math.random() - 0.5);
                setPicked(new Set(shuffled.slice(0, Math.ceil(shuffled.length / 2)).map((c) => c.id)));
              }}
            >
              🎲 Random half ({Math.ceil(mailable.length / 2)})
            </button>
          )}
          {picked.size > 0 && <button className="btn-small" onClick={() => setPicked(new Set())}>clear ({picked.size})</button>}
          <button className="btn-small" onClick={downloadCsv}>
            ⬇ CSV ({picked.size || sorted.length})
          </button>
          <button className="add-recommended" disabled={!picked.size || sending} onClick={() => { setPlanIds([...picked]); planBatch(forced, [...picked]); }}>
            {sending ? 'Checking…' : `→ Send ${picked.size || ''} to a campaign`}
          </button>
          <span className="hint">
            Sendable = available + an address our validator accepted: <b>valid</b>, <b>catch-all</b> (its share
            of a batch will be capped) or <b>unknown</b> after 3 failed checks. Invalid, role and not-yet-checked
            rows can be picked but the campaign pre-flight will drop them — as will anyone already active in
            another campaign, so the same lead can never get a second cold email from a different sender.
          </span>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {/* Предпросмотр состава пакета. Квота catch-all режет ЗДЕСЬ, до подтверждения, и всегда
          называет отложенных поимённо: молчаливый отсев — то, из-за чего pre-flight однажды
          выбросил явно выбранные контакты (ТЗ п.31). */}
      {plan && (
        <div className="reply-card">
          <div className="reply-head">
            <b>Batch preview — {plan.included.length} of {plan.selected}</b>
            <span className="reply-badge" style={{ background: plan.deferred.length ? '#fffbeb' : '#f0fdf4', color: plan.deferred.length ? '#b45309' : '#15803d' }}>
              catch-all {plan.greyIncluded} ({Math.round(plan.shareAfter * 100)}%) · limit {Math.round(plan.quota * 100)}%
            </span>
            {plan.overQuota && (
              <span className="reply-badge" style={{ background: '#fef2f2', color: '#b91c1c' }}>over the limit — your call</span>
            )}
          </div>

          {plan.deferred.length > 0 ? (
            <>
              <div className="reply-summary">
                Deferred {plan.deferred.length} catch-all: the quota was exceeded
                ({Math.round(plan.shareBefore * 100)}% of the selection against a {Math.round(plan.quota * 100)}% limit).
                Dropped lowest fit score first, ties broken by fewer sources. They stay <b>available</b> in the
                registry and will show up again in your next batch — nothing is lost.
              </div>
              <div className="thread">
                {plan.deferred.map((c) => (
                  <label key={c.id} className="msg msg-in" style={{ display: 'block', cursor: 'pointer' }}>
                    <input type="checkbox" checked={forced.has(c.id)} onChange={() => toggleForce(c.id)} style={{ marginRight: 8 }} />
                    <b>{c.full_name || '—'}</b> — {c.title || '?'} @ {c.company || '?'} · {c.email}
                    <span className="hint"> · fit {c.fit_score ?? '—'}</span>
                  </label>
                ))}
              </div>
              <p className="hint">
                Tick anyone you want back in — they <b>swap</b> with the lowest-scoring catch-all currently
                included, so the share stays within the limit and the list below updates to show who moved out.
                Tick more than fits and the limit is exceeded on purpose — it will say so.
              </p>
            </>
          ) : (
            <div className="reply-summary">
              Catch-all share is within the limit — nothing deferred, all {plan.included.length} contacts go in.
            </div>
          )}

          {/* Ре-верификация: отдельный видимый шаг, а не побочный эффект подтверждения.
              Почта протухает ~2%/мес, а контакты у нас лежат месяцами (карантины, отложенные). */}
          {Number(stale?.stale) > 0 && (
            <div className="reply-summary" style={{ background: '#fffbeb', borderColor: '#fde68a' }}>
              ⏳ {stale.stale} address{Number(stale.stale) === 1 ? '' : 'es'} in this batch {Number(stale.stale) === 1 ? 'was' : 'were'} checked
              more than 90 days ago. B2B addresses go stale at roughly 2% a month — a re-check costs a fraction
              of a cent, a bounce costs domain reputation.
              <div className="shortlist-actions" style={{ marginTop: 6 }}>
                <button className="btn-small" disabled={rechecking} onClick={recheckStale}>
                  {rechecking ? 'Checking…' : `✓ Re-check ${stale.stale}`}
                </button>
              </div>
            </div>
          )}
          {recheckReport && (
            <div className="reply-summary" style={{ background: '#f0fdf4', borderColor: '#bbf7d0' }}>
              Re-checked {recheckReport.checked}.{' '}
              {recheckReport.changed.length === 0
                ? 'Nothing changed — the batch is unchanged.'
                : <>Changed {recheckReport.changed.length}: {recheckReport.changed.map((c) => `${c.email} ${c.from || 'unchecked'} → ${c.to}`).join('; ')}. Batch size updated above.</>}
              {recheckReport.outOfCredits && ' ⚠️ Validator credits ran out mid-way — the rest stay as they were.'}
            </div>
          )}

          {/* Тони: кампанией имеет смысл называть от 200 контактов — меньшая выборка не даёт
              статистики, и по ней нельзя судить ни о тексте, ни о сегменте. Не блокируем. */}
          {plan.included.length < 200 && (
            <div className="reply-summary" style={{ background: '#fffbeb', borderColor: '#fde68a' }}>
              ⚠️ {plan.included.length} contacts — below the 200 needed to judge a hypothesis. The wave will
              run fine, but do not read reply rate off it: at this size two replies swing the number by
              a percentage point. Either add more contacts, or treat this as a smoke test, not a test of
              the text.
            </div>
          )}

          <div className="field" style={{ marginTop: 8 }}>
            <span className="field-label">
              Catch-all limit
              <span
                className="hint" style={{ marginLeft: 6, cursor: 'help' }}
                title={'Catch-all = a domain that accepts mail for ANY address, so no validator can tell whether the specific mailbox exists — it is a limitation of the method, not of the service. Roughly a third of large US corporate domains are set up this way, so cutting them out means cutting out a third of the ICP. We send them, but cap their share so that a batch never becomes mostly guesswork. Do NOT set this to 5%: you would be throwing away most of your addressable market to avoid a risk we already measure with bounce rate.'}
              >
                — what is this?
              </span>
            </span>
            <div className="shortlist-actions" style={{ marginTop: 4 }}>
              <input
                type="number" min="0" max="100" step="1" value={quota} style={{ width: 90 }}
                onChange={(e) => setQuota(e.target.value)}
              />
              <span className="hint">% of the batch · default 33 · applies to this batch only</span>
              <button className="btn-small" disabled={sending} onClick={() => planBatch()}>recalculate</button>
            </div>
          </div>

          <div className="shortlist-actions">
            <button
              className="save-registry"
              disabled={sending || rechecking || Number(stale?.stale) > 0}
              title={Number(stale?.stale) > 0 ? 'Re-check the stale addresses first — the batch size may change' : ''}
              onClick={confirmBatch}
            >
              {sending ? 'Creating…' : `Create batch of ${plan.included.length}`}
            </button>
            <button className="link" onClick={() => { setPlan(null); setForced(new Set()); setPlanIds(null); setStale(null); setRecheckReport(null); }}>cancel</button>
          </div>
        </div>
      )}

      {sorted.length > 0 && (
        <table>
          <thead>
            <tr>
              <th className="pick">✓</th>
              {th('full_name', 'Name')}
              {th('title', 'Title')}
              {th('company', 'Company')}
              {th('email', 'Email')}
              {th('lifecycle', 'Status')}
              {th('quarantine_until', 'Quarantine ends')}
              {th('unique_detail', '💡 Detail')}
              {th('segment_names', 'Segments')}
              {th('touches', 'Touches')}
              {th('updated_at', 'Updated')}
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <React.Fragment key={c.id}>
              <tr
                className={picked.has(c.id) ? 'picked' : ''}
                style={{ background: timelineId === c.id ? '#eef2ff' : undefined }}
              >
                {/* Подсказку вешаем на ЯЧЕЙКУ, а не на сам чекбокс: браузер не показывает
                    `title` у disabled-элемента — событий мыши он не получает. Из-за этого
                    объяснение «почему нельзя» было недоступно ровно там, где оно нужно
                    (найдено Ольгой 13.08). Плюс видимый замок: тултип надо ещё догадаться
                    вызвать наведением, а замок виден сразу. */}
                <td className="pick" title={isSendable(c) ? '' : blockReason(c)}>
                  <input
                    type="checkbox" checked={picked.has(c.id)}
                    disabled={!isSendable(c)}
                    onChange={() => setPicked((prev) => { const n = new Set(prev); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })}
                  />
                  {!isSendable(c) && <span className="pick-lock" aria-label={blockReason(c)}>🔒</span>}
                </td>
                <td>
                  {c.full_name || '—'}
                  {Array.isArray(c.sources) && c.sources.includes('getsales-import') && (
                    <span className="hint" title="From the GetSales history import: no search filters, segments or details — usable for quarantine and dedup, not for batches" style={{ marginLeft: 6 }}>· GetSales import</span>
                  )}
                </td>
                <td>{c.title || '—'}</td>
                <td>{c.company || '—'}{c.company_domain ? ` (${c.company_domain})` : ''}</td>
                <td>
                  {c.email || '—'}
                  {c.email && (() => {
                    const st = String(c.email_status || '').toLowerCase();
                    if (!st) return <span className="reply-badge" style={{ background: '#f8fafc', color: '#94a3b8' }} title="Validator has not reached this address yet">not checked</span>;
                    const b = EMAIL_BADGE[st] || { bg: '#f8fafc', color: '#475569', label: st };
                    const exhausted = st === 'unknown' && (c.email_verify_attempts || 0) >= 3;
                    return (
                      <span
                        className="reply-badge" style={{ background: b.bg, color: b.color }}
                        title={[
                          c.email_verify_note ? `reason: ${c.email_verify_note}` : '',
                          exhausted ? 'checked 3 times without an answer — treated as a grey zone like catch-all' : '',
                          c.source_email_status ? `source said: ${c.source_email_status}` : '',
                          c.email_verified_at ? `checked ${new Date(c.email_verified_at).toLocaleDateString('en-US')}` : '',
                        ].filter(Boolean).join(' · ')}
                      >
                        {b.label}{exhausted ? ' ×3' : ''}
                      </span>
                    );
                  })()}
                  {/* Мёртвая компания: pre-flight такой контакт не пропустит (методология поиска,
                      блок 1). Показываем причину, чтобы отсев не выглядел необъяснимым. */}
                  {c.liveness === 'dead' && (
                    <span
                      className="reply-badge" style={{ background: '#fef2f2', color: '#b91c1c' }}
                      title={`Company appears closed: ${c.liveness_note || 'found in news'} — pre-flight will not let this contact into a campaign`}
                    >
                      ⚠️ company closed
                    </span>
                  )}
                  {c.last_deferred_at && (
                    <span className="reply-badge" style={{ background: '#faf5ff', color: '#7e22ce' }} title="Was deferred from an earlier batch by the catch-all quota">deferred</span>
                  )}
                </td>
                <td>
                  <span className={`lifecycle ${c.lifecycle}`}>{c.lifecycle}</span>
                  {/* Резерв: контакт уже лежит в чьём-то несобранном пакете. Без этой пометки
                      два оператора собирают один и тот же контакт и узнают об этом только
                      при запуске, когда оба пакета уже согласованы (решение Ольги 11.08). */}
                  {isReserved(c) && (
                    <span
                      className="reply-badge" style={{ background: '#fffbeb', color: '#b45309', marginLeft: 4 }}
                      title={`In an unsent batch by ${c.reserved_by}. The hold expires ${fmtDate(c.reserved_until)} unless that campaign is launched.`}
                    >
                      🔒 in {c.reserved_by}’s draft
                    </span>
                  )}
                  {c.lifecycle !== 'available' && (
                    <button className="link" style={{ marginLeft: 6 }} onClick={() => setAvailable(c)}>
                      → available
                    </button>
                  )}
                  {c.email && (
                    <button
                      className="link" style={{ marginLeft: 6 }}
                      title="Never send this person a cold email — for example, someone already in talks outside the CRM. A reason is required and is recorded with your name."
                      onClick={() => toStopList(c)}
                    >
                      🔒 to stop list
                    </button>
                  )}
                </td>
                <td>{c.lifecycle === 'quarantined' ? fmtDate(c.quarantine_until) : '—'}</td>
                <td>
                  {c.unique_detail
                    ? <span className="seg-names" title={c.unique_detail}>{c.unique_detail}</span>
                    : '—'}
                </td>
                <td>
                  {c.segment_names
                    ? <span className="seg-names" title={c.segment_names}>{c.segment_names}</span>
                    : '—'}
                </td>
                <td>
                  {c.touches}
                  {/* LinkedIn-касание видно в списке (L5.7): оно закрывает канал на 3 месяца,
                      и узнавать об этом на pre-flight запуска — поздно. */}
                  {c.last_linkedin && (() => {
                    const reopen = new Date(c.last_linkedin); reopen.setMonth(reopen.getMonth() + 3);
                    const open = reopen <= new Date();
                    return (
                      <span
                        className="reply-badge"
                        style={{ marginLeft: 6, background: open ? '#ecfdf5' : '#eff6ff', color: open ? '#047857' : '#1d4ed8' }}
                        title={open
                          ? `LinkedIn touched ${fmtDate(c.last_linkedin)} — over 3 months ago, the channel is open again`
                          : `LinkedIn touched ${fmtDate(c.last_linkedin)} — the channel reopens ${fmtDate(reopen)}`}
                      >
                        in {fmtDate(c.last_linkedin)}
                      </span>
                    );
                  })()}
                </td>
                <td>{fmtDate(c.updated_at)}</td>
                {/* История — ОТДЕЛЬНОЙ кнопкой, а не кликом по строке: в колонке Status живут
                    ссылки смены жизненного цикла, и клик «мимо» менял статус контакта
                    (промах Ольги 17.08). Разрушительное действие и безопасный просмотр
                    не должны лежать в одной зоне промаха. */}
                <td>
                  <button
                    className="btn-small"
                    title="Everything we ever did with this person, both channels"
                    onClick={() => setTimelineId(timelineId === c.id ? null : c.id)}
                  >
                    🧾 history
                  </button>
                </td>
              </tr>
              {/* Лента раскрывается ПРЯМО ПОД строкой человека. Панель под таблицей была
                  за пределами экрана (таблица — сотня строк), и кнопка выглядела мёртвой. */}
              {timelineId === c.id && (
                <tr>
                  <td colSpan={20} style={{ background: '#fafaf9' }}>
                    <LeadTimeline contactId={c.id} onClose={() => setTimelineId(null)} />
                  </td>
                </tr>
              )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}

      {!error && !sorted.length && !loading && (
        <div className="empty-state">
          <div className="empty-icon">🗂️</div>
          <h2>Registry is empty</h2>
          <p>Save a shortlist from the Search tab — contacts, segments and signal snapshots will appear here.</p>
        </div>
      )}
    </div>
  );
}
