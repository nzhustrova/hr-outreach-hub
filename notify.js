// Уведомления в Telegram (решение Ольги 07.08: пинг при неотрицательном ответе — сразу).
// Мягкая деградация: без TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID пишем в лог и не падаем.
// TELEGRAM_CHAT_ID поддерживает несколько получателей через запятую (Ольга + Стас).
//
// ДВА КАНАЛА (решение Ольги 13.08). Разница не косметическая:
//   • рабочие уведомления (ответ лида, утренний дайджест) — всем получателям: это то, ради
//     чего Стас вообще подключён к боту;
//   • технические сбои (синхронизация упала, кончились кредиты) — ТОЛЬКО админу. Стасу
//     незачем видеть, что у нас отвалился API: он на это не реагирует, а шум обесценивает
//     остальные пинги, и через неделю их перестают читать все.
// Админ — TELEGRAM_ADMIN_CHAT_ID, а если он не задан, первый из общего списка.
export async function sendTelegram(text, { adminOnly = false } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const all = (process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  const admin = (process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim() || all[0];
  const chatIds = adminOnly ? [admin].filter(Boolean) : all;
  if (!token || !chatIds.length) {
    console.log('[notify] telegram not configured — message:', text.slice(0, 200));
    return { sent: false, reason: 'not configured' };
  }
  const results = [];
  for (const chatId of chatIds) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(JSON.stringify(data).slice(0, 200));
      results.push({ chatId, sent: true });
    } catch (e) {
      console.error(`[notify] telegram → ${chatId} failed:`, e.message);
      results.push({ chatId, sent: false, reason: e.message });
    }
  }
  return { sent: results.some((r) => r.sent), results };
}
