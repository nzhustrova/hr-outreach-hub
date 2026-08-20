// Поиск по базе знаний Zinit — порт `_search_wiki` из weekly-бота (prompts/wiki):
// плоские .md, keyword-скоринг, первые 15 строк весят ×3 (заголовки и Keywords-строка несут сигнал),
// top-K карточек уходят в промпт. Эмбеддингов нет намеренно: корпус маленький, обновляется руками,
// а имена файлов и заголовки уже описательные.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.join(__dirname, 'knowledge');

let cache = null; // [{name, text, lines}] — читаем один раз за процесс

function loadCards() {
  if (cache) return cache;
  try {
    cache = fs.readdirSync(KB_DIR)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => {
        const text = fs.readFileSync(path.join(KB_DIR, f), 'utf8');
        return { name: f.replace(/\.md$/, ''), text, lines: text.split('\n') };
      });
  } catch {
    cache = [];
  }
  return cache;
}

export function kbEnabled() {
  return loadCards().length > 0;
}

export function kbCardNames() {
  return loadCards().map((c) => c.name);
}

// Стоп-слова: не дают «the/and/with» перетягивать скоринг.
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'not', 'from', 'our',
  'what', 'how', 'who', 'why', 'does', 'their', 'they', 'have', 'has', 'was', 'can', 'all', 'any',
  'про', 'для', 'что', 'как', 'это', 'или']);

export function searchKnowledge(query, { topK = 3 } = {}) {
  const cards = loadCards();
  if (!cards.length) return [];
  const words = [...new Set(String(query || '').toLowerCase().match(/[\wа-яё]{3,}/g) || [])]
    .filter((w) => !STOP.has(w));
  if (!words.length) return [];

  const scored = cards.map((c) => {
    const head = c.lines.slice(0, 15);
    const body = c.lines.slice(15);
    // Имя файла — самый сильный сигнал (persona_category_manager под запрос «Procurement Manager»).
    const nameHits = words.filter((w) => c.name.toLowerCase().includes(w)).length * 5;
    // Строка «Keywords:» — явный маршрутизатор карточки: считаем КАЖДОЕ попавшее слово, не строку.
    // Кейс 08.08: «who else uses this» не дотягивался до proof_points, хотя фраза стоит в Keywords.
    const kwLine = (c.lines.find((l) => /^keywords:/i.test(l.trim())) || '').toLowerCase();
    const kwHits = words.filter((w) => kwLine.includes(w)).length * 6;
    const score = nameHits + kwHits
      + head.filter((l) => words.some((w) => l.toLowerCase().includes(w))).length * 3
      + body.filter((l) => words.some((w) => l.toLowerCase().includes(w))).length;
    return { name: c.name, text: c.text, score };
  }).filter((c) => c.score > 0);

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);
  if (top.length) {
    console.log(`[kb] query="${String(query).slice(0, 60)}" → ${top.map((t) => `${t.name}:${t.score}`).join(', ')}`);
  }
  return top;
}

// Стилевые правила письма (ТЗ п.42, свод AI_Writing_Red_Flags от Стаса + наши наблюдения).
// ОДНА константа на все драфтеры (email-цепочка, ответ из Inbox, близнец, LinkedIn) — до 13.08
// правила жили только в ТЗ, и промпты о них не знали: узнаваемо машинный текст обнуляет
// всю работу по сегменту и доставляемости.
export const WRITING_STYLE = `WRITING STYLE — the text must not read as machine-written:
- Banned words: leverage, delve, tapestry, landscape (figurative), seamless, robust, pivotal, crucial, comprehensive, streamline, foster, underscore, navigate (figurative), testament, synergy, ecosystem (figurative), cutting-edge, holistic, vibrant, nestled, spearhead, game-changer.
- Banned openers and closers: "I hope this email finds you well", "I came across your profile", "I wanted to reach out", "Looking forward to hearing from you". Never end with a sentence that summarizes the message — finish on the question or the ask.
- Banned constructions: "not just X, but Y"; "no X, no Y, just Z"; rule-of-three rhetoric ("A, B, and C"); "Despite … challenges" framing; more than one em-dash per paragraph.
- Rhythm: vary sentence length — put one short sentence next to a longer one. Paragraphs must differ in length.
- Repeat the word instead of rotating synonyms: if it is the platform, call it the platform every time. Clarity beats variety.
- Plain verbs: "is" and "has", not "serves as" / "boasts" / "features". Concrete verifiable facts; no "experts say", no vague quantities ("several", "widely recognized").
- Starting a sentence with "But" or "And" is fine. One small honest hedge is fine — it reads human.`;

// Готовый блок для промпта LLM.
export function knowledgeContext(query, { topK = 3 } = {}) {
  const cards = searchKnowledge(query, { topK });
  if (!cards.length) return '';
  return cards.map((c) => `### Zinit knowledge: ${c.name}\n\n${c.text}`).join('\n\n---\n\n');
}

// Карточка конкретного отправителя (sender_stan / sender_anton) — берём точным именем файла,
// а не поиском: подпись задана явно, угадывать нечего.
export function senderCard(signerName) {
  const want = `sender_${String(signerName || '').toLowerCase().split(/\s+/)[0]}`;
  return loadCards().find((c) => c.name === want) || null;
}

// Позиционирование — рамка под любым текстом, а не результат поиска: подмешиваем всегда,
// иначе выдача продолжит описывать Zinit как инструмент для хвостовых закупок (правка 08.08).
export function cardByName(name) {
  return loadCards().find((c) => c.name === name) || null;
}

// Контекст для ответа лиду: ВОПРОС и ПРОФИЛЬ ищутся раздельно и объединяются.
// Иначе длинный профиль («Head of Procurement, manufacturing…») перебивает сам вопрос,
// и на «what does it cost» не приезжает карточка про цены (поймано на живом тесте 08.08).
export function replyKnowledge({ replyText = '', profile = '' }) {
  const byQuestion = searchKnowledge(replyText, { topK: 2 });
  const byPersona = searchKnowledge(profile, { topK: 1 });
  const merged = [];
  for (const c of [...byQuestion, ...byPersona]) {
    if (!merged.some((m) => m.name === c.name)) merged.push(c);
  }
  return {
    context: merged.map((c) => `### Zinit knowledge: ${c.name}\n\n${c.text}`).join('\n\n---\n\n'),
    sources: merged.map((c) => c.name),
  };
}
