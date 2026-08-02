#!/usr/bin/env node
// TOKENHOURS Live — terminal statusline. A thin consumer of the meter's numbers-only
// channel, for people who won't keep a browser tab open. One line, threshold-colored.
//
// Claude Code — add to ~/.claude/settings.json:
//   "statusLine": { "type": "command", "command": "node /abs/path/statusline.mjs" }
// Run the meter with a fixed token so this can read it:  TH_TOKEN=xyz node meter.mjs
// then:  export TH_TOKEN=xyz   (same value for the statusline)
//
// Generic prompt use:  TH_TOKEN=xyz node statusline.mjs   → prints one line, exits.

const PORT = process.env.TH_PORT || 4317;
const TOKEN = process.env.TH_TOKEN || "";
const C = { dim: "\x1b[2m", green: "\x1b[38;5;40m", amber: "\x1b[38;5;178m", red: "\x1b[38;5;196m", accent: "\x1b[38;5;68m", reset: "\x1b[0m" };

// Claude Code streams session JSON on stdin; we don't need it, just don't block.
try { process.stdin.resume(); process.stdin.on("data", () => {}); setImmediate(() => process.stdin.pause()); } catch {}

const money = (n) => (n >= 1000 ? "$" + Math.round(n).toLocaleString("en-US") : "$" + n.toFixed(2));
const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n)));

try {
  const r = await fetch(`http://127.0.0.1:${PORT}/state?token=${TOKEN}`, { signal: AbortSignal.timeout(400) });
  if (!r.ok) throw 0;
  const s = await r.json();
  const ratio = s.budget > 0 ? s.cost / s.budget : 0;
  const col = ratio >= 1 ? C.red : ratio >= 0.7 ? C.amber : C.green;
  const dot = col + "●" + C.reset;
  const line =
    `${dot} ${C.dim}TOKENHOURS${C.reset} ${col}${money(s.cost)}${C.reset} ` +
    `${C.dim}·${C.reset} ${money(s.perHour)}/hr ` +
    `${C.dim}·${C.reset} ${compact(s.tokens)} tok ` +
    `${C.dim}·${C.reset} ${s.requests} req` +
    (s.connectorsCost > 0 ? ` ${C.dim}· +${money(s.connectorsCost)} conn${C.reset}` : "");
  process.stdout.write(line);
} catch {
  process.stdout.write(`${C.dim}○ TOKENHOURS · meter offline${C.reset}`);
}
