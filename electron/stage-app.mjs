// stage-app.mjs — copy the meter runtime into ./app so electron-builder bundles it.
// Keeps the meter as the single source of truth (no forked copy in git); run before build.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");            // meter/
const APP = path.join(HERE, "app");
rmSync(APP, { recursive: true, force: true });
mkdirSync(path.join(APP, "overlay"), { recursive: true });

const files = ["meter.mjs", "hud.html", "heartbeat.mjs", "subscriptions.mjs", "true-cost.mjs", "prices.fallback.json", "prices.meta.json"];
for (const f of files) cpSync(path.join(SRC, f), path.join(APP, f));
cpSync(path.join(SRC, "overlay", "indicator.html"), path.join(APP, "overlay", "indicator.html"));
console.log(`staged ${files.length + 1} meter files → electron/app/`);
