// Сервер Outreach Hub: прокси к провайдерам + реестр контактов (Postgres) + статика фронта в проде.
// Ключи — только здесь (env), фронт их не видит.
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRegistry, registryEnabled, saveShortlist, listContacts, registryStats, setContactLifecycle, registryAngle, backfillLinkedinSlugs, importLinkedinHistory } from './db/registry.js';
import { processSmartleadEvent, closeCampaign } from './db/webhooks.js';
import { generateAngles, runAngles, identityKeyServer } from './angles.js';
import {
  listMessageAngles, saveMessageAngle, approveMessageAngle, listSegments,
  campaignCandidates, listCampaigns, createCampaignRow, updateCampaignRow,
  markContactsActive, campaignsWithoutSends, listReplies, upsertZeroRunContacts,
  backfillSenderIdentities, createBatch, listBatches, getBatchContacts,
  closeConversation, reopenConversation, markMeetingScheduled, setKommoLeadIds,
  autoCloseStaleConversations, waitingConversations,
  applyCatchAllQuota, contactsForQuota, markDeferred, CATCH_ALL_QUOTA,
  campaignBounceStats, deliverabilityDigest, BOUNCE_FLOOR, BOUNCE_ALERT, BOUNCE_PAUSE,
  reserveContacts, releaseReservation, registryStateByEmail, RESERVE_DAYS, openCampaignsToCheck, unavailableForBatch,
  REPLY_MATURATION_DAYS,
} from './db/campaigns.js';
import { kommoEnabled, pushLeadsToQualified, moveLeadToMeeting, createLeadAtMeetingStage, buildCrmBlocklist, checkEmailsLive, integrationRules, noteStopListChange, unprotectedWarmLeads } from './kommo.js';
import { replaceCrmBlocklist, crmSyncState, checkBlocked, blockedContactIds, listBlocklist, setOverride, revokeOverride,
  blocklistByStage, setStageRule, revokeStageRule, activeStageRules, effectiveBlockCounts, filterLiveHits, bulkOverride, noteSyncFailure } from './db/crm.js';
