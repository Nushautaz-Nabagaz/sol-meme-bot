import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// ===== ENV =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const BOT_MODE = process.env.BOT_MODE || "TEST";

const SCAN_ENABLED_DEFAULT = (process.env.SCAN_ENABLED || "true").toLowerCase() === "true";
const SCAN_INTERVAL_SEC = Number(process.env.SCAN_INTERVAL_SEC || 20);

const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || 30000);
const MIN_VOLUME_M5_USD = Number(process.env.MIN_VOLUME_M5_USD || 50000);
const MAX_TOKEN_AGE_MIN = Number(process.env.MAX_TOKEN_AGE_MIN || 30);
const MAX_MARKETCAP_USD = Number(process.env.MAX_MARKETCAP_USD || 200000);

const BUY_AMOUNT_SOL = Number(process.env.BUY_AMOUNT_SOL || 0.08);

// Exit rules (TEST now)
const TP1_MULTIPLIER = Number(process.env.TP1_MULTIPLIER || 2);
const TP1_SELL_PERCENT = Number(process.env.TP1_SELL_PERCENT || 80);

const TP2_MULTIPLIER = Number(process.env.TP2_MULTIPLIER || 5);
const TRAILING_STOP_PERCENT = Number(process.env.TRAILING_STOP_PERCENT || 30);
const TIME_STOP_MIN = Number(process.env.TIME_STOP_MIN || 60);
const MIN_SELL_OUT_SOL = Number(process.env.MIN_SELL_OUT_SOL || 0.01);

// ===== Telegram helpers =====
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data?.description || `Telegram API error ${r.status}`);
  return data;
}

async function sendMessage(chatId, text, buttons = null) {
  const body = { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  return tg("sendMessage", body);
}

async function answerCallback(callbackQueryId) {
  // neatidarysim popup, tik "ack"
  try { await tg("answerCallbackQuery", { callback_query_id: callbackQueryId }); } catch {}
}

// ===== State =====
const state = {
  enabled: SCAN_ENABLED_DEFAULT,
  chatId: null,
  seenPairs: new Set(),
  openPosition: null,
  lastSignalAt: 0,
  cooldownSec: 25, // anti-spam
};

function now() { return Date.now(); }
function minutesSince(tsMs) { return (now() - tsMs) / 60000; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function fmt(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "n/a";
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(2)}M`;
  if (x >= 1_000) return `${(x / 1_000).toFixed(1)}k`;
  return `${x.toFixed(0)}`;
}

// ===== Dexscreener =====
async function dexSearchSolana() {
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

function mkSignalText(p) {
  const base = p?.baseToken?.symbol || "TOKEN";
  const quote = p?.quoteToken?.symbol || "SOL";
  const liq = Number(p?.liquidity?.usd || 0);
  const vol = Number(p?.volume?.m5 || 0);
  const mc = Number(p?.fdv || p?.marketCap || 0);
  const ageMin = minutesSince(Number(p?.pairCreatedAt));
  const url = p?.url || "n/a";
  const pairAddr = p?.pairAddress || "n/a";

  return {
    base, quote, pairAddr, url, liq, vol, mc, ageMin,
    text:
`🚨 *REAL SIGNAL* (Dexscreener)
*Pair:* ${base}/${quote}
*Liquidity:* $${fmt(liq)}
*Volume (5m):* $${fmt(vol)}
*Age:* ${ageMin.toFixed(1)} min
*Mcap/FDV:* $${fmt(mc)}
*Pair:* \`${pairAddr}\`
*Link:* ${url}

Mode: *${BOT_MODE}*`
  };
}

// ===== Fake trading engine =====
// Mes simuliuojam kainą kaip "multiple" nuo entry.
// Kas tick: multiple juda random walk + kartais jump.
// Tada taikom exit taisykles.
function startFakePosition(signal) {
  state.openPosition = {
    pairAddress: signal.pairAddr,
    base: signal.base,
    quote: signal.quote,
    url: signal.url,
    entryTs: now(),
    spentSol: BUY_AMOUNT_SOL,
    // simuliuojamas "multiple"
    multiple: 1.0,
    athMultiple: 1.0,

    tp1Done: false,
    soldPct: 0, // kiek % jau parduota
    remainingPct: 100,

    // po TP1 aktyvuojam trailing
    trailingActive: false,
    trailingFloorMultiple: 0, // ATH*(1 - trailing%)
  };
}

