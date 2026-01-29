import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// ====== ENV ======
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const BOT_MODE = process.env.BOT_MODE || "TEST"; // TEST / LIVE (kol kas TEST)

const SCAN_ENABLED_DEFAULT = (process.env.SCAN_ENABLED || "true").toLowerCase() === "true";
const SCAN_INTERVAL_SEC = Number(process.env.SCAN_INTERVAL_SEC || 20);

const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || 30000);
const MIN_VOLUME_M5_USD = Number(process.env.MIN_VOLUME_M5_USD || 50000);
const MAX_TOKEN_AGE_MIN = Number(process.env.MAX_TOKEN_AGE_MIN || 30);
const MAX_MARKETCAP_USD = Number(process.env.MAX_MARKETCAP_USD || 200000);

const BUY_AMOUNT_SOL = Number(process.env.BUY_AMOUNT_SOL || 0.08);

// ====== Telegram helpers ======
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) {
    throw new Error(data?.description || `Telegram API error ${r.status}`);
  }
  return data;
}

async function sendMessage(chatId, text, buttons = null) {
  const body = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  return tg("sendMessage", body);
}

// ====== State ======
const state = {
  enabled: SCAN_ENABLED_DEFAULT,
  chatId: null,
  seenPairs: new Set(),
  // V1: vienas trade test režime
  openPosition: null, // { pairAddress, createdAtMs, tp1Done, athMultiple }
};

function minutesSince(tsMs) {
  return (Date.now() - tsMs) / 60000;
}

function fmt(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "n/a";
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(2)}M`;
  if (x >= 1_000) return `${(x / 1_000).toFixed(1)}k`;
  return `${x.toFixed(0)}`;
}

// ====== Dexscreener scan ======
async function dexSearchSolana() {
  // Viešas endpointas — grąžina daug porų, mes filtruojam pagal tavo taisykles
  const url = "https://api.dexscreener.com/latest/dex/search?q=solana";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Dexscreener failed: ${r.status}`);
  const data = await r.json();
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

function passFilters(p) {
  if (!p || p.chainId !== "solana") return false;

  const liq = Number(p?.liquidity?.usd || 0);
  const volM5 = Number(p?.volume?.m5 || 0);
  const mc = Number(p?.fdv || p?.marketCap || 0);

  const createdAt = Number(p?.pairCreatedAt || 0);
  if (!createdAt) return false;
  const ageMin = minutesSince(createdAt);

  if (liq < MIN_LIQUIDITY_USD) return false;
  if (volM5 < MIN_VOLUME_M5_USD) return false;
  if (ageMin > MAX_TOKEN_AGE_MIN) return false;
  if (mc && mc > MAX_MARKETCAP_USD) return false;

  return true;
}

async function sendRealSignal(p) {
  const base = p?.baseToken?.symbol || "TOKEN";
  const quote = p?.quoteToken?.symbol || "SOL";
  const liq = Number(p?.liquidity?.usd || 0);
  const vol = Number(p?.volume?.m5 || 0);
  const mc = Number(p?.fdv || p?.marketCap || 0);
  const ageMin = minutesSince(Number(p?.pairCreatedAt));
  const url = p?.url || "n/a";
  const pairAddr = p?.pairAddress || "n/a";

  const text =
`🚨 *REAL SIGNAL* (Dexscreener)
*Pair:* ${base}/${quote}
*Liquidity:* $${fmt(liq)}
*Volume (5m):* $${fmt(vol)}
*Age:* ${ageMin.toFixed(1)} min
*Mcap/FDV:* $${fmt(mc)}
*Pair:* \`${pairAddr}\`
*Link:* ${url}

Mode: *${BOT_MODE}*`;

  await sendMessage(state.chatId, text, [
    [{ text: `BUY ${BUY_AMOUNT_SOL} SOL`, callback_data: `buy|${pairAddr}` }],
    [{ text: "SKIP", callback_data: `skip|${pairAddr}` }],
    [{ text: state.enabled ? "PAUSE" : "RESUME", callback_data: state.enabled ? "pause" : "resume" }],
  ]);
}

async function scanOnce(sendNothingFoundMsg = false) {
  if (!state.chatId) return;
  if (!state.enabled) return;

  // V1: kol yra "atvira" test pozicija, nespamint signalais
  if (state.openPosition) return;

  const pairs = await dexSearchSolana();
  pairs.sort((a, b) => Number(b?.volume?.m5 || 0) - Number(a?.volume?.m5 || 0));

  for (const p of pairs) {
    if (!passFilters(p)) continue;

    const pairAddr = p?.pairAddress;
    if (!pairAddr) continue;

    if (state.seenPairs.has(pairAddr)) continue;
    state.seenPairs.add(pairAddr);

    await sendRealSignal(p);
    return;
  }

  if (sendNothingFoundMsg) {
    await sendMessage(
      state.chatId,
      `ℹ️ Nieko neradau pagal filtrus:\n` +
      `Liq ≥ $${fmt(MIN_LIQUIDITY_USD)}\n` +
      `Vol(5m) ≥ $${fmt(MIN_VOLUME_M5_USD)}\n` +
      `Age ≤ ${MAX_TOKEN_AGE_MIN} min\n` +
      `Mcap ≤ $${fmt(MAX_MARKETCAP_USD)}`
    );
  }
}

