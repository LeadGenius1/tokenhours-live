#!/usr/bin/env node
// TOKENHOURS Live — universal localhost metering proxy.
// Put this in front of any model provider; it reads the `usage` off every
// response, prices it against tokenhours.com/api/prices, and streams a running
// build-cost total to the instrument HUD over SSE. Your API key passes straight
// through to the provider — the proxy never stores it.
//
//   node meter.mjs                       # starts on http://localhost:4317
//   open http://localhost:4317          # the HUD ("need box")
//
// Point clients at it:
//   Anthropic:  ANTHROPIC_BASE_URL=http://localhost:4317/anthropic
//   OpenAI:     OPENAI_BASE_URL=http://localhost:4317/openai/v1
//   OpenRouter: OPENAI_BASE_URL=http://localhost:4317/openai/v1  + OPENAI_UPSTREAM=https://openrouter.ai/api
//
// Non-LLM connector costs (Stripe calls, search APIs, etc.) — report them:
//   curl -XPOST localhost:4317/meter/connector -d '{"name":"Stripe API","cost":0.012}'

import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// True Cost upgrade — additive local data sources (time + subscriptions). Same
// "sees nothing" architecture: no network, no content, computed on-device.
import { startHeartbeat } from "./heartbeat.mjs";
import { computeTrueCost } from "./true-cost.mjs";
import { addSub, getSubscriptions, monthlyTotal } from "./subscriptions.mjs";

// CLI subcommands (before the server boots): manage the hand-entered subscription list.
const ARGV = process.argv.slice(2);
if (ARGV[0] === "--add-sub" && ARGV[1]) { addSub(ARGV[1], ARGV[2], ARGV[3]); console.log(`  added subscription: ${ARGV[1]} · $${+ARGV[2] || 0}/mo`); process.exit(0); }
if (ARGV[0] === "--subs") { const s = getSubscriptions(); if (s.length) { console.table(s); console.log(`  monthly total: $${monthlyTotal().toFixed(2)}`); } else console.log("  no subscriptions yet — add:  npx tokenhours-live --add-sub \"Railway\" 20"); process.exit(0); }
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ── Privacy model — "the meter that sees nothing" ────────────────────────────
// The proxy computes cost ON-DEVICE and transmits NOTHING about your work:
//   · prompts, responses, and API keys are forwarded ONLY to the provider you
//     already call — never to tokenhours.com or anywhere else, never logged to disk.
//   · the HUD receives NUMBERS ONLY (aggregate token counts + dollars), never content.
//   · the sole extra outbound request is a public GET for the price table
//     (no query, no body, no identifiers) — disable it entirely with TH_OFFLINE=1.
//   · binds 127.0.0.1 only · data channel is token-authenticated · strict
//     Origin/Host checks defeat browser cross-origin & DNS-rebinding.
// Built to be open-sourced: zero dependencies, no telemetry, auditable in one file.
// ─────────────────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 4317);
const HOST = "127.0.0.1";                                // loopback only, never 0.0.0.0
const TOKEN = process.env.TH_TOKEN || crypto.randomBytes(16).toString("hex");
const OFFLINE = process.env.TH_OFFLINE === "1";          // never touch the network except the provider passthrough
const BUDGET = +(process.env.TH_BUDGET || 25);          // session soft-cap for threshold states ($)
const HORIZON = +(process.env.TH_HORIZON_HOURS || 40);  // projection horizon (hours)
const UP_ANTHROPIC = process.env.ANTHROPIC_UPSTREAM || "https://api.anthropic.com";
const UP_OPENAI = process.env.OPENAI_UPSTREAM || "https://api.openai.com";
const PRICES_URL = process.env.TH_PRICES_URL || "https://tokenhours.com/api/prices";
const STATE_FILE = process.env.TH_STATE || join(os.homedir(), ".tokenhours-live", "session.json");
const SELF_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const SELF_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

// request guards
const hostOk = (req) => SELF_HOSTS.has(req.headers.host || "");          // DNS-rebind defense
const originOk = (req) => { const o = req.headers.origin; return !o || SELF_ORIGINS.has(o); }; // block browser cross-origin; allow no-Origin (SDK/curl)
const tokenOk = (req) => {
  const t = req.headers["x-th-token"] || new URL(req.url, "http://x").searchParams.get("token");
  return typeof t === "string" && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
};

