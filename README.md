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

## True cost — time + subscriptions (v0.3)

Token spend is only part of the bill. TOKENHOURS Live now folds in **the time you actually worked** and the **flat subscriptions** a token meter can't see, into one number — **true cost per hour**:

    trueCostPerHour = tokenSpendToday / hoursWorkedToday
                    + subscriptionsThisMonth / hoursWorkedThisMonth

- **Time** — a local heartbeat checks which window is in front every ~45s; if it's a "working" app (editor, terminal, your provider console…) it credits the time and auto-pauses after 5 minutes idle. Focus only — never keystrokes or screen content. Zero dependencies (OS commands).
- **Subscriptions** — a hand-entered list, prorated across the hours you work this month. No bank, no card, ever.

```bash
npx tokenhours-live --add-sub "Railway" 20     # add a $20/mo subscription
npx tokenhours-live --subs                       # list them
```

The dashboard gains a **True Cost** readout (the existing gauge, labels and bars are unchanged). An **overlay** — `GET /overlay` — shows the *same* full dashboard on a slow timer: hidden most of the time, fully visible for about a minute every five, so you can glance the real number without it being in the way (this is what the desktop app rides on).

> Time is tracked from window focus only — never keystrokes or screen content. Subscriptions are entered by hand — no bank or card ever connected. Nothing here calls an AI or leaves your device.

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
| `TH_STATE` | `~/.tokenhours-live/session.json` | Where the running session is persisted (see below) |
| `TH_SUBSCRIPTIONS` | `~/.tokenhours-live/subscriptions.json` | Your hand-entered monthly subscriptions (True Cost) |
| `TH_HEARTBEAT` | `~/.tokenhours-live/heartbeat.json` | Local focus-time log, minutes/day (True Cost) |
| `TH_IDLE_MIN` | `5` | Minutes of no focus that auto-pause the work clock |

## Endpoints

- `GET /` — the HUD
- `GET /events` — SSE stream of meter state
- `GET /state` — JSON snapshot (now includes `trueCostPerHour`, `hoursToday`, `subsMonthly`)
- `GET /overlay` — the same dashboard on a slow show/hide timer (tray/wallpaper overlay)
- `POST /reset` — zero the session (or press **R** in the HUD)
- `POST /meter/connector` — add a non-LLM connector cost
- `ANY /anthropic/*`, `ANY /openai/*` — metered pass-through proxies

## Session persistence

Running totals are written to `~/.tokenhours-live/session.json` (override with `TH_STATE`) as
they change and on exit — so **closing the terminal no longer zeroes your session.** Restart the
meter and it resumes where it left off; the startup banner prints `resumed→ $X · N req`. Press **R**
in the HUD (or `POST /reset`) to start a fresh session.

## Keep it always-on (optional)

So the meter is up whenever you build, without remembering to start it:

**Windows — Scheduled Task (runs at logon):**
```powershell
schtasks /create /tn "TOKENHOURS Live" /tr "cmd /c npx -y tokenhours-live" /sc onlogon /rl highest /f
# stop / remove:
schtasks /end /tn "TOKENHOURS Live";  schtasks /delete /tn "TOKENHOURS Live" /f
```
Set a fixed token first (so the HUD/statusline can read it): `setx TH_TOKEN yourtoken`.

**Windows — Startup shortcut:** press `Win+R` → `shell:startup` → new shortcut to
`cmd /c npx -y tokenhours-live`.

**macOS / Linux — keep it supervised:**
```bash
npm i -g pm2 && pm2 start "npx -y tokenhours-live" --name tokenhours-live && pm2 save
```

## Troubleshooting

- **HUD shows "connection refused" / "site can't be reached" / `RECONNECT`.**
  The meter isn't running — start it with `npx tokenhours-live`, then reload the HUD.
- **HUD loads but the number stays $0.** Your build isn't routed through the meter yet — set
  `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` (see Quickstart) and make a request.
- **`401 unauthorized` on the HUD.** Open it from the meter's own URL (it injects the token), or
  start the meter with a fixed `TH_TOKEN` and open `http://localhost:4317/?token=<TH_TOKEN>`.
- **Costs read `(est rate)`.** The model id didn't match the rate table — cost uses a default rate.
  Check the model id against tokenhours.com; file an issue with the id.
