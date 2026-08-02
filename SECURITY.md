# Security & privacy model

TOKENHOURS Live is **local-first by design**. The entire thing is one auditable file
(`meter.mjs`) with **zero dependencies** — please read it. This document states the
guarantees so you can verify them against the code.

## Guarantees

1. **Nothing about your work leaves the machine.** Prompts, responses, and API keys are
   forwarded **only** to the provider you already call (`ANTHROPIC_UPSTREAM` / `OPENAI_UPSTREAM`).
   They are never sent to tokenhours.com, never to any telemetry endpoint, never written to disk.
   Grep the source: there is exactly one non-provider outbound call — a public `GET` for the
   price table, with no query, body, or identifiers. `TH_OFFLINE=1` removes even that.

2. **The HUD receives numbers only.** The `/events` stream and `/state` carry aggregate token
   counts, dollar figures, model ids, and connector names/costs — never prompt or response content.

3. **Loopback only.** The server binds `127.0.0.1`. It is never exposed on `0.0.0.0`.

4. **Authenticated data channel.** `/events`, `/state`, `/reset`, `/reconcile`, `/meter/connector`,
   and `/demo` require a per-run token (`TH_TOKEN`, printed on start; auto-injected into the
   same-origin HUD). Comparison is constant-time.

5. **Cross-origin & DNS-rebind defense.** Every route validates the `Host` header against an
   allow-list and rejects any foreign `Origin`, so a web page in your browser cannot read your
   cost or drive the meter.

6. **The provider pass-through** (`/anthropic`, `/openai`) carries your own key straight to the
   provider — exactly where it was already going, and nowhere else. It is not token-gated because
   your SDK cannot present the token; it is still Host/Origin guarded.

## Threat model

Defended: a malicious web page trying to read your spend or hit the proxy; casual network exposure;
accidental content/keys exfiltration. Out of scope: a hostile process already running as your user
on your machine (it can read your env and keys regardless of this tool).

## Reporting

Found a hole — content leaking, a bypass of the Host/Origin/token checks, an accounting error that
misstates cost? Open a GitHub issue, or email security@aileadstrategies.com. Accuracy and privacy
are the product; reports are welcome and credited.
