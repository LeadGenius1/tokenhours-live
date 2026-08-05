// TOKENHOURS Live · desktop wrapper (Electron).
// The exact same meter + True Cost engine as `npx tokenhours-live`, wrapped so
// non-terminal users get a double-click app: it runs the meter in the background,
// lives in the tray, and shows the same full dashboard as a transparent,
// click-through overlay on the slow show/hide timer. No code changes to the meter —
// this just launches it and hosts the /overlay window.
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, utilityProcess, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4317;
const METER = path.join(__dir, "app", "meter.mjs"); // staged by stage-app.mjs at build time
let meter, win, tray;

function startMeter() {
  meter = utilityProcess.fork(METER, [], { env: { ...process.env, PORT: String(PORT), TH_STATE: undefined } });
}
function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 720, height: 960, x: width - 740, y: Math.max(0, height - 980),
    transparent: true, frame: false, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false,
    webPreferences: { contextIsolation: true },
  });
  win.setIgnoreMouseEvents(true, { forward: true });   // click-through — it's an overlay, not a window
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(`http://127.0.0.1:${PORT}/overlay`);
  win.on("closed", () => { win = null; });
}
function showNow() { if (win) win.webContents.reloadIgnoringCache(); } // reload → the overlay timer re-shows immediately

app.whenReady().then(() => {
  startMeter();
  setTimeout(createOverlay, 1400);                     // give the meter a moment to bind :4317
  const icon = nativeImage.createFromPath(path.join(__dir, "build", "tray.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 18, height: 18 }));
  tray.setToolTip("TOKENHOURS Live — true cost as you build");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show dashboard now", click: showNow },
    { label: "Open full HUD…", click: () => shell.openExternal(`http://127.0.0.1:${PORT}/`) },
    { type: "separator" },
    { label: "tokenhours.com", click: () => shell.openExternal("https://tokenhours.com") },
    { label: "Quit", click: () => app.quit() },
  ]));
});
app.on("window-all-closed", (e) => { e.preventDefault?.(); });  // stay alive in the tray
app.on("before-quit", () => { try { meter?.kill(); } catch {} });
