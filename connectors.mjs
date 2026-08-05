// TOKENHOURS Live · connector reporter
// Folds NON-TOKEN paid tool calls (image/video gen, web scrape, TTS, etc.) into the
// running build cost, so the meter reflects EVERY paid call — not just LLM tokens.
// Prices from connectors.json; posts to the local meter's /meter/connector endpoint.
//
// CLI:
//   node connectors.mjs report --name "Higgsfield" --cost 0.05 --note "1 video"
//   node connectors.mjs firecrawl '{"op":"scrape","pages":12}'
//   node connectors.mjs openai '{"kind":"image","model":"gpt-image-1","quality":"high","n":2}'
//   node connectors.mjs higgsfield '{"op":"generate_video","count":1}'
//   node connectors.mjs price openai '{"kind":"audio","model":"tts-1","chars":1840}'   (price only, no post)
// Programmatic: import { reportEvent, priceEvent, report } from "./connectors.mjs"

import os from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadCatalog() {
  return JSON.parse(readFileSync(join(HERE, "connectors.json"), "utf8"));
}

export function endpoint() {
  // env overrides win; else read the file the meter writes on boot
  const envUrl = process.env.TH_URL, envTok = process.env.TH_TOKEN;
  if (envUrl && envTok) return { url: envUrl, token: envTok };
  try {
    const e = JSON.parse(readFileSync(join(os.homedir(), ".tokenhours-live", "endpoint.json"), "utf8"));
    return { url: envUrl || e.url, token: envTok || e.token };
  } catch {
    return { url: envUrl || "http://127.0.0.1:4317", token: envTok || null };
  }
}

const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

// Compute { cost, note } for a connector event. If ev.cost is given, it's used verbatim.
export function priceEvent(service, ev = {}, catalog = loadCatalog()) {
  service = String(service || "").toLowerCase();
  if (ev.cost != null) return { cost: round(ev.cost), note: ev.note || `${service} (reported)` };

  if (service === "firecrawl") {
    const c = catalog.firecrawl || {};
    const credits = ev.credits ?? ev.creditsUsed ?? ((c.creditsPerOp?.[ev.op] ?? 1) * (ev.pages ?? ev.count ?? 1));
    return { cost: round(credits * (c.perCredit ?? 0)), note: ev.note || `firecrawl ${ev.op || ""} · ${credits} cr`.trim() };
  }

  if (service === "higgsfield") {
    const c = catalog.higgsfield || {};
    const credits = ev.credits ?? ((c.creditsPerOp?.[ev.op] ?? 1) * (ev.count ?? 1));
    return { cost: round(credits * (c.perCredit ?? 0)), note: ev.note || `higgsfield ${ev.op || ""} · ${credits} cr`.trim() };
  }

  if (service === "openai") {
    const c = catalog.openai || {};
    const kind = ev.kind;
    if (kind === "image") {
      const m = c.images?.[ev.model] || {};
      let per = 0;
      if (ev.model === "gpt-image-1") per = m[ev.quality || "medium"] ?? m.medium ?? 0;
      else { const key = (ev.quality === "hd" ? "hd-" : "") + (ev.size || "1024x1024"); per = m[key] ?? m[ev.size || "1024x1024"] ?? 0; }
      return { cost: round(per * (ev.n ?? 1)), note: ev.note || `openai image ${ev.model} ×${ev.n ?? 1}` };
    }
    if (kind === "audio") {
      const m = c.audio?.[ev.model] || {};
      if (m.perMinute != null) return { cost: round((ev.minutes ?? 0) * m.perMinute), note: ev.note || `openai ${ev.model} · ${ev.minutes ?? 0}min` };
      if (m.perMillionChars != null) return { cost: round(((ev.chars ?? 0) / 1e6) * m.perMillionChars), note: ev.note || `openai ${ev.model} · ${ev.chars ?? 0} chars` };
    }
    if (kind === "embeddings") {
      const m = c.embeddings?.[ev.model] || {};
      return { cost: round(((ev.tokens ?? 0) / 1e6) * (m.perMillionTokens ?? 0)), note: ev.note || `openai ${ev.model} · ${ev.tokens ?? 0} tok` };
    }
  }

  return { cost: 0, note: ev.note || `${service} (unpriced)` };
}

export async function report({ name, cost, note }) {
  const { url, token } = endpoint();
  const r = await fetch(url + "/meter/connector", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-th-token": token } : {}) },
    body: JSON.stringify({ name, cost: round(cost), note }),
  });
  if (!r.ok) throw new Error(`meter ${r.status}: ${await r.text().catch(() => "")}`);
  return { name, cost: round(cost), note };
}

export async function reportEvent(service, ev = {}) {
  const { cost, note } = priceEvent(service, ev);
  const name = ev.name || service.charAt(0).toUpperCase() + service.slice(1);
  if (!(cost > 0)) return { skipped: true, name, cost, note };
  await report({ name, cost, note });
  return { name, cost, note };
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const parseFlags = (a) => { const o = {}; for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1]; return o; };
  try {
    if (cmd === "report") {
      const f = parseFlags(rest);
      const out = await report({ name: f.name || "connector", cost: +f.cost || 0, note: f.note });
      console.log(`reported → ${out.name}  $${out.cost}  ${out.note || ""}`);
    } else if (cmd === "price") {
      const [service, json] = rest;
      console.log(JSON.stringify(priceEvent(service, json ? JSON.parse(json) : {}), null, 2));
    } else if (cmd === "test") {
      const { url, token } = endpoint();
      console.log(`endpoint: ${url}  token: ${token ? token.slice(0, 6) + "…" : "(none)"}`);
    } else if (cmd) {
      const json = rest[0];
      const out = await reportEvent(cmd, json ? JSON.parse(json) : {});
      console.log(out.skipped ? `skipped (no cost) → ${out.name}` : `reported → ${out.name}  $${out.cost}  ${out.note || ""}`);
    } else {
      console.log("usage: connectors.mjs <report|price|test|SERVICE> …  (see file header)");
    }
  } catch (e) { console.error("error:", e.message); process.exit(1); }
}