// ---------- pricing ----------
let RATES = [];               // [{id,name,provider,input,output,cached}] per 1M tokens
const DEFAULT_RATE = { input: 3, output: 15, cached: 0.3, _default: true };

const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch { return iso; } };
async function loadRates() {
  if (!OFFLINE) {
    try {
      // public GET — no query, body, or identifiers; the only non-provider outbound call
      const r = await fetch(PRICES_URL, { signal: AbortSignal.timeout(6000) });
      const d = await r.json();
      if (Array.isArray(d.models) && d.models.length) {
        RATES = d.models;
        return `live · ${d.models.length} models · synced ${d.syncedAt ? fmtDate(d.syncedAt) : "recently"}`;
      }
    } catch {}
  }
  try {
    RATES = JSON.parse(await readFile(join(__dir, "prices.fallback.json"), "utf8"));
    let asOf = "unknown date";
    try { asOf = fmtDate(JSON.parse(await readFile(join(__dir, "prices.meta.json"), "utf8")).asOf); } catch {}
    return `${OFFLINE ? "offline" : "fallback"} · ${RATES.length} models · as of ${asOf}`;
  } catch { RATES = []; return "no price table"; }
}
// canonicalize a model id for matching: lowercase, and collapse . _ - runs to a
// single "-" so a runtime id like "claude-opus-4-8" matches the table's dot-form
// "anthropic/claude-opus-4.8". Without this the flagship models fall through to the
// estimated default rate (caught by the 2026-08-02 live reconciliation).
const canon = (s) => String(s ?? "").toLowerCase().replace(/[._-]+/g, "-");
const bareId = (s) => { const t = String(s ?? ""); return t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t; };
function rateFor(model) {
  if (!model) return DEFAULT_RATE;
  const m = canon(model);
  const bare = canon(bareId(model));
  let hit =
    RATES.find(r => canon(r.id) === m) ||
    RATES.find(r => canon(bareId(r.id)) === bare) ||
    RATES.find(r => { const rb = canon(bareId(r.id)); return bare && rb && (rb.includes(bare) || bare.includes(rb)); }) ||
    RATES.find(r => r.name && bare.includes(canon(r.name.replace(/\s+/g, "-"))));
  return hit || DEFAULT_RATE;
}

// ---------- meter state ----------
const S = {
  startedAt: Date.now(),
  requests: 0, errors: 0,
  cost: 0,
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  toolDefTokEst: 0, toolResultTokEst: 0,   // for the hidden-cost breakdown
  byModel: {}, connectors: [],
  dailyCost: {},                            // token+connector $ bucketed per day → tokenSpendToday
  lastModel: null, lastCost: 0, lastAt: 0,
  rateNote: "loading", demo: false,
};
const addDaily = (c) => { const k = dayKey(); S.dailyCost[k] = (S.dailyCost[k] || 0) + c; };
const est = (obj) => Math.round(JSON.stringify(obj ?? "").length / 4);

function priceCharge({ model, input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  const r = rateFor(model);
  const c =
    (input / 1e6) * (r.input ?? 3) +
    (output / 1e6) * (r.output ?? 15) +
    (cacheRead / 1e6) * (r.cached ?? (r.input ?? 3) * 0.1) +
    (cacheWrite / 1e6) * ((r.input ?? 3) * 1.25);
  S.cost += c; addDaily(c); S.input += input; S.output += output; S.cacheRead += cacheRead; S.cacheWrite += cacheWrite;
  S.requests += 1; S.lastModel = model; S.lastCost = c; S.lastAt = Date.now();
  const key = model || "unknown";
  const bm = (S.byModel[key] ||= { cost: 0, input: 0, output: 0, cacheRead: 0, reqs: 0, estimated: !!r._default });
  bm.cost += c; bm.input += input; bm.output += output; bm.cacheRead += cacheRead; bm.reqs += 1;
  broadcast(); scheduleSave();
  return c;
}

// ---------- SSE ----------
const clients = new Set();
function snapshot() {
  const elapsedH = Math.max((Date.now() - S.startedAt) / 3.6e6, 1e-6);
  const perHour = S.cost / elapsedH;
  const totalTok = S.input + S.output + S.cacheRead;
  const overheadTok = S.toolDefTokEst + S.toolResultTokEst;
  const tc = computeTrueCost({ tokenSpendToday: S.dailyCost[dayKey()] || 0 }); // time + subscriptions, layered in
  return {
    trueCostPerHour: tc.trueCostPerHour, tokenPerHourWorked: tc.tokenPerHour, subsPerHour: tc.subsPerHour,
    hoursToday: tc.hoursToday, subsMonthly: tc.subsMonthly, costToday: tc.tokenSpendToday, trueReady: tc.ready,
    cost: S.cost, perHour, projected: perHour * HORIZON, horizon: HORIZON, budget: BUDGET,
    requests: S.requests, errors: S.errors,
    input: S.input, output: S.output, cacheRead: S.cacheRead,
    tokens: totalTok, tokPerHour: totalTok / elapsedH,
    overheadTok, overheadPct: totalTok ? overheadTok / (S.input + overheadTok || 1) : 0,
    toolDefTokEst: S.toolDefTokEst, toolResultTokEst: S.toolResultTokEst,
    connectorsCost: S.connectors.reduce((a, c) => a + c.cost, 0), connectors: S.connectors.slice(-6),
    models: Object.entries(S.byModel).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.cost - a.cost).slice(0, 6),
    lastModel: S.lastModel, lastCost: S.lastCost, lastAt: S.lastAt,
    elapsedMs: Date.now() - S.startedAt, rateNote: S.rateNote, demo: !!S.demo, now: Date.now(),
  };
}
function broadcast() {
  const line = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) { try { c.write(line); } catch {} }
}