function calcExpectedOutSol(pos) {
  // TEST: expectedOut = spent * multiple * remainingPct/100
  const gross = pos.spentSol * pos.multiple * (pos.remainingPct / 100);
  // TEST fee model (švelnus): -0.6% nuo išėjimo
  const fee = gross * 0.006;
  return gross - fee;
}

function mkPosText(pos) {
  const elapsedMin = minutesSince(pos.entryTs);
  const pnlPct = ((pos.multiple - 1) * 100).toFixed(1);
  const expOut = calcExpectedOutSol(pos);
  return (
`📍 *OPEN POSITION* (TEST)
*Pair:* ${pos.base}/${pos.quote}
*Multiple:* x${pos.multiple.toFixed(2)}  (ATH x${pos.athMultiple.toFixed(2)})
*PnL:* ${pnlPct}%
*Sold:* ${pos.soldPct}%   *Remaining:* ${pos.remainingPct}%
*Expected out (after est. fees):* ${expOut.toFixed(4)} SOL
*Time:* ${elapsedMin.toFixed(1)} min

Rules:
• TP1: x${TP1_MULTIPLIER} → sell ${TP1_SELL_PERCENT}%
• TP2: x${TP2_MULTIPLIER} OR trailing -${TRAILING_STOP_PERCENT}% OR breakeven OR time ${TIME_STOP_MIN}m
• Min sell out: ${MIN_SELL_OUT_SOL} SOL`
  );
}

function mkPosButtons(pos) {
  const rows = [];
  if (!pos.tp1Done) {
    rows.push([{ text: `SELL ${TP1_SELL_PERCENT}% @${TP1_MULTIPLIER}x`, callback_data: "sell_tp1" }]);
  }
  rows.push([{ text: "SELL ALL", callback_data: "sell_all" }]);
  rows.push([{ text: "PANIC SELL", callback_data: "panic" }]);
  rows.push([{ text: state.enabled ? "PAUSE SCAN" : "RESUME SCAN", callback_data: state.enabled ? "pause" : "resume" }]);
  return rows;
}

async function sendPosUpdate() {
  if (!state.chatId || !state.openPosition) return;
  await sendMessage(state.chatId, mkPosText(state.openPosition), mkPosButtons(state.openPosition));
}

function closePosition(reason) {
  const pos = state.openPosition;
  state.openPosition = null;
  return pos ? `✅ Position closed (${reason}).` : "No position.";
}

// Fake price tick
function fakeTick() {
  const pos = state.openPosition;
  if (!pos) return;

  // random walk + occasional jump
  let step = (Math.random() - 0.48) * 0.10; // small drift
  if (Math.random() < 0.06) step += Math.random() * 0.8; // pump jump
  if (Math.random() < 0.04) step -= Math.random() * 0.5; // dump jump

  pos.multiple = clamp(pos.multiple + step, 0.15, 12.0);
  pos.athMultiple = Math.max(pos.athMultiple, pos.multiple);

  // trailing logic (aktyvuojasi po TP1 arba pasiekus 2x)
  if (pos.tp1Done || pos.multiple >= TP1_MULTIPLIER) {
    pos.trailingActive = true;
    const floor = pos.athMultiple * (1 - TRAILING_STOP_PERCENT / 100);
    pos.trailingFloorMultiple = Math.max(pos.trailingFloorMultiple, floor);
  }

  // exit checks (TEST)
  const elapsedMin = minutesSince(pos.entryTs);
  const expectedOut = calcExpectedOutSol(pos);

  // min sell output check
  const tooSmallToSell = expectedOut < MIN_SELL_OUT_SOL;

  // TIME STOP
  if (elapsedMin >= TIME_STOP_MIN && !tooSmallToSell) {
    state.chatId && sendMessage(state.chatId, `⏱️ Time stop ${TIME_STOP_MIN}m → SELL ALL (TEST)`);
    closePosition("time_stop");
    return;
  }

  // TP1 auto-trigger (jei pasiekė 2x ir dar nepadaryta)
  if (!pos.tp1Done && pos.multiple >= TP1_MULTIPLIER) {
    // auto sell TP1
    const sellPct = TP1_SELL_PERCENT;
    pos.tp1Done = true;
    pos.soldPct = sellPct;
    pos.remainingPct = 100 - sellPct;

    sendMessage(state.chatId, `🟢 TP1 hit x${TP1_MULTIPLIER} → SOLD ${sellPct}% (TEST)\nRemaining ${pos.remainingPct}% managed by TP2/trailing/breakeven/time.`);
    return;
  }

  // TP2 (5x)
  if (pos.tp1Done && pos.multiple >= TP2_MULTIPLIER && !tooSmallToSell) {
    sendMessage(state.chatId, `🚀 TP2 hit x${TP2_MULTIPLIER} → SELL ALL remaining (TEST)`);
    closePosition("tp2");
    return;
  }

  // Trailing stop
  if (pos.trailingActive && pos.multiple <= pos.trailingFloorMultiple && !tooSmallToSell) {
    sendMessage(state.chatId, `🟠 Trailing stop hit (floor x${pos.trailingFloorMultiple.toFixed(2)}) → SELL ALL (TEST)`);
    closePosition("trailing_stop");
    return;
  }

  // Breakeven: po TP1, jei multiple grįžo ~1.0 (su tolerancija)
  if (pos.tp1Done && pos.multiple <= 1.05 && !tooSmallToSell) {
    sendMessage(state.chatId, `🟡 Breakeven zone reached → SELL ALL remaining (TEST)`);
    closePosition("breakeven");
    return;
  }
}

