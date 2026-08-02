# TOKENHOURS Live — real-time build-cost meter

A zero-dependency localhost **proxy** that sits in front of any model provider,
reads the `usage` off every response, prices it against your live
[tokenhours.com](https://tokenhours.com) rate table, and streams a running
**build-cost** total to an instrument HUD — the "need box" on your screen.

## Quickstart (30 seconds)

```bash
npx tokenhours-live                 # starts on http://localhost:4317 — open it
```

Point your build at it with **one env var**, then build normally:

```bash
ANTHROPIC_BASE_URL=http://localhost:4317/anthropic  claude       # Claude Code / Anthropic SDK
# or:  OPENAI_BASE_URL=http://localhost:4317/openai/v1  node your-app.js
```

Every request is now metered live. That's it.

## Privacy — the meter that sees nothing

Cost is computed **on-device**. The meter transmits **nothing** about your work:

- **Prompts, responses, and API keys** are forwarded **only to the provider you already call** — never to tokenhours.com, never to any telemetry endpoint, never written to disk.
- **The HUD receives numbers only** — aggregate token counts and dollars. Prompt/response content never crosses the channel.
- The **sole** extra outbound request is a public `GET` for the price table (no query, no body, no identifiers). Set `TH_OFFLINE=1` to disable even that and price from the bundled table.
- **Bound to `127.0.0.1`** only. The data channel is **token-authenticated**; strict **Origin/Host** checks defeat browser cross-origin reads and DNS-rebinding. The provider pass-through carries your key exactly where it was already going — and nowhere else.
- **Zero dependencies, no telemetry, one auditable file.** Built to be open-sourced.

## Run

```bash
node meter.mjs            # → http://localhost:4317
```

Open `http://localhost:4317` for the HUD. Kick the tires with no wiring:

```bash
curl localhost:4317/demo   # synthesizes a realistic build session
```

## Point your build at it

The meter can only price what flows through it — so route your model calls through it.

| Client | Set |
|---|---|
| **Anthropic SDK / Claude Code** | `ANTHROPIC_BASE_URL=http://localhost:4317/anthropic` |
| **OpenAI SDK** | `OPENAI_BASE_URL=http://localhost:4317/openai/v1` |
| **OpenRouter / Groq / any OpenAI-compatible** | `OPENAI_BASE_URL=http://localhost:4317/openai/v1` and start the meter with `OPENAI_UPSTREAM=https://openrouter.ai/api` |

Then build as normal. Every request is metered; the HUD updates live.

## What it meters — honestly

- **LLM tokens → exact.** Input, output, and cache-read tokens come from the provider's own `usage` block, priced per model.
- **MCP overhead & tool results → attributed.** The proxy sizes the `tools` schema and `tool_result` blocks in each request so the HUD's composition bar shows how much of your spend is *hidden* cost vs. actual conversation.
- **Connectors / 3rd-party APIs → reported.** Anything not in the LLM `usage` (a Stripe call, a search API) is a call-count × unit price. Report it:

```bash
curl -XPOST localhost:4317/meter/connector \
  -H 'content-type: application/json' \
  -d '{"name":"Stripe API","cost":0.012}'
```

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `4317` | HUD + proxy port (bound to `127.0.0.1` only) |
| `TH_TOKEN` | random per run | Auth token for the numbers-only data channel (printed on start; auto-injected into the same-origin HUD) |
| `TH_OFFLINE` | off | `1` = never touch the network except the provider pass-through; price from the bundled table |
| `TH_BUDGET` | `25` | Session soft-cap driving the gauge's threshold states (nominal → caution → over) |
| `TH_HORIZON_HOURS` | `40` | Projection horizon shown as "Projected / 40h" |
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Anthropic origin |
| `OPENAI_UPSTREAM` | `https://api.openai.com` | OpenAI-compatible origin |
| `TH_PRICES_URL` | `https://tokenhours.com/api/prices` | Live rate table (falls back to bundled `prices.fallback.json`) |

## Endpoints

- `GET /` — the HUD
- `GET /events` — SSE stream of meter state
- `GET /state` — JSON snapshot
- `POST /reset` — zero the session (or press **R** in the HUD)
- `POST /meter/connector` — add a non-LLM connector cost
- `ANY /anthropic/*`, `ANY /openai/*` — metered pass-through proxies
