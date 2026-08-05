#!/usr/bin/env node
// TOKENHOURS Live · heartbeat — local focus-time tracker.
// Every ~45s it asks the OS which window is in front (app name + title). If that
// matches your "working" list it credits the time; if you switch away or go idle
// for 5 minutes it pauses automatically. It records MINUTES PER DAY to a local
// file and nothing else — no keystrokes, no screen content, no network. Same
// "sees nothing" architecture as the meter; zero npm dependencies (OS commands only).
//
//   node heartbeat.mjs            # run standalone (prints a status line each poll)
//   import { startHeartbeat, getWorked } from "./heartbeat.mjs"   # from the meter

import os from "node:os";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const DIR = join(os.homedir(), ".tokenhours-live");
const FILE = process.env.TH_HEARTBEAT || join(DIR, "heartbeat.json");
const CFG = join(DIR, "heartbeat.config.json");
const POLL_MS = +(process.env.TH_HEARTBEAT_POLL || 45) * 1000; // focus check cadence
const IDLE_MS = +(process.env.TH_IDLE_MIN || 5) * 60 * 1000;   // gap that auto-pauses the clock

// what counts as "working" — match on app name OR window title (so browser tabs like
// "Railway", "Anthropic Console", "localhost" count). Substrings, case-insensitive.
const DEFAULT_WATCH = [
  "code", "cursor", "windsurf", "zed", "sublime", "webstorm", "intellij", "idea", "pycharm", "goland",
  "terminal", "iterm", "alacritty", "kitty", "wezterm", "warp", "windowsterminal", "wt", "cmd",
  "powershell", "pwsh", "bash", "node", "docker", "postman", "insomnia", "tableplus", "dbeaver",
  "railway", "vercel", "render", "anthropic", "console", "openai", "platform", "localhost", "github",
];
function watchList() {
  try { const c = JSON.parse(readFileSync(CFG, "utf8")); if (Array.isArray(c.watch) && c.watch.length) return c.watch.map((s) => s.toLowerCase()); } catch {}
  return DEFAULT_WATCH;
}

const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function load() { try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return { days: {}, lastBeat: null }; } }
function save(st) { try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(st)); } catch {} }

// ── OS foreground query (name + title), zero-dep ──
const PS = "Add-Type 'using System;using System.Text;using System.Runtime.InteropServices;public class Fg{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);[DllImport(\"user32.dll\")]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);}'; $h=[Fg]::GetForegroundWindow(); $p=0; [Fg]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null; $sb=New-Object System.Text.StringBuilder 512; [Fg]::GetWindowText($h,$sb,512)|Out-Null; $n=try{(Get-Process -Id $p -ErrorAction Stop).ProcessName}catch{''}; Write-Output ($n+\"`t\"+$sb.ToString())";
function foreground() {
  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === "win32") { cmd = "powershell"; args = ["-NoProfile", "-Command", PS]; }
    else if (process.platform === "darwin") { cmd = "osascript"; args = ["-e", 'tell application "System Events" to (name of first application process whose frontmost is true) & "\t" & (try\nname of front window of (first application process whose frontmost is true)\non error\n""\nend try)']; }
    else { cmd = "sh"; args = ["-c", 'id=$(xdotool getactivewindow 2>/dev/null); echo "$(xdotool getwindowclassname $id 2>/dev/null)\t$(xdotool getwindowname $id 2>/dev/null)"']; }
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (e, out) => resolve(e ? "" : String(out).trim()));
  });
}

let watch = watchList();
function isWorking(sig) { const s = sig.toLowerCase(); return watch.some((w) => s.includes(w)); }

let st = load();
async function tick(quiet) {
  const sig = await foreground();
  const now = Date.now();
  const working = sig && isWorking(sig);
  if (working) {
    if (st.lastBeat && now - st.lastBeat <= IDLE_MS) {
      const mins = Math.min(now - st.lastBeat, IDLE_MS) / 60000; // credit contiguous focus, capped
      st.days[today()] = +((st.days[today()] || 0) + mins).toFixed(3);
    }
    st.lastBeat = now;
  } else {
    st.lastBeat = null; // switched away → don't credit the gap
  }
  save(st);
  if (!quiet) {
    const app = (sig.split("\t")[0] || "?").slice(0, 24);
    process.stdout.write(`\r  heartbeat · ${working ? "▶ working" : "‖ paused "} · ${app.padEnd(24)} · today ${(st.days[today()] || 0).toFixed(0)} min   `);
  }
}

let timer = null;
export function startHeartbeat({ quiet = true } = {}) {
  watch = watchList();
  st = load();
  tick(quiet);
  timer = setInterval(() => tick(quiet), POLL_MS);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
export function getWorked() {
  const s = load();
  const t = today();
  const hoursToday = (s.days[t] || 0) / 60;
  const hoursSince = (dayStr) => Object.entries(s.days).filter(([d]) => d >= dayStr).reduce((a, [, m]) => a + m, 0) / 60;
  return { hoursToday, hoursSince, days: s.days };
}

// standalone
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("heartbeat.mjs")) {
  console.log(`\n  TOKENHOURS heartbeat · focus-time only, no keystrokes/content, no network`);
  console.log(`  file  → ${FILE}\n`);
  startHeartbeat({ quiet: false });
}