// ===== Signal scan =====
async function scanOnce(sendNothingFoundMsg = false) {
  if (!state.chatId) return;
  if (!state.enabled) return;

  // jei yra atvira pozicija – nesiunčiam naujų signalų
  if (state.openPosition) return;

  // anti-spam cooldown
  if ((now() - state.lastSignalAt) / 1000 < state.cooldownSec) return;

  const pairs = await dexSearchSolana();
  pairs.sort((a, b) => Number(b?.volume?.m5 || 0) - Number(a?.volume?.m5 || 0));

  for (const p of pairs) {
    if (!passFilters(p)) continue;

    const addr = p?.pairAddress;
    if (!addr) continue;
    if (state.seenPairs.has(addr)) continue;

    state.seenPairs.add(addr);
    state.lastSignalAt = now();

    const sig = mkSignalText(p);
    await sendMessage(state.chatId, sig.text, [
      [{ text: `BUY ${BUY_AMOUNT_SOL} SOL`, callback_data: `buy|${sig.pairAddr}` }],
      [{ text: "SKIP", callback_data: `skip|${sig.pairAddr}` }],
      [{ text: state.enabled ? "PAUSE SCAN" : "RESUME SCAN", callback_data: state.enabled ? "pause" : "resume" }],
    ]);
    return;
  }

  if (sendNothingFoundMsg) {
    await sendMessage(
      state.chatId,
      `ℹ️ Nieko neradau pagal filtrus:\n` +
      `• Liq ≥ $${fmt(MIN_LIQUIDITY_USD)}\n` +
      `• Vol(5m) ≥ $${fmt(MIN_VOLUME_M5_USD)}\n` +
      `• Age ≤ ${MAX_TOKEN_AGE_MIN} min\n` +
      `• Mcap ≤ $${fmt(MAX_MARKETCAP_USD)}`
    );
  }
}

