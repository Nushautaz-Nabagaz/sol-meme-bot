import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function sendMessage(chatId, text, buttons = null) {
  const body = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fakeSignal(chatId) {
  await sendMessage(
    chatId,
    `🧪 *TEST SIGNAL*\n\nLiquidity: $52k\nVolume (5m): $61k\nAge: 11 min\nMcap: $180k`,
    [
      [{ text: "BUY 0.08 SOL", callback_data: "buy" }],
      [{ text: "SKIP", callback_data: "skip" }],
    ]
  );
}

async function handleUpdate(update) {
  const message = update.message;
  const callback = update.callback_query;

  if (message?.text === "/start") {
    const chatId = message.chat.id;
    await sendMessage(chatId, "🤖 Botas paleistas TEST MODE. Naudosim tik *fake trades*.");
    setTimeout(() => fakeSignal(chatId), 1200);
  }

  if (callback) {
    const chatId = callback.message.chat.id;
    if (callback.data === "buy") {
      await sendMessage(chatId, "🧪 TEST BUY įvykdytas (0.08 SOL). Laukiam 2x...");
      setTimeout(() => sendMessage(chatId, "🟢 2x pasiektas → SELL 80% (TEST)"), 2500);
    } else if (callback.data === "skip") {
      await sendMessage(chatId, "⏭️ Token praleistas.");
    }
  }
}

let offset = 0;
async function poll() {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?timeout=30&offset=${offset}`
  );
  const data = await res.json();
  for (const u of data.result || []) {
    offset = u.update_id + 1;
    await handleUpdate(u);
  }
}

setInterval(poll, 3000);
