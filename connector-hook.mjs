#!/usr/bin/env node
// TOKENHOURS Live · Claude Code PostToolUse hook
// Fires after EVERY tool call. For paid non-token connectors (Higgsfield, Firecrawl,
// OpenAI image/audio, …) it prices the call and folds it into the running build cost,
// so the meter reflects the whole build — not just LLM tokens. Silent + never fails
// (always exits 0 so it can't break a session). Wire in Claude Code settings.json:
//
//   "hooks": { "PostToolUse": [ { "hooks": [
//     { "type": "command", "command": "node \"C:\\\\tokenhours\\\\meter\\\\connector-hook.mjs\"" }
//   ] } ] }

import { reportEvent } from "./connectors.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    setTimeout(() => resolve(d), 2000); // safety: never hang the session
  });
}

// find the first numeric value under any of the candidate keys, anywhere in the object
function deepNum(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return null;
  for (const k of Object.keys(obj)) {
    if (keys.includes(k) && typeof obj[k] === "number") return obj[k];
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") { const r = deepNum(v, keys, depth + 1); if (r != null) return r; }
  }
  return null;
}

function asObj(x) { if (x == null) return {}; if (typeof x === "string") { try { return JSON.parse(x); } catch { return {}; } } return x; }

function classify(toolName, input, response) {
  const t = String(toolName || "").toLowerCase();
  const op = String(toolName || "").split("__").pop();          // e.g. generate_video
  const credits = deepNum(response, ["credits", "creditsUsed", "credits_used", "credit_cost", "creditCost"]);
  const reportedCost = deepNum(response, ["costUsd", "cost_usd"]); // only trust explicit USD

  if (t.includes("higgsfield")) {
    if (!/generate|upscale|reframe|outpaint|dubbing|3d|voice|clipper|remove_background|motion|animation/.test(t)) return null; // ignore reads (status, list, show…)
    const count = (Array.isArray(input?.jobs) && input.jobs.length) || (Array.isArray(input?.batch) && input.batch.length) || 1;
    return { service: "higgsfield", ev: { op, count, ...(credits != null ? { credits } : {}), ...(reportedCost != null ? { cost: reportedCost } : {}), name: "Higgsfield" } };
  }

  if (t.includes("firecrawl")) {
    if (!/scrape|crawl|map|search|extract|monitor|batch/.test(t)) return null;
    const pages = (Array.isArray(response?.data) && response.data.length) || input?.limit || 1;
    const kind = /crawl/.test(t) ? "crawl" : /map/.test(t) ? "map" : /search/.test(t) ? "search" : /extract/.test(t) ? "extract" : "scrape";
    return { service: "firecrawl", ev: { op: kind, ...(credits != null ? { creditsUsed: credits } : { pages }), name: "Firecrawl" } };
  }

  // OpenAI image/audio via a tool (only if not already going through the /openai proxy)
  if (/dall-?e|gpt-image|image.*generat|generat.*image/.test(t)) {
    return { service: "openai", ev: { kind: "image", model: input?.model || "gpt-image-1", quality: input?.quality || "medium", size: input?.size, n: input?.n || 1 } };
  }
  if (/text.?to.?speech|\btts\b|audio.*speech/.test(t)) {
    const chars = (input?.input || input?.text || "").length || 0;
    return { service: "openai", ev: { kind: "audio", model: input?.model || "tts-1", chars } };
  }

  return null; // not a paid connector → ignore
}

try {
  const raw = await readStdin();
  const payload = asObj(raw);
  const hit = classify(payload.tool_name, asObj(payload.tool_input), asObj(payload.tool_response));
  if (hit) { await reportEvent(hit.service, hit.ev).catch(() => {}); }
} catch { /* never fail the session */ }
process.exit(0);
