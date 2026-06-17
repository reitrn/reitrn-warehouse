# reitrn Warehouse (Lite)

Desktop **station app** for the reitrn portal warehouse. It runs reitrn.com Lite's
inspection workflow on a warehouse PC and **replaces the separate Print Agent** —
printing is built in.

It is a thin Electron shell, **not** a second copy of the UI: the main window loads
the portal's warehouse section (`portal.reitrn.com/warehouse`), so there is one
codebase. The desktop app adds what a browser can't:

- **Built-in label printing** — runs the same local print server on `localhost:3010`
  (`/ping`, `/print`, ZPL/TSPL) the warehouse UI already calls, so no separate
  Print Agent install. Pick the printer in **Station → Printer settings…**.
- **Webcam recording + barcode scanning** — camera/mic are granted to the portal
  origin so the unboxing/item-video capture works; USB keyboard-wedge scanners
  type straight into the inspection screens (the UI already detects them).
- **Station conveniences** — single-instance, maximised station window, tray,
  auto-start, external links open in the OS browser.

## Run (dev)

```
npm install
# point at a local portal during development:
REITRN_PORTAL_URL=http://localhost:3002 npm start
# default (no env) loads https://portal.reitrn.com/warehouse
```

## Build (Windows installer)

```
npm run build      # → dist/reitrn-warehouse-setup.exe (+ portable)
```

## Config

- `REITRN_PORTAL_URL` — portal base URL (default `https://portal.reitrn.com`).
  The app loads `<base>/warehouse/process`.

## Still to wire (founder / follow-ups)

- **Code signing** — set up an EV/OV cert in `electron-builder` (`win.certificateFile`
  / env) so Windows SmartScreen doesn't warn on install.
- **Auto-update** — add `electron-updater` + a release feed (e.g. GitHub Releases).
- **Per-user access (roles)** — once portal auth/roles land, a `warehouse` role
  scopes who can use this; until then the app loads whatever the signed-in portal
  session can see.
- **Offline outbox** — durable local queue for scans/findings/media on poor wifi
  (the video-agent store-and-forward pattern) — planned phase 2.
- **Hub/Enterprise** — a separate, richer station app wrapping ReturnHub — later.

## Repo

`github.com/reitrn/reitrn-lite-warehouse` (create the remote, then `git push -u origin main`).
Built on the proven `reitrn-lite-print-agent` print stack (`printer.js` carried over verbatim).