// ---------- session persistence (survive terminal close / restart) ----------
// Running totals are written to a local JSON so a restart RESUMES instead of zeroing.
const PERSIST_KEYS = ["startedAt", "requests", "errors", "cost", "input", "output", "cacheRead", "cacheWrite", "toolDefTokEst", "toolResultTokEst", "byModel", "connectors", "dailyCost", "demo"];
let saveTimer = null, resumed = false;
const collectPersist = () => { const o = {}; for (const k of PERSIST_KEYS) o[k] = S[k]; return o; };
async function saveState() { try { await mkdir(dirname(STATE_FILE), { recursive: true }); await writeFile(STATE_FILE, JSON.stringify(collectPersist())); } catch {} }
function scheduleSave() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveState(); }, 800); }
function saveSync() { try { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(collectPersist())); } catch {} }
async function loadState() { try { if (!existsSync(STATE_FILE)) return; const d = JSON.parse(await readFile(STATE_FILE, "utf8")); for (const k of PERSIST_KEYS) if (d[k] != null) S[k] = d[k]; resumed = S.cost > 0 || S.requests > 0; } catch {} }
process.on("SIGINT", () => { saveSync(); process.exit(0); });
process.on("SIGTERM", () => { saveSync(); process.exit(0); });

// ---------- usage parsing ----------
// Provider-correct usage accounting. Critical distinction:
//   · Anthropic  usage.input_tokens EXCLUDES cache tokens (cache_read/creation are separate).
//   · OpenAI     usage.prompt_tokens INCLUDES cached tokens (cached_tokens is a subset).
// So Anthropic input is charged as-is; OpenAI input = prompt_tokens - cached.
function parseUsage(bodyText, contentType, model) {
  if (!bodyText) return;
  const a = { anthropic: false, openai: false, model, in: null, out: null, cr: 0, cw: 0, prompt: null, comp: null, cached: 0 };
  const take = (u, j) => {
    if (j?.model) a.model = j.model;
    if (j?.message?.model) a.model = j.message.model;
    if (!u) return;
    if (u.input_tokens != null) { a.anthropic = true; a.in = u.input_tokens; }
    if (u.output_tokens != null) a.out = Math.max(a.out ?? 0, u.output_tokens);
    if (u.cache_read_input_tokens != null) a.cr = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens != null) a.cw = u.cache_creation_input_tokens;
    if (u.prompt_tokens != null) { a.openai = true; a.prompt = u.prompt_tokens; }
    if (u.completion_tokens != null) a.comp = u.completion_tokens;
    if (u.prompt_tokens_details?.cached_tokens != null) a.cached = u.prompt_tokens_details.cached_tokens;
  };
  try {
    if (/event-stream/.test(contentType)) {
      for (const line of bodyText.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim(); if (!p || p === "[DONE]") continue;
        let j; try { j = JSON.parse(p); } catch { continue; }
        take(j.usage || j.message?.usage, j);
      }
    } else {
      const j = JSON.parse(bodyText); take(j.usage, j);
    }
  } catch { return; }
  if (a.anthropic && a.in != null) priceCharge({ model: a.model, input: a.in, output: a.out || 0, cacheRead: a.cr, cacheWrite: a.cw });
  else if (a.openai && a.prompt != null) priceCharge({ model: a.model, input: Math.max(a.prompt - a.cached, 0), output: a.comp || 0, cacheRead: a.cached, cacheWrite: 0 });
}

