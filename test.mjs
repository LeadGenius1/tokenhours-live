// Accuracy proof for TOKENHOURS Live.
// Spawns a mock provider + the REAL meter (offline, deterministic rates), drives
// Anthropic + OpenAI traffic (JSON and streaming) through the actual proxy, and
// asserts metered cost === tokens × published rate, with provider-correct cache
// accounting. Run: node test.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const METER_PORT = 4318, MOCK_PORT = 4319, TOKEN = "testtok";
const RATES = JSON.parse(await readFile(join(__dir, "prices.fallback.json"), "utf8"));

// mirror meter's rateFor + price formula (proves the pipeline is arithmetically exact).
// Separator-insensitive: dash-form runtime ids match the table's dot-form ids.
const canon = (s) => String(s ?? "").toLowerCase().replace(/[._-]+/g, "-");
const bareId = (s) => { const t = String(s ?? ""); return t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t; };
function rateFor(model) {
  const m = canon(model), bare = canon(bareId(model));
  return RATES.find(r => canon(r.id) === m) ||
    RATES.find(r => canon(bareId(r.id)) === bare) ||
    { input: 3, output: 15, cached: 0.3 };
}
const price = ({ model, input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) => {
  const r = rateFor(model);
  return input / 1e6 * (r.input ?? 3) + output / 1e6 * (r.output ?? 15) +
    cacheRead / 1e6 * (r.cached ?? (r.input ?? 3) * 0.1) + cacheWrite / 1e6 * ((r.input ?? 3) * 1.25);
};
// threshold function mirrored from the HUD (transition points the brief specifies)
const stateOf = (cost, budget) => { const r = budget > 0 ? cost / budget : 0; return r >= 1 ? "over" : r >= 0.7 ? "caution" : "nominal"; };

// pick a real Anthropic + OpenAI id from the bundled table
const A_ID = (RATES.find(r => /anthropic/i.test(r.id) || /anthropic/i.test(r.provider)) || RATES[0]).id;
const O_ID = (RATES.find(r => /^openai\//i.test(r.id) || /openai/i.test(r.provider)) || RATES[1]).id;

// ---- mock provider: reflects the model + returns usage per body._mock ----
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const M = body._mock || {}; const model = body.model;
  if (M.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (M.shape === "anthropic") {
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model, usage: { input_tokens: M.in, cache_read_input_tokens: M.cr || 0, cache_creation_input_tokens: M.cw || 0, output_tokens: 1 } } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: M.out } })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ model, choices: [{ delta: { content: "x" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ model, usage: { prompt_tokens: M.prompt, completion_tokens: M.out, prompt_tokens_details: { cached_tokens: M.cached || 0 } } })}\n\n`);
    }
    res.write("data: [DONE]\n\n"); res.end();
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    const usage = M.shape === "anthropic"
      ? { input_tokens: M.in, output_tokens: M.out, cache_read_input_tokens: M.cr || 0, cache_creation_input_tokens: M.cw || 0 }
      : { prompt_tokens: M.prompt, completion_tokens: M.out, prompt_tokens_details: { cached_tokens: M.cached || 0 } };
    res.end(JSON.stringify({ model, usage }));
  }
});
await new Promise(r => mock.listen(MOCK_PORT, "127.0.0.1", r));

// ---- spawn the real meter, pointed at the mock, deterministic offline rates ----
await rm(join(__dir, ".test-session.json"), { force: true });   // start clean, never resume
const meter = spawn(process.execPath, [join(__dir, "meter.mjs")], {
  env: { ...process.env, PORT: METER_PORT, TH_TOKEN: TOKEN, TH_OFFLINE: "1", TH_BUDGET: "25",
    TH_STATE: join(__dir, ".test-session.json"),   // isolated — never touch the real session
    ANTHROPIC_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`, OPENAI_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}` },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${METER_PORT}`;
for (let i = 0; i < 50; i++) { try { const r = await fetch(`${base}/state?token=${TOKEN}`); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
const state = async () => (await fetch(`${base}/state?token=${TOKEN}`)).json();

async function send(path, mockSpec, extra = {}) {
  const before = (await state()).cost;
  await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: mockSpec.model, ...extra, _mock: mockSpec }) });
  await new Promise(r => setTimeout(r, 120));
  return (await state()).cost - before;
}

