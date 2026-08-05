# TokenHours Live — desktop app (Electron)

The "Download for Windows / Mac" build. Wraps the exact same meter + True Cost
engine (`../meter.mjs` and friends) — no code changes — so non-terminal users get
a double-click installer that runs it in the tray and shows the same dashboard as a
transparent, click-through overlay on the slow show/hide timer.

## Build

```bash
cd meter/electron
npm install            # electron + electron-builder (~dev deps, a few hundred MB)
npm start              # run locally (stages the meter, launches the overlay + tray)
npm run build:win      # → dist/TokenHours-Live-Setup.exe   (build on Windows)
npm run build:mac      # → dist/TokenHours-Live.dmg          (build on macOS or CI)
```

`stage-app.mjs` copies the meter runtime into `app/` before each build, so the meter
stays the single source of truth (no forked copy). Icons live in `build/` (`icon.png`
for the installer, `tray.png` for the tray).

## Notes
- **Cross-compiling:** a Windows machine builds the `.exe`; the `.dmg` needs **macOS**
  (or a Mac CI runner) — Apple's tooling can't be run from Windows. Ship the Windows
  installer first; add the Mac build from a Mac/CI.
- **Signing (later):** unsigned installers trigger SmartScreen/Gatekeeper warnings.
  For a real release, add a Windows code-signing cert + Apple notarization to the
  `build` config. Fine to skip for internal/beta.
- **Same privacy guarantees** as the CLI — the Electron shell only hosts the local
  overlay window; nothing new leaves the machine.

## Ship to tokenhours.com
Upload the artifacts and point the site's "Download" buttons at them (e.g.
`/download/TokenHours-Live-Setup.exe`). Keep `npx tokenhours-live` as the developer
path; the installers are the everyone-else path.
