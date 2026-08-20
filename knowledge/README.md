# Zinit knowledge base (for the outreach agent)

Distilled sales knowledge about Zinit, used by the app to (a) pick what to say to a given lead
and (b) draft replies in the Inbox. Pattern mirrors the weekly-bot wiki
(`bot_sales_report_weekly/prompts/wiki`): flat markdown files, keyword scoring, top-K pages
injected into the prompt. No embeddings — filenames and headings carry the signal.

## Source and boundaries
- Primary source: `Zinit_GTM_Playbook_General.docx` v2.0 (August 2026) — the **general-distribution**
  version, already anonymized by Stan. Plus `Key differentiators of Zinit.docx` and `Zinit CVP.docx`.
- **Never add to this folder:** signed contracts, NDAs, client-named spend reports, personal documents,
  security certificates, pricing quotes tied to a named account. The Drive archive contains all of that;
  it stays in Drive. This repo is private, but a knowledge base for an outreach agent has no business
  holding client-confidential material.
- Client names are removed on purpose. Proof points are profile-based ("multi-plant manufacturer,
  North America"), and naming a real client in an email requires reference permission from Stan.

## Naming convention (prefix = card type)
| Prefix | Contains | Used for |
|---|---|---|
| `icp_` | who we target, who we drop | segment design, scoring, disqualifiers |
| `persona_` | one buyer persona per file | matching the angle to the title of the lead |
| `product_` | what Zinit is / is not, the four products | avoiding scope confusion |
| `value_` | promises, differentiators | first-touch copy, письмо 3 |
| `proof_` | anonymized results | when a lead asks "who else / how much" |
| `pricing_` | commercial models, fees | replies about cost |
| `objection_` | objection → answer | Inbox reply drafts |
| `play_` | sales mechanics (GPO wedge, discovery) | next-step suggestions |
| `sender_` | one card per person who signs emails (Stan, Anton) | credibility line and voice when drafting an angle |

## How it is consumed
`knowledge.js` scores every card against a query (segment criteria, lead title, reply text),
returns the top matches, and the agent composes from them. Same scoring idea as `_search_wiki`
in the bot: matches in the first 15 lines weigh 3×.

## Update rule
When Stan updates the playbook, re-distill the changed section into the matching card rather than
appending a second version of it — the search picks one card per topic and a duplicate splits the signal.

## Актуализация («обучить», L2.5a — 2026-08-13)

| Карточка | Проверена | Источник/статус |
|---|---|---|
| proof_points, value_three_promises, product_positioning_us, sender_stan | 11.08 | ответы Стаса + колода v4 внесены; Bidzaar-цифры помечены «не использовать» |
| pricing_commercial_models | **13.08** | помечено расхождение с колодой (ТЗ §8 п.13) — до ответа Стаса в текстах только «форма», без цифр |
| channel_linkedin_format | **13.08 (новая)** | формат LinkedIn-сообщений; A/B 43%/12%; place-holder под заготовки Тони |
| остальные (icp_, persona_, objection_, play_, product_, value_differentiators, sender_anton) | 07.08 | качественные, чисел колоды не содержат — сверены 13.08 без правок |

Стилевые правила п.42 живут константой `WRITING_STYLE` в `knowledge.js` и врезаны во все драфтеры
(email-цепочка, ответ из Inbox, близнец, LinkedIn) — не копируй их в карточки.
