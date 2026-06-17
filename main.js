const { app, BrowserWindow, Tray, Menu, ipcMain, session, shell } = require('electron');
const path = require('path');
const http = require('http');
const os = require('os');
const Store = require('electron-store');
const { getInstalledPrinters, printRaw, generateTestLabel } = require('./printer');

const store = new Store();

// Station identity = the machine, the way ReturnHub names stations via its agent.
// Defaults to the computer name; a renamable alias overrides it. Reported to the
// warehouse UI (via /status) so inspections record WHERE they happened — and so
// cartons can be allocated to a station and not wander.
const machineName = os.hostname();
const stationName = () => store.get('stationName') || machineName;

// Which warehouse this station loads. One app, pointed by config:
//   • Lite → https://portal.reitrn.com  (default, loads /warehouse/process)
//   • Hub  → https://app.reitrn.com     (later; set REITRN_WAREHOUSE_URL to the full URL)
// Dev: REITRN_WAREHOUSE_URL=http://localhost:3002/warehouse/process npm start
const PORTAL_URL = (process.env.REITRN_PORTAL_URL || 'https://portal.reitrn.com').replace(/\/$/, '');
const WAREHOUSE_URL = process.env.REITRN_WAREHOUSE_URL || `${PORTAL_URL}/warehouse/process`;
const LOCAL_PORT = 3010; // same contract the warehouse UI already calls for printing
// Which merchant this station belongs to (until account login in-app resolves it).
const MERCHANT_SLUG = process.env.REITRN_MERCHANT_SLUG || store.get('merchantSlug') || 'reitrntest';
// Auto-lock the station after this much inactivity (no clicks / keys / scans),
// so an unattended station drops back to the PIN screen. Env wins (for testing),
// else the saved Station setting, else 15 min. Read live so changes apply at once.
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const idleLockMs = () => Number(process.env.REITRN_IDLE_LOCK_MS) || store.get('idleLockMs') || DEFAULT_IDLE_MS;

let mainWindow = null;
let settingsWindow = null;
let lockWindow = null;
let tray = null;
let localServer = null;
let activeUser = null;     // { id, name, role } — the PIN'd user at this station
let idleTimer = null;      // auto-lock countdown (armed only while signed in)
let mainReady = false;     // warehouse window finished loading
let gatePassed = false;    // PIN gate satisfied (or not required)
let recentJobs = (store.get('recentJobs', []) || []).map((j) => ({ ...j, time: j.time ? new Date(j.time) : new Date() }));

app.setName('reitrn Warehouse');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

app.on('ready', () => {
  grantMediaPermissions();
  createTray();
  createWindow();
  startLocalServer();
  enforceGate();
  app.setLoginItemSettings({ openAtLogin: store.get('autoStart', true), name: 'reitrn Warehouse' });
});

// Show the PIN lock if this merchant has warehouse users configured; otherwise
// go straight in (never bricked before anyone is added). The warehouse window
// only reveals once the gate is satisfied.
async function enforceGate() {
  try {
    const res = await fetch(`${PORTAL_URL}/api/warehouse/pin-status?merchant=${encodeURIComponent(MERCHANT_SLUG)}`);
    const data = await res.json().catch(() => ({}));
    if (data && data.configured) { showLock(); return; }
  } catch { /* offline / not reachable → don't lock the station out */ }
  gatePassed = true;
  maybeShowMain();
}

function maybeShowMain() { if (mainReady && gatePassed && mainWindow) mainWindow.show(); }

app.on('window-all-closed', () => { /* keep running in tray (print server + station) */ });
app.on('before-quit', () => { app.isQuitting = true; if (localServer) localServer.close(); });

// ── Camera + microphone: the inspection flow records unboxing/item video via
// getUserMedia, which Electron blocks unless we grant it. Trust only our portal.
function grantMediaPermissions() {
  const trusted = (url) => { try { return new URL(url).origin === new URL(PORTAL_URL).origin; } catch { return false; } };
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    if ((permission === 'media' || permission === 'camera' || permission === 'microphone') && trusted(wc.getURL())) return cb(true);
    cb(false);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (permission === 'media' || permission === 'camera' || permission === 'microphone') {
      return trusted(requestingOrigin || (wc && wc.getURL()) || '');
    }
    return false;
  });
}