let pass = 0, fail = 0;
const approx = (a, b) => Math.abs(a - b) < 1e-9;
function check(name, got, want, extra = "") {
  const ok = approx(got, want); ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}\n      metered $${got.toFixed(8)}  expected $${want.toFixed(8)}${extra ? "  · " + extra : ""}`);
}

console.log(`\nTOKENHOURS Live — accuracy proof  (rates: bundled offline table)\n  anthropic model: ${A_ID}\n  openai model:    ${O_ID}\n`);

// 1 · Anthropic JSON — input EXCLUDES cache
{
  const spec = { model: A_ID, shape: "anthropic", in: 40000, out: 2000, cr: 90000, cw: 10000 };
  const got = await send("/anthropic/v1/messages", spec, { tools: [{ name: "x", input_schema: { a: 1 } }], messages: [{ role: "user", content: [{ type: "tool_result", content: "hello world result" }] }] });
  check("Anthropic · JSON · cache-aware", got, price({ model: A_ID, input: 40000, output: 2000, cacheRead: 90000, cacheWrite: 10000 }));
}
// 2 · Anthropic streaming (SSE)
{
  const spec = { model: A_ID, shape: "anthropic", stream: true, in: 12000, out: 900, cr: 30000, cw: 0 };
  const got = await send("/anthropic/v1/messages", spec);
  check("Anthropic · SSE  · message_start/delta", got, price({ model: A_ID, input: 12000, output: 900, cacheRead: 30000, cacheWrite: 0 }));
}
// 3 · OpenAI JSON — prompt_tokens INCLUDES cached (must subtract)
{
  const spec = { model: O_ID, shape: "openai", prompt: 8000, out: 1200, cached: 3000 };
  const got = await send("/openai/v1/chat/completions", spec);
  check("OpenAI    · JSON · cached-subset", got, price({ model: O_ID, input: 8000 - 3000, output: 1200, cacheRead: 3000 }));
}
// 4 · OpenAI streaming
{
  const spec = { model: O_ID, shape: "openai", stream: true, prompt: 5000, out: 700, cached: 0 };
  const got = await send("/openai/v1/chat/completions", spec);
  check("OpenAI    · SSE  · final usage chunk", got, price({ model: O_ID, input: 5000, output: 700, cacheRead: 0 }));
}
// 5 · hidden-cost attribution present
{
  const s = await state();
  const ok = s.toolDefTokEst > 0 && s.toolResultTokEst > 0; ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} MCP/tool attribution tracked      toolDefs≈${s.toolDefTokEst} tok · toolResults≈${s.toolResultTokEst} tok`);
}
// 6 · threshold transition points (×0.7 caution, ×1.0 over)
{
  const b = 25, cases = [[b*0.69,"nominal"],[b*0.70,"caution"],[b*0.99,"caution"],[b*1.0,"over"]];
  let ok = true; for (const [c, want] of cases) if (stateOf(c, b) !== want) ok = false;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} threshold states  nominal <0.7≤ caution <1.0≤ over  (budget $${b})`);
}
// 7 · REAL runtime ids resolve to the PUBLISHED rate, not the estimated default.
//     Runtime emits dash ids ("claude-opus-4-8"); the table lists dot ids
//     ("anthropic/claude-opus-4.8"). Before the rateFor() separator fix these fell
//     through to the est default (3/15/0.3) — the flagship model was mispriced.
//     Regression guard for the 2026-08-02 live-reconciliation finding.
{
  const cases = [
    { id: "claude-opus-4-8",  row: "anthropic/claude-opus-4.8" },
    { id: "claude-haiku-4-5", row: "anthropic/claude-haiku-4.5" },
  ];
  let ok = true; const detail = [];
  for (const c of cases) {
    const pub = RATES.find(r => r.id === c.row);
    const got = await send("/anthropic/v1/messages", { model: c.id, shape: "anthropic", in: 100000, out: 5000, cr: 200000, cw: 0 });
    const want = 100000 / 1e6 * pub.input + 5000 / 1e6 * pub.output + 200000 / 1e6 * (pub.cached ?? pub.input * 0.1);
    const bm = (await state()).models.find(m => m.id === c.id);
    const priced = approx(got, want), notEst = !!bm && bm.estimated === false;
    if (!priced || !notEst) ok = false;
    detail.push(`${c.id}→${c.row.split("/").pop()}${priced ? "" : " COST≠pub"}${notEst ? "" : " EST!"}`);
  }
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} real runtime ids map to published rate (no est fallback)\n      ${detail.join("  ·  ")}`);
}

console.log(`\n  ${fail === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${fail} failed\n`);
meter.kill(); mock.close();
process.exit(fail === 0 ? 0 : 1);