import { getState, setState } from './db/state.js';
import { linkedinSlug } from './linkedin.js';
import { judgeIndustries } from './industry.js';
import { sendTelegram } from './notify.js';
import * as smartlead from './smartlead.js';
import { compressDetail } from './classify.js';
import { replyKnowledge, senderCard, cardByName, WRITING_STYLE } from './knowledge.js';
import { verifyEnabled, verifyEmail, credits as verifyCredits } from './verify.js';
import { contactsToVerify, staleContacts, applyVerification, verifyCounters, sourceQuality } from './db/validation.js';
import { seedUsersFromEnv, anyUsers, verifyUser, listUsers, createUser, setUserActive, writeAudit, listAudit, auditActors } from './db/users.js';
import {
  identityOf, identityFromSignature, validateSenders, ensureSignature, knownSigners, angleNameFor,
  validateLinkedinTexts,
} from './identities.js';
import * as getsales from './getsales.js';
import { currentProblems, ackProblem } from './health.js';
import { syncLinkedinCampaigns, channelConfig, saveChannelConfig, lateAcceptStats, markAcceptedByHand, repairSendTouch } from './getsales-sync.js';
import { checkLinkedinLive } from './kommo.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Авторизация (ТЗ п.37). Механизм прежний — Basic на том же адресе, но пары логин/пароль
// на человека вместо общего пароля: логин браузер и так присылал, раньше код его выбрасывал.
// Исключения: health и вебхуки провайдеров (у них своя аутентификация по секрету) — иначе
// закрытие приложения молча убило бы приём ответов лидов.
const OPEN_PATHS = [/^\/api\/health$/, /^\/api\/webhooks\//];

function parseBasic(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  const raw = Buffer.from(header.slice(6), 'base64').toString();
  const i = raw.indexOf(':');
  return i < 0 ? { login: raw, password: '' } : { login: raw.slice(0, i), password: raw.slice(i + 1) };
}

app.use(async (req, res, next) => {
  if (OPEN_PATHS.some((re) => re.test(req.path))) return next();
  const creds = parseBasic(req);
  const deny = () => {
    res.set('WWW-Authenticate', 'Basic realm="Outreach Hub"');
    return res.status(401).send('Authentication required');
  };
  try {
    // Есть заведённые пользователи → работаем только по ним.
    if (await anyUsers()) {
      if (!creds) return deny();
      const user = await verifyUser(creds.login, creds.password);
      if (!user) return deny();
      req.user = user;
      return next();
    }
  } catch (e) {
    console.error('[auth] проверка пользователя упала:', e.message);
    // Падение БД не должно открывать приложение — уходим в общий пароль ниже.
  }
  // Пользователей ещё нет — прежний режим общего пароля, чтобы деплой ничего не сломал.
  const pass = process.env.APP_PASSWORD;
  if (!pass) { req.user = { login: 'local', name: 'local' }; return next(); }
  if (creds && creds.password === pass) {
    req.user = { login: creds.login || 'panel user', name: creds.login || 'panel user' };
    return next();
  }
  return deny();
});

// Кто выполняет действие — для журнала и для полей вроде approved_by.
const actorOf = (req) => req.user?.name || req.user?.login || 'unknown';

const EXPLEE = 'https://api.explee.com/public/api/v1';
const APOLLO = 'https://api.apollo.io/api/v1';

function requireKey(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} не задан в .env`);
  return v;
}

// --- Explee: поиск людей (people_filters + company_filters) ---
app.post('/api/explee/people', async (req, res) => {
  try {
    const r = await fetch(`${EXPLEE}/search/people`, {
      method: 'POST',
      headers: { 'X-API-Key': requireKey('EXPLEE_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Explee: поиск компаний ---
app.post('/api/explee/companies', async (req, res) => {
  try {
    const r = await fetch(`${EXPLEE}/search/companies`, {
      method: 'POST',
      headers: { 'X-API-Key': requireKey('EXPLEE_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Apollo: поиск людей (mixed_people/api_search — старый /search deprecated) ---
app.post('/api/apollo/people', async (req, res) => {
  try {
    const r = await fetch(`${APOLLO}/mixed_people/api_search`, {
      method: 'POST',
      headers: { 'X-Api-Key': requireKey('APOLLO_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Explee: обогащение email (premium = 6 провайдеров, verified; 5 кредитов/контакт) ---
app.post('/api/explee/enrich-email', async (req, res) => {
  try {
    const r = await fetch(`${EXPLEE}/enrich/email`, {
      method: 'POST',
      headers: { 'X-API-Key': requireKey('EXPLEE_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'premium', ...req.body }),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Реестр (Postgres; без DATABASE_URL — 503, локальная панель живёт без БД) ---
function requireRegistry(res) {
  if (!registryEnabled()) {
    res.status(503).json({ error: 'registry not configured (no DATABASE_URL)' });
    return false;
  }
  return true;
}

app.post('/api/registry/shortlist', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    res.json(await saveShortlist(req.body));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Лента касаний одного лида: что именно с ним произошло, когда и по чьей воле.
// Понадобилась на разборе 17.08 («принял — почему не написали?»): агрегаты по кампании
// отвечают «сколько», а вопрос был «что случилось с этим человеком».
app.get('/api/registry/contacts/:id/touches', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { getPool } = await import('./db/registry.js');
    const id = Number(req.params.id);
    // Лента = события + провалы. Ошибки отправки живут в `verification` (решение L5.5),
    // и без них лента врала бы умолчанием: «ничего не показано» читается как «всё хорошо».
    const [ev, fails, contact] = await Promise.all([
      getPool().query(
        `SELECT t.id, t.channel, t.event, t.occurred_at, t.campaign_ext_id,
                c.id AS campaign_id, c.channel AS campaign_channel,
                t.meta->>'by' AS by, t.meta->>'actor' AS actor,
                t.meta->>'sender_profile_uuid' AS sender_profile,
                t.meta->>'delivery' AS delivery, t.meta->>'gs_message_uuid' AS gs_message_uuid,
                t.meta->>'import' AS imported, t.meta->>'subject' AS subject,
                left(t.meta->>'text', 2000) AS text
           FROM touch t
           LEFT JOIN campaign c ON c.external_id = t.campaign_ext_id
          WHERE t.contact_id = $1 ORDER BY t.occurred_at`,
        [id],
      ),
      getPool().query(
        `SELECT id, kind, result, provider, created_at FROM verification
          WHERE contact_id = $1 ORDER BY created_at`,
        [id],
      ).catch(() => ({ rows: [] })),
      getPool().query(
        `SELECT id, full_name, company, email, linkedin_slug, lifecycle, quarantine_until FROM contact WHERE id = $1`,
        [id],
      ),
    ]);
    res.json({ contact: contact.rows[0] || null, events: ev.rows, failures: fails.rows });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Статус волны по людям (L5.11): кто на каком шаге и чего ждём. Отвечает на вопрос
// «что происходит с волной прямо сейчас» — в отличие от агрегатов, которые отвечают «сколько».
app.get('/api/campaigns/:id/leads', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { getPool } = await import('./db/registry.js');
    const camp = (await getPool().query('SELECT * FROM campaign WHERE id = $1', [Number(req.params.id)])).rows[0];
    if (!camp) return res.status(404).json({ error: 'campaign not found' });
    const r = await getPool().query(
      `SELECT c.id, c.full_name, c.company, c.email, c.linkedin_slug, c.lifecycle,
              -- Скор нужен рядом с отправителем: без него нельзя проверить правило
              -- «лучших — Стэну» (вопрос Ольги 18.08). Берём лучший матч по сегментам.
              (SELECT max(m.value_score) FROM contact_segment_match m WHERE m.contact_id = c.id) AS value_score,
              (SELECT max(m.fit_score) FROM contact_segment_match m WHERE m.contact_id = c.id) AS fit_score,
              (SELECT t.event FROM touch t WHERE t.contact_id = c.id AND t.campaign_ext_id = $1
                ORDER BY t.occurred_at DESC LIMIT 1) AS last_event,
              (SELECT t.occurred_at FROM touch t WHERE t.contact_id = c.id AND t.campaign_ext_id = $1
                ORDER BY t.occurred_at DESC LIMIT 1) AS last_at,
              (SELECT t.meta->>'delivery' FROM touch t WHERE t.contact_id = c.id AND t.campaign_ext_id = $1
                AND t.event IN ('message_sent', 'message_followup', 'sent')
                ORDER BY t.occurred_at DESC LIMIT 1) AS last_delivery
         FROM contact c
        WHERE c.id = ANY($2::int[]) ORDER BY c.full_name`,
      [camp.external_id, Object.values(camp.meta?.getsales?.lead_map || {}).map(Number).length
        ? Object.values(camp.meta.getsales.lead_map).map(Number)
        : (await getPool().query(
          'SELECT DISTINCT contact_id FROM touch WHERE campaign_ext_id = $1', [camp.external_id],
        )).rows.map((x) => x.contact_id)],
    );
    // Кто отправляет этому лиду: назначение зафиксировано при запуске ячейки. Показываем
    // ИМЯ профиля, а не uuid — правило «лучших Стэну» проверяют глазами, а не сверкой строк.
    const assignment = camp.meta?.getsales?.assignment || {};
    let names = {};
    if (camp.channel === 'linkedin' && Object.keys(assignment).length) {
      try {
        const profs = await getsales.listSenderProfiles();
        names = Object.fromEntries((profs || []).map((p) => [p.uuid, [p.first_name, p.last_name].filter(Boolean).join(' ') || p.label || p.uuid]));
      } catch { /* имена — украшение, отсутствие профилей не должно ронять разрез волны */ }
    }
    res.json({
      campaign: { id: camp.id, channel: camp.channel, status: camp.status },
      leads: r.rows.map((l) => {
        const uuid = assignment[String(l.id)] || null;
        return { ...l, sender_profile_uuid: uuid, sender_name: uuid ? (names[uuid] || uuid.slice(0, 8)) : null };
      }),
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/registry/contacts', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const out = await listContacts({
      lifecycle: req.query.lifecycle, q: req.query.q,
      segmentId: req.query.segmentId, since: req.query.since,
      emailStatus: req.query.emailStatus, hideImported: req.query.hideImported === '1',
      limit: req.query.limit, offset: req.query.offset,
    });
    // Совместимость: без параметра offset отвечаем массивом, как раньше (селектор лидов
    // в кампаниях и старые вызовы); с offset — {rows, total} для страниц реестра.
    res.json(req.query.offset !== undefined ? out : out.rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/registry/stats', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try {
    res.json(await registryStats());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Apollo top-up: добор из второй базы с раскрытием (1 кредит = контакт сразу с email) ---
app.post('/api/apollo/topup', async (req, res) => {
  try {
    const { searchPayload, count = 10 } = req.body;
    const key = requireKey('APOLLO_API_KEY');
    const sr = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...searchPayload, per_page: Math.min(count * 2, 100), page: 1 }),
    });
    const sdata = await sr.json();
    if (!sr.ok) return res.status(sr.status).json(sdata);
    const ids = (sdata.people || []).map((p) => p.id).slice(0, count);

    // Раскрытие по 3 параллельно (people/match, ~1 кредит/чел).
    const revealed = [];
    const queue = [...ids];
    async function worker() {
      while (queue.length) {
        const id = queue.shift();
        try {
          const mr = await fetch('https://api.apollo.io/api/v1/people/match', {
            method: 'POST',
            headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, reveal_personal_emails: false }),
          });
          const mdata = await mr.json();
          if (mr.ok && mdata.person) revealed.push(mdata.person);
        } catch { /* пропускаем сбойного, добор best-effort */ }
      }
    }
    await Promise.all(Array.from({ length: 3 }, worker));
    console.log(`[apollo:topup] requested=${count} revealed=${revealed.length}`);
    res.json({ people: revealed, total_entries: sdata.total_entries ?? null, spent_credits_estimate: revealed.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Apollo: точечный поиск email для контакта шорт-листа (people/match, ~1 кредит) ---
// «Перевёрнутый waterfall»: сначала дешёвый Apollo (1 кр), Explee premium (5 кр) — добивка.
app.post('/api/apollo/find-email', async (req, res) => {
  try {
    const { linkedin, firstName, lastName, domain, company } = req.body;
    const body = { reveal_personal_emails: false };
    if (linkedin) body.linkedin_url = linkedin;
    if (firstName && lastName) { body.first_name = firstName; body.last_name = lastName; }
    if (domain) body.domain = domain;
    if (company) body.organization_name = company;
    const r = await fetch(`${APOLLO}/people/match`, {
      method: 'POST',
      headers: { 'X-Api-Key': requireKey('APOLLO_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const p = data.person || null;
    // Верификация мэтча: без linkedin Apollo может вернуть ТЁЗКУ из другой компании
    // (живой кейс 07.08: Steven Flanagan @ Owens Corning → вернулся Flanagan из Carrier).
    let companyOk = Boolean(p);
    if (p && !linkedin) {
      const orgDomain = (p.organization?.primary_domain || '').toLowerCase();
      const orgName = (p.organization?.name || '').toLowerCase();
      const wantDomain = (domain || '').toLowerCase();
      const coWord = (company || '').toLowerCase().split(/\s+/)[0];
      companyOk = Boolean((wantDomain && orgDomain === wantDomain)
        || (coWord && coWord.length >= 3 && orgName.includes(coWord)));
    }
    const email = companyOk && p?.email && !/email_not_unlocked/.test(p.email) ? p.email : null;
    console.log(`[apollo:find-email] ${firstName || ''} ${lastName || ''} @ ${company || domain || ''} → ${email ? p.email_status || 'found' : (p && !companyOk ? 'wrong-company match dropped' : 'not found')}`);
    // Выручка приезжает вместе с reveal и стоит нам ноль дополнительных кредитов —
    // забираем её всегда, даже когда адрес не нашёлся (найдено 13.08).
    const revenue = companyOk ? Number(p?.organization?.annual_revenue || p?.organization?.organization_revenue) || null : null;
    res.json({ email, email_status: email ? (p.email_status || 'unknown') : null, revenue, matched: Boolean(p), company_mismatch: Boolean(p) && !companyOk });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Serper + Haiku: разведка по компании лида (расширено 08.08 по решению Ольги) ---
// Было: один факт. Стало: НЕСКОЛЬКО фактов трёх типов — signal (событие), problem (боль компании),
// procurement (закупочный контекст). Три параллельных Google-запроса; LLM отбирает проверяемые факты
// и объясняет, чем каждый цепляет закупки. Оператор выбирает нужный переключателем ◀ ▶.
app.post('/api/serper/unique-detail', async (req, res) => {
  try {
    const { name, title, company, domain, exclude } = req.body;
    if (!company) return res.status(400).json({ error: 'company required' });
    const key = requireKey('SERPER_API_KEY');
    // Три запроса про персонализацию ограничены последним годом — свежий факт и нужен.
    // Четвёртый — про закрытие компании — БЕЗ ограничения по времени, и это не мелочь:
    // тест 12.08 показал, что Fry's Electronics (закрылась в 2021) даёт НОЛЬ результатов
    // в окне года, то есть проверка живости не поймала бы ровно тот случай, ради которого
    // делалась. Смерть компании не устаревает — искать её надо по всей истории.
    const queries = [
      { q: `"${company}" (news OR announcement OR expansion OR acquisition OR launch OR award OR contract)`, recent: true },
      { q: `"${company}" (challenges OR "cost pressure" OR "supply chain disruption" OR restructuring OR "cost reduction" OR layoffs)`, recent: true },
      { q: `"${company}" (procurement OR sourcing OR suppliers OR "supply chain") strategy`, recent: true },
      { q: `"${company}" (bankruptcy OR "chapter 11" OR "ceased operations" OR "went out of business" OR liquidation OR "shut down" OR acquired)`, recent: false },
    ];
    const searches = await Promise.all(queries.map(async ({ q, recent }) => {
      try {
        const sr = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, num: 8, gl: 'us', hl: 'en', ...(recent ? { tbs: 'qdr:y' } : {}) }),
        });
        const sdata = await sr.json();
        return (sdata.organic || []).slice(0, 8)
          .map((o) => ({ title: o.title, snippet: o.snippet, link: o.link, date: o.date || null }));
      } catch { return []; }
    }));
    const organic = searches.flat();
    if (!organic.length) return res.json({ detail: null, details: [], reason: 'no search results' });
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ detail: null, details: [], reason: 'no LLM key' });

    const prompt = `You research a company before a cold B2B email from a procurement-software vendor. Below are Google results (past year) for "${company}"${domain ? ` (website: ${domain})` : ''}. The prospect is ${name || 'a decision maker'}, ${title || 'procurement leader'}.

Extract UP TO 4 distinct, specific, verifiable facts about THIS exact company. Rules:
- Must clearly refer to this company — skip results about same-named other companies (check the website domain when present).
- Company-level facts only, nothing personal about the prospect.
- No generic industry trends, no listicles/rankings, no job-board postings.
- Prefer variety over volume: different facts, not four angles on one event.
- "detail": neutral factual English, max 25 words, no marketing adjectives.
- "type": "signal" (expansion, acquisition, contract, launch, investment), "problem" (cost pressure, supply-chain disruption, restructuring, margin squeeze, recall), or "procurement" (anything about how they buy, suppliers, sourcing strategy).
- "hook": max 15 words — why this matters to a procurement leader. Be concrete, never salesy.
${exclude ? `- Already used (do NOT repeat these, find DIFFERENT facts): "${exclude}"` : ''}

ALSO judge whether the company still exists as a going concern. You are already reading the news —
this costs nothing extra. Look for: bankruptcy or Chapter 7/11 filings, "ceased operations", "shut down",
"went out of business", liquidation, or an acquisition that dissolved the company into the buyer.
A mere restructuring, layoffs or a minority investment is NOT a death signal. If nothing suggests it,
say alive — silence is not evidence of death.

Return STRICT JSON only:
{"details":[{"detail":"...","type":"signal|problem|procurement","hook":"...","source_url":"...","confidence":"high|medium|low"}],
 "liveness":{"status":"alive|dead|uncertain","note":"<max 12 words, only if not alive>","source_url":"<if any>"}}
If nothing clearly about this company — {"details":[], "liveness":{"status":"uncertain"}}.

Results:
${JSON.stringify(organic, null, 1)}`;

    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 900, messages: [{ role: 'user', content: prompt }] }),
    });
    const adata = await ar.json();
    if (!ar.ok) return res.status(502).json({ error: `anthropic ${ar.status}` });
    const text = (adata.content?.[0]?.text || '{}').replace(/^```json?\s*|\s*```$/g, '');
    const parsed = JSON.parse(text);
    const details = (parsed.details || []).filter((d) => d?.detail).slice(0, 4);
    // Второй слой защиты от мёртвых компаний (методология, блок 1). Признаки закрытия достаём
    // из ТОГО ЖЕ разбора новостей — дополнительных вызовов и денег не требуется.
    // `is_alive` у Explee не знает про поглощения и банкротства свежее его базы, а новости знают.
    const liveness = ['alive', 'dead', 'uncertain'].includes(parsed.liveness?.status)
      ? parsed.liveness : { status: 'uncertain' };
    if (liveness.status === 'dead') console.warn(`[serper:intel] ⚠️ ${company} — признаки закрытия: ${liveness.note || '—'}`);
    console.log(`[serper:intel] ${company} → ${details.length} facts: ${details.map((d) => d.type).join('/')} · liveness=${liveness.status}`);
    // detail/source_url — для обратной совместимости (retry, CSV, реестр).
    res.json({
      detail: details[0]?.detail || null,
      source_url: details[0]?.source_url || null,
      confidence: details[0]?.confidence || null,
      liveness,
      details,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Углы (методология, блоки 1–2, 5): предпросмотр идеального лида + мультиугловой поиск ---
app.post('/api/angles/preview', async (req, res) => {
  try {
    const g = await generateAngles(req.body.criteria || {});
    res.json({ ideal_lead: g.ideal_lead, angles: g.angles.map((a) => a.label), llm: g.llm !== false });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/search/angles', async (req, res) => {
  try {
    const { criteria = {}, basePayload } = req.body;
    if (!basePayload) return res.status(400).json({ error: 'basePayload required' });

    const g = await generateAngles(criteria).catch((e) => {
      console.error('[angles] LLM failed, falling back to base angle:', e.message);
      return { ideal_lead: null, angles: [{ label: 'base', titles: criteria.titles || [], definition: null }], llm: false };
    });

    // Угол №0 — реестр (бесплатные проверенные кандидаты), параллельно с Explee-углами.
    const [explee, registryRows] = await Promise.all([
      runAngles({ basePayload, angles: g.angles, pageSize: 10 }),
      registryEnabled()
        ? registryAngle({ titles: criteria.titles || [], location: criteria.location, sizes: criteria.sizes || [] }).catch(() => [])
        : Promise.resolve([]),
    ]);

    // Union: реестр первым (приоритет по верифицированным контактам), Explee-дубли помечаются.
    const seen = new Map();
    for (const c of registryRows) {
      seen.set(identityKeyServer(c), { ...c, company_name: c.company, _angles: ['registry'], _source: 'registry' });
    }
    for (const p of explee.results) {
      const k = identityKeyServer(p);
      if (seen.has(k)) {
        const cur = seen.get(k);
        cur._angles = [...new Set([...cur._angles, ...p._angles])];
        cur._source = cur._source === 'registry' ? 'registry+explee' : cur._source;
      } else seen.set(k, p);
    }

    res.json({
      ideal_lead: g.ideal_lead,
      llm: g.llm !== false,
      angleStats: [
        { angle: 'registry', total: registryRows.length, returned: registryRows.length, error: null },
        ...explee.angleStats,
      ],
      people: [...seen.values()],
      meta: { remaining_balance: explee.balance },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ============ Этап кампаний (решения 07.08) ============

// --- Библиотека заходов (message angles) ---
app.get('/api/message-angles', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await listMessageAngles()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/message-angles', async (req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await saveMessageAngle(req.body)); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Удаление черновика захода (запрос Ольги 08.08 — библиотека забивается пробными генерациями).
// Утверждённые и использованные в кампаниях не трогаем: на них ссылается история матрицы.
app.delete('/api/message-angles/:id', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { getPool } = await import('./db/registry.js');
    const used = await getPool().query('SELECT COUNT(*)::int AS n FROM campaign WHERE message_angle_id = $1', [Number(req.params.id)]);
    if (used.rows[0].n > 0) return res.status(400).json({ error: `angle is used by ${used.rows[0].n} campaign(s) — kept for matrix history` });
    const r = await getPool().query(`DELETE FROM message_angle WHERE id = $1 AND status = 'draft' RETURNING id`, [Number(req.params.id)]);
    if (!r.rowCount) return res.status(400).json({ error: 'only draft angles can be deleted' });
    res.json({ deleted: r.rowCount });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Близнец захода для второго отправителя (запрос Ольги 08.08): тот же текст, другая подпись.
// Имя захода сохраняется — это одна messaging-гипотеза, а (name + sender_identity) = ячейка матрицы,
// поэтому «тот же текст от Стэна и от Антона» сравним между собой.
// Апрув НЕ наследуется: подпись изменилась, текст обязан быть перечитан человеком.
app.post('/api/message-angles/:id/twin', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { signedBy } = req.body;
    if (!signedBy) return res.status(400).json({ error: 'signedBy required' });
    const src = (await listMessageAngles()).find((a) => a.id === Number(req.params.id));
    if (!src) return res.status(404).json({ error: 'angle not found' });
    const identity = identityOf(`${String(signedBy).toLowerCase()}@zinit.com`).id;
    if (identity === src.sender_identity) return res.status(400).json({ error: 'the angle is already signed by this sender' });

    // КРИТИЧНО: близнец переписывает текст под другого человека, а не подменяет подпись.
    // Баг 08.08: в тексте оставалось «ex-McKinsey, co-founder» Стэна под подписью Антона —
    // письмо становилось ложью. Строку доверия и голос берём из карточки нового отправителя.
    const card = senderCard(signedBy);
    let sequence = (src.sequence || []).map((s) => ({ ...s, body: ensureSignature(s.body, signedBy) }));
    if (process.env.ANTHROPIC_API_KEY && card) {
      const prompt = `Rewrite this cold email sequence so it comes from ${signedBy} instead of the previous sender.

RULES:
- Keep the message, the structure, the length and the ask exactly as they are. This is the SAME
  messaging hypothesis — only the person speaking changes.
- Replace ANY credibility/background claim with ${signedBy}'s own from the sender card below.
  If a claim belongs to the previous sender (a past employer, a co-founder role, a personal story),
  it must NOT survive — remove it or swap it for ${signedBy}'s equivalent.
- Keep the variables ({{first_name}}, {{company_name}}, {{unique_detail_short}}) in the same places.
- Keep spintax {a|b} where it is.
- Sign every email "${signedBy}" on the last line, alone.
- Plain text, no links, no markdown.

${WRITING_STYLE}

SENDER CARD for ${signedBy}:
${card.text}

SEQUENCE TO REWRITE (JSON):
${JSON.stringify(sequence.map((s) => ({ wait_days: s.wait_days, subject: s.subject, body: s.body })), null, 1)}

Return STRICT JSON only: {"sequence":[{"wait_days":0,"subject":"...","body":"..."}, ...]}`;
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
        });
        const data = await r.json();
        if (r.ok) {
          const parsed = JSON.parse((data.content?.[0]?.text || '{}').replace(/^```json?\s*|\s*```$/g, ''));
          if (parsed.sequence?.length === sequence.length) {
            sequence = parsed.sequence.map((s) => ({ ...s, body: ensureSignature(s.body, signedBy) }));
          }
        }
      } catch (e) {
        console.error('[angle:twin] rewrite failed, falling back to signature-only:', e.message);
      }
    }

    const saved = await saveMessageAngle({
      name: angleNameFor(src.name, signedBy),
      description: `${src.description || ''}`.replace(/\s*\(signed by [^)]+\)$/i, '').trim(),
      sequence,
      variables: src.variables,
      senderIdentity: identity,
      // LinkedIn-часть обезличена по построению (L2.4) — близнецу переезжает как есть.
      linkedin: src.linkedin || null,
    });
    console.log(`[angle:twin] #${src.id} "${src.name}" → twin for ${signedBy} (#${saved.id})`);
    res.json(saved);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Проверка LinkedIn-части захода (L2.4): переменные без источника, подпись/личные строки
// (шаблон обезличен — отправитель назначается per lead), мягкие лимиты длины.
app.post('/api/message-angles/validate-linkedin', (req, res) => {
  try { res.json(validateLinkedinTexts(req.body?.linkedin)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Апрув текста — кнопкой в приложении (факт+дата; Тони вне системы — решение Ольги 07.08).
app.post('/api/message-angles/:id/approve', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    // Актор берём из авторизации; заголовок Cloudflare оставлен как будущий источник —
    // после перехода он подменит логин на почту без изменения кода вокруг (ТЗ п.37).
    const by = req.headers['cf-access-authenticated-user-email'] || actorOf(req);
    const saved = await approveMessageAngle(Number(req.params.id), String(by));
    await writeAudit({ actor: actorOf(req), action: 'angle.approve', entity: 'message_angle', entityId: req.params.id, meta: { name: saved?.name } });
    res.json(saved);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Драфт цепочки писем из критериев сегмента + базы знаний Zinit (конструктор сообщения, 08.08).
// Матрица: сегмент (кому) × знания Zinit (что даём) → message angle (что пишем).
app.post('/api/message-angles/draft', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'no ANTHROPIC_API_KEY' });
    const { criteria = {}, instruction = '', signedBy = 'Stan' } = req.body;
    const segmentText = [
      criteria.industry, (criteria.titles || []).join(', '), criteria.titleType,
      criteria.hiringRole ? `hiring ${criteria.hiringRole} roles` : '',
      criteria.signal, criteria.signal2, criteria.keywords,
      (criteria.sizes || []).length ? 'enterprise' : '',
    ].filter(Boolean).join(' ');

    // Знания ищем по сегменту И по явной инструкции оператора (например «упор на GPO benchmark»).
    const { context: kbBase, sources: kbSources } = replyKnowledge({ replyText: instruction || segmentText, profile: segmentText });
    if (!kbBase) return res.status(422).json({ error: 'no matching knowledge cards — fill in the segment filters first' });
    // Позиционирование и карточка отправителя добавляются всегда: первое — рамка под любым текстом,
    // второе — чей голос и какая строка доверия. Поиском их ловить нельзя, они нужны безусловно.
    const forced = [cardByName('product_positioning_us'), senderCard(signedBy)].filter(Boolean);
    const kb = [...forced.map((c) => c.text), kbBase].join('\n\n---\n\n');
    const sources = [...forced.map((c) => c.name), ...kbSources];

    const SIZE_LABELS = { '1,10': '1–10', '11,50': '11–50', '51,200': '51–200', '201,500': '201–500', '501,1000': '501–1,000', '1001,5000': '1,001–5,000', '5001,1000000': '5,000+' };
    const segmentDesc = [
      `Location: ${criteria.location || 'United States'}${criteria.region && criteria.region !== 'Any' ? `, ${criteria.region}` : ''}`,
      `Industry: ${criteria.industry || 'any'}`,
      `Company size: ${(criteria.sizes || []).map((s) => SIZE_LABELS[s] || s).join(' / ') || 'any'} employees`,
      `Titles: ${(criteria.titles || []).join(', ') || criteria.titleType || 'procurement leaders'}`,
      criteria.hiringRole ? `Signal: actively hiring ${criteria.hiringRole} roles (posted ≤ ${criteria.hiringPostedDays || 30} days)` : '',
      criteria.signal ? `Signal: ${criteria.signal}` : '',
      criteria.revenueMin ? `Revenue: $${(Number(criteria.revenueMin) / 1000000).toLocaleString('en-US')}M+` : '',
    ].filter(Boolean).join('\n');

    const prompt = `Write a 3-step cold email sequence for ${signedBy} (Zinit), aimed at this segment.

SEGMENT (who we are writing to):
${segmentDesc}
${instruction ? `\nOPERATOR INSTRUCTION (follow it): ${instruction}` : ''}

Rules (these come from our email playbook — follow strictly):
- Step 1: day 0, has a subject line. Steps 2 and 3: empty subject (they reply into the same thread).
- Step 2 waits 3 days, step 3 waits 4 days after step 2.
- 60–110 words per email. Plain text. NO links, NO images, NO attachments, NO bullet lists.
- Variables available: {{first_name}}, {{company_name}}, {{unique_detail_short}}.
  {{unique_detail_short}} expands to a COMPLETE short sentence about that specific lead's company
  (e.g. "Saw the Arcosa deal went through."). Put it on its own, as a whole sentence — never inside
  another sentence. It is EMPTY for leads with no research hit, so the paragraph around it must read
  fine when it disappears. Use it at most once, in step 1 only.
- Spintax allowed as {option A|option B} — Smartlead expands it. Use it in the subject and 1–2 phrases.
- Ask for a 15-minute call or offer the free benchmark. Step 3 is a polite break-up.
- Do NOT name any client company. Do NOT quote setup fees or thresholds. Do NOT claim full autonomy.
- Respect the persona framing rules in the knowledge below (e.g. never use headcount-efficiency framing
  with procurement staff — they are the buyer).
- Sign every email with "${signedBy}" on the last line, alone.
- Write in ${signedBy}'s voice and use ONLY their credibility line from the sender card below.
  Never attribute another person's background to them.

${WRITING_STYLE}

Use the Zinit knowledge below for what to say and which proof/value to lean on.

${kb}

Return STRICT JSON only:
{"name":"<short slug, e.g. A4-tail-spend>","description":"<one line: which segment and what the angle bets on>","sequence":[{"wait_days":0,"subject":"...","body":"..."},{"wait_days":3,"subject":"","body":"..."},{"wait_days":4,"subject":"","body":"..."}]}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: `anthropic ${r.status}` });
    const parsed = JSON.parse((data.content?.[0]?.text || '{}').replace(/^```json?\s*|\s*```$/g, ''));
    if (!parsed.sequence?.length) return res.status(502).json({ error: 'LLM returned no sequence' });
    // Подпись не оставляем на волю модели: без неё заход незапускаем (кейс 08.08 — LLM забыла подписать).
    parsed.sequence = parsed.sequence.map((s) => ({ ...s, body: ensureSignature(s.body, signedBy) }));
    // Имя захода всегда несёт отправителя: «База · Stan» / «База · Anton».
    parsed.name = angleNameFor(parsed.name || 'angle', signedBy);
    console.log(`[angle:draft] segment="${segmentText.slice(0, 50)}" signed=${signedBy} → ${parsed.name}, kb: ${sources.join(', ')}`);
    res.json({
      ...parsed,
      senderIdentity: identityOf(`${String(signedBy).toLowerCase()}@zinit.com`).id,
      variables: ['first_name', 'company_name', 'unique_detail_short'],
      sources,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Конструктор LinkedIn-формы захода (L2.5, решение П10: заход един, форма разная).
// Берёт email-цепочку захода и перекладывает ТУ ЖЕ аргументацию в формат LinkedIn:
// message #1 после принятия заявки + фоллоуап. Черновик проходит validateLinkedinTexts
// (одна попытка исправления по ошибкам валидатора), сохранение — обычным save со сбросом апрува.
app.post('/api/message-angles/:id/draft-linkedin', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'no ANTHROPIC_API_KEY' });
    // «new» — заход ещё не сохранён: конвертируем цепочку из тела запроса. Требовать
    // «сначала сохрани» было лишним шагом (вопрос Ольги 14.08) — цепочка уже на экране.
    const angle = req.params.id === 'new'
      ? { id: null, name: req.body?.name || 'unsaved angle', description: req.body?.description || '', sequence: req.body?.sequence || [] }
      : (await listMessageAngles()).find((a) => a.id === Number(req.params.id));
    if (!angle) return res.status(404).json({ error: 'angle not found' });
    if (!(angle.sequence || []).length) return res.status(400).json({ error: 'angle has no email sequence to convert' });
    const { instruction = '' } = req.body || {};

    // Формат канала и позиционирование — принудительно (как в email-конструкторе);
    // остальное добирается поиском по сути захода и инструкции оператора.
    const forced = [cardByName('channel_linkedin_format'), cardByName('product_positioning_us')].filter(Boolean);
    const { context: kbBase, sources: kbSources } = replyKnowledge({
      replyText: instruction || angle.description || angle.name, profile: '',
    });
    const kb = [...forced.map((c) => c.text), kbBase].filter(Boolean).join('\n\n---\n\n');
    const sources = [...new Set([...forced.map((c) => c.name), ...kbSources])];
    const emailSeq = (angle.sequence || [])
      .map((s, i) => `Email ${i + 1}${s.subject ? ` (subject: ${s.subject})` : ''}:\n${s.body}`).join('\n\n');

    const ask = async (extraNote = '') => {
      const prompt = `Convert this approved cold-email angle into the LinkedIn form of the SAME angle.
Same hypothesis, same argument — different format. The lead has just ACCEPTED a connection request
(sent without a note); message #1 lands in chat right after that.

THE EMAIL ANGLE (already approved, do not change its argument):
${emailSeq}
${instruction ? `\nOPERATOR INSTRUCTION (follow it): ${instruction}` : ''}${extraNote}

Hard rules:
- message #1: UNDER 40 words, one question, no pitch, no links, no pricing, no numbers, no client names.
- follow-up: wait_days 3, UNDER 60 words, one new angle; {{unique_detail_short}} allowed ONLY here,
  as its own standalone sentence (it may be empty — the text must read fine without it).
- UNSIGNED, and no personal credibility lines: the same template is sent from several different
  profiles, the sending profile is the identity. Never reference the sender.
- Variables available: {{first_name}}, {{company_name}}, and {{unique_detail_short}} (follow-up only).

${WRITING_STYLE}

${kb}

Return STRICT JSON only:
{"linkedin":{"message1":{"body":"..."},"followup":{"wait_days":3,"body":"..."}}}`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(`anthropic ${r.status}`);
      return JSON.parse((data.content?.[0]?.text || '{}').replace(/^```json?\s*|\s*```$/g, '')).linkedin || null;
    };

    let li = await ask();
    let check = validateLinkedinTexts(li);
    if (!check.ok) {
      // Одна попытка самопочинки: валидатор называет ошибки, модель правит.
      li = await ask(`\n\nYOUR PREVIOUS ATTEMPT FAILED VALIDATION — fix exactly these problems:\n- ${check.errors.join('\n- ')}`);
      check = validateLinkedinTexts(li);
    }
    // Пары «черновик агента → финал человека» копятся с первого дня (материал будущего
    // дообучения — решение Ольги 13.08): черновик в журнал, финал виден по angle.save.
    await writeAudit({ actor: actorOf(req), action: 'angle.draft_linkedin', entity: 'message_angle', entityId: angle.id,
      meta: { draft: li, valid: check.ok, sources } }).catch(() => {});
    console.log(`[angle:draft-linkedin] #${angle.id} "${angle.name}" → valid=${check.ok}, kb: ${sources.join(', ')}`);
    res.json({ linkedin: li, validation: check, sources });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Живое превью письма на выбранном лиде: подстановка переменных + сжатие unique_detail.
app.post('/api/message-angles/render', async (req, res) => {
  try {
    const { sequence = [], contact = {} } = req.body;
    const detailShort = contact.unique_detail ? await compressDetail(contact.unique_detail).catch(() => contact.unique_detail) : '';
    const vars = {
      first_name: contact.first_name || (contact.full_name || '').split(' ')[0] || 'there',
      company_name: (contact.company || '').replace(/,?\s+(Inc\.?|LLC|Ltd\.?|Corp\.?)$/i, ''),
      unique_detail_short: detailShort,
    };
    const render = (t) => String(t || '')
      .replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`)
      // спинтакс {a|b} — в превью показываем первый вариант
      .replace(/\{([^{}|]+)\|[^{}]*\}/g, '$1');
    res.json({
      steps: sequence.map((s) => ({ ...s, subject: render(s.subject), body: render(s.body) })),
      vars,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Сегменты и кандидаты из реестра (список рассылки всегда из реестра — решение 07.08) ---
app.get('/api/registry/segments', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await listSegments()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/registry/candidates', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    res.json(await campaignCandidates({
      segmentId: req.query.segmentId || null,
      minFit: Number(req.query.minFit || 0),
      requireVerified: req.query.requireVerified !== 'false',
      validatorOn: verifyEnabled(),
    }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Пакеты рассылки: отбор фильтрами в Contacts → сущность, которую видно в билдере ---
app.get('/api/batches', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await listBatches()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Предпросмотр состава: квота catch-all применяется ЗДЕСЬ, до подтверждения. Принцип (ТЗ п.31):
// состав пакета не меняется после подтверждения — всё, что способно его изменить, происходит
// раньше, на глазах и с числами. Поэтому /api/batches ничего не фильтрует сам.
app.post('/api/batches/plan', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { contactIds = [], forceIds = [], quota } = req.body;
    if (!contactIds.length) return res.status(400).json({ error: 'no contacts' });
    const rows = await contactsForQuota(contactIds);
    const plan = applyCatchAllQuota(rows, {
      quota: Number(quota) > 0 && Number(quota) < 1 ? Number(quota) : undefined,
      forceIds,
    });
    res.json({
      ...plan,
      selected: rows.length,
      included: plan.included.map((c) => c.id),
      includedRows: plan.included,
      deferred: plan.deferred,
    });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.post('/api/batches', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { contactIds = [], segmentId = null, filters = {}, deferredIds = [] } = req.body;
    if (!contactIds.length) return res.status(400).json({ error: 'no contacts' });
    // Жёсткая защита (решение Ольги 13.08): контакт, занятый чужим пакетом или уже
    // работающий в кампании, в новый пакет не попадает ВООБЩЕ. Не «пропустим и отсеем на
    // запуске» — тогда размер пакета не сойдётся с размером отправки и аналитика соврёт.
    const blocked = await unavailableForBatch(contactIds.map(Number), actorOf(req));
    if (blocked.length) {
      return res.status(409).json({
        error: `${blocked.length} contact(s) are not available and cannot go into a batch`,
        blocked,
      });
    }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const name = `${stamp} · ${contactIds.length} lead${contactIds.length === 1 ? '' : 's'}`;
    const batch = await createBatch({ name, contactIds: contactIds.map(Number), segmentId, filters });
    // Пакет и есть «черновик кампании» — отдельной сущности нет. Резервируем его контакты
    // за оператором, чтобы второй не собрал тех же людей в свой пакет (вопрос Стаса).
    await reserveContacts(contactIds, actorOf(req), batch.id).catch(() => {});
    await writeAudit({ actor: actorOf(req), action: 'batch.create', entity: 'batch', entityId: batch.id,
      meta: { contacts: contactIds.length, deferred: deferredIds.length } });
    // Отметка «отложен» — для бейджа в реестре и приоритета среди равных в следующем пакете.
    if (deferredIds.length) await markDeferred(deferredIds);
    res.json(batch);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.get('/api/batches/:id/contacts', async (req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await getBatchContacts(req.params.id)); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Inbox: ответы с классификацией (после ТГ-пинга Стас/Ольга идут сюда) ---
app.get('/api/inbox', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const threads = await listReplies({
      includeClosed: req.query.includeClosed === '1',
      includeTest: req.query.includeTest === '1',
    });
    // Имя профиля вместо uuid: отвечающий должен видеть, ЧЬИМ аккаунтом он пишет —
    // в LinkedIn это и есть личность отправителя (вопрос Ольги 19.08).
    if (threads.some((x) => x.sender_profile_uuid) && getsales.getsalesEnabled()) {
      try {
        const profs = await getsales.listSenderProfiles();
        const nameOf = Object.fromEntries(profs.map((p) => [p.uuid, [p.first_name, p.last_name].filter(Boolean).join(' ') || p.label]));
        for (const x of threads) if (x.sender_profile_uuid) x.sender_name = nameOf[x.sender_profile_uuid] || null;
      } catch { /* имя — украшение; недоступность GetSales не должна ронять Inbox */ }
    }
    res.json(threads);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Закрыть / переоткрыть разговор (ТЗ п.25): тестовые треды и отработанные убираются из очереди.
app.post('/api/inbox/contact/:contactId/close', async (req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await closeConversation(req.params.contactId, req.body?.outcome || 'dead')); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.post('/api/inbox/contact/:contactId/reopen', async (req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await reopenConversation(req.params.contactId)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// «Meeting scheduled»: помечаем встречу, закрываем разговор исходом meeting и переносим
// карточку в Kommo на этап встреч (из New leads она уходит сама — у лида один статус).
app.post('/api/inbox/contact/:contactId/meeting', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    // Тот же набор полей, что и при заливке пакета: карточка человека, с которым назначена
    // встреча, тем более не должна быть пустой (выравнено 13.08).
    const { contactsForKommo } = await import('./db/registry.js');
    const c = (await contactsForKommo([Number(req.params.contactId)]))[0];
    if (!c) return res.status(404).json({ error: 'contact not found' });

    let kommoLeadId = c.kommo_lead_id;
    let kommoNote = null;
    if (kommoEnabled()) {
      try {
        if (kommoLeadId) await moveLeadToMeeting(kommoLeadId);
        else kommoLeadId = await createLeadAtMeetingStage(c); // встречу могли назначить вне пакета
        kommoNote = kommoLeadId ? `moved to «Online meeting Scheduled» (lead ${kommoLeadId})` : 'Kommo lead not created';
      } catch (e) {
        console.error('[kommo] meeting move failed:', e.message);
        kommoNote = `Kommo error: ${e.message}`; // сам факт встречи всё равно фиксируем у себя
      }
    } else kommoNote = 'Kommo not configured';

    const updated = await markMeetingScheduled(c.id, { meetingAt: req.body?.meetingAt || null, kommoLeadId });
    await writeAudit({ actor: actorOf(req), action: 'kommo.move', entity: 'contact', entityId: c.id,
      meta: { lead: kommoLeadId, to: 'Online meeting Scheduled', trigger: 'Meeting scheduled button', note: kommoNote } });
    console.log(`[meeting] ${c.full_name} → ${kommoNote}`);
    res.json({ ok: true, contact: updated, kommo: kommoNote });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Драфт ответа из базы знаний Zinit (третья сущность матрицы — «что даём о Zinit»).
// Агент: берёт ответ лида + его профиль → ищет релевантные карточки → пишет короткий ответ Стэна.
// Поправка классификации рукой (L5.12). Классификация — СУЖДЕНИЕ модели, а не факт:
// на нём стоят карантин, подавление и запись в Kommo, поэтому человек обязан иметь право
// его исправить. Сознательно НЕ откатываем уже сделанные действия: тихий откат карантина
// или подавления — сюрприз хуже ошибки. Поправка фиксируется в журнале, а последствия
// человек меняет явно (статус контакта в Контактах).
app.post('/api/inbox/:touchId/classification', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const value = String(req.body?.classification || '').trim();
    const ALLOWED = ['positive', 'question', 'neutral', 'not_now', 'unclear', 'negative',
      'unsubscribe', 'ooo', 'bounce_notification'];
    if (!ALLOWED.includes(value)) return res.status(400).json({ error: `classification: ${ALLOWED.join(' | ')}` });
    const { getPool } = await import('./db/registry.js');
    const r = await getPool().query(
      `UPDATE touch SET meta = meta || jsonb_build_object('classification', $2::text,
              'classified_by', 'human', 'classified_by_actor', $3::text, 'classified_at', now()::text)
        WHERE id = $1 AND event = 'replied' RETURNING id, contact_id, meta->>'classification' AS classification`,
      [Number(req.params.touchId), value, actorOf(req)],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'reply not found' });
    await writeAudit({ actor: actorOf(req), action: 'inbox.reclassify', entity: 'touch',
      entityId: req.params.touchId, meta: { to: value, contact_id: r.rows[0].contact_id } }).catch(() => {});
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/inbox/:touchId/suggest', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'no ANTHROPIC_API_KEY' });
    const { getPool } = await import('./db/registry.js');
    const t = (await getPool().query(
      `SELECT t.*, c.full_name, c.title, c.company, c.company_industry, c.company_size, c.unique_detail
       FROM touch t JOIN contact c ON c.id = t.contact_id WHERE t.id = $1`,
      [Number(req.params.touchId)],
    )).rows[0];
    if (!t) return res.status(404).json({ error: 'reply not found' });

    const replyText = t.meta?.reply_text || '';
    const profile = [t.title, t.company_industry, t.company_size ? `${t.company_size} employees` : ''].filter(Boolean).join(' ');
    const { context: kb, sources } = replyKnowledge({ replyText, profile });
    if (!kb) return res.status(422).json({ error: 'no matching knowledge cards' });

    // Канал решает форму ответа. В LinkedIn подпись — ошибка, а не вежливость: отправитель
    // виден в самом чате, и чужое имя под текстом читается как подмена собеседника
    // (замечание Ольги 19.08: черновик пришёл с подписью «Stan» в переписке от Наташи).
    const isLinkedin = t.channel === 'linkedin';
    const channelRules = isLinkedin
      ? `\nCHANNEL: LinkedIn chat, not email. Hard rules:
- NO SIGNATURE and no sign-off name of any kind. The sending profile is the identity; a name in the
  text contradicts the avatar next to it and reads as impersonation.
- No subject line, no greeting block — this is a chat message continuing a live thread.
- Under 90 words. No links. Plain sentences, no bullet lists.`
      : '';

    const prompt = `You draft a reply for Stan (co-founder of Zinit, AI-native e-sourcing platform) to a prospect who answered a cold email.${channelRules}

PROSPECT: ${t.full_name || '—'}, ${t.title || 'procurement leader'} at ${t.company || '—'}${t.company_industry ? ` (${t.company_industry})` : ''}${t.company_size ? `, ${t.company_size} employees` : ''}.
THEIR REPLY: """${replyText}"""

Use ONLY the Zinit knowledge below. Rules:
- 60-110 words, plain text, no subject line, no markdown, no links, no attachments.
- Answer what they actually asked, using the knowledge — do not dodge into a generic pitch.
- Never name a client company (references need permission). Use anonymized profiles instead.
- Never quote the setup fee or a waiver threshold — those are call topics.
- Respect persona framing rules in the knowledge (e.g. никогда "do more with less" to procurement staff).
- End with ONE low-friction next step (a 15-minute call, or the free GPO benchmark if it fits).
- Sign as "Stan" on the last line.

${WRITING_STYLE}

${kb}

Return ONLY the reply text.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: `anthropic ${r.status}` });
    let draft = (data.content?.[0]?.text || '').trim();
    if (isLinkedin) {
      // Страховка поверх промпта: модель иногда подписывается по привычке. Срезаем короткую
      // последнюю строку, если она выглядит именем — правило важнее послушности модели.
      const lines = draft.split('\n');
      const last = (lines[lines.length - 1] || '').trim();
      if (last && last.length <= 24 && !/[.!?,:;]$/.test(last) && lines.length > 1) {
        lines.pop();
        draft = lines.join('\n').trim();
      }
    }
    console.log(`[inbox:suggest] touch ${t.id} → ${draft.length} chars, kb: ${sources.join(', ')}`);
    res.json({ draft, sources });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Ответ лиду из карточки Inbox: уходит в том же треде с ящика кампании (Smartlead reply-email-thread).
app.post('/api/inbox/:touchId/reply', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'reply text is empty' });
    const { getPool } = await import('./db/registry.js');
    const t = (await getPool().query(
      `SELECT t.*, c.email AS contact_email, c.full_name FROM touch t
       JOIN contact c ON c.id = t.contact_id WHERE t.id = $1 AND t.event = 'replied'`,
      [Number(req.params.touchId)],
    )).rows[0];
    if (!t) return res.status(404).json({ error: 'reply not found' });

    // --- LinkedIn-ветка (L5.3) ------------------------------------------------------------
    // Ответ человека уходит СРАЗУ, без окна рабочих часов: это переписка, а не рассылка —
    // заставлять человека ждать утра Нью-Йорка, когда собеседник написал минуту назад,
    // бессмысленно (решение Ольги 19.08). Дневной потолок профиля тоже не блокирует ответ:
    // упустить ответ хуже, чем превысить потолок на единицу; в статистику он при этом попадёт.
    if (t.channel === 'linkedin') {
      const leadUuid = t.meta?.lead_uuid;
      if (!leadUuid) return res.status(422).json({ error: 'у этой нити нет lead_uuid — ответить можно только из GetSales' });
      // Отвечает ТОТ ЖЕ профиль, что вёл разговор: иначе человек получит сообщение
      // от незнакомого аккаунта, и это выглядит как подмена собеседника.
      const sender = (await getPool().query(
        `SELECT meta->>'sender_profile_uuid' AS s FROM touch
          WHERE channel = 'linkedin' AND meta->>'lead_uuid' = $1
            AND meta->>'sender_profile_uuid' IS NOT NULL
          ORDER BY occurred_at DESC LIMIT 1`,
        [leadUuid],
      )).rows[0]?.s;
      if (!sender) return res.status(422).json({ error: 'не знаем, какой профиль вёл этот разговор' });
      const sent = await getsales.sendMessage(sender, leadUuid, String(text));
      await getPool().query(
        `INSERT INTO touch (contact_id, segment_id, channel, campaign_ext_id, event, meta)
         VALUES ($1, $2, 'linkedin', $3, 'manual_reply', $4)`,
        [t.contact_id, t.segment_id, t.campaign_ext_id, JSON.stringify({
          text: String(text).slice(0, 1500), in_reply_to_touch: t.id, by: actorOf(req),
          lead_uuid: leadUuid, sender_profile_uuid: sender,
          gs_message_uuid: sent?.uuid || null, delivery: 'pending',
        })],
      );
      await writeAudit({ actor: actorOf(req), action: 'inbox.reply', entity: 'contact', entityId: t.contact_id, meta: { channel: 'linkedin', lead_uuid: leadUuid } });
      console.log(`[inbox:reply] LinkedIn touch ${t.id} → lead ${leadUuid} by ${actorOf(req)}`);
      return res.json({ ok: true, channel: 'linkedin', messageUuid: sent?.uuid || null });
    }

    const sl = t.meta?.sl || {};
    const campaignId = sl.campaign_id || t.campaign_ext_id;
    if (!campaignId || !sl.stats_id) {
      return res.status(422).json({
        error: 'thread identifiers missing in the webhook payload — reply from Smartlead Master Inbox this time; raw payload is in event_log, mapping will be fixed',
      });
    }
    const htmlBody = String(text).split('\n').map((l) => `<div>${l || '<br>'}</div>`).join('');
    await smartlead.replyToThread(campaignId, {
      email_stats_id: sl.stats_id,
      email_body: htmlBody,
      reply_message_id: sl.message_id || null,
      reply_email_time: sl.time || null,
      reply_email_body: t.meta?.reply_text || '',
      add_signature: false,
    });
    await getPool().query(
      `INSERT INTO touch (contact_id, segment_id, channel, campaign_ext_id, event, meta)
       VALUES ($1, $2, 'email', $3, 'manual_reply', $4)`,
      // meta.by — кто именно ответил: основа медианы времени реакции по сейлзу (ТЗ п.25).
      [t.contact_id, t.segment_id, String(campaignId), JSON.stringify({ text: String(text).slice(0, 1500), in_reply_to_touch: t.id, by: actorOf(req) })],
    );
    await writeAudit({ actor: actorOf(req), action: 'inbox.reply', entity: 'contact', entityId: t.contact_id, meta: { campaign: String(campaignId) } });
    console.log(`[inbox:reply] touch ${t.id} → campaign ${campaignId} (${t.full_name}) by ${actorOf(req)}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Импорт истории LinkedIn-касаний GetSales (L1.3): разовая загрузка выгрузки разведки L0.10.
// Файл живёт вне репо приложения, поэтому строки приходят телом запроса (батчами с локальной
// машины: node import-linkedin-history.mjs). Идемпотентно — повторный прогон ничего не дублирует.
app.post('/api/registry/import/linkedin-history', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' });
    if (rows.length > 500) return res.status(400).json({ error: 'batch too large — send ≤500 rows per request' });
    const out = await importLinkedinHistory(rows);
    await writeAudit({ actor: actorOf(req), action: 'registry.import', entity: 'contact', entityId: null,
      meta: { source: 'getsales-history', ...out } });
    console.log(`[import:linkedin] rows=${rows.length} → contacts=${out.contacts} (new ${out.created}), touches=${out.touches}, skipped=${out.skipped}`);
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Гигиена реестра: подозрения на дубли — один человек двумя записями (разные identity_key).
// Появился из-за импорта истории (L1.3): контакт, сохранённый поиском БЕЗ LinkedIn-URL,
// живёт под ключом «имя+компания», и импорт того же человека завёл вторую запись под slug.
app.get('/api/registry/duplicates', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { getPool } = await import('./db/registry.js');
    const r = await getPool().query(
      `SELECT a.id AS id_a, b.id AS id_b, a.full_name, a.company,
              a.identity_key AS key_a, b.identity_key AS key_b,
              a.email AS email_a, b.email AS email_b, a.sources AS sources_a, b.sources AS sources_b
         FROM contact a
         JOIN contact b ON b.id > a.id
          AND lower(a.full_name) = lower(b.full_name)
          AND COALESCE(lower(a.company), '') = COALESCE(lower(b.company), '')
        WHERE a.full_name IS NOT NULL AND a.full_name <> ''
        ORDER BY a.full_name LIMIT 200`,
    );
    res.json({ pairs: r.rows });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Отладка (за паролем): последние сырые вебхук-события — отлов формата payload на пред-прогоне.
app.get('/api/registry/events', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { getPool } = await import('./db/registry.js');
    const params = [];
    let where = '';
    if (req.query.type) { params.push(req.query.type); where = `WHERE event_type = $1`; }
    params.push(Math.min(Number(req.query.limit) || 5, 20));
    const r = await getPool().query(
      `SELECT id, event_type, received_at, payload FROM event_log ${where} ORDER BY received_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Реплей события из event_log через актуальный код (GET — чтобы открывалось из браузера за паролем).
app.get('/api/registry/events/:id/replay', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { getPool } = await import('./db/registry.js');
    const row = (await getPool().query('SELECT payload FROM event_log WHERE id = $1', [Number(req.params.id)])).rows[0];
    if (!row) return res.status(404).json({ error: 'event not found' });
    const result = await processSmartleadEvent(row.payload, { replay: true });
    console.log(`[webhook:replay] event ${req.params.id} →`, result.actions);
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Smartlead: ящики (для выбора отправителей) ---
// Список известных подписантов — не зависит от доступности Smartlead.
app.get('/api/identities', (_req, res) => res.json(knownSigners()));

// Правила email-канала — константы кода наружу (принцип п.43: документация из кода).
// Read-only сознательно: пороги выстраданы инцидентами и меняются через правку кода с ревью,
// а не крутилкой в UI. Первое же желание крутить — сигнал превратить в параметр app_state.
app.get('/api/email-channel/rules', (_req, res) => {
  res.json({
    replyMaturationDays: REPLY_MATURATION_DAYS,
    bounce: { floor: BOUNCE_FLOOR, alert: BOUNCE_ALERT, pause: BOUNCE_PAUSE },
    catchAllQuota: CATCH_ALL_QUOTA,
    reserveDays: RESERVE_DAYS,
    quarantineMonths: 3,
  });
});

app.get('/api/smartlead/email-accounts', async (_req, res) => {
  try {
    const raw = await smartlead.listEmailAccounts();
    const list = Array.isArray(raw) ? raw : (raw?.email_accounts || []);
    // Проставляем личность каждому ящику — UI группирует по ней и не даёт смешать отправителей.
    res.json(list.map((a) => ({ ...a, identity: identityOf(a.from_email) })));
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// --- Кампании ---
// Что требует внимания прямо сейчас (L5.13, слой детекции). Доставка в Telegram отложена
// сознательно: сперва содержание и процесс отслеживания (решение Ольги 18.08).
app.get('/api/health/problems', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await currentProblems()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// «Принято в работу»: прячет состояние на срок, но не отменяет его. Если причина
// не ушла — состояние вернётся (иначе кнопка станет способом не делать).
app.post('/api/health/ack', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const key = String(req.body?.key || '').trim();
    if (!key) return res.status(400).json({ error: 'нужен key' });
    const saved = await ackProblem({ key, hours: req.body?.hours, actor: actorOf(req), note: req.body?.note || '' });
    await writeAudit({ actor: actorOf(req), action: 'health.ack', entity: 'problem', entityId: key,
      meta: { until: saved.until, note: saved.note } }).catch(() => {});
    res.json(saved);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/campaigns', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const [rows, stuck] = await Promise.all([listCampaigns(), campaignsWithoutSends().catch(() => [])]);
    const stuckIds = new Set(stuck.map((s) => s.id));
    // Прогресс по людям из touch-событий (вопрос Ольги 14.08: «собрали волну — а как понять,
    // какой статус сейчас?»). Считаем ЛЮДЕЙ, не события: два письма одному — один человек.
    const { getPool } = await import('./db/registry.js');
    const prog = await getPool().query(
      `SELECT campaign_ext_id, event, COUNT(DISTINCT contact_id) AS n FROM touch
        WHERE campaign_ext_id IS NOT NULL AND COALESCE(meta->>'import', '') <> 'true'
        GROUP BY 1, 2`,
    ).catch(() => ({ rows: [] }));
    const progress = {};
    for (const p of prog.rows) (progress[p.campaign_ext_id] = progress[p.campaign_ext_id] || {})[p.event] = Number(p.n);
    res.json(rows.map((r) => ({ ...r, no_sends_alert: stuckIds.has(r.id), progress: progress[r.external_id] || {} })));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/campaigns', async (req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await createCampaignRow(req.body)); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Уборка черновика после неудачного запуска — иначе таблица кампаний забивается draft/error.
app.delete('/api/campaigns/:id', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { getPool } = await import('./db/registry.js');
    const r = await getPool().query(
      `DELETE FROM campaign WHERE id = $1 AND status IN ('draft', 'error') AND external_id IS NULL RETURNING id`,
      [Number(req.params.id)],
    );
    res.json({ deleted: r.rowCount });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Текст цепочки → формат Smartlead. Грабли Урока: delay первого шага ВСЕГДА 0.
function toSmartleadSequences(sequence) {
  return sequence.map((s, i) => ({
    seq_number: i + 1,
    seq_delay_details: { delay_in_days: i === 0 ? 0 : Number(s.wait_days || 3) },
    subject: s.subject || '', // пустой subject = письмо в том же треде
    email_body: String(s.body || '').split('\n').map((line) => `<div>${line || '<br>'}</div>`).join(''),
  }));
}

// Запуск: pre-flight → Smartlead (кампания → sequence → ящики → расписание → лиды → вебхук → START).
app.post('/api/campaigns/:id/launch', async (req, res) => {
  if (!requireRegistry(res)) return;
  const campaignId = Number(req.params.id);
  try {
    const { contactIds = [], testLeads = [], senderIds = [], schedule = {}, testMode = false, batchId = null } = req.body;
    const rows = await listCampaigns();
    const camp = rows.find((c) => c.id === campaignId);
    if (!camp) return res.status(404).json({ error: 'campaign not found' });
    if (camp.status !== 'draft') return res.status(400).json({ error: `campaign is ${camp.status}, not draft` });
    if (camp.angle_status !== 'approved') return res.status(400).json({ error: 'message angle text is not approved — approve it first' });
    if (!senderIds.length) return res.status(400).json({ error: 'no sender email accounts selected' });

    // Одна ячейка на канал в волне (L2.1): второй email той же волны — это два холодных
    // письма одним людям; вторая ячейка волны законна только в ДРУГОМ канале.
    if (batchId) {
      const { getPool } = await import('./db/registry.js');
      const dup = await getPool().query(
        `SELECT id FROM campaign
          WHERE (meta->>'batch_id')::int = $1 AND channel = $2 AND id <> $3
            AND status NOT IN ('draft', 'error') AND closed_at IS NULL`,
        [Number(batchId), camp.channel, campaignId],
      );
      if (dup.rows.length) {
        return res.status(400).json({
          error: `this batch already has a live ${camp.channel} cell (campaign #${dup.rows[0].id}) — one channel per wave; a second cell must use the other channel`,
        });
      }
    }

    // === LinkedIn-ячейка (L3.2): список GetSales + флоу-на-отправителя, без Smartlead ===
    if ((camp.channel || 'email') === 'linkedin') {
      return await launchLinkedinCell(req, res, { camp, campaignId, contactIds, senderIds, batchId });
    }

    const angle = (await listMessageAngles()).find((a) => a.id === camp.message_angle_id);
    const sequence = angle?.sequence || [];
    if (!sequence.length) return res.status(400).json({ error: 'angle has empty sequence' });

    // Личность отправителя (решение 08.08): текст подписан человеком, а Smartlead раздаёт ящики
    // round-robin в момент отправки — подставить подпись под ящик нельзя. Значит все ящики кампании
    // обязаны принадлежать личности захода, иначе часть писем уйдёт с чужой подписью.
    const angleIdentity = angle.sender_identity || identityFromSignature(sequence)?.id || null;
    const accountsRaw = await smartlead.listEmailAccounts().catch(() => []);
    const accountList = Array.isArray(accountsRaw) ? accountsRaw : (accountsRaw?.email_accounts || []);
    const chosen = accountList.filter((a) => senderIds.map(Number).includes(Number(a.id)));
    if (!angleIdentity) {
      return res.status(400).json({
        error: `Angle "${angle.name}" has no sender identity — the text is not signed by a known sender. Set it in the angle editor before launching.`,
      });
    }
    const check = validateSenders(angleIdentity, chosen);
    if (!check.ok) {
      const who = check.offenders.map((o) => `${o.email} (${o.identity.name})`).join(', ');
      return res.status(400).json({
        error: `Sender mismatch: the text is signed by ${angleIdentity}, but these mailboxes belong to someone else — ${who}. `
          + 'Smartlead assigns mailboxes round-robin at send time, so part of the batch would go out with the wrong signature. '
          + 'Use only mailboxes of the signing sender, or write a separate angle for the other one.',
      });
    }

    // Сбор лидов: боевой режим — из реестра с pre-flight Тони (только verified/valid);
    // testMode (нулевой прогон) — testLeads напрямую, реестр не трогаем.
    let leadList = [];
    let usedContactIds = [];
    const rejected = [];
    if (testMode) {
      leadList = testLeads.map((t) => ({
        email: t.email,
        first_name: t.first_name || 'Test',
        last_name: t.last_name || '',
        company_name: t.company_name || 'Zero Run',
        custom_fields: { unique_detail_short: t.unique_detail_short || '' },
      }));
    } else {
      // Если список контактов задан явно (пришёл с вкладки Contacts) — сегмент кампании служит
      // только атрибуцией ячейки матрицы и НЕ должен сужать pre-flight: контакт мог быть отобран
      // фильтром по другому сегменту или не иметь мэтча вовсе (zero-run контакты).
      const { candidates } = await campaignCandidates({
        segmentId: contactIds.length ? null : camp.segment_id,
        requireVerified: true,
        validatorOn: verifyEnabled(),
      });
      const byId = new Map(candidates.map((c) => [c.id, c]));
      // Точная причина отсева: «уже в другой кампании» и «почта не верифицирована» — разные проблемы,
      // и первая защищает лида от двух холодных писем от разных отправителей (вопрос Ольги 08.08).
      const missing = contactIds.filter((id) => !byId.has(id));
      const states = new Map();
      if (missing.length) {
        const { getPool } = await import('./db/registry.js');
        const st = await getPool().query(
          `SELECT id, full_name, lifecycle, email, email_status, quarantine_until
           FROM contact WHERE id = ANY($1::int[])`,
          [missing],
        );
        for (const row of st.rows) states.set(row.id, row);
      }
      const reasonFor = (s) => {
        if (!s) return 'contact not found in the registry';
        if (s.lifecycle === 'active_in_campaign') return 'already active in another campaign — protected from a second cold email';
        if (s.lifecycle === 'in_conversation') return 'a person is talking to them — a meeting is scheduled';
        if (s.lifecycle === 'quarantined') return `in quarantine until ${s.quarantine_until ? String(s.quarantine_until).slice(0, 10) : '—'}`;
        if (s.lifecycle === 'suppressed_forever') return 'suppressed (unsubscribe / hard bounce)';
        if (!s.email) return 'no email';
        return `email not verified (status: ${s.email_status || 'unknown'})`;
      };
      // Барьер CRM (ТЗ п.28). Сначала по ночному стоп-листу, затем ЖИВАЯ перепроверка адресов:
      // между синхронизацией и отправкой проходит целый день, лид мог переехать тем же утром.
      // Это последний рубеж перед реальной отправкой, поэтому лишний вызов API оправдан.
      const crmBlocked = new Map();
      if (!testMode) {
        for (const row of await blockedContactIds(contactIds).catch(() => [])) {
          crmBlocked.set(row.id, `already in the CRM — ${row.stage_name} · ${row.pipeline_name}`);
        }
        const survivors = contactIds.filter((id) => !crmBlocked.has(id) && byId.has(id));
        const emails = survivors.map((id) => byId.get(id).email).filter(Boolean);
        if (kommoEnabled() && emails.length) {
          // Сырые попадания прогоняем через те же правила снятия, что и ночной список,
          // иначе живая проверка отменяет кнопку «release this stage» и правило давности.
          const raw = await checkEmailsLive(emails).catch((e) => { console.warn('[crm-block] живая проверка не удалась:', e.message); return []; });
          const live = await filterLiveHits(raw).catch(() => raw);
          if (raw.length !== live.length) console.log(`[crm-block] живая проверка: ${raw.length} попаданий, ${raw.length - live.length} снято правилами`);
          const byEmail = new Map(live.map((b) => [String(b.email).toLowerCase(), b]));
          for (const id of survivors) {
            const hit = byEmail.get(String(byId.get(id).email).toLowerCase());
            if (hit) crmBlocked.set(id, `moved in the CRM today — ${hit.stage} · ${hit.pipeline}`);
          }
        }
      }

      for (const id of contactIds) {
        const c = byId.get(id);
        if (!c) {
          const s = states.get(id);
          rejected.push({ id, name: s?.full_name || null, reason: reasonFor(s) });
          continue;
        }
        if (crmBlocked.has(id)) {
          rejected.push({ id, name: c.full_name, reason: crmBlocked.get(id) });
          continue;
        }
        const detailShort = c.unique_detail ? await compressDetail(c.unique_detail).catch(() => '') : '';
        leadList.push({
          email: c.email,
          first_name: c.first_name || (c.full_name || '').split(' ')[0] || '',
          last_name: c.last_name || (c.full_name || '').split(' ').slice(1).join(' '),
          company_name: (c.company || '').replace(/,?\s+(Inc\.?|LLC|Ltd\.?|Corp\.?)$/i, ''),
          custom_fields: { unique_detail_short: detailShort },
        });
        usedContactIds.push(c.id);
      }
    }
    if (!leadList.length) return res.status(400).json({ error: 'no leads passed pre-flight', rejected });

    // Smartlead: сборка по Уроку 04.08.
    const name = `${camp.segment_name || 'no-segment'} × ${angle.name} · ${new Date().toISOString().slice(0, 10)}${testMode ? ' · ZERO-RUN' : ''}`;
    const created = await smartlead.createCampaign(name);
    const extId = created.id;
    await smartlead.setSequences(extId, toSmartleadSequences(sequence));
    await smartlead.addEmailAccounts(extId, senderIds.map(Number));
    await smartlead.setSchedule(extId, {
      timezone: schedule.timezone || 'America/New_York',
      // Нулевой прогон — реально 24/7 (как обещает UI и Урок 04.08): иначе запуск в выходной
      // создаёт кампанию, показывает «Launched», но writes не уходят до понедельника.
      days_of_the_week: schedule.days || (testMode ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]),
      start_hour: schedule.startHour || (testMode ? '00:00' : '08:00'),
      end_hour: schedule.endHour || (testMode ? '23:59' : '17:00'),
      min_time_btw_emails: schedule.minGapMinutes || 5,
      max_new_leads_per_day: schedule.maxNewLeadsPerDay || 20,
      schedule_start_time: null,
    });
    const upload = await smartlead.uploadLeads(extId, leadList, { allowTestOverrides: testMode });
    // Трекинг (открытия + клики) выключаем в боевых кампаниях. Результат ЗАПИСЫВАЕМ:
    // «не удалось» должно быть видно до волны, а не выясняться по её результатам.
    let tracking = { ok: true, skipped: 'zero run keeps tracking on by protocol' };
    if (!testMode) {
      tracking = await smartlead.disableTracking(extId);
      if (!tracking.ok) {
        await sendTelegram(`⚠️ Кампания ${extId}: не удалось выключить отслеживание в Smartlead (${tracking.error}). Письма пойдут с пикселем через общий домен — проверьте настройки кампании вручную.`, { adminOnly: true }).catch(() => {});
      }
    }
    if (testMode) await upsertZeroRunContacts(leadList); // фикс 07.08: петля ответов требует контакта в реестре

    // Вебхук на кампанию (per-campaign — API-аудит).
    const base = process.env.APP_PUBLIC_URL || `https://${req.get('host')}`;
    const secret = process.env.WEBHOOK_SECRET || '';
    const eventTypes = ['EMAIL_SENT', 'EMAIL_REPLY', 'EMAIL_BOUNCE', 'LEAD_UNSUBSCRIBED', 'LEAD_CATEGORY_UPDATED'];
    if (testMode) eventTypes.push('EMAIL_OPEN'); // только нулевой прогон — техпроверка петли
    await smartlead.registerWebhook(extId, {
      name: `outreach-hub ${testMode ? 'zero-run' : 'campaign'} ${campaignId}`,
      url: `${base}/api/webhooks/smartlead?secret=${secret}`,
      eventTypes,
    });

    await smartlead.setStatus(extId, 'START');

    if (!testMode && usedContactIds.length) {
      // Канал и волна — параметрами (L2.1/L2.2): замок держится на пакете-волне,
      // LinkedIn-ячейка того же пакета (этап L3) пройдёт, чужая волна — нет.
      await markContactsActive(usedContactIds, extId, { channel: camp.channel || 'email', batchId });
      // Резерв снимаем: дальше контакт защищён статусом active_in_campaign.
      await releaseReservation(usedContactIds).catch(() => {});
    }
    await writeAudit({ actor: actorOf(req), action: 'campaign.launch', entity: 'campaign', entityId: extId,
      meta: { name, leads: usedContactIds.length || leadList.length, senders: senderIds, testMode } });

    // Пакет дублируется в Kommo, этап New leads (решение Ольги): CRM видит всех, кому написали.
    // Best-effort: сбой Kommo не должен отменять уже запущенную рассылку.
    let kommoPushed = 0;
    if (!testMode && kommoEnabled() && usedContactIds.length) {
      try {
        // Тянем всё, чем можно наполнить карточку: пустая CRM-карточка с одним адресом
        // не даёт менеджеру ничего, ради чего в неё стоит заходить. Запрос общий с кнопкой
        // «Meeting scheduled» — чтобы два места не разъехались по составу полей.
        const { contactsForKommo } = await import('./db/registry.js');
        const rows = await contactsForKommo(usedContactIds, { onlyUnlinked: true });
        if (rows.length) {
          const pairs = await pushLeadsToQualified(rows);
          await setKommoLeadIds(pairs);
          kommoPushed = pairs.filter((p) => p.kommoLeadId).length;
          const matched = pairs.filter((p) => p.matched).length;
          const stayed = pairs.filter((p) => p.matched && !p.moved).length;
          console.log(`[kommo] Qualified leads: ${kommoPushed}/${rows.length} (найдено существующих: ${matched}, из них оставлено на своём этапе: ${stayed})`);
          await writeAudit({ actor: actorOf(req), action: 'kommo.push', entity: 'campaign', entityId: extId,
            meta: { pushed: kommoPushed, matched, created: kommoPushed - matched, stayed } });
        }
      } catch (e) {
        console.error('[kommo] push failed (campaign still launched):', e.message);
      }
    }
    const updated = await updateCampaignRow(campaignId, {
      external_id: String(extId),
      status: 'active',
      leads_count: upload.total ?? leadList.length,
      started_at: new Date().toISOString(),
      senders: senderIds,
      meta: { ...(camp.meta || {}), schedule, testMode, rejected, batch_id: batchId },
    });

    console.log(`[campaign:launch] #${campaignId} → smartlead ${extId}, leads=${upload.total}, test=${testMode}`);
    res.json({
      ok: true,
      campaign: updated,
      smartlead_id: extId,
      uploaded: upload.total,
      rejected,
      kommo_pushed: kommoPushed,
      smartlead_url: `https://app.smartlead.ai/app/email-campaign/${extId}/analytics`,
    });
  } catch (e) {
    await updateCampaignRow(campaignId, { status: 'error', meta: { error: String(e.message || e) } }).catch(() => {});
    res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * Запуск LinkedIn-ячейки (L3.2). Отличия от email-пути по существу канала:
 * ключ лида — linkedin_slug (почта не обязательна), барьер CRM проверяется по slug
 * (ночной список + живая перепроверка), отправитель назначается НА ЛИДА по Value
 * («сильных — Стэну», решение §1.5) выбором флоу этого отправителя.
 * senderIds здесь — uuid'ы профилей GetSales в порядке приоритета.
 */
async function launchLinkedinCell(req, res, { camp, campaignId, contactIds, senderIds, batchId }) {
  try {
    if (!getsales.getsalesEnabled()) return res.status(503).json({ error: 'GETSALES_API_TOKEN не задан' });
    if (!contactIds.length) return res.status(400).json({ error: 'no contacts — a LinkedIn cell launches from a batch' });

    const angle = (await listMessageAngles()).find((a) => a.id === camp.message_angle_id);
    const liCheck = validateLinkedinTexts(angle?.linkedin);
    if (!liCheck.ok) {
      return res.status(400).json({ error: 'angle has no valid LinkedIn part — draft and approve it first', details: liCheck.errors });
    }

    // Карта «отправитель → флоу-лестница» — из Settings (разовое клонирование «Connect» в UI).
    const cfg = await channelConfig();
    const senders = senderIds.map(String);
    const missingFlow = senders.filter((s) => !cfg.senderFlows[s]);
    if (!senders.length || missingFlow.length) {
      return res.status(400).json({
        error: missingFlow.length
          ? `no ladder flow configured for sender profile(s): ${missingFlow.join(', ')} — set it in Settings (getsales_sender_flows)`
          : 'no sender profiles selected',
      });
    }

    // Pre-flight канала: жив, свой (волна) и со slug; почта не требуется.
    const { getPool } = await import('./db/registry.js');
    const rows = (await getPool().query(
      `SELECT c.id, c.full_name, c.first_name, c.last_name, c.title, c.company, c.email,
              c.linkedin_slug, c.lifecycle, c.quarantine_until, c.active_batch_id, c.liveness,
              (SELECT MAX(m.value_score) FROM contact_segment_match m WHERE m.contact_id = c.id) AS value_score
         FROM contact c WHERE c.id = ANY($1::int[])`,
      [contactIds.map(Number)],
    )).rows;
    const rejected = [];
    const reason = (c) => {
      if (!c.linkedin_slug) return 'no LinkedIn profile — this channel cannot reach them';
      if (COALESCE_DEAD(c)) return 'company looks dead';
      if (c.lifecycle === 'available') return null;
      if (c.lifecycle === 'active_in_campaign' && Number(c.active_batch_id) === Number(batchId)) return null; // своя волна
      if (c.lifecycle === 'active_in_campaign') return 'already active in another campaign — protected from a second cold touch';
      if (c.lifecycle === 'in_conversation') return 'a person is talking to them';
      if (c.lifecycle === 'quarantined') return `in quarantine until ${c.quarantine_until ? String(c.quarantine_until).slice(0, 10) : '—'}`;
      if (c.lifecycle === 'suppressed_forever') return 'suppressed';
      return `not available (${c.lifecycle})`;
    };
    function COALESCE_DEAD(c) { return (c.liveness || 'alive') === 'dead'; }

    // Канальный карантин (решение П4a): LinkedIn-касание младше 3 месяцев закрывает канал.
    // Дату держим ради причины отсева (L5.7): «трогали DD.MM — канал откроется DD.MM»,
    // а не безликое «недоступен». Молчаливого отсева не бывает.
    const touched = (await getPool().query(
      `SELECT contact_id, max(occurred_at) AS last_touch FROM touch
        WHERE channel = 'linkedin' AND event IN ('connection_sent', 'message_sent')
          AND contact_id = ANY($1::int[]) AND occurred_at > now() - interval '3 months'
        GROUP BY contact_id`,
      [contactIds.map(Number)],
    )).rows;
    const touchedSet = new Map(touched.map((r) => [r.contact_id, r.last_touch]));

    // Барьер CRM: ночной список (email+slug) + живая перепроверка по slug.
    const crmBlocked = new Map();
    for (const row of await blockedContactIds(contactIds.map(Number)).catch(() => [])) {
      crmBlocked.set(row.id, `already in the CRM — ${row.stage_name} · ${row.pipeline_name}`);
    }
    const surviving = rows.filter((c) => !reason(c) && !crmBlocked.has(c.id) && !touchedSet.has(c.id));
    if (kommoEnabled() && surviving.length) {
      const raw = await checkLinkedinLive(surviving.map((c) => c.linkedin_slug)).catch(() => []);
      const live = await filterLiveHits(raw).catch(() => raw);
      const hitSet = new Map(live.map((h) => [h.slug, h]));
      for (const c of surviving) {
        const hit = hitSet.get(c.linkedin_slug);
        if (hit) crmBlocked.set(c.id, `moved in the CRM today — ${hit.stage} · ${hit.pipeline}`);
      }
    }

    const passed = [];
    const reopenOf = (d) => { const x = new Date(d); x.setMonth(x.getMonth() + 3); return x.toISOString().slice(0, 10); };
    for (const c of rows) {
      const t = touchedSet.get(c.id);
      const r = reason(c) || crmBlocked.get(c.id)
        || (t ? `LinkedIn touched ${String(t).slice(0, 10)} — the channel reopens ${reopenOf(t)}` : null);
      if (r) rejected.push({ id: c.id, name: c.full_name, reason: r });
      else passed.push(c);
    }
    if (!passed.length) return res.status(400).json({ error: 'no leads passed pre-flight', rejected });

    // Распределение по Value: сортируем и режем блоками в порядке приоритета отправителей.
    passed.sort((a, b) => Number(b.value_score || 0) - Number(a.value_score || 0));
    const perSender = Math.ceil(passed.length / senders.length);
    const assignment = {}; // contact_id → sender_profile_uuid
    passed.forEach((c, i) => { assignment[c.id] = senders[Math.min(Math.floor(i / perSender), senders.length - 1)]; });

    // Список GetSales = ячейка; заливка батчами; карта slug → lead_uuid из серверного поиска.
    const name = `OH ${camp.segment_name || 'no-segment'} × ${angle.name} · ${new Date().toISOString().slice(0, 10)}`;
    const list = await getsales.createList(name);
    const listUuid = list?.uuid || list?.data?.uuid;
    if (!listUuid) return res.status(502).json({ error: 'GetSales did not return a list uuid' });
    for (let i = 0; i < passed.length; i += 100) {
      await getsales.uploadLeads(listUuid, passed.slice(i, i + 100).map((c) => ({
        linkedin: c.linkedin_slug,
        first_name: c.first_name || (c.full_name || '').split(' ')[0] || '',
        last_name: c.last_name || (c.full_name || '').split(' ').slice(1).join(' ') || '',
        company_name: c.company || '',
        position: c.title || '',
        work_email: c.email || null,
      })));
    }
    const uploaded = await getsales.leadsOfList(listUuid);
    const bySlug = new Map(uploaded.map((r) => [(r.lead || r).linkedin, (r.lead || r).uuid]));
    const leadMap = {}; // lead_uuid → contact_id
    const byFlow = {};  // flow_uuid → [lead_uuid]
    for (const c of passed) {
      // GetSales не заводит второго лида на тот же профиль: человек из импортированной
      // истории (2 433 записи) уже существует лидом, и заливка по нему — пустая операция.
      // Такие люди молча выпадали бы из волны, поэтому ищем существующего лида по slug
      // и привязываем к лестнице его (находка 18.08 на тесте отзыва заявки).
      let leadUuid = bySlug.get(c.linkedin_slug);
      if (!leadUuid) {
        const existing = await getsales.findLeadBySlug(c.linkedin_slug).catch(() => null);
        if (existing?.uuid) leadUuid = existing.uuid;
      }
      if (!leadUuid) { rejected.push({ id: c.id, name: c.full_name, reason: 'GetSales has no lead for this profile and the upload created none' }); continue; }
      leadMap[leadUuid] = c.id;
      const flow = cfg.senderFlows[assignment[c.id]];
      (byFlow[flow] = byFlow[flow] || []).push(leadUuid);
    }
    for (const [flowUuid, uuids] of Object.entries(byFlow)) {
      await getsales.attachToFlow(uuids, flowUuid);
    }

    await markContactsActive(Object.values(leadMap), listUuid, { channel: 'linkedin', batchId });
    await releaseReservation(Object.values(leadMap)).catch(() => {});
    // Kommo — та же механика, что у email: пакет дублируется в Qualified leads (мэтч и по slug).
    let kommoPushed = 0;
    if (kommoEnabled() && Object.values(leadMap).length) {
      try {
        const { contactsForKommo } = await import('./db/registry.js');
        const kRows = await contactsForKommo(Object.values(leadMap), { onlyUnlinked: true });
        if (kRows.length) {
          const pairs = await pushLeadsToQualified(kRows);
          await setKommoLeadIds(pairs);
          kommoPushed = pairs.filter((p) => p.kommoLeadId).length;
        }
      } catch (e) { console.error('[kommo] push failed (LinkedIn cell still launched):', e.message); }
    }

    const updated = await updateCampaignRow(campaignId, {
      external_id: String(listUuid),
      status: 'active',
      leads_count: Object.keys(leadMap).length,
      started_at: new Date().toISOString(),
      senders: senders,
      meta: {
        ...(camp.meta || {}),
        batch_id: batchId,
        rejected,
        getsales: { lead_map: leadMap, assignment, sender_flows: cfg.senderFlows },
      },
    });
    await writeAudit({ actor: actorOf(req), action: 'campaign.launch', entity: 'campaign', entityId: String(listUuid),
      meta: { name, channel: 'linkedin', leads: Object.keys(leadMap).length, senders, batchId } });
    console.log(`[campaign:launch:linkedin] #${campaignId} → list ${listUuid}, leads=${Object.keys(leadMap).length}, senders=${senders.length}`);
    res.json({ ok: true, campaign: updated, list_uuid: listUuid, uploaded: Object.keys(leadMap).length, rejected, kommo_pushed: kommoPushed });
  } catch (e) {
    await updateCampaignRow(campaignId, { status: 'error', meta: { error: String(e.message || e) } }).catch(() => {});
    res.status(500).json({ error: String(e.message || e) });
  }
}

// --- Вебхуки GetSales: вне пароля (OPEN_PATHS), защита секретом; payload пишется сырым ---
// Формат событий не задокументирован (хвост L0.5) — приёмник складывает сырое в event_log
// и дёргает ту же синхронизацию, что и часовой поллер: источник правды один — markers.
let gsSyncQueued = false;
app.post('/api/webhooks/getsales', async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(401).json({ error: 'bad secret' });
  if (!requireRegistry(res)) return;
  try {
    const { getPool } = await import('./db/registry.js');
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
    await getPool().query(
      `INSERT INTO event_log (source, event_type, payload_hash, payload)
       VALUES ('getsales', $1, $2, $3) ON CONFLICT (payload_hash) DO NOTHING`,
      [String(req.body?.event || req.body?.type || req.body?.event_type || 'unknown'), hash, JSON.stringify(req.body)],
    );
    // Немедленный триггер синхронизации, с дебаунсом: пачка вебхуков = один прогон.
    if (!gsSyncQueued) {
      gsSyncQueued = true;
      setTimeout(() => { gsSyncQueued = false; syncLinkedinCampaigns().catch((e) => console.error('[getsales:sync]', e.message)); }, 5000);
    }
    res.json({ stored: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Конфиг LinkedIn-канала: карта «отправитель → флоу», лимиты сообщений (Settings, L3).
// Ручная отметка принятия заявки: человек видит принятие в GetSales, автомат его проспал
// (маркеры живут только пока лид в потоке — разбор 17.08). Пишем факт и сразу зовём синк,
// чтобы сообщение №1 ушло без ожидания часового поллера.
app.post('/api/getsales/mark-accepted', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const r = await markAcceptedByHand({ leadUuid: req.body?.leadUuid, actor: actorOf(req) });
    await writeAudit({ actor: actorOf(req), action: 'getsales.mark_accepted', entity: 'touch', entityId: null,
      meta: { lead_uuid: req.body?.leadUuid, ...r } }).catch(() => {});
    const sync = await syncLinkedinCampaigns().catch((e) => ({ error: String(e.message || e) }));
    res.json({ ...r, sync });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Починка ложной записи об отправке (разбор 17.08): с messageUuid — переставить время
// и привязать реальное сообщение, без него — удалить запись, чтобы оркестратор отправил заново.
app.post('/api/getsales/repair-send', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const r = await repairSendTouch({
      leadUuid: req.body?.leadUuid, event: req.body?.event || 'message_sent',
      messageUuid: req.body?.messageUuid || null, actor: actorOf(req),
    });
    await writeAudit({ actor: actorOf(req), action: 'getsales.repair_send', entity: 'touch', entityId: null,
      meta: { lead_uuid: req.body?.leadUuid, ...r } }).catch(() => {});
    res.json(r);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Порядок отправителей LinkedIn — по ПРИОРИТЕТУ, а не по алфавиту (решение Ольги 18.08).
// Порядок здесь не косметика: в билдере профили кликают по очереди, и первый выбранный
// получает самый ценный блок пакета (правило «сильных — Стэну»). Алфавит ставил бы во главу
// случайного человека и тихо ломал правило распределения.
const SENDER_PRIORITY = ['Stan Moskovtsev', 'Anton Buzdalin', 'Maria Holtz', 'Natalia Zh',
  'Shikhar Gupta', 'Dalia Sharma', 'Nitha Purnama', 'Prasetya Imansyah', 'Rianto Pratama',
  'Natalia Sidorevich'];
const senderRank = (name) => {
  const i = SENDER_PRIORITY.findIndex((n) => n.toLowerCase() === String(name || '').trim().toLowerCase());
  return i === -1 ? SENDER_PRIORITY.length : i;   // незнакомые — в конец, но не теряются
};

app.get('/api/getsales/config', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const cfg = await channelConfig();
    const [profiles, flows, accounts] = getsales.getsalesEnabled()
      ? await Promise.all([
        getsales.listSenderProfiles().catch(() => []),
        getsales.listFlows().catch(() => []),
        getsales.linkedinAccounts().catch(() => []),
      ])
      : [[], [], []];
    // Пульс аккаунта: живой бьётся ежедневно. Порог 3 дня — с запасом на выходные,
    // но заметно меньше «замер на месяц» (случай Антона, 18.08).
    const HEARTBEAT_STALE_DAYS = 3;
    const health = {};
    for (const a of accounts) {
      const beat = a.last_tasks_heartbeat_at || a.last_messages_heartbeat_at || null;
      const ageDays = beat ? Math.floor((Date.now() - new Date(beat).getTime()) / 864e5) : null;
      health[a.sender_profile_uuid] = {
        heartbeat_at: beat,
        heartbeat_age_days: ageDays,
        alive: ageDays != null && ageDays <= HEARTBEAT_STALE_DAYS,
        weekly_limit_at: a.last_connection_weekly_limit_at || null,
      };
    }
    res.json({
      enabled: getsales.getsalesEnabled(),
      ...cfg,
      profiles: profiles
        .map((p) => ({
          uuid: p.uuid, name: `${p.first_name} ${p.last_name}`, label: p.label,
          status: p.status, hold_tasks_till: p.hold_tasks_till, smart_limits: p.smart_limits_enabled,
          ...(health[p.uuid] || { alive: null, heartbeat_at: null, heartbeat_age_days: null, weekly_limit_at: null }),
        }))
        .sort((a, b) => senderRank(a.name) - senderRank(b.name) || a.name.localeCompare(b.name)),
      flows: flows.map((f) => ({ uuid: f.uuid, name: f.name, status: f.status })),
      // Метрика поздних принятий (L5.4) — живёт рядом с параметром окна, который она обосновывает.
      lateAccepts: await lateAcceptStats().catch(() => null),
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/getsales/config', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const cfg = await saveChannelConfig({
      senderFlows: req.body?.senderFlows, limits: req.body?.limits,
      acceptWindowDays: req.body?.acceptWindowDays,
    });
    await writeAudit({ actor: actorOf(req), action: 'getsales.config', entity: 'app_state', entityId: null, meta: cfg });
    res.json(cfg);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Ручной прогон синхронизации (отладка и нулевой прогон).
app.post('/api/getsales/sync', async (req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await syncLinkedinCampaigns({ send: req.body?.send !== false })); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Вебхуки Smartlead: вне пароля, защита секретом в query (?secret=WEBHOOK_SECRET) ---
app.post('/api/webhooks/smartlead', async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(401).json({ error: 'bad secret' });
  if (!requireRegistry(res)) return;
  try {
    const result = await processSmartleadEvent(req.body);
    console.log('[webhook:smartlead]', result.eventType || 'dup', result.actions || '');
    // Петля bounce (ТЗ п.32): проверяем пороги сразу после отскока. Ответ вебхуку не ждёт —
    // Smartlead не должен получать 500 из-за нашей телеграм-отправки.
    if ((result.actions || []).some((a) => String(a).startsWith('bounce:'))) {
      bounceGuard(String(req.body?.campaign_id ?? '')).catch((e) => console.error('[bounce-guard]', e.message));
    }
    res.json(result);
  } catch (e) {
    console.error('[webhook:smartlead] error:', e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Ручная коррекция ЖЦ контакта (вкладка Contacts, за паролем).
app.post('/api/registry/contacts/:id/lifecycle', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const out = await setContactLifecycle(Number(req.params.id), req.body.lifecycle, req.body.quarantine_until ?? null);
    await writeAudit({ actor: actorOf(req), action: 'contact.lifecycle', entity: 'contact', entityId: req.params.id, meta: { to: req.body.lifecycle } });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Закрытие кампании: неответившие → карантин +3 мес (за паролем, зовётся из панели/оркестратора).
app.post('/api/registry/campaigns/:extId/close', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    res.json(await closeCampaign(req.params.extId));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Суточный обход (ТЗ п.25): авто-закрытие протухших разговоров + утренний дайджест неотвеченных.
// Дайджест — ОДИН раз в день, а не пинг на каждое сообщение: повторные пинги превращаются в шум
// и обесценивают первый, мгновенный (правило «в 4:47 сейлз уже должен ответить»).
const DIGEST_HOUR_ET = 9;
// ⚠️ Отметка «дайджест за сегодня ушёл» ХРАНИТСЯ В БАЗЕ, а не в памяти процесса.
// Баг 11.08: она была переменной, каждый деплой Railway сбрасывал её, и дайджест ушёл
// пять раз за час — по числу выкаток. Всё, что должно случаться «раз в сутки», обязано
// переживать перезапуск, иначе частота привязана к темпу деплоев, а не к суткам.

async function dailyMaintenance() {
  if (!registryEnabled()) return;
  try {
    const closed = await autoCloseStaleConversations(7);
    if (closed.length) console.log(`[maintenance] auto-closed ${closed.length} stale conversation(s)`);
  } catch (e) { console.error('[maintenance] auto-close failed:', e.message); }

  // Барьер CRM — раз в сутки в фиксированный час (правка 13.08). Раньше стояло
  // `setInterval(24 часа)` от старта процесса: на Railway каждый деплой перезапускает процесс,
  // поэтому «ночная» синхронизация уезжала на время последнего деплоя и ночной не была.
  try {
    const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dayKey = nowEt.toISOString().slice(0, 10);
    // Отметка дня — в БД, не в памяти (та же грабля, что у дайджеста 11.08): каждый деплой
    // перезапускает процесс, и in-memory отметка давала полную пересборку стоп-листа на
    // каждый пуш — 8 лишних прогонов за день 13.08 (найдено по журналу).
    if (lastCrmSyncDay === null) lastCrmSyncDay = await getState('crm_sync_day').catch(() => null);
    if (kommoEnabled() && nowEt.getHours() >= CRM_SYNC_HOUR_ET && lastCrmSyncDay !== dayKey) {
      // День помечаем ТОЛЬКО после успеха. Раньше метка ставилась до прогона, и один
      // сетевой сбой оставлял барьер на вчерашних данных на целые сутки — автоповтора
      // не было вовсе (найдено по сбою 13.08 в 16:00). Теперь следующая часовая проверка
      // попробует снова, и так до первого успеха.
      const ok = await syncCrmBlocklist('cron').then(() => true).catch(() => false);
      if (ok) { lastCrmSyncDay = dayKey; await setState('crm_sync_day', dayKey).catch(() => {}); }
      else console.warn('[maintenance] синхронизация барьера не удалась — повторим через час');
    }
  } catch (e) { console.error('[maintenance] crm sync gate failed:', e.message); }

  // Закрытие отработавших кампаний (дыра, найденная вопросом Ольги 11.08).
  // `closeCampaign` существовал только эндпоинтом: ни кнопки, ни триггера. Smartlead события
  // «кампания завершена» не присылает, поэтому контакты оставались active_in_campaign НАВСЕГДА,
  // и правило «карантин 3 месяца, потом снова доступен» никогда не срабатывало — реестр
  // медленно замерзал. Спрашиваем статус сами: в аналитике Smartlead он есть (COMPLETED).
  if (smartlead.smartleadEnabled()) {
    try {
      // Два условия, а не одно: Smartlead сказал COMPLETED (больше писем не будет) И с последней
      // фактической отправки прошло окно дозревания ответов. Отсчёт от письма, а не от статуса.
      const open = await openCampaignsToCheck();
      for (const c of open) {
        const a = await smartlead.campaignAnalytics(c.external_id).catch(() => null);
        if (!a || String(a.status).toUpperCase() !== 'COMPLETED') continue;
        const out = await closeCampaign(String(c.external_id));
        await updateCampaignRow(c.id, { status: 'completed', closed_at: new Date().toISOString() });
        await writeAudit({ actor: 'cron', action: 'campaign.close', entity: 'campaign', entityId: c.external_id,
          meta: { ...out, days_since_last_send: c.days_since_last_send } });
        console.log(`[maintenance] кампания ${c.external_id}: последняя отправка ${c.days_since_last_send} дн. назад → в карантин ${out.quarantined}`);
      }
    } catch (e) { console.error('[maintenance] закрытие кампаний упало:', e.message); }
  }

  // LinkedIn-ячейки (L3.4): markers → touch, ответы → Inbox/пинг, оркестратор сообщений.
  // Час — достаточный темп лестницы (заявки принимают днями); вебхук ускоряет до секунд.
  if (getsales.getsalesEnabled()) {
    try { await syncLinkedinCampaigns(); } catch (e) { console.error('[maintenance] getsales sync failed:', e.message); }
  }

  try {
    const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dayKey = nowEt.toISOString().slice(0, 10);
    if (nowEt.getHours() < DIGEST_HOUR_ET) return;
    if (await getState('digest_day') === dayKey) return;
    const waiting = await waitingConversations(24);
    // Блок доставляемости (ТЗ п.32) выходит и в тихий день: «вчера отправлено 0» — тоже
    // информация, а нулевой bounce при живой волне надо видеть так же, как ненулевой.
    const d = await deliverabilityDigest(24).catch(() => null);
    const deliverability = d && (d.sent || d.bounced) ? [
      '',
      `📮 Deliverability, last 24h: sent ${d.sent} · bounced ${d.bounced} (${(d.rate * 100).toFixed(1)}%)`,
      `   hard ${d.hard} — buried · soft ${d.soft} — quarantined 30 days, will retry`,
      d.worstMailbox && Number(d.worstMailbox.sent) > 0
        ? `   Worst mailbox (7d): ${d.worstMailbox.mailbox} — ${d.worstMailbox.bounced}/${d.worstMailbox.sent}`
        : '',
      d.worstSource ? `   Most bounces by source (7d): ${d.worstSource.source} — ${d.worstSource.bounced}` : '',
      d.buried ? `   Contacts buried in the last 24h: ${d.buried}` : '',
    ].filter(Boolean) : [];

    // Молчим, когда сообщать нечего: «отправлено 4, отскоков 0» — не новость, а шум,
    // а шум обесценивает те дайджесты, в которых новость есть.
    const worthSending = waiting.length > 0 || (d && d.bounced > 0);
    if (!worthSending) { await setState('digest_day', dayKey); return; }
    await setState('digest_day', dayKey);
    const head = waiting.length ? [
      `☀️ Morning digest — ${waiting.length} repl${waiting.length === 1 ? 'y is' : 'ies are'} waiting for an answer`,
      ...(() => {
        const oldest = waiting[0];
        const hours = Math.round((Date.now() - new Date(oldest.occurred_at)) / 36e5);
        return [
          `Oldest: ${oldest.full_name || oldest.email} @ ${oldest.company || '—'} — ${hours}h (${oldest.classification || 'unclassified'})`,
          ...waiting.slice(1, 6).map((w) => `· ${w.full_name || w.email} @ ${w.company || '—'}`),
          waiting.length > 6 ? `…and ${waiting.length - 6} more` : '',
          'Open the Inbox tab to reply.',
        ];
      })(),
    ] : ['☀️ Morning digest — no replies waiting'];

    await sendTelegram([...head, ...deliverability].filter(Boolean).join('\n'));
    console.log(`[maintenance] digest sent: ${waiting.length} waiting, deliverability=${deliverability.length > 0}`);
  } catch (e) { console.error('[maintenance] digest failed:', e.message); }
}

// --- Петля bounce: пороги и автопауза (ТЗ п.32) --------------------------------------------
// Автопауза — единственное автоматическое действие во всей петле, остальное только сообщает.
// Поэтому она ОБЯЗАНА сказать о себе немедленно: молчаливая пауза до утреннего дайджеста
// хуже лишнего пинга — оператор будет считать, что рассылка идёт.
const bouncePinged = new Set(); // чтобы не пинговать на каждый следующий отскок той же кампании

async function bounceGuard(campaignExtId) {
  if (!campaignExtId || !registryEnabled()) return null;
  const s = await campaignBounceStats(campaignExtId);
  if (s.level === 'digest') return s;                       // ниже порога — молчим до утра
  const key = `${campaignExtId}:${s.level}`;
  if (bouncePinged.has(key)) return s;
  bouncePinged.add(key);

  const pct = (s.rate * 100).toFixed(1);
  let head = `⚠️ Bounce ${pct}% (${s.bounced} of ${s.sent}) — campaign ${campaignExtId}`;
  if (s.level === 'pause') {
    try {
      await smartlead.setStatus(campaignExtId, 'PAUSED');
      head = `⛔️ Campaign ${campaignExtId} PAUSED automatically — bounce ${pct}% (${s.bounced} of ${s.sent})`;
    } catch (e) {
      head = `⛔️ Bounce ${pct}% on campaign ${campaignExtId} — AUTO-PAUSE FAILED (${e.message}). Pause it by hand.`;
    }
  }
  await sendTelegram([
    head,
    `hard ${s.hard} · soft ${s.soft} (soft = quarantined 30 days, not buried)`,
    s.level === 'pause'
      ? `Threshold ${Math.round(BOUNCE_PAUSE * 100)}% — the list is the suspect, not the copy. Check the source of these contacts before resuming.`
      : `Threshold ${Math.round(BOUNCE_ALERT * 100)}% with at least ${BOUNCE_FLOOR} bounces. Watching.`,
  ].join('\n'));
  return s;
}

app.get('/api/deliverability', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await deliverabilityDigest(24)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Валидация адресов (ТЗ п.31) ---------------------------------------------------------
// Проверка асинхронная: сохранение контакта её не ждёт (двести адресов синхронно — это минуты
// крутилки и потеря всего при сбое). Воркер разгребает очередь фоном, статусы появляются сами.
let verifyBusy = false;
let verifyState = { running: false, done: 0, outOfCredits: false, lastRun: null };

async function verificationSweep(limit = 40) {
  if (!registryEnabled() || !verifyEnabled() || verifyBusy) return verifyState;
  verifyBusy = true;
  verifyState = { ...verifyState, running: true, done: 0, outOfCredits: false };
  try {
    const rows = await contactsToVerify(limit);
    for (const row of rows) {
      const res = await verifyEmail(row.email);
      // Кредиты кончились — НЕ помечаем контакты, просто останавливаемся: иначе вся пачка
      // получит `unknown` из-за нашей биллинговой проблемы (правило «ошибка инфраструктуры
      // не хоронит контакт»).
      if (res.outOfCredits) { verifyState.outOfCredits = true; break; }
      await applyVerification(row.id, res);
      verifyState.done += 1;
    }
    if (verifyState.done) console.log(`[verify] проверено ${verifyState.done}`);
  } catch (e) {
    console.error('[verify] sweep failed:', e.message);
  } finally {
    verifyBusy = false;
    verifyState = { ...verifyState, running: false, lastRun: new Date().toISOString() };
  }
  return verifyState;
}

app.get('/api/verify/state', async (_req, res) => {
  try {
    const out = { enabled: verifyEnabled(), ...verifyState };
    if (verifyEnabled()) out.balance = await verifyCredits().catch(() => null);
    if (registryEnabled()) out.counters = await verifyCounters().catch(() => null);
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Ручной прогон — им же делается разовая проверка накопленного реестра.
app.post('/api/verify/run', async (req, res) => {
  if (!requireRegistry(res)) return;
  if (!verifyEnabled()) return res.status(503).json({ error: 'MILLIONVERIFIER_API_KEY не задан' });
  try { res.json(await verificationSweep(Number(req.body?.limit) || 200)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Ре-верификация конкретных контактов — видимый шаг pre-flight перед сборкой пакета
// (замечание Ольги 10.08: состав пакета не должен меняться после подтверждения).
app.post('/api/verify/stale', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const ids = (req.body?.contactIds || []).map(Number).filter(Boolean);
    const rows = await staleContacts(ids, Number(req.body?.days) || 90);
    if (!req.body?.apply) return res.json({ stale: rows.length, contacts: rows });
    if (!verifyEnabled()) return res.status(503).json({ error: 'MILLIONVERIFIER_API_KEY не задан' });
    const changed = [];
    for (const row of rows) {
      const before = row.email_status;
      const out = await verifyEmail(row.email);
      if (out.outOfCredits) return res.json({ checked: changed.length, changed, outOfCredits: true });
      await applyVerification(row.id, out);
      if (out.status !== before) changed.push({ id: row.id, email: row.email, from: before, to: out.status });
    }
    res.json({ checked: rows.length, changed, outOfCredits: false });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Качество источников: меряет живость адресов, НЕ релевантность лида (подпись обязательна в UI).
app.get('/api/verify/sources', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await sourceQuality()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Вердикты по индустриям для выдачи поиска (ТЗ п.38). Клиент присылает выбранную индустрию
// и список индустрий компаний; отвечаем картой company → verdict. Кэш внутри.
app.post('/api/industry/judge', async (req, res) => {
  try {
    const { selected, companies = [] } = req.body || {};
    if (!selected) return res.json({});
    res.json(await judgeIndustries(String(selected), companies));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// История контакта для выдачи поиска (вопрос Стаса 11.08: «зачем ты мне их показываешь,
// если им уже что-то отправили»). Зелёного бейджа «в реестре» мало — нужна история.
app.post('/api/registry/state', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    // Профили приходят сырыми URL из выдачи — нормализуем в slug здесь, а не на клиенте.
    const slugs = (req.body?.linkedins || []).map((u) => linkedinSlug(u)).filter(Boolean);
    res.json(await registryStateByEmail(req.body?.emails || [], slugs));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Барьер CRM (ТЗ п.28) -------------------------------------------------------------------
// Ночная полная синхронизация: лид переезжает между этапами, и нам важен ТЕКУЩИЙ этап,
// а не факт изменения — поэтому перезаписываем целиком, а не инкрементально.
let crmSyncing = false;
let lastCrmSyncDay = null;
const CRM_SYNC_HOUR_ET = 3;   // 3 утра по ET — до начала рабочего дня в США
// Насколько старым должен быть список, чтобы пересобирать его на старте процесса.
const STARTUP_SYNC_MAX_AGE_H = 6;
async function syncCrmBlocklist(actor = 'cron') {
  if (!registryEnabled() || !kommoEnabled() || crmSyncing) return null;
  crmSyncing = true;
  const t0 = Date.now();
  try {
    const { rows } = await buildCrmBlocklist();
    const out = await replaceCrmBlocklist(rows);
    console.log(`[crm-block] синхронизация: ${out.emails} адресов, ${out.domains} доменов за ${Math.round((Date.now() - t0) / 1000)} c`);
    await writeAudit({ actor, action: 'crm.sync', entity: 'crm_block', meta: out });
    return out;
  } catch (e) {
    console.error('[crm-block] синхронизация упала:', e.message);
    // Записываем сбой туда, откуда его читает интерфейс. Раньше `last_error` заполнялся
    // только при падении ЗАПИСИ в базу, а падение ВЫГРУЗКИ из Kommo туда не попадало —
    // на экране было «synced Nh ago» без единого намёка, что прогон вообще был и упал.
    await noteSyncFailure(e).catch(() => {});
    // Молчаливый сбой здесь опаснее всего: барьер продолжает работать на вчерашних данных,
    // и снаружи всё выглядит нормально (вопрос Ольги 13.08). Поэтому пинг сразу.
    await sendTelegram([
      '🔴 Kommo barrier sync FAILED',
      String(e.message || e).slice(0, 300),
      'The stop-list is now stale: leads already in the CRM may pass into a cold campaign.',
      actor === 'cron'
        ? 'Automatic retry in an hour. To force it: Settings → Kommo — stop list → Sync now.'
        : 'Settings → Kommo — stop list → Sync now, after fixing the cause.',
    ].join('\n'), { adminOnly: true }).catch(() => {});
    throw e;
  } finally { crmSyncing = false; }
}

// Правила интеграции для показа человеку. Отдаём из кода, а не из руками написанного текста:
// скопированная таблица через месяц начинает врать, а врущей документации верят (вопрос Ольги 13.08).
app.get('/api/kommo/rules', (_req, res) => res.json(integrationRules()));

app.get('/api/crm/state', async (_req, res) => {
  try {
    const counts = registryEnabled() ? await effectiveBlockCounts().catch(() => null) : null;
    res.json({ enabled: kommoEnabled(), syncing: crmSyncing, ...(await crmSyncState() || {}), counts });
  }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/crm/sync', async (req, res) => {
  if (!requireRegistry(res)) return;
  if (!kommoEnabled()) return res.status(503).json({ error: 'KOMMO_API_TOKEN не задан' });
  try { res.json(await syncCrmBlocklist(actorOf(req))); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// Сам стоп-лист: просмотр с поиском (вопрос Ольги 13.08 — список должен быть видимым).
app.get('/api/crm/blocklist', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    res.json(await listBlocklist({
      q: req.query.q || '', level: req.query.level || null, pipeline: req.query.pipeline || null,
      stage: req.query.stage || null, notes: req.query.notes || null, owner: req.query.owner || null,
      limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Разбивка по этапам + снятие/возврат ЦЕЛОГО этапа одной кнопкой (предложение Ольги 13.08).
app.get('/api/crm/stages', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try {
    res.json({
      stages: await blocklistByStage(), rules: await activeStageRules(),
      approvals: JSON.parse(await getState('stoplist_review_approvals') || '{}'),
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// «✓ My part is reviewed» (L5.10, решение Ольги 14.08): владелец отмечает, что разобрал свою
// часть стоп-листа. Отметка — гейт для боевых волн («можно запускать, тёплых не заденем»),
// а не блокирующий механизм: повторное нажатие просто обновляет дату (перепроверка через месяц).
app.post('/api/crm/review-approve', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const owner = String(req.body?.owner || '').trim();
    if (!owner) return res.status(400).json({ error: 'нужен owner' });
    const approvals = JSON.parse(await getState('stoplist_review_approvals') || '{}');
    approvals[owner] = { actor: actorOf(req), at: new Date().toISOString() };
    await setState('stoplist_review_approvals', JSON.stringify(approvals));
    await writeAudit({ actor: actorOf(req), action: 'crm.review_approve', entity: 'crm_block', meta: { owner } });
    res.json({ ok: true, approvals });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/crm/stage-rule', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { pipelineName, stageName, reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'нужна причина' });
    const row = await setStageRule({ pipelineName, stageName, action: 'allow', reason, actor: actorOf(req) });
    await writeAudit({ actor: actorOf(req), action: 'crm.stage_unblock', entity: 'crm_block_rule', entityId: row.id,
      meta: { pipeline: pipelineName, stage: stageName, reason } });
    res.json(row);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.post('/api/crm/stage-rule/:id/revoke', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const row = await revokeStageRule(req.params.id, actorOf(req));
    await writeAudit({ actor: actorOf(req), action: 'crm.stage_reblock', entity: 'crm_block_rule', entityId: req.params.id,
      meta: { pipeline: row?.pipeline_name, stage: row?.stage_name } });
    res.json(row);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Ручная правка: снять блок или поставить его руками. Причина обязательна.
app.post('/api/crm/override', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { subject, kind = 'email', action, reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'нужна причина' });
    const row = await setOverride({ subject, kind, action, reason, actor: actorOf(req) });
    await writeAudit({
      actor: actorOf(req), action: action === 'allow' ? 'crm.unblock' : 'crm.block',
      entity: 'crm_block_override', entityId: row.id, meta: { subject: row.subject, kind, reason },
    });
    // Решение дублируем в карточку Kommo: при разборе «почему вы написали моему лиду»
    // смотреть будут туда (вопрос Ольги 13.08). Best-effort — ответ не задерживаем.
    pushStopListNotes({ subjects: [row.subject], action, reason, actor: actorOf(req) });
    res.json(row);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Массовое снятие по фильтру списка. Отдельно от правила этапа: правило подхватывает НОВЫХ
// людей на том же этапе, а это — разовое решение про конкретных, уже видимых на экране.
/**
 * Пишет решение о стоп-листе в карточки Kommo. В фоне и по три параллельно: массовое снятие
 * может задеть тысячи адресов, и держать ради этого HTTP-ответ нельзя. Сбой примечания
 * не отменяет само снятие — оно уже записано у нас.
 */
async function pushStopListNotes({ subjects = [], action, reason, actor }) {
  if (!kommoEnabled() || !registryEnabled() || !subjects.length) return;
  setImmediate(async () => {
    try {
      const { getPool } = await import('./db/registry.js');
      const rows = (await getPool().query(
        'SELECT DISTINCT email, lead_id FROM crm_block WHERE email = ANY($1::text[]) AND lead_id IS NOT NULL',
        [subjects.map((x) => String(x).toLowerCase())],
      )).rows;
      let done = 0;
      const q = [...rows];
      async function worker() {
        while (q.length) {
          const r = q.shift();
          const ok = await noteStopListChange(r.lead_id, { subject: r.email, action, reason, actor }).catch(() => false);
          if (ok) done += 1;
        }
      }
      await Promise.all(Array.from({ length: 3 }, worker));
      console.log(`[crm-block] решение записано в Kommo: ${done} из ${rows.length} карточек`);
    } catch (e) { console.warn('[crm-block] примечания в Kommo не записались:', e.message); }
  });
}

// Тёплые карточки, которые барьер защитить не может (нет ни одного адреса). Считается
// живым обходом Kommo, поэтому отдельной кнопкой, а не на каждой загрузке страницы.
app.get('/api/crm/unprotected', async (_req, res) => {
  try { res.json(await unprotectedWarmLeads()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/crm/override/bulk', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const { pipeline = null, stage = null, q = '', notes = null, owner = null, action = 'allow', reason } = req.body || {};
    const out = await bulkOverride({ pipeline, stage, q, notes, owner, action, reason, actor: actorOf(req) });
    await writeAudit({
      actor: actorOf(req), action: action === 'allow' ? 'crm.unblock' : 'crm.block',
      entity: 'crm_block_override', entityId: null,
      meta: { bulk: true, affected: out.affected, pipeline, stage, notes, q: q || null, reason },
    });
    console.log(`[crm-block] массовое снятие: ${out.affected} адресов · ${pipeline || 'все воронки'} / ${stage || 'все этапы'}`);
    pushStopListNotes({ subjects: out.subjects, action, reason, actor: actorOf(req) });
    res.json(out);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.post('/api/crm/override/:id/revoke', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const row = await revokeOverride(req.params.id, actorOf(req));
    await writeAudit({ actor: actorOf(req), action: 'crm.override_revoke', entity: 'crm_block_override', entityId: req.params.id, meta: { subject: row?.subject } });
    res.json(row);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Проверка выдачи поиска: адреса точечно, домены — только «тёплые» компании,
// LinkedIn-slug — единственный ключ для людей без почты (L1.2).
app.post('/api/crm/check', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    res.json(await checkBlocked({
      emails: req.body?.emails || [], domains: req.body?.domains || [], slugs: req.body?.slugs || [],
    }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Пользователи и журнал (вкладка Settings, ТЗ п.37) ---
app.get('/api/me', (req, res) => res.json(req.user || null));

app.get('/api/users', async (_req, res) => {
  if (!requireRegistry(res)) return;
  try { res.json(await listUsers()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/users', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const u = await createUser(req.body || {});
    await writeAudit({ actor: actorOf(req), action: 'user.create', entity: 'app_user', entityId: u.id, meta: { login: u.login } });
    res.json(u);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.post('/api/users/:id/active', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    const u = await setUserActive(req.params.id, req.body?.active !== false);
    await writeAudit({ actor: actorOf(req), action: 'user.active', entity: 'app_user', entityId: req.params.id, meta: { active: u?.active } });
    res.json(u);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.get('/api/audit', async (req, res) => {
  if (!requireRegistry(res)) return;
  try {
    res.json({
      rows: await listAudit({
        limit: req.query.limit,
        actor: req.query.actor || null,
        action: req.query.action || null,
        actions: req.query.actions ? String(req.query.actions).split(',').filter(Boolean) : null,
        humansOnly: req.query.humansOnly === '1',
      }),
      actors: await auditActors(),
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    registry: registryEnabled(),
    validator: verifyEnabled(),
    keys: {
      explee: Boolean(process.env.EXPLEE_API_KEY),
      apollo: Boolean(process.env.APOLLO_API_KEY),
      serper: Boolean(process.env.SERPER_API_KEY),
    },
  });
});

// Прод (Railway): раздаём собранный фронт из dist той же нодой; PORT задаёт платформа.
const isProd = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production');
if (isProd) {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
}

// Дев: именно API_PORT — превью передают PORT для фронта, Express не должен его подхватывать.
const PORT = isProd ? (process.env.PORT || 3002) : (process.env.API_PORT || 3002);
initRegistry()
  .then(() => (registryEnabled() ? backfillSenderIdentities().catch((e) => console.error('[angles] backfill failed:', e.message)) : null))
  .then(() => (registryEnabled() ? backfillLinkedinSlugs().catch((e) => console.error('[registry] slug backfill failed:', e.message)) : null))
  .then(() => (registryEnabled() ? seedUsersFromEnv().catch((e) => console.error('[users] seed failed:', e.message)) : null))
  .catch((e) => console.error('[registry] init failed:', e.message))
  .finally(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`[outreach-hub api] listening on ${PORT} (prod=${isProd}, registry=${registryEnabled()})`));
    // Проверяем раз в час: так дайджест попадает в утро ET даже после перезапуска процесса.
    // Настоящий cron вынесем отдельно, когда Railway-процесс перестанет быть единственным местом.
    setInterval(dailyMaintenance, 60 * 60 * 1000);
    setTimeout(dailyMaintenance, 30 * 1000);
    // Валидация адресов: очередь разгребается фоном каждую минуту. Триггер — «у контакта
    // появился или изменился email», а не нажатие Save: почта часто добивается через Apollo
    // уже ПОСЛЕ сохранения, и привязка к кнопке пропустила бы самые дорогие адреса (ТЗ п.31).
    if (verifyEnabled()) {
      setInterval(() => verificationSweep(40), 60 * 1000);
      setTimeout(() => verificationSweep(40), 15 * 1000);
    }
    // Прогон после старта — чтобы приложение не работало с пустым стоп-листом
    // (пустой барьер = барьера нет). Но ТОЛЬКО если список уже несвежий: на Railway каждый
    // пуш перезапускает процесс, и безусловный прогон давал 16 полных пересборок за полдня
    // (видно в журнале 13.08) — тысяча лишних запросов к Kommo и шум в логе.
    // Регулярное расписание живёт в dailyMaintenance.
    if (kommoEnabled() && registryEnabled()) {
      setTimeout(async () => {
        try {
          const st = await crmSyncState();
          const fresh = st?.last_ok_at && (Date.now() - new Date(st.last_ok_at)) < STARTUP_SYNC_MAX_AGE_H * 36e5;
          if (fresh) {
            console.log(`[crm-block] стартовый прогон пропущен: список свежий (${st.age_hours} ч)`);
            return;
          }
          await syncCrmBlocklist('cron');
        } catch { /* пинг и last_error уже записаны внутри */ }
      }, 60 * 1000);
    }
  });