// ====== Commands / callbacks ======
async function handleText(chatId, text) {
  if (text === "/start") {
    state.chatId = chatId;
    await sendMessage(
      chatId,
      `🤖 Botas paleistas *${BOT_MODE}*.\nScan: *${state.enabled ? "ON" : "OFF"}*\nKomandos: /scan /pause /resume /status`
    );
    return;
  }

  if (text === "/scan") {
    await sendMessage(chatId, "🔎 Scanuoju Dexscreener...");
    try {
      await scanOnce(true);
    } catch (e) {
      await sendMessage(chatId, `❌ Scan klaida: ${String(e.message || e)}`);
    }
    return;
  }

  if (text === "/pause") {
    state.enabled = false;
    await sendMessage(chatId, "⏸️ Scan OFF");
    return;
  }

  if (text === "/resume") {
    state.enabled = true;
    await sendMessage(chatId, "▶️ Scan ON");
    return;
  }

  if (text === "/status") {
    const pos = state.openPosition ? `YES (tp1=${state.openPosition.tp1Done ? "yes" : "no"})` : "NO";
    await sendMessage(
      chatId,
      `📊 Status\n` +
      `Mode: *${BOT_MODE}*\n` +
      `Scan: *${state.enabled ? "ON" : "OFF"}*\n` +
      `Interval: ${SCAN_INTERVAL_SEC}s\n` +
      `Open position: *${pos}*\n\n` +
      `Filters:\n` +
      `• Liq ≥ $${fmt(MIN_LIQUIDITY_USD)}\n` +
      `• Vol(5m) ≥ $${fmt(MIN_VOLUME_M5_USD)}\n` +
      `• Age ≤ ${MAX_TOKEN_AGE_MIN} min\n` +
      `• Mcap ≤ $${fmt(MAX_MARKETCAP_USD)}`
    );
    return;
  }
}

async function handleCallback(chatId, data) {
  if (data === "pause") {
    state.enabled = false;
    await sendMessage(chatId, "⏸️ Scan OFF");
    return;
  }

  if (data === "resume") {
    state.enabled = true;
    await sendMessage(chatId, "▶️ Scan ON");
    return;
  }

  if (data.startsWith("skip|")) {
    await sendMessage(chatId, "⏭️ Praleista.");
    return;
  }

  if (data.startsWith("buy|")) {
    if (state.openPosition) {
      await sendMessage(chatId, "⚠️ Jau yra atvira pozicija (V1 test: max 1).");
      return;
    }

    const pairAddr = data.split("|")[1];
    state.openPosition = {
      pairAddress: pairAddr,
      createdAtMs: Date.now(),
      tp1Done: false,
      athMultiple: 1,
    };

    await sendMessage(
      chatId,
      `🧪 TEST BUY (${BUY_AMOUNT_SOL} SOL)\nPair: \`${pairAddr}\`\n\nLIVE dar nejungiam. Imituosiu TP logiką.`
    );

    // Imituojam: po 3s pasiekia 2x -> sell 80%
    setTimeout(async () => {
      if (!state.openPosition) return;
      state.openPosition.tp1Done = true;
      state.openPosition.athMultiple = Math.max(state.openPosition.athMultiple, 2);
      await sendMessage(chatId, "🟢 2x pasiektas → SELL 80% (TEST)\nLikę 20%: 5x / trailing / breakeven / time stop (vėliau live).");
    }, 3000);

    // Po 20s uždarom test poziciją, kad vėl galėtų gaudyti signalus
    setTimeout(async () => {
      if (!state.openPosition) return;
      await sendMessage(chatId, "🧪 TEST pozicija uždaryta (reset). Galim gaudyti kitą signalą.");
      state.openPosition = null;
    }, 20000);

    return;
  }
}

// ====== Telegram long-poll ======
let offset = 0;
async function poll() {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?timeout=30&offset=${offset}`);
  const data = await r.json();
  for (const u of data.result || []) {
    offset = u.update_id + 1;

    if (u.message?.text) {
      await handleText(u.message.chat.id, u.message.text.trim());
    }

    if (u.callback_query?.data) {
      await handleCallback(u.callback_query.message.chat.id, u.callback_query.data);
    }
  }
}

// ====== Schedulers ======
setInterval(() => poll().catch(() => {}), 2500);
setInterval(() => scanOnce(false).catch(() => {}), SCAN_INTERVAL_SEC * 1000);
