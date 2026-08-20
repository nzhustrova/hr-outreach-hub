# HR Outreach Hub

> **Читать первым: [HANDOVER.md](HANDOVER.md).** Это копия системы холодного аутрича,
> построенной под продажи в США, переданная HR под задачу поиска сотрудников.
> В HANDOVER — что обязательно заменить до первого запуска, что переписать под кандидатов
> и что система получает незакрытым.

Панель системы холодного аутрича: поиск людей (Explee / Apollo) → отбор и скоринг → реестр
контактов → волна в двух каналах (LinkedIn через GetSales, email через Smartlead) → приём
и классификация ответов → ответ из Inbox.

## Запуск (dev)

```bash
npm install
npm run dev:local
```

- Фронт: http://localhost:5174 (Vite)
- API: http://localhost:3001 (Express, `server.js`)
- `dev:local` поднимает встроенную базу PGlite в `.localdb` — Postgres не нужен.
- Ключи провайдеров живут только в окружении (`.env` локально, Variables на Railway).
  Полный список переменных с описанием — [`.env.example`](.env.example). `.env` в `.gitignore`
  и никогда не коммитится.

Вариант с внешним Postgres: `npm run dev` (нужен `DATABASE_URL`).

## Структура

| Слой | Файлы |
|---|---|
| Ядро и API (85 эндпоинтов) | `server.js` |
| Схема и доступ к данным | `db/schema.sql` (14 таблиц), `db/registry.js`, `db/campaigns.js`, `db/crm.js`, `db/webhooks.js`, `db/state.js`, `db/users.js` |
| Канал LinkedIn | `getsales.js` (адаптер), `getsales-sync.js` (синк событий, оркестратор отправки) |
| Канал email | `smartlead.js` |
| CRM | `kommo.js` — стоп-лист и барьер. Спит при пустом `KOMMO_API_TOKEN` |
| Валидация адресов | `verify.js` (MillionVerifier) |
| LLM | `angles.js` (углы поиска), `classify.js` (классификатор ответов), `industry.js`, `knowledge.js` + `knowledge/` (база знаний) |
| Операционка | `health.js` (детекторы проблем), `notify.js` (Telegram), `identities.js` (личности отправителей), `linkedin.js` (нормализация профилей) |
| Фронт | `src/App.jsx` + `src/components/`: Search · Contacts · Campaigns · Inbox · Settings · Shortlist · ResultsTable · LeadTimeline |
| Справочники и скоринг | `src/lib/dictionaries.js`, `src/lib/search.js`, `src/lib/scoring.js` |

## Прод

Railway: приложение + плагин Postgres в одном проекте. `DATABASE_URL` подставляется
автоматически, схема создаётся при первом старте, деплой по пушу в `main`.

Вебхуки провайдеров настраиваются в их интерфейсах и идут в обход пароля приложения,
защищены секретом в query:

```
https://<домен>/api/webhooks/getsales?secret=<WEBHOOK_SECRET>
https://<домен>/api/webhooks/smartlead?secret=<WEBHOOK_SECRET>
```

Состояние интеграций — `GET /api/health`. Раздел «START HERE» в Settings объясняет
механику системы из самого кода.