// ── Main window: the warehouse UI, full-screen-ish station view ──────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 832, minWidth: 1024, minHeight: 700,
    title: 'reitrn Warehouse',
    backgroundColor: '#F7F7F9',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: false, // keep the menu bar visible so Lock / switch user + Quit are findable
    webPreferences: { contextIsolation: true, nodeIntegration: false },
    show: false,
  });
  mainWindow.maximize();
  // Announce we're the desktop app so the portal login hides "Create account"
  // (accounts are made on the web; the app only signs in).
  mainWindow.webContents.setUserAgent(`${mainWindow.webContents.getUserAgent()} reitrnWarehouse/${app.getVersion()}`);
  mainWindow.loadURL(WAREHOUSE_URL);
  mainWindow.once('ready-to-show', () => { mainReady = true; maybeShowMain(); });

  // Keep navigation inside the portal; open anything external in the OS browser.
  const sameSite = (url) => { try { return new URL(url).origin === new URL(PORTAL_URL).origin; } catch { return false; } };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!sameSite(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!sameSite(url)) { e.preventDefault(); shell.openExternal(url); } });

  // Inactivity auto-lock: reset the countdown on real interaction only
  // (clicks, keys, scans) — not idle mouse drift.
  mainWindow.webContents.on('input-event', (_e, input) => {
    if (input.type === 'keyDown' || input.type === 'char' || input.type === 'mouseDown') armIdle();
  });

  mainWindow.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); } });
  buildAppMenu();
}

function buildAppMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'Station', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
      { label: 'Toggle full screen', accelerator: 'F11', click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
      { type: 'separator' },
      { label: 'Lock / switch user', accelerator: 'CmdOrCtrl+L', click: lockStation },
      { label: 'Printer settings…', click: openSettings },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { app.isQuitting = true; app.quit(); } },
    ] },
  ]);
  Menu.setApplicationMenu(menu);
}

// ── Printer settings window (carried over from the print agent) ──────────────
function openSettings() {
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 380, height: 600, resizable: false, title: 'Printer settings',
    backgroundColor: '#FFFFFF', icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true, parent: mainWindow,
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWindow.loadFile('settings/index.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ── PIN lock (app-only) ──────────────────────────────────────────────────────
// Shows the scan-or-type PIN screen and hides the warehouse until a staff member
// signs in. "Lock / switch user" returns here without quitting.
function showLock() {
  if (mainWindow) mainWindow.hide();
  if (lockWindow) { lockWindow.show(); lockWindow.focus(); return; }
  lockWindow = new BrowserWindow({
    width: 480, height: 640, resizable: false, title: 'Sign in — reitrn Warehouse',
    backgroundColor: '#F7F7F9', icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'lock-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  lockWindow.loadFile('lock/index.html');
  lockWindow.on('closed', () => { lockWindow = null; });
}

function lockStation() {
  gatePassed = false;
  activeUser = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (tray) tray.setToolTip(`reitrn Warehouse · ${stationName()}`);
  showLock();
}

// (Re)start the inactivity countdown. Only armed while a user is signed in;
// each real interaction (click/key/scan) calls this to reset it.
function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!gatePassed) return;
  idleTimer = setTimeout(() => { if (gatePassed) lockStation(); }, idleLockMs());
}

// ── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray.ico'));
  tray.setToolTip(`reitrn Warehouse · ${stationName()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open warehouse', click: openStation },
    { label: 'Lock / switch user', click: lockStation },
    { label: 'Printer settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', openStation);
}

// Bring the station forward — but respect the PIN gate (show the lock if not in).
function openStation() {
  if (!gatePassed) { showLock(); return; }
  if (mainWindow) (mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show());
}

// ── Local print server (localhost:3010) — same /ping + /print contract the
// warehouse UI already uses, so printing works with no separate agent. ────────
function startLocalServer() {
  localServer = http.createServer(handleRequest);
  localServer.listen(LOCAL_PORT, '127.0.0.1', () => console.log(`[PrintServer] http://localhost:${LOCAL_PORT}`));
  localServer.on('error', (err) => console.error('[PrintServer] failed:', err.message));
}

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, app: 'reitrn-warehouse', station: stationName() })); return; }
  if (req.method === 'GET' && req.url === '/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, printer: store.get('printer', ''), station: stationName(), machine: machineName, user: activeUser })); return; }
  if (req.method === 'POST' && req.url === '/print') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const job = JSON.parse(body);
        const printerName = store.get('printer', '');
        if (!printerName) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'No printer configured' })); return; }
        res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
        const data = job.data || job.zpl || job.tspl || '';
        const id = `local_${Date.now()}`;
        if (!data) { addRecentJob({ id, printer: printerName, status: 'error', time: new Date(), error: 'No printable data' }); return; }
        addRecentJob({ id, printer: printerName, status: 'printing', time: new Date() });
        printRaw(printerName, data)
          .then(() => addRecentJob({ id, printer: printerName, status: 'done', time: new Date() }))
          .catch((err) => addRecentJob({ id, printer: printerName, status: 'error', time: new Date(), error: err.message }));
      } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: err.message })); }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

