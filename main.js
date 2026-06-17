const { app, BrowserWindow, Tray, Menu, ipcMain, session, shell } = require('electron');
const path = require('path');
const http = require('http');
const Store = require('electron-store');
const { getInstalledPrinters, printRaw, generateTestLabel } = require('./printer');

const store = new Store();

// Where the warehouse UI lives. Defaults to production; override for dev with
//   REITRN_PORTAL_URL=http://localhost:3002 npm start
const PORTAL_URL = (process.env.REITRN_PORTAL_URL || 'https://portal.reitrn.com').replace(/\/$/, '');
const WAREHOUSE_URL = `${PORTAL_URL}/warehouse/process`;
const LOCAL_PORT = 3010; // same contract the warehouse UI already calls for printing

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let localServer = null;
let recentJobs = (store.get('recentJobs', []) || []).map((j) => ({ ...j, time: j.time ? new Date(j.time) : new Date() }));

app.setName('reitrn Warehouse');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

app.on('ready', () => {
  grantMediaPermissions();
  createTray();
  createWindow();
  startLocalServer();
  app.setLoginItemSettings({ openAtLogin: store.get('autoStart', true), name: 'reitrn Warehouse' });
});

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
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
    show: false,
  });
  mainWindow.maximize();
  mainWindow.loadURL(WAREHOUSE_URL);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Keep navigation inside the portal; open anything external in the OS browser.
  const sameSite = (url) => { try { return new URL(url).origin === new URL(PORTAL_URL).origin; } catch { return false; } };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!sameSite(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!sameSite(url)) { e.preventDefault(); shell.openExternal(url); } });

  mainWindow.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); } });
  buildAppMenu();
}

function buildAppMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'Station', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
      { label: 'Toggle full screen', accelerator: 'F11', click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
      { type: 'separator' },
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

// ── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray.ico'));
  tray.setToolTip('reitrn Warehouse');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open warehouse', click: () => { if (mainWindow) mainWindow.show(); } },
    { label: 'Printer settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { if (mainWindow) (mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show()); });
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
  if (req.method === 'GET' && req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, app: 'reitrn-warehouse' })); return; }
  if (req.method === 'GET' && req.url === '/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, printer: store.get('printer', '') })); return; }
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
ipcMain.handle('getState', async () => ({ printers: await getInstalledPrinters(), printer: store.get('printer', ''), autoStart: store.get('autoStart', true), recentJobs: recentJobs.slice(0, 20) }));
ipcMain.handle('refreshPrinters', async () => ({ printers: await getInstalledPrinters(), printer: store.get('printer', '') }));
ipcMain.handle('testPrint', async (e, printerName) => {
  try { await printRaw(printerName, generateTestLabel()); addRecentJob({ id: `test_${Date.now()}`, printer: printerName, status: 'done', time: new Date() }); return true; }
  catch (err) { addRecentJob({ id: `test_${Date.now()}`, printer: printerName, status: 'error', time: new Date(), error: err.message }); return false; }
});
ipcMain.handle('setSetting', async (e, key, value) => {
  store.set(key, value);
  if (key === 'autoStart') app.setLoginItemSettings({ openAtLogin: value, name: 'reitrn Warehouse' });
});
ipcMain.handle('minimizeToTray', () => { if (settingsWindow) settingsWindow.hide(); });

function addRecentJob(job) {
  recentJobs.unshift(job);
  if (recentJobs.length > 50) recentJobs.pop();
  store.set('recentJobs', recentJobs);
  if (settingsWindow && settingsWindow.webContents) settingsWindow.webContents.send('jobsUpdate', recentJobs.slice(0, 20));
}
