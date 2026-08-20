-- Реестр контактов Outreach Hub — схема по ТЗ §4 (контакт-центричная, ЖЦ с карантином).
-- Идемпотентно: выполняется на каждом старте сервера.

CREATE TABLE IF NOT EXISTS segment (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,                -- читаемое имя (позже — от LLM «идеальный лид»)
  criteria      JSONB NOT NULL,               -- каркас: поля формы как есть
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact (
  id            SERIAL PRIMARY KEY,
  identity_key  TEXT UNIQUE NOT NULL,         -- нормализованный ключ (linkedin | name-tokens+company)
  first_name    TEXT,
  last_name     TEXT,
  full_name     TEXT,
  title         TEXT,
  company       TEXT,
  company_domain TEXT,
  company_size  TEXT,
  company_geo   TEXT,
  company_industry TEXT,
  location      TEXT,
  linkedin_url  TEXT,
  email         TEXT,
  email_status  TEXT,                         -- valid / catch_all / invalid / unknown
  sources       JSONB NOT NULL DEFAULT '[]',  -- ["explee","apollo"] — явное поле (решение 06.08)
  lifecycle     TEXT NOT NULL DEFAULT 'available',  -- available | active_in_campaign | quarantined | suppressed_forever
  quarantine_until TIMESTAMPTZ,
  raw           JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_lifecycle_idx ON contact (lifecycle, quarantine_until);
CREATE INDEX IF NOT EXISTS contact_company_idx ON contact (company_domain);

-- Мэтч лида сегментом (many-to-many, со снапшотом сигналов — решение Ольги 06.08).
CREATE TABLE IF NOT EXISTS contact_segment_match (
  id            SERIAL PRIMARY KEY,
  contact_id    INT NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  segment_id    INT NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  matched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source        TEXT,                         -- explee | apollo | registry
  signals_snapshot JSONB,                     -- сигналы каркаса на момент мэтча
  fit_score     INT,
  value_score   INT,
  shortlisted   BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (contact_id, segment_id)
);

-- Messaging-гипотеза («с каким сообщением зайти») — переиспользуемый компонент матрицы.
CREATE TABLE IF NOT EXISTS message_angle (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,                -- код захода (например, A3-hiring)
  description   TEXT,                         -- суть захода в одну строку
  sequence      JSONB NOT NULL DEFAULT '[]',  -- ступени цепочки: [{step, wait_days, subject, body}]
  variables     JSONB NOT NULL DEFAULT '[]',  -- используемые переменные ({{first_name}}, {{unique_detail_short}}…)
  status        TEXT NOT NULL DEFAULT 'draft',-- draft | approved | retired
  approved_by   TEXT,                         -- финальный апрув — Тони (решение 07.08)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Пакет рассылки (решение Ольги 08.08): список, отобранный фильтрами во вкладке Contacts,
-- становится сущностью — его можно выбрать в билдере, переиспользовать и увидеть в истории.
-- До этого выборка жила только в памяти браузера и терялась при обновлении страницы.
CREATE TABLE IF NOT EXISTS batch (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,                -- читаемое: «Contacts · 08.08 14:32 · 24 lead(s)»
  contact_ids   INT[] NOT NULL,
  segment_id    INT REFERENCES segment(id),   -- если отбор шёл по сегменту — для атрибуции ячейки
  filters       JSONB,                        -- снимок фильтров вкладки Contacts
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Личность отправителя (решение 08.08): текст подписан конкретным человеком, а Smartlead раздаёт
-- ящики round-robin в момент отправки — подставить подпись под ящик нельзя. Значит одна кампания =
-- одна личность, и ящики кампании обязаны ей соответствовать.
ALTER TABLE message_angle ADD COLUMN IF NOT EXISTS sender_identity TEXT;

-- Кампания = ячейка матрицы: segment × message_angle × канал × отправители.
CREATE TABLE IF NOT EXISTS campaign (
  id            SERIAL PRIMARY KEY,
  segment_id    INT REFERENCES segment(id),
  message_angle_id INT REFERENCES message_angle(id),
  channel       TEXT NOT NULL DEFAULT 'email',-- email | linkedin | multi
  senders       JSONB NOT NULL DEFAULT '[]',  -- ящики (email) / аккаунты (linkedin)
  external_id   TEXT,                         -- id кампании в Smartlead/GetSales
  status        TEXT NOT NULL DEFAULT 'draft',-- draft | uploading | active | paused | closed | error
  leads_count   INT,
  started_at    TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  meta          JSONB,                        -- schedule, лимиты, pre-flight результаты
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_ext_idx ON campaign (external_id);

-- История касаний (основа карантина, дедупа и аналитики матрицы).
CREATE TABLE IF NOT EXISTS touch (
  id            SERIAL PRIMARY KEY,
  contact_id    INT NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  segment_id    INT REFERENCES segment(id),
  channel       TEXT NOT NULL,                -- email | linkedin
  campaign_ext_id TEXT,                       -- id кампании в Smartlead/GetSales
  step          TEXT,
  event         TEXT NOT NULL,                -- sent | delivered | opened | replied | bounced | accepted | ...
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta          JSONB
);
CREATE INDEX IF NOT EXISTS touch_contact_idx ON touch (contact_id, occurred_at);

-- История верификаций (email/роль) — для правила «ре-верификация старше 3 мес».
CREATE TABLE IF NOT EXISTS verification (
  id            SERIAL PRIMARY KEY,
  contact_id    INT NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                -- email | role | signal
  result        TEXT NOT NULL,
  provider      TEXT,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Уникальная деталь компании (Serper+LLM) — сырьё для персонализации первого письма.
ALTER TABLE contact ADD COLUMN IF NOT EXISTS unique_detail TEXT;

-- ЖЦ разговора и прогресс сделки (ТЗ п.25, решения 08.08).
-- lifecycle отвечает за пригодность к аутричу, deal_stage — за движение сделки: это разные оси,
-- и смешивать их нельзя, иначе «встреча назначена» съедает смысл статусов рассылки.
ALTER TABLE contact ADD COLUMN IF NOT EXISTS conversation_state TEXT NOT NULL DEFAULT 'open'; -- open | closed
ALTER TABLE contact ADD COLUMN IF NOT EXISTS conversation_outcome TEXT;      -- meeting | no_reaction | dead | test
ALTER TABLE contact ADD COLUMN IF NOT EXISTS conversation_closed_at TIMESTAMPTZ;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS deal_stage TEXT;                -- replied | meeting_scheduled | meeting_held
ALTER TABLE contact ADD COLUMN IF NOT EXISTS meeting_at TIMESTAMPTZ;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS kommo_lead_id BIGINT;

-- Сырой лог вебхук-событий (append-only, идемпотентность по hash).
CREATE TABLE IF NOT EXISTS event_log (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL,                -- smartlead | getsales
  event_type    TEXT,
  payload_hash  TEXT UNIQUE,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Валидация адресов (ТЗ п.31, «Методология валидации адресов», решения 10.08).
-- email_status теперь ведёт НАШ валидатор: valid | catch_all | unknown | role | invalid | pending.
-- Заявка источника («verified» от Apollo) сохраняется отдельно — это разные знания, и их
-- расхождение показывает, какой источник врёт.
ALTER TABLE contact ADD COLUMN IF NOT EXISTS source_email_status TEXT;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS email_verify_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS email_role BOOLEAN;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS email_free BOOLEAN;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS email_verify_note TEXT;
-- Отложенные по квоте catch-all остаются available и сами всплывают в следующем пакете;
-- колонка нужна только для бейджа и приоритета среди равных (решение Ольги 10.08).
ALTER TABLE contact ADD COLUMN IF NOT EXISTS last_deferred_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS contact_verify_idx ON contact (email_verified_at, email_status);

-- Идентификация оператора и журнал действий (ТЗ п.37, решения Ольги 11.08).
-- Задача — не «сменить адрес», а знать, кто заходит и что делает. Пары логин/пароль на человека
-- вместо общего пароля: браузер логин и так присылает, код его просто выбрасывал.
CREATE TABLE IF NOT EXISTS app_user (
  id            SERIAL PRIMARY KEY,
  login         TEXT UNIQUE NOT NULL,
  name          TEXT,
  email         TEXT,
  role          TEXT NOT NULL DEFAULT 'operator',   -- operator | admin
  pass_salt     TEXT NOT NULL,
  pass_hash     TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ
);

-- Идентификация без журнала бессмысленна: пишем действия, у которых есть последствия.
CREATE TABLE IF NOT EXISTS audit_log (
  id            SERIAL PRIMARY KEY,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,          -- angle.approve | batch.create | campaign.launch | ...
  entity        TEXT,
  entity_id     TEXT,
  meta          JSONB,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor, at DESC);

-- Барьер CRM (ТЗ п.28): контакты, которым нельзя писать холодное письмо, потому что с ними
-- уже работают. Задача Тони: лид на подписании контракта получил холодную рассылку и счёл
-- это бардаком. Таблица перезаписывается целиком ночной синхронизацией.
CREATE TABLE IF NOT EXISTS crm_block (
  id            SERIAL PRIMARY KEY,
  email         TEXT,                       -- нормализованный, lower
  domain        TEXT,                       -- домен компании; заполнен только для «тёплых» этапов
  level         TEXT NOT NULL,              -- email | domain
  pipeline_id   BIGINT,
  pipeline_name TEXT,
  stage_name    TEXT,
  lead_id       BIGINT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_block_email_idx ON crm_block (email);
CREATE INDEX IF NOT EXISTS crm_block_domain_idx ON crm_block (domain) WHERE domain IS NOT NULL;

-- Когда последняя синхронизация прошла успешно — показываем в поиске. Барьер на устаревших
-- данных даёт ложное чувство защиты, поэтому «старше суток» = предупреждение.
CREATE TABLE IF NOT EXISTS crm_sync_state (
  id            INT PRIMARY KEY DEFAULT 1,
  last_ok_at    TIMESTAMPTZ,
  last_error    TEXT,
  emails        INT NOT NULL DEFAULT 0,
  domains       INT NOT NULL DEFAULT 0
);

-- Небольшое состояние приложения между перезапусками. Появилось из-за реального бага:
-- отметка «дайджест за сегодня уже ушёл» жила в памяти процесса, и каждый деплой Railway
-- сбрасывал её — 11.08 дайджест ушёл пять раз за час.
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Словарь соответствия индустрий (ТЗ п.38). LLM оценивает не контакты, а уникальные ПАРЫ
-- «выбранная в фильтре индустрия × индустрия компании»: в выдаче из ста контактов таких пар
-- 15–25, а не 100. Вердикт кэшируется навсегда — пара не меняется во времени, поэтому со
-- второй недели модель зовётся только для новых, невиданных индустрий.
CREATE TABLE IF NOT EXISTS industry_match (
  id          SERIAL PRIMARY KEY,
  selected    TEXT NOT NULL,          -- что выбрано в фильтре
  company     TEXT NOT NULL,          -- что вернул провайдер
  verdict     TEXT NOT NULL,          -- fits | adjacent | mismatch
  note        TEXT,                   -- человеческое объяснение для карточки скоринга
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (selected, company)
);

-- Мягкое резервирование контакта за оператором (ТЗ п.37/О5, решение Ольги 11.08).
-- Дыра, которую это закрывает: между созданием пакета и запуском кампании контакт оставался
-- `available`, и второй оператор спокойно собирал его в свой пакет. Расходились они только
-- в момент запуска — когда оба пакета уже согласованы.
-- Резерв МЯГКИЙ: другой оператор видит пометку, но может взять. Жёсткая блокировка подвесила
-- бы контакты в брошенных черновиках, поэтому у резерва есть срок.
ALTER TABLE contact ADD COLUMN IF NOT EXISTS reserved_by TEXT;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS reserved_batch_id INT;
CREATE INDEX IF NOT EXISTS contact_reserved_idx ON contact (reserved_until) WHERE reserved_until IS NOT NULL;

-- Живость компании (методология поиска, блок 1; вопрос Ольги 12.08).
-- Раньше вердикт жил только в памяти браузера и терялся при сохранении в реестр: заплатили
-- за разведку, узнали что компания мертва — и забыли. Теперь платим один раз и помним всегда.
ALTER TABLE contact ADD COLUMN IF NOT EXISTS liveness TEXT;              -- alive | dead | uncertain
ALTER TABLE contact ADD COLUMN IF NOT EXISTS liveness_note TEXT;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS liveness_checked_at TIMESTAMPTZ;

-- Ручные правки стоп-листа (вопрос Ольги 13.08): люди должны иметь возможность проверить
-- машинный список и поправить его — но не молча, а с причиной и с именем.
-- Живёт ОТДЕЛЬНО от crm_block: тот перезаписывается ночью целиком, а правки терять нельзя.
CREATE TABLE IF NOT EXISTS crm_block_override (
  id          SERIAL PRIMARY KEY,
  subject     TEXT NOT NULL,              -- email или домен, нормализованный
  kind        TEXT NOT NULL,              -- email | domain
  action      TEXT NOT NULL,              -- allow (убрать из стоп-листа) | block (добавить вручную)
  reason      TEXT NOT NULL,              -- обязательна: правка без причины через месяц необъяснима
  actor       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  revoked_by  TEXT,
  UNIQUE (subject, kind)
);
CREATE INDEX IF NOT EXISTS crm_override_active_idx ON crm_block_override (subject) WHERE revoked_at IS NULL;

-- Имя человека и компания в стоп-листе (вопрос Ольги 13.08): по одному адресу невозможно
-- понять, кого именно снимаешь с блокировки, а решение принимает человек.
ALTER TABLE crm_block ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE crm_block ADD COLUMN IF NOT EXISTS company TEXT;

-- Правило-исключение на уровне ЭТАПА воронки (предложение Ольги 13.08).
-- Точечные правки в crm_block_override не годятся для «снять весь этап»: это тысячи строк,
-- и они разъедутся при следующей синхронизации, когда состав этапа изменится.
-- Правило же применяется на лету и остаётся верным при любом составе.
CREATE TABLE IF NOT EXISTS crm_block_rule (
  id            SERIAL PRIMARY KEY,
  pipeline_name TEXT NOT NULL,
  stage_name    TEXT NOT NULL,
  action        TEXT NOT NULL DEFAULT 'allow',   -- allow — этап не блокирует
  reason        TEXT NOT NULL,
  actor         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT,
  UNIQUE (pipeline_name, stage_name)
);

-- Давность и «теплота» записи стоп-листа (решение Ольги 13.08: блок протухает через 3 месяца,
-- но тёплые этапы — встречи и дальше — не освобождаются никогда).
ALTER TABLE crm_block ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
ALTER TABLE crm_block ADD COLUMN IF NOT EXISTS is_warm BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS crm_block_age_idx ON crm_block (is_warm, last_activity_at);

-- Годовая выручка компании (13.08). Оба источника её отдают, и мы её выбрасывали:
-- Explee — в поиске (`company_revenue_annual`), Apollo — в reveal, за который уже платим.
-- Нужна для поля «Revenue (M, $)» в карточке Kommo и как честное значение вместо порога фильтра.
ALTER TABLE contact ADD COLUMN IF NOT EXISTS company_revenue BIGINT;

-- Сколько записей в карточке Kommo (13.08). Единственный доступный признак «с человеком
-- разговаривали»: он отделяет живые карточки от мёртвого импорта и позволяет снимать этап
-- целиком, не боясь задеть тех, с кем шло общение.
ALTER TABLE crm_block ADD COLUMN IF NOT EXISTS note_count INT NOT NULL DEFAULT 0;

-- Канонический LinkedIn-ключ (этап L, задача L1.1). Slug — общий язык трёх систем:
-- GetSales оперирует им нативно, Kommo хранит URL (нормализуем при чтении), у нас он
-- становится вторым ключом барьера рядом с email: 206 контактов Kommo без почты на
-- блокирующих этапах иначе невидимы для защиты (разведка L0.10 §5.1).
ALTER TABLE contact ADD COLUMN IF NOT EXISTS linkedin_slug TEXT;
CREATE INDEX IF NOT EXISTS contact_linkedin_slug_idx ON contact (linkedin_slug) WHERE linkedin_slug IS NOT NULL;

-- Второй ключ стоп-листа CRM (задача L1.2): запись барьера может держать email, slug или оба.
ALTER TABLE crm_block ADD COLUMN IF NOT EXISTS linkedin_slug TEXT;
CREATE INDEX IF NOT EXISTS crm_block_slug_idx ON crm_block (linkedin_slug) WHERE linkedin_slug IS NOT NULL;
ALTER TABLE crm_sync_state ADD COLUMN IF NOT EXISTS slugs INT NOT NULL DEFAULT 0;

-- Модель волны (задача L2.1, решение П1 интервью 13.08). Пакет = волна с N ячеек-кампаний
-- (email + LinkedIn). Замок «одно активное касание» держится на волне, а не на ячейке:
-- контакт, залитый в email-ячейку, доступен LinkedIn-ячейке ТОЙ ЖЕ волны и никому больше.
-- Карантин — только после закрытия ВСЕХ ячеек волны (иначе email-закрытие карантинило бы
-- лида, чья LinkedIn-заявка ещё ждёт принятия).
ALTER TABLE contact ADD COLUMN IF NOT EXISTS active_batch_id INT;

-- LinkedIn-часть захода (задача L2.4, решение П10: заход един, форма разная).
-- Формат: {"message1": {"body": "..."}, "followup": {"wait_days": 3, "body": "..."}}.
-- Записки в заявке ЗДЕСЬ НЕТ намеренно: заявка идёт без записки — правило 23.07,
-- подтверждённое живым A/B разведки L0.10 (без записки 43% принятия против 12% с запиской).
ALTER TABLE message_angle ADD COLUMN IF NOT EXISTS linkedin JSONB;

-- Владелец карточки и те, кто реально в ней писал (13.08). Стоп-лист разбирают Стас и Шикхар
-- вдвоём, и каждый знает только своих: без этих полей «оставить или снять» решать не по чему.
-- `worked_by` честнее `owner`: ответственного 02.07 переназначили массово у 795 карточек.
ALTER TABLE crm_block ADD COLUMN IF NOT EXISTS owner TEXT;
ALTER TABLE crm_block ADD COLUMN IF NOT EXISTS worked_by TEXT;
