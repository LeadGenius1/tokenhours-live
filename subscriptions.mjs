#!/usr/bin/env node
// TOKENHOURS Live · subscriptions — the flat, hand-entered monthly costs (Railway,
// an AI plan, a seat…) that a token meter can't see. No bank, no card, ever — you
// type them. Each is prorated across the hours you actually work this month.
//
//   node subscriptions.mjs                       # list
//   node subscriptions.mjs --add "Railway" 20    # add / update (monthly $, optional billing day)
//   node subscriptions.mjs --rm "Railway"        # remove
//   import { monthlyTotal, subsCostPerHour } from "./subscriptions.mjs"

import os from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const FILE = process.env.TH_SUBSCRIPTIONS || join(os.homedir(), ".tokenhours-live", "subscriptions.json");
function load() { try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return { subscriptions: [] }; } }
function save(d) { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); }

export function getSubscriptions() { return load().subscriptions || []; }
export function monthlyTotal() { return getSubscriptions().reduce((a, s) => a + (+s.monthly || 0), 0); }
// subscription contribution to $/hr = total monthly / hours actually worked this billing period.
export function subsCostPerHour(hoursThisPeriod) {
  const total = monthlyTotal();
  return total > 0 && hoursThisPeriod > 0 ? total / hoursThisPeriod : 0;
}
export function addSub(name, monthly, billingDay) {
  const d = load();
  d.subscriptions = (d.subscriptions || []).filter((s) => s.name.toLowerCase() !== name.toLowerCase());
  d.subscriptions.push({ name, monthly: +monthly || 0, ...(billingDay ? { billingDay: +billingDay } : {}) });
  d.subscriptions.sort((a, b) => b.monthly - a.monthly);
  save(d); return d.subscriptions;
}
export function removeSub(name) { const d = load(); d.subscriptions = (d.subscriptions || []).filter((s) => s.name.toLowerCase() !== name.toLowerCase()); save(d); return d.subscriptions; }

// CLI
if (process.argv[1]?.endsWith("subscriptions.mjs")) {
  const [, , cmd, name, amount, day] = process.argv;
  if (cmd === "--add" && name) { const s = addSub(name, amount, day); console.log(`added/updated ${name} · $${(+amount || 0)}/mo`); console.table(s); }
  else if (cmd === "--rm" && name) { removeSub(name); console.log(`removed ${name}`); console.table(getSubscriptions()); }
  else {
    const subs = getSubscriptions();
    console.log(`\n  TOKENHOURS subscriptions · ${FILE}`);
    if (!subs.length) console.log(`  (none yet)  add one:  npx tokenhours-live --add-sub "Railway" 20\n`);
    else { console.table(subs); console.log(`  monthly total: $${monthlyTotal().toFixed(2)}\n`); }
  }
}