// estimate hidden-cost breakdown from the request body (attribution only)
function tapRequest(bodyText) {
  if (!bodyText) return null;
  try {
    const b = JSON.parse(bodyText);
    if (b.tools) S.toolDefTokEst += est(b.tools);
    const msgs = b.messages || [];
    for (const m of msgs) {
      const content = m.content;
      if (Array.isArray(content)) for (const part of content) {
        if (part?.type === "tool_result" || part?.type === "tool_use") S.toolResultTokEst += est(part);
      } else if (m.role === "tool") S.toolResultTokEst += est(content);
    }
    return b.model;
  } catch { return null; }
}

// ---------- proxy ----------
async function proxy(req, res, upstreamBase, stripPrefix) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const reqBody = Buffer.concat(chunks);
  const model = tapRequest(reqBody.toString("utf8"));

  const path = req.url.slice(stripPrefix.length) || "/";
  const target = upstreamBase + path;
  const headers = { ...req.headers };
  delete headers.host; delete headers["content-length"]; headers["accept-encoding"] = "identity";

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : reqBody,
      duplex: "half",
    });
  } catch (e) {
    S.errors++; broadcast();
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "th-meter upstream failed", detail: String(e) }));
    return;
  }

  const outHeaders = {};
  upstream.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) outHeaders[k] = v; });
  res.writeHead(upstream.status, outHeaders);
  const ctype = upstream.headers.get("content-type") || "";
  const reader = upstream.body?.getReader();
  const acc = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value)); acc.push(Buffer.from(value));
    }
  }
  res.end();
  if (upstream.ok) parseUsage(Buffer.concat(acc).toString("utf8"), ctype, model);
  else S.errors++, broadcast();
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    // DNS-rebind + cross-origin defense on every route
    if (!hostOk(req) || !originOk(req)) { res.writeHead(403); return void res.end("forbidden"); }

    // metered pass-throughs (SDKs send their own key; no meter token required)
    if (url.startsWith("/anthropic")) return void await proxy(req, res, UP_ANTHROPIC, "/anthropic");
    if (url.startsWith("/openai")) return void await proxy(req, res, UP_OPENAI, "/openai");

    // data + control channel — numbers only, token-authenticated
    const needsToken = ["/events", "/state", "/reset", "/meter/connector", "/demo", "/reconcile"].includes(url);
    if (needsToken && !tokenOk(req)) { res.writeHead(401); return void res.end("unauthorized"); }

    if (url === "/reconcile") { // per-model token totals to tick against the provider console
      const s = snapshot(); const pad = (x, n) => String(x).padEnd(n);
      let out = `TOKENHOURS Live · reconciliation  (session ${(s.elapsedMs / 60000).toFixed(1)} min)\n`;
      if (s.demo) out += `⚠  SYNTHETIC DEMO DATA — this is NOT a real session. Do not reconcile. POST /reset.\n`;
      out += `rates: ${s.rateNote}\n\n${pad("MODEL", 34)}${pad("INPUT", 12)}${pad("OUTPUT", 12)}${pad("CACHE-RD", 12)}COST\n`;
      for (const m of s.models) out += `${pad(m.id, 34)}${pad(m.input.toLocaleString(), 12)}${pad(m.output.toLocaleString(), 12)}${pad((m.cacheRead || 0).toLocaleString(), 12)}$${m.cost.toFixed(4)}${m.estimated ? "  (est rate)" : ""}\n`;
      out += `\nTOTAL  $${s.cost.toFixed(4)}   · compare INPUT/OUTPUT per model to your provider usage export for the same window.\n`;
      res.writeHead(200, { "content-type": "text/plain" }); return void res.end(out);
    }

    if (url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    if (url === "/state") { res.writeHead(200, { "content-type": "application/json" }); return void res.end(JSON.stringify(snapshot())); }
    if (url === "/reset" && req.method === "POST") {
      Object.assign(S, { startedAt: Date.now(), requests: 0, errors: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolDefTokEst: 0, toolResultTokEst: 0, byModel: {}, connectors: [], lastModel: null, lastCost: 0, demo: false });
      broadcast(); saveState(); res.writeHead(200); return void res.end("ok");
    }
    if (url === "/meter/connector" && req.method === "POST") {
      const b = Buffer.concat(await collect(req)).toString("utf8");
      try { const { name, cost, note } = JSON.parse(b); S.connectors.push({ name: name || "connector", cost: +cost || 0, note, at: Date.now() }); S.cost += +cost || 0; addDaily(+cost || 0); broadcast(); scheduleSave(); res.writeHead(200); res.end("ok"); }
      catch { res.writeHead(400); res.end("bad json"); }
      return;
    }
    if (url === "/demo") {
      // Guard: demo must NEVER pollute a real reading. Refuse if the session already
      // has charges; require an explicit ?confirm=1 even on an empty session.
      if (S.requests > 0 || S.cost > 0) { res.writeHead(409, { "content-type": "text/plain" }); return void res.end("refused: session already has real charges — POST /reset first so demo can never pollute a reading.\n"); }
      if (new URL(req.url, "http://x").searchParams.get("confirm") !== "1") { res.writeHead(400, { "content-type": "text/plain" }); return void res.end("refused: /demo injects SYNTHETIC data. Re-run with ?confirm=1 to acknowledge (empty session only).\n"); }
      runDemo(); res.writeHead(200); return void res.end("demo running (synthetic — session flagged demo:true)\n");
    }
    if (url === "/overlay") {
      // the SAME full dashboard, shown on a slow show/hide timer (see overlay/indicator.html)
      const html = (await readFile(join(__dir, "overlay", "indicator.html"), "utf8")).replaceAll("__TH_TOKEN__", TOKEN);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return void res.end(html);
    }
    if (url === "/" || url === "/index.html") {
      // inject the session token + a first-paint snapshot (so the HUD is never blank)
      const html = (await readFile(join(__dir, "hud.html"), "utf8"))
        .replaceAll("__TH_TOKEN__", TOKEN)
        .replace("__TH_INIT__", JSON.stringify(snapshot()));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return void res.end(html);
    }
    res.writeHead(404); res.end("not found");
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
async function collect(req) { const c = []; for await (const x of req) c.push(x); return c; }

// demo: synthesize a realistic build session so the HUD can be seen without wiring a client
function runDemo() {
  S.demo = true;   // self-labeling: any synthetic session is flagged in /state + /reconcile
  const seq = [
    { model: "claude-opus-4-8", input: 42000, output: 1800, cacheRead: 90000 },
    { model: "gpt-5.6-sol", input: 8000, output: 1200 },
    { model: "claude-haiku-4-5", input: 120000, output: 3400, cacheRead: 210000 },
    { model: "claude-opus-4-8", input: 300000, output: 5200, cacheRead: 480000 },
  ];
  S.toolDefTokEst += 6200; S.toolResultTokEst += 14300;
  let i = 0;
  const t = setInterval(() => { if (i >= seq.length) return clearInterval(t); priceCharge(seq[i++]); }, 1400);
  setTimeout(() => S.connectors.push({ name: "Stripe API", cost: 0.02, at: Date.now() }) || (S.cost += 0.02) || broadcast(), 4200);
}

await loadState();
const note = await loadRates(); S.rateNote = note;
if (!OFFLINE) setInterval(async () => { S.rateNote = await loadRates(); }, 36e5);
startHeartbeat({ quiet: true }); // True Cost: track focus-time locally (no keystrokes/content/network)
server.listen(PORT, HOST, () => {
  // Write a local endpoint file so on-device connector reporters (and the Claude Code
  // hook) can find the port + token to POST costs to /meter/connector. Loopback only.
  try {
    const dir = join(os.homedir(), ".tokenhours-live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${PORT}`, token: TOKEN, port: PORT, pid: process.pid, startedAt: Date.now() }));
  } catch {}
  console.log(`\n  TOKENHOURS Live · the meter that sees nothing`);
  console.log(`  HUD    → http://localhost:${PORT}/?token=${TOKEN}`);
  console.log(`  rates  → ${note}${OFFLINE ? " (offline)" : ""}`);
  console.log(`  bound  → ${HOST}:${PORT} · loopback only · token-authed · numbers-only channel`);
  if (resumed) console.log(`  resumed→ $${S.cost.toFixed(4)} · ${S.requests} req  (from ${STATE_FILE} · press R in the HUD to reset)`);
  else console.log(`  state  → ${STATE_FILE}  (persists across restarts)`);
  console.log(`  point clients at  /anthropic  and  /openai/v1\n`);
});
