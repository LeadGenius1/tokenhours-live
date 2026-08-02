# Accuracy validation

Accuracy IS the product. Two layers:

## 1. Pipeline is exact (automated — passing)

```bash
node test.mjs
```

Spawns a mock provider + the real meter and asserts **metered cost === tokens × published rate**,
with provider-correct cache accounting, for Anthropic (JSON + streaming, `input_tokens` excludes cache)
and OpenAI (JSON + streaming, `prompt_tokens` includes cached → subtracted). Also checks MCP/tool
attribution and the ×0.7 / ×1.0 threshold points. Current: **6/6 pass.**

This proves the meter does the arithmetic exactly. It does **not** prove the *rate table* matches
your real bill — that's layer 2.

## 2. Rates match your real bill (manual — 2-minute tick, run once)

The one gate that matters. Do this against a real working session:

1. Start the meter and point a real session at it:
   ```bash
   node meter.mjs
   ANTHROPIC_BASE_URL=http://localhost:4317/anthropic claude   # or your app / IDE proxy
   ```
2. Work for **30+ minutes** of real usage. Note the **start and end timestamps.**
3. Read the meter's per-model totals:
   ```bash
   curl "http://localhost:4317/reconcile?token=$TH_TOKEN"
   ```
4. Open the provider's **usage export** for the *same window*:
   - Anthropic → console.anthropic.com → Usage (filter to your window; it exposes input/output/cache tokens per model).
5. **Tick line by line:** the meter's INPUT / OUTPUT / CACHE-RD per model should match the console's token
   counts within rounding. If tokens match, cost matches (same rate table the site publishes).
6. **Proof artifact:** screenshot the HUD next to the console Usage page.

### If they don't match
- **Tokens differ** → a response shape isn't parsed (open an issue with the provider + streaming/non-streaming).
- **Tokens match, cost differs** → the rate table is stale or a model mapped to the wrong row. Check the
  HUD footer's "rates as of" stamp and the model id; file it. Staleness is visible by design — a cost
  meter with silently stale prices is a wrong cost meter.

> Console usage can lag a few minutes behind real time — compare a *closed* window, not the live minute.
