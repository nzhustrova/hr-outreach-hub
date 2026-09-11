// Unified LLM gateway — the hub historically spoke only to Anthropic, but the
// operator's key can be OpenAI (Natalia's is). Every module asks through here:
// OPENAI_API_KEY wins when both are set, ANTHROPIC_API_KEY stays as fallback,
// neither -> callers degrade the same way they always did (llmAvailable()).
//
// The contract mirrors the old inline calls exactly: one user prompt in,
// plain response text out. Prompt wording and downstream JSON parsing are
// untouched by design — only the transport moved.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// gpt-4o mirrors what ZINIT HEADLINER runs on the same key; haiku is the
// hub's historical model. Both are overridable without a deploy.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

export function llmAvailable() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

/**
 * Ask the configured LLM with a single user prompt; returns the response text.
 * Throws `llm <status>: <detail>` on transport errors so existing catch blocks
 * keep working (they only ever matched on a thrown Error).
 */
export async function askLLM(prompt, { maxTokens = 800 } = {}) {
  if (process.env.OPENAI_API_KEY) {
    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_completion_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`llm ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data.choices?.[0]?.message?.content || '';
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`llm ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data.content?.[0]?.text || '';
  }
  throw new Error('llm: no API key configured (OPENAI_API_KEY or ANTHROPIC_API_KEY)');
}