// ===== Commands / callbacks =====
async function handleText(chatId, text) {
  if (text === "/start") {
    state.chatId = chatId;
    await sendMessage(
      chatId,
      `🤖 Botas paleistas *${BOT_MODE}*.\nScan: *${state.enabled ? "ON" : "OFF"}*\nKomandos: /scan /pause /resume /status /panic /close`
    );
    return;
  }

  if (text === "/scan") {
    await sendMessage(chatId, "🔎 Scanuoju Dexscreener...");
    try { await scanOnce(true); } catch (e) { await sendMessage(chatId, `❌ Scan klaida: ${String(e.message || e)}`); }
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
    const pos = state.openPosition ? "YES" : "NO";
    const posLine = state.openPosition ? `\n\n${mkPosText(state.openPosition)}` : "";
    await sendMessage(
      chatId,
      `📊 *Status*\nMode: *${BOT_MODE}*\nScan: *${state.enabled ? "ON" : "OFF"}*\nInterval: ${SCAN_INTERVAL_SEC}s\nOpen position: *${pos}*\n\nFilters:\n• Liq ≥ $${fmt(MIN_LIQUIDITY_USD)}\n• Vol(5m) ≥ $${fmt(MIN_VOLUME_M5_USD)}\n• Age ≤ ${MAX_TOKEN_AGE_MIN} min\n• Mcap ≤ $${fmt(MAX_MARKETCAP_USD)}` + posLine
    );
    return;
  }

  if (text === "/panic") {
    if (!state.openPosition) { await sendMessage(chatId, "ℹ️ No open position."); return; }
    closePosition("panic");
    await sendMessage(chatId, "🔴 PANIC SELL (TEST) → closed position.");
    return;
  }

  if (text === "/close") {
    if (!state.openPosition) { await sendMessage(chatId, "ℹ️ No open position."); return; }
    closePosition("manual_close");
    await sendMessage(chatId, "✅ Closed position (manual).");
    return;
  }
}

async function handleCallback(chatId, data, cbId) {
  await answerCallback(cbId);

  if (data === "pause") { state.enabled = false; await sendMessage(chatId, "⏸️ Scan OFF"); return; }
  if (data === "resume") { state.enabled = true; await sendMessage(chatId, "▶️ Scan ON"); return; }

  if (data.startsWith("skip|")) { await sendMessage(chatId, "⏭️ Praleista."); return; }

  if (data.startsWith("buy|")) {
    if (state.openPosition) { await sendMessage(chatId, "⚠️ Jau yra atvira pozicija (V1)."); return; }

    // TEST: atidarom fake position su paskutiniu signal
    // info iš callback turim tik pair address, bet UI pakanka.
    const pairAddr = data.split("|")[1];

    // Minimal signal object (kad būtų tekstas)
    const fakeSig = { pairAddr, base: "TOKEN", quote: "SOL", url: "" };
    startFakePosition(fakeSig);

    await sendMessage(chatId, `🧪 TEST BUY (${BUY_AMOUNT_SOL} SOL)\nPair: \`${pairAddr}\`\n\nAtidariau poziciją. Seku PnL ir vykdau exit taisykles (TEST).`);
    await sendPosUpdate();
    return;
  }

  if (data === "sell_tp1") {
    const pos = state.openPosition;
    if (!pos) { await sendMessage(chatId, "ℹ️ No open position."); return; }
    if (pos.tp1Done) { await sendMessage(chatId, "ℹ️ TP1 jau padarytas."); return; }
    if (pos.multiple < TP1_MULTIPLIER) {
      await sendMessage(chatId, `ℹ️ Dar nepasiekė x${TP1_MULTIPLIER}. Dabar x${pos.multiple.toFixed(2)}.`);
      return;
    }
    pos.tp1Done = true;
    pos.soldPct = TP1_SELL_PERCENT;
    pos.remainingPct = 100 - TP1_SELL_PERCENT;
    await sendMessage(chatId, `✅ Manual TP1: SOLD ${TP1_SELL_PERCENT}% (TEST). Remaining ${pos.remainingPct}%.`);
    await sendPosUpdate();
    return;
  }

  if (data === "sell_all" || data === "panic") {
    const pos = state.openPosition;
    if (!pos) { await sendMessage(chatId, "ℹ️ No open position."); return; }
    closePosition(data === "panic" ? "panic" : "sell_all");
    await sendMessage(chatId, data === "panic" ? "🔴 PANIC SELL (TEST) → closed." : "✅ SELL ALL (TEST) → closed.");
    return;
  }
}

// ===== Telegram long-poll =====
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
      await handleCallback(u.callback_query.message.chat.id, u.callback_query.data, u.callback_query.id);
    }
  }
}

// ===== Schedulers =====
setInterval(() => poll().catch(() => {}), 2500);
setInterval(() => scanOnce(false).catch(() => {}), SCAN_INTERVAL_SEC * 1000);
setInterval(() => { try { fakeTick(); } catch {} }, 3000);