// ── IPC for the printer-settings window ─────────────────────────────────────
ipcMain.handle('getState', async () => ({ printers: await getInstalledPrinters(), printer: store.get('printer', ''), autoStart: store.get('autoStart', true), recentJobs: recentJobs.slice(0, 20), stationName: stationName(), machineName, idleLockMin: Math.round(idleLockMs() / 60000) }));
ipcMain.handle('refreshPrinters', async () => ({ printers: await getInstalledPrinters(), printer: store.get('printer', '') }));
ipcMain.handle('testPrint', async (e, printerName) => {
  try { await printRaw(printerName, generateTestLabel()); addRecentJob({ id: `test_${Date.now()}`, printer: printerName, status: 'done', time: new Date() }); return true; }
  catch (err) { addRecentJob({ id: `test_${Date.now()}`, printer: printerName, status: 'error', time: new Date(), error: err.message }); return false; }
});
ipcMain.handle('setSetting', async (e, key, value) => {
  store.set(key, value);
  if (key === 'autoStart') app.setLoginItemSettings({ openAtLogin: value, name: 'reitrn Warehouse' });
  if (key === 'stationName' && tray) tray.setToolTip(`reitrn Warehouse · ${stationName()}`);
  if (key === 'idleLockMs') armIdle(); // apply the new timeout immediately
});
ipcMain.handle('minimizeToTray', () => { if (settingsWindow) settingsWindow.hide(); });

// PIN login from the lock screen. A 4–8 digit value is a typed PIN; anything else
// (a scanned ID-card barcode) is sent as a token. Validated server-side.
ipcMain.handle('getStationName', () => stationName());
ipcMain.handle('pinLogin', async (e, value) => {
  const v = String(value || '').trim();
  if (!v) return { error: 'Enter your PIN' };
  const isPin = /^\d{4,8}$/.test(v);
  try {
    const res = await fetch(`${PORTAL_URL}/api/warehouse/pin-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantSlug: MERCHANT_SLUG, ...(isPin ? { pin: v } : { token: v }) }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.user) {
      activeUser = data.user;
      gatePassed = true;
      armIdle(); // start the inactivity countdown for this session
      if (tray) tray.setToolTip(`reitrn Warehouse · ${stationName()} · ${activeUser.name}`);
      // Show the warehouse window reliably (don't depend on the ready-to-show
      // race), then close the lock — otherwise we can end up with no window.
      mainReady = true;
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      if (lockWindow) lockWindow.close();
      return { ok: true };
    }
    return { error: data.error || 'Not recognised' };
  } catch {
    return { error: 'Could not reach the portal — check the connection.' };
  }
});

function addRecentJob(job) {
  recentJobs.unshift(job);
  if (recentJobs.length > 50) recentJobs.pop();
  store.set('recentJobs', recentJobs);
  if (settingsWindow && settingsWindow.webContents) settingsWindow.webContents.send('jobsUpdate', recentJobs.slice(0, 20));
}
