# reitrn Warehouse

One desktop **station app** for the reitrn warehouse. It runs the inspection
workflow on a warehouse PC and **replaces the separate Print Agent** — printing
is built in.

**One app, pointed by config.** It's a thin Electron shell — *not* a copy of any
UI. The main window loads a warehouse web app:

- **Lite** → `https://portal.reitrn.com/warehouse` (default)
- **Hub** → `https://app.reitrn.com` (later — set `REITRN_WAREHOUSE_URL`)

The web apps differ a lot (Lite = one merchant's returns; Hub = reitrn staff across
many enterprise clients), but the *shell* is identical, so there's one binary, one
installer, one updater. The shell never bridges Hub↔Lite — it just loads one of them.

The desktop app adds what a browser can't:

- **Built-in label printing** — runs the same local print server on `localhost:3010`
  (`/ping`, `/print`, ZPL/TSPL) the warehouse UI already calls, so no separate
  Print Agent install. Pick the printer in **Station → Printer settings…**.
- **Webcam recording + barcode scanning** — camera/mic are granted to the loaded
  warehouse origin so unboxing/item-video capture works; USB keyboard-wedge
  scanners type straight into the inspection screens (the UI already detects them).
- **Station conveniences** — single-instance, maximised window, tray, auto-start,
  external links open in the OS browser.

## Run (dev)

```
npm install
# point at a local portal during development:
REITRN_WAREHOUSE_URL=http://localhost:3002/warehouse/process npm start
# default (no env) loads https://portal.reitrn.com/warehouse
```

## Build (Windows installer)

```
npm run build      # → dist/reitrn-warehouse-setup.exe (+ portable)
```

## Config

- `REITRN_WAREHOUSE_URL` — full warehouse URL to load (overrides everything).
- `REITRN_PORTAL_URL` — portal base (default `https://portal.reitrn.com`); the app
  loads `<base>/warehouse/process` when `REITRN_WAREHOUSE_URL` isn't set.

## Roadmap / to wire (founder + follow-ups)

- **Unified video upload** — move video to the Hub's store-and-forward pattern:
  write `.webm` + sidecar to a local watch folder → presigned **R2** upload with
  retry → `return_media` record. Lifts `server.js`/`watcher.js`/`uploader.js` from
  `reitrn-returnhub-video-agent` so Lite and Hub upload identically. (Replaces the
  in-page Firebase upload; needs a portal `/api/storage/r2-signed-url` + R2 creds.)
- **Code signing** — EV/OV cert in `electron-builder` so Windows SmartScreen stays quiet.
- **Auto-update** — `electron-updater` + a release feed (GitHub Releases).
- **Per-user access (roles)** — once portal auth/roles land, a `warehouse` role
  scopes who can use this. Also gives real "who processed/scanned what".
- **Hub target** — point `REITRN_WAREHOUSE_URL` at `app.reitrn.com` (and, if wanted,
  a build flavour with Hub branding/icon from this same source).

## Repo

`github.com/reitrn/reitrn-warehouse` (create the remote, then `git push -u origin main`).
Built on the proven `reitrn-lite-print-agent` print stack (`printer.js` carried over verbatim).
