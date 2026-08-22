import React, { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar.jsx';
import SearchForm from './components/SearchForm.jsx';
import ResultsTable from './components/ResultsTable.jsx';
import Shortlist from './components/Shortlist.jsx';
import ContactsTab from './components/ContactsTab.jsx';
import CampaignsTab from './components/CampaignsTab.jsx';
import InboxTab from './components/InboxTab.jsx';
import SettingsTab from './components/SettingsTab.jsx';
import { buildExpleePayload, buildApolloPayload, normalizeResults, flagResult, identityKey, sameIdentity } from './lib/search.js';
import { scoreFit, scoreValue, FIT_RECOMMEND_THRESHOLD } from './lib/scoring.js';

const keyOf = identityKey;

const DEFAULTS = {
  location: 'United States',
  region: 'Any',
  sizes: [],
  industry: '',
  titleType: '',
  titles: [],
  signal: '',
  signal2: '',
  hiringRole: '',
  hiringPostedDays: 30,
  verifiedEmailOnly: false,
  technologies: '',
  keywords: '',
  revenueMin: '',
  apolloOnly: false,
  channel: '',   // '' любой · email · linkedin · both (ТЗ п.39)
};

export default function App() {
  const [tab, setTab] = useState('search');
  // Мостик Contacts → Campaigns: отобранные фильтрами контакты едут в билдер кампании.
  const [campaignPreselect, setCampaignPreselect] = useState(null);
  const [form, setForm] = useState(DEFAULTS);
  const [provider, setProvider] = useState('explee');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [flags, setFlags] = useState([]);
  const [total, setTotal] = useState(null);
  const [rawResponse, setRawResponse] = useState(null);
  const [error, setError] = useState('');
  const [shortlist, setShortlist] = useState([]);
  const [balance, setBalance] = useState(null);
  const [apolloTotal, setApolloTotal] = useState(null);
  const [scores, setScores] = useState([]);
  const [idealLead, setIdealLead] = useState(null);
  const [angleStats, setAngleStats] = useState(null);
  // Барьер CRM (ТЗ п.28): контакты, с которыми уже работают, не должны попадать в холодную
  // рассылку. Проверяем выдачу поиска — по адресу точечно, по домену только «тёплые» компании.
  const [crmState, setCrmState] = useState(null);
  const [crmBlocked, setCrmBlocked] = useState({ emails: {}, domains: {} });
  // Вердикты по индустриям (ТЗ п.38): карта «индустрия компании → fits/adjacent/mismatch».
  // Считает сервер по уникальным парам и кэширует, поэтому запрос дешёвый и быстро становится
  // почти бесплатным — со второй недели модель зовётся только для новых индустрий.
  const [industryVerdicts, setIndustryVerdicts] = useState({});
  // История контакта в выдаче (вопрос Стаса): был ли в кампании, ответил ли, в карантине ли,
  // не забронирован ли другим оператором. Зелёный бейдж «в реестре» на эти вопросы не отвечал.
  const [registryState, setRegistryState] = useState({});

  async function loadRegistryState(rows) {
    const emails = [...new Set(rows.map((r) => (r.email || '').toLowerCase()).filter(Boolean))];
    // Профили тоже (L5.7): LinkedIn-only контакт (например, из импорта истории GetSales)
    // по email не находится — без slug его история в выдаче молча терялась.
    const linkedins = [...new Set(rows.map((r) => r.linkedin).filter(Boolean))];
    if (!emails.length && !linkedins.length) return;
    try {
      const r = await fetch('/api/registry/state', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emails, linkedins }),
      });
      if (r.ok) setRegistryState(await r.json());
    } catch { /* история best-effort */ }
  }
  useEffect(() => { fetch('/api/crm/state').then((r) => (r.ok ? r.json() : null)).then(setCrmState).catch(() => {}); }, []);

  async function markCrmBlocked(rows) {
    const emails = [...new Set(rows.map((r) => (r.email || '').toLowerCase()).filter(Boolean))];
    const domains = [...new Set(rows.map((r) => (r.domain || '').toLowerCase()).filter(Boolean))];
    if (!emails.length && !domains.length) return;
    try {
      const r = await fetch('/api/crm/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emails, domains }),
      });
      if (r.ok) setCrmBlocked(await r.json());
    } catch { /* барьер best-effort: pre-flight перед отправкой проверит ещё раз */ }
  }
  const previewTimer = useRef(null);

  // Живой предпросмотр «идеального лида» (методология, блок 1): debounce 1.5 c, Haiku, не блокирует Find.
  useEffect(() => {
    if (provider !== 'explee') return;
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      try {
        const r = await fetch('/api/angles/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ criteria: form }),
        });
        const data = await r.json();
        if (r.ok && data.llm) setIdealLead(data.ideal_lead);
      } catch { /* предпросмотр — best effort */ }
    }, 1500);
    return () => clearTimeout(previewTimer.current);
  }, [form, provider]);

  function computeScores(norm, flgs, verdicts = industryVerdicts) {
    return norm.map((r, i) => ({ fit: scoreFit(r, flgs[i], form, verdicts), value: scoreValue(r, form) }));
  }

  // Судим индустрии и ПЕРЕСЧИТЫВАЕМ скор: без пересчёта ось появилась бы только после
  // следующего действия, и оператор увидел бы старые цифры рядом с новыми вердиктами.
  async function judgeAndRescore(rows, flgs) {
    if (!form.industry) return;
    const companies = [...new Set(rows.map((r) => (r.companyIndustry || '').trim()).filter(Boolean))];
    if (!companies.length) return;
    try {
      const r = await fetch('/api/industry/judge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: form.industry, companies }),
      });
      if (!r.ok) return;
      const verdicts = await r.json();
      setIndustryVerdicts(verdicts);
      setScores(computeScores(rows, flgs, verdicts));
    } catch { /* ось best-effort: без вердиктов индустрия считается смежной, а не режется */ }
  }

  const [enriching, setEnriching] = useState(false);
  const [savingRegistry, setSavingRegistry] = useState(false);
  const [registryMsg, setRegistryMsg] = useState('');

  // Save shortlist → реестр (сегмент + контакты + мэтчи со снапшотом сигналов). ТЗ этап 2.
  async function saveToRegistry() {
    setSavingRegistry(true);
    setRegistryMsg('');
    try {
      const segmentName = [form.industry || 'Any industry', form.region !== 'Any' ? form.region : form.location,
        form.titles.join('/') || 'any titles', form.signal || null].filter(Boolean).join(' · ');
      const items = shortlist.map((r) => {
        const i = results.findIndex((x) => keyOf(x) === keyOf(r));
        return {
          ...r, identityKey: keyOf(r), source: provider, sources: [provider],
          liveness: r.liveness || null, livenessNote: r.livenessNote || null,
          fit: i >= 0 ? scores[i]?.fit : null, value: i >= 0 ? scores[i]?.value : null,
        };
      });
      const resp = await fetch('/api/registry/shortlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segmentName,
          criteria: form,
          signalsSnapshot: { signal: form.signal || null, signal2: form.signal2 || null, captured_at: new Date().toISOString() },
          items,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) setRegistryMsg(`⚠️ ${data.error || resp.status}`);
      else setRegistryMsg(`✓ saved: ${data.saved} contact(s), segment #${data.segmentId}`);
    } catch (e) {
      setRegistryMsg(`⚠️ ${String(e.message || e)}`);
    } finally {
      setSavingRegistry(false);
    }
  }

  // Enrich shortlist: Explee premium email (5 credits per contact).
  // Цели: без почты ИЛИ с сомнительной Apollo-почтой (guessed/unavailable) — методология
  // «Apollo guessed добиваем Explee-верификацией»; verified/valid повторно не оплачиваем.
  async function enrichShortlist() {
    const targets = shortlist.filter(
      (r) => (!r.email || ['guessed', 'unverified', 'unavailable'].includes(r.emailStatus))
        && r.domain && r.firstName && r.lastName,
    );
    if (!targets.length) return;
    // Подтверждений нет намеренно (решение Ольги 08.08: у Стаса confirm-диалоги блокировались,
    // и «кто работает — понимает»; стоимость написана на самой кнопке).
    setEnriching(true);
    try {
      // Параллелим по 3 (Explee premium ~10–20 c на контакт; последовательно 10+ лидов — минуты).
      const CONCURRENCY = 3;
      const queue = [...targets];
      async function worker() {
        while (queue.length) {
          const t = queue.shift();
          try {
            const r = await fetch('/api/explee/enrich-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ first_name: t.firstName, last_name: t.lastName, company_domain: t.domain }),
            });
            const data = await r.json();
            if (data?.meta?.remaining_balance != null) setBalance(data.meta.remaining_balance);
            const email = r.ok ? data.email : null;
            const status = r.ok ? (data.email_status || (email ? 'unknown' : 'not_found')) : 'error';
            // Explee не нашёл, а guessed-почта уже была → guessed остаётся (не затираем статус).
            setShortlist((prev) => prev.map((x) => (keyOf(x) === keyOf(t)
              ? { ...x, email: email || x.email, emailStatus: email ? status : (x.email ? x.emailStatus : status) }
              : x)));
          } catch { /* keep going; row stays without email */ }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      setEnriching(false);
    }
  }

  // Добивка почт из Apollo (перевёрнутый waterfall: 1 кр против 5 кр Explee premium).
  // Мэтч по linkedin_url либо имя+домен/компания; not found помечаем, чтобы не жечь кредит повторно.
  const [findingEmails, setFindingEmails] = useState(false);
  async function findEmailsApollo() {
    const targets = shortlist.filter(
      (r) => !r.email && r.emailStatus !== 'not_found_apollo'
        && (r.linkedin || (r.firstName && r.lastName && (r.domain || r.company))),
    );
    if (!targets.length) return;
    setFindingEmails(true);
    try {
      const queue = [...targets];
      async function worker() {
        while (queue.length) {
          const t = queue.shift();
          try {
            const r = await fetch('/api/apollo/find-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ linkedin: t.linkedin, firstName: t.firstName, lastName: t.lastName, domain: t.domain, company: t.company }),
            });
            const data = await r.json();
            if (!r.ok) continue;
            setShortlist((prev) => prev.map((x) => (keyOf(x) === keyOf(t)
              ? (data.email
                ? { ...x, email: data.email, emailStatus: data.email_status || 'unknown', revenue: x.revenue || data.revenue, sources: [...new Set([...(x.sources || ['explee']), 'apollo'])] }
                : { ...x, emailStatus: 'not_found_apollo', revenue: x.revenue || data.revenue })
              : x)));
          } catch { /* best effort, идём дальше */ }
        }
      }
      await Promise.all(Array.from({ length: 3 }, worker));
    } finally {
      setFindingEmails(false);
    }
  }

  // «Уникальная деталь» (Serper + Haiku): один факт компании для персонализации первого касания.
  const [findingDetails, setFindingDetails] = useState(false);
  async function findUniqueDetails() {
    const targets = shortlist.filter((r) => r.company && !r.uniqueDetail && !r.uniqueDetailChecked);
    if (!targets.length) return;
    setFindingDetails(true);
    try {
      const queue = [...targets];
      async function worker() {
        while (queue.length) {
          const t = queue.shift();
          try {
            const r = await fetch('/api/serper/unique-detail', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: t.name, title: t.title, company: t.company, domain: t.domain }),
            });
            const data = await r.json();
            if (!r.ok) continue;
            // Разведка возвращает несколько фактов (signal/problem/procurement) — все кладём
            // в варианты, первый становится выбранным; переключатель ◀ ▶ даёт выбрать другой.
            const opts = (data.details || []).map((d) => ({
              detail: d.detail, source: d.source_url || null, type: d.type || null, hook: d.hook || null,
            }));
            // Признаки закрытия компании приходят из того же разбора (методология, блок 1).
            // Второй слой после `is_alive`: тот не знает про свежие банкротства и поглощения.
            setShortlist((prev) => prev.map((x) => (keyOf(x) === keyOf(t)
              ? {
                ...x,
                liveness: data.liveness?.status || null,
                livenessNote: data.liveness?.note || null,
                uniqueDetail: opts[0]?.detail || null,
                uniqueDetailSource: opts[0]?.source || null,
                uniqueDetailType: opts[0]?.type || null,
                uniqueDetailHook: opts[0]?.hook || null,
                uniqueDetailChecked: true,
                uniqueDetailOptions: opts,
              }
              : x)));
          } catch { /* best effort */ }
        }
      }
      await Promise.all(Array.from({ length: 3 }, worker));
    } finally {
      setFindingDetails(false);
    }
  }

  // «↻ another»: повторный поиск с исключением ВСЕХ уже найденных вариантов; прошлые не теряются —
  // копятся в uniqueDetailOptions, выбор переключателем ◀ ▶ (вопрос Ольги 07.08: «вернуть уже не могу»).
  const [retryingDetailKey, setRetryingDetailKey] = useState(null);
  async function retryDetail(t) {
    setRetryingDetailKey(keyOf(t));
    try {
      const known = (t.uniqueDetailOptions || (t.uniqueDetail ? [{ detail: t.uniqueDetail, source: t.uniqueDetailSource }] : []));
      const r = await fetch('/api/serper/unique-detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: t.name, title: t.title, company: t.company, domain: t.domain,
          exclude: known.map((o) => o.detail).join(' /// ') || null,
        }),
      });
      const data = await r.json();
      const fresh = (data.details || []).map((d) => ({
        detail: d.detail, source: d.source_url || null, type: d.type || null, hook: d.hook || null,
      })).filter((d) => !known.some((k) => k.detail === d.detail));
      if (fresh.length) {
        const options = [...known, ...fresh];
        setShortlist((prev) => prev.map((x) => (keyOf(x) === keyOf(t)
          ? { ...x, uniqueDetail: fresh[0].detail, uniqueDetailSource: fresh[0].source, uniqueDetailType: fresh[0].type, uniqueDetailHook: fresh[0].hook, uniqueDetailChecked: true, uniqueDetailOptions: options }
          : x)));
      }
    } catch { /* best effort */ } finally {
      setRetryingDetailKey(null);
    }
  }

  // Переключение выбранного варианта детали (выбранный уходит в CSV и реестр).
  function selectDetailVariant(t, idx) {
    setShortlist((prev) => prev.map((x) => {
      if (keyOf(x) !== keyOf(t)) return x;
      const o = (x.uniqueDetailOptions || [])[idx];
      return o ? { ...x, uniqueDetail: o.detail, uniqueDetailSource: o.source, uniqueDetailType: o.type, uniqueDetailHook: o.hook } : x;
    }));
  }

  // Free second width indicator: Apollo total_entries (per_page:1, obfuscated feed — no reveal cost).
  async function fetchApolloWidth() {
    try {
      const r = await fetch('/api/apollo/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...buildApolloPayload(form, 1, 1) }),
      });
      const data = await r.json();
      setApolloTotal(data?.total_entries ?? data?.pagination?.total_entries ?? null);
    } catch { /* width indicator is best-effort */ }
  }

  // Список приходит уже собранным из таблицы: там применяется правило (порог по Fit, порядок
  // по Fit, тай-брейк Value, не больше 2 из компании) и там же оператор увидел расклад до
  // добавления. Здесь просто кладём в шорт-лист — второй раз фильтровать нельзя, иначе состав
  // разойдётся с тем, что было показано (ТЗ п.39).
  function addRecommended(list = []) {
    setShortlist((prev) => [...prev, ...list.filter((r) => !prev.some((s) => keyOf(s) === keyOf(r)))]);
  }

  // Apollo top-up: добор из второй базы с раскрытием (1 кредит = контакт сразу с email).
  const [toppingUp, setToppingUp] = useState(false);
  async function apolloTopUp(count = 10) {
    setToppingUp(true);
    setError('');
    try {
      const r = await fetch('/api/apollo/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchPayload: buildApolloPayload(form, count, 1), count }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.status);
      const incoming = normalizeResults('apollo', data).map((x) => ({ ...x, sources: ['apollo'] }));
      // Мердж (блок 5): дубль двух баз — не потеря кредита, а подтверждение + недостающие поля (email!).
      // sameIdentity ловит и разночтения компаний («Turner» vs «Turner Construction Company»).
      const merged = [...results];
      for (const n of incoming) {
        const i = merged.findIndex((x) => sameIdentity(x, n));
        if (i >= 0) {
          merged[i] = {
            ...merged[i],
            email: merged[i].email || n.email,
            emailStatus: merged[i].emailStatus || n.emailStatus,
            domain: merged[i].domain || n.domain,
            sources: [...new Set([...(merged[i].sources || ['explee']), 'apollo'])],
          };
        } else merged.push(n);
      }
      const flgs = merged.map((x, i) => flagResult(x, merged, i));
      setResults(merged);
      setFlags(flgs);
      setScores(computeScores(merged, flgs));
      markCrmBlocked(merged);
      loadRegistryState(merged);
      judgeAndRescore(merged, flgs);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setToppingUp(false);
    }
  }


  const isPicked = (r) => shortlist.some((s) => keyOf(s) === keyOf(r));
  const togglePick = (r) => {
    const i = results.findIndex((x) => keyOf(x) === keyOf(r));
    const enriched = { ...r, fit: r.fit ?? scores[i]?.fit ?? null, value: r.value ?? scores[i]?.value ?? null };
    setShortlist((prev) => (prev.some((s) => keyOf(s) === keyOf(r)) ? prev.filter((s) => keyOf(s) !== keyOf(r)) : [...prev, enriched]));
  };

  const [page, setPage] = useState(1);

  async function fetchPage(pageNum) {
    // Страница 1 в Explee-режиме — мультиугловой поиск (углы + реестр); Load more — базовый угол постранично.
    if (provider === 'explee' && pageNum === 1) {
      const r = await fetch('/api/search/angles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ criteria: form, basePayload: buildExpleePayload(form, 100, 1) }),
      });
      const data = await r.json();
      if (r.ok) return data;
      console.warn('angles search failed, falling back to single-angle:', data.error);
    }
    const url = provider === 'apollo' ? '/api/apollo/people' : '/api/explee/people';
    const payload = provider === 'apollo' ? buildApolloPayload(form, 10, pageNum) : buildExpleePayload(form, 100, pageNum);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Provider returned ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  async function onSearch() {
    setLoading(true);
    setError('');
    setResults([]);
    setFlags([]);
    setTotal(null);
    setRawResponse(null);
    setPage(1);
    setApolloTotal(null);
    setAngleStats(null);
    // Шорт-лист сбрасывается вместе с выдачей (находка 11.08). Раньше он переживал новый поиск,
    // и после смены фильтров на экране продолжали висеть контакты от прошлого запроса — отсюда
    // на встрече и возникло «в результатах остались DHL и компании 10000+», а заодно ложное
    // ощущение, что вторая Find «добирает». Сам поиск всегда был новым, врал именно шорт-лист.
    setShortlist([]);
    setCrmBlocked({ emails: {}, domains: {} });
    setIndustryVerdicts({});
    setRegistryState({});
    // Apollo-only (вопрос Ольги 07.08): точная проверка hiring/keywords-гипотезы без Explee-шума.
    // Explee не запускается; ширина Apollo + кнопки top-up доступны сразу.
    if (provider === 'explee' && form.apolloOnly) {
      try {
        await fetchApolloWidth();
        setRawResponse({ mode: 'apollo-only' });
      } finally {
        setLoading(false);
      }
      return;
    }
    if (provider === 'explee') fetchApolloWidth(); // parallel, best-effort
    try {
      const data = await fetchPage(1);
      setRawResponse(data);
      if (data?.meta?.remaining_balance != null) setBalance(data.meta.remaining_balance);
      if (data.ideal_lead) setIdealLead(data.ideal_lead);
      if (data.angleStats) {
        setAngleStats(data.angleStats);
        setTotal(Math.max(...data.angleStats.map((a) => a.total || 0)));
      } else {
        setTotal(data?.meta?.total ?? data?.pagination?.total_entries ?? data?.total_entries ?? null);
      }
      const norm = normalizeResults(provider, data).map((x, idx) => ({
        ...x,
        angles: data.people?.[idx]?._angles,
        fromRegistry: (data.people?.[idx]?._source || '').includes('registry'),
      }));
      const flgs = norm.map((x, i) => flagResult(x, norm, i));
      setResults(norm);
      setFlags(flgs);
      setScores(computeScores(norm, flgs));
      markCrmBlocked(norm);
      loadRegistryState(norm);
      judgeAndRescore(norm, flgs);
      // ⚠️ ЗДЕСЬ РАНЬШЕ БЫЛ АВТОМАТИЧЕСКИЙ ПОСТРАНИЧНЫЙ ОБХОД ВСЕГО ПУЛА — и он молча тратил
      // деньги. Explee берёт 1 кредит за каждый результат сверх первых 100 набора фильтров,
      // поэтому обход страниц 2…30 стоил до ~200 кредитов за один поиск. Полная модель
      // тарификации и замеры — в шапке `angles.js`.
      //
      // Объём берётся ЧИСЛОМ УГЛОВ, а не глубиной страниц: у каждого угла (набора фильтров)
      // своя бесплатная сотня, восемь углов дают ~800 сырых строк за $0. Если выдачи мало —
      // добавляй углы или расширяй критерии, но НЕ включай обход страниц обратно.
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }


  return (
    <div className="layout">
      <Sidebar active={tab} onSelect={setTab} />
      <div className="main">
        <header className="topbar">
          <h1>Outreach Hub <span className="badge">prototype v0</span></h1>
          {balance != null && <span className="badge balance">Explee: {balance} credits</span>}
        </header>
        {tab === 'contacts' && (
          <div className="content single">
            <div className="right-pane">
              <ContactsTab onSendToCampaign={(batch) => { setCampaignPreselect(batch); setTab('campaigns'); }} />
            </div>
          </div>
        )}
        {tab === 'campaigns' && (
          <div className="content single">
            <div className="right-pane">
              <CampaignsTab preselect={campaignPreselect} />
            </div>
          </div>
        )}
        {tab === 'inbox' && (
          <div className="content single">
            <div className="right-pane"><InboxTab /></div>
          </div>
        )}
        {tab === 'settings' && (
          <div className="content single">
            <div className="right-pane">
              <SettingsTab />
            </div>
          </div>
        )}
        <div className="content" style={{ display: tab === 'search' ? undefined : 'none' }}>
          <div className="left-pane">
            <SearchForm
              value={form} onChange={setForm} onSearch={onSearch}
              loading={loading} provider={provider} setProvider={setProvider}
              shortlistCount={shortlist.length}
            />
            {idealLead && (
              <div className="ideal-lead">
                <div className="ideal-lead-title">🎯 Ideal lead (AI preview)</div>
                <p>{idealLead}</p>
                <div className="ideal-lead-hint">To adjust — change the filters above.</div>
              </div>
            )}
          </div>
          <div className="right-pane">
            {error && <div className="error">{error}</div>}
            {angleStats && (
              <div className="angle-stats">
                Angles: {angleStats.map((a) => `${a.angle} ${a.error ? '⚠️' : `${a.returned}${a.total != null ? `/${Number(a.total).toLocaleString('en-US')}` : ''}`}`).join(' · ')}
              </div>
            )}
            {!rawResponse && !error && (
              <div className="empty-state">
                <div className="empty-icon">🔍</div>
                <h2>Start your lead search</h2>
                <p>Define the target segment on the left, then click <b>Find People</b>. Signals narrow the pool to companies showing buying-moment indicators.</p>
              </div>
            )}
            <Shortlist
              items={shortlist} onRemove={togglePick} onClear={() => setShortlist([])}
              onEnrich={enrichShortlist} enriching={enriching}
              onFindEmails={findEmailsApollo} findingEmails={findingEmails}
              onUniqueDetails={findUniqueDetails} findingDetails={findingDetails}
              onRetryDetail={retryDetail} retryingDetailKey={retryingDetailKey} keyOf={keyOf}
              onSelectDetailVariant={selectDetailVariant}
              onSave={saveToRegistry} saving={savingRegistry} saveMsg={registryMsg}
            />
            <ResultsTable
              results={results} rawResponse={rawResponse} total={total} apolloTotal={apolloTotal}
              isPicked={isPicked} onToggle={togglePick} flags={flags} scores={scores} form={form}
              onAddRecommended={addRecommended} recommendThreshold={FIT_RECOMMEND_THRESHOLD}
              crmBlocked={crmBlocked} crmState={crmState} industryVerdicts={industryVerdicts}
              registryState={registryState}
            />
            {(results.length > 0 || apolloTotal > 0) && (
              <div className="load-buttons">
                {/* Кнопок добора страниц здесь нет СОЗНАТЕЛЬНО: у Explee всё сверх первых 100
                    результатов набора фильтров стоит 1 кредит за строку, поэтому обход страниц —
                    платный путь. Объём набирается углами: у каждого своя бесплатная сотня.
                    Добор из Apollo остаётся — он платный и потому только вручную, с ценой на кнопке. */}
                {results.length > 0 && total > results.length && (
                  <span className="hint">
                    Loaded {results.length} of {Number(total).toLocaleString('en-US')} — free zone is
                    the first 100 per angle. To get more, widen the segment or add angles: paging
                    deeper is billed 1 credit per row.
                  </span>
                )}
                {provider === 'explee' && apolloTotal > 0 && (
                  <>
                    <button className="load-more topup" onClick={() => apolloTopUp(10)} disabled={toppingUp}>
                      {toppingUp ? 'Topping up…' : 'Top up from Apollo +10 (≈10 cr)'}
                    </button>
                    <button className="load-more topup" onClick={() => apolloTopUp(50)} disabled={toppingUp}>
                      +50 (≈50 cr)
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
