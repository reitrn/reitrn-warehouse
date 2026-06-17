const { app, BrowserWindow, Tray, Menu, ipcMain, session, shell, nativeImage } = require('electron');
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
let gatePassed = false;    // PIN gate satisfied this session
let pinConfigured = false; // merchant has warehouse PIN users
let recentJobs = (store.get('recentJobs', []) || []).map((j) => ({ ...j, time: j.time ? new Date(j.time) : new Date() }));

app.setName('reitrn Warehouse');
// Windows: group + icon the taskbar entry under our identity, not Electron's.
if (process.platform === 'win32') app.setAppUserModelId('com.reitrn.warehouse');

// ── The living gradient — the running window + tray icon shift colour each week.
// (The packaged .exe/.ico stays fixed; this only recolours the icon while running.)
// Mirror of reitrn-www/living-gradient.js. Rasterised via a hidden window because
// nativeImage can't render SVG directly.
const WK_ANCHORS = ['#C21460','#8601AF','#4424D6','#0247FE','#347C98','#66B032','#B2D732','#FEFE33','#FABC02','#FB9902','#FD5308','#FE2712'];
function _h2r(h){h=h.replace('#','');return[parseInt(h.substr(0,2),16),parseInt(h.substr(2,2),16),parseInt(h.substr(4,2),16)];}
function _r2hsl(r,g,b){r/=255;g/=255;b/=255;var mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn,h=0,s=0,l=(mx+mn)/2;if(d){s=l>0.5?d/(2-mx-mn):d/(mx+mn);if(mx===r)h=((g-b)/d+(g<b?6:0));else if(mx===g)h=((b-r)/d+2);else h=((r-g)/d+4);h*=60;}return{h:h,s:s,l:l};}
function _hsl2hex(h,s,l){h=(h%360+360)%360;s=Math.max(0,Math.min(1,s));l=Math.max(0,Math.min(1,l));var c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2,r,g,b;if(h<60){r=c;g=x;b=0;}else if(h<120){r=x;g=c;b=0;}else if(h<180){r=0;g=c;b=x;}else if(h<240){r=0;g=x;b=c;}else if(h<300){r=x;g=0;b=c;}else{r=c;g=0;b=x;}function t(v){v=Math.round((v+m)*255);return('0'+v.toString(16)).slice(-2);}return('#'+t(r)+t(g)+t(b)).toUpperCase();}
function _lerpH(a,b,t){var d=b-a;if(d>180)d-=360;if(d<-180)d+=360;return a+d*t;}
function _rgblerp(a,b,t){function p(v){return('0'+Math.round(v).toString(16)).slice(-2);}return('#'+p(a[0]+(b[0]-a[0])*t)+p(a[1]+(b[1]-a[1])*t)+p(a[2]+(b[2]-a[2])*t)).toUpperCase();}
const _HSL = WK_ANCHORS.map((a) => { const r = _h2r(a); return _r2hsl(r[0], r[1], r[2]); });
function _baseHsl(frac){var pos=frac*12,i=Math.floor(pos),t=pos-i;i=((i%12)+12)%12;var j=(i+1)%12,X=_HSL[i],Y=_HSL[j];return{h:_lerpH(X.h,Y.h,t),s:X.s+(Y.s-X.s)*t,l:X.l+(Y.l-X.l)*t};}
const _DR=[254,39,18],_DT=[0,184,154],_DW=[];for(let k=0;k<52;k++){if(Math.floor(k/52*12)===11)_DW.push(k);}
function weekGradient(){const d=new Date(),s=new Date(d.getFullYear(),0,1),w=Math.max(0,Math.min(51,Math.floor((d-s)/(7*86400000))));if(Math.floor(w/52*12)===11){const i=_DW.indexOf(w),n=_DW.length;return{start:_rgblerp(_DR,_DT,i/n),end:_rgblerp(_DR,_DT,(i+1)/n)};}const b=_baseHsl((w+0.5)/52);return{start:_hsl2hex(b.h-14,b.s,b.l+0.10),end:_hsl2hex(b.h+14,b.s,b.l-0.10)};}
const RI_PATHS = '<path d="M28.76,132.71V59.55h22.18v13.35h.79c1.31-4.84,3.48-8.43,6.51-10.76,3.03-2.33,6.55-3.5,10.57-3.5,1.05,0,2.15.07,3.3.2,1.16.13,2.21.33,3.17.59v19.89c-1.09-.39-2.52-.69-4.29-.88s-3.35-.29-4.74-.29c-2.79,0-5.3.62-7.52,1.86s-3.97,2.96-5.23,5.14c-1.27,2.18-1.9,4.73-1.9,7.66v39.91h-22.83Z"/><path d="M90.51,50.98c-3.23,0-6-1.08-8.31-3.24-2.31-2.16-3.47-4.74-3.47-7.75s1.16-5.65,3.47-7.79c2.31-2.14,5.08-3.21,8.31-3.21s6.06,1.07,8.38,3.21c2.31,2.14,3.47,4.75,3.47,7.85s-1.16,5.58-3.47,7.72c-2.31,2.14-5.1,3.21-8.38,3.21ZM79.13,132.71V59.55h22.83v73.15h-22.83Z"/><path d="M128.96,141.08c-3.49,0-6.42-1.17-8.8-3.5-2.38-2.33-3.57-5.25-3.57-8.74s1.19-6.33,3.57-8.67c2.38-2.33,5.31-3.5,8.8-3.5s6.42,1.17,8.8,3.5c2.38,2.33,3.57,5.22,3.57,8.67s-1.19,6.4-3.57,8.74c-2.38,2.33-5.31,3.5-8.8,3.5Z"/>';
function brandIconSvg(start, end){return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 170.08 170.08"><defs><linearGradient id="g" x1="0" y1="0" x2="170.08" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="'+start+'"/><stop offset="1" stop-color="'+end+'"/></linearGradient></defs><rect width="170.08" height="170.08" rx="34" fill="url(#g)"/><g fill="#ffffff">'+RI_PATHS+'</g></svg>';}
async function rasterizePng(svg, size){
  const win = new BrowserWindow({ show: false, width: size, height: size, webPreferences: { offscreen: false } });
  try {
    await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body></body>');
    return await win.webContents.executeJavaScript(
      '(function(){return new Promise(function(res,rej){var img=new Image();img.onload=function(){var c=document.createElement("canvas");c.width='+size+';c.height='+size+';var x=c.getContext("2d");x.drawImage(img,0,0,'+size+','+size+');res(c.toDataURL("image/png"));};img.onerror=function(){rej(new Error("svg"));};img.src='+JSON.stringify('data:image/svg+xml,'+encodeURIComponent(svg))+';});})()'
    );
  } finally { if (!win.isDestroyed()) win.destroy(); }
}
let _lastIconKey = null;
async function applyWeekIcons(force){
  try {
    const g = weekGradient();
    const key = g.start + g.end;
    if (!force && key === _lastIconKey) return;   // unchanged week → skip the work
    const svg = brandIconSvg(g.start, g.end);
    const big = nativeImage.createFromDataURL(await rasterizePng(svg, 256));
    const small = nativeImage.createFromDataURL(await rasterizePng(svg, 32));
    for (const w of [mainWindow, settingsWindow, lockWindow]) { if (w && !w.isDestroyed()) w.setIcon(big); }
    if (tray) tray.setImage(small);
    _lastIconKey = key;
  } catch (e) { /* fall back to the static .ico */ }
}

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

app.on('ready', () => {
  grantMediaPermissions();
  createTray();
  createWindow();
  startLocalServer();
  fetchPinConfigured();
  app.setLoginItemSettings({ openAtLogin: store.get('autoStart', true), name: 'reitrn Warehouse' });
  // Colour the running window + tray icon for this week, and re-check every 6h so an
  // always-on station rolls over to the new colour without ever being restarted.
  applyWeekIcons(true);
  setInterval(() => applyWeekIcons(false), 6 * 60 * 60 * 1000);
});

// Does this merchant use PIN login? (No users → never gate.)
async function fetchPinConfigured() {
  try {
    const res = await fetch(`${PORTAL_URL}/api/warehouse/pin-status?merchant=${encodeURIComponent(MERCHANT_SLUG)}`);
    const data = await res.json().catch(() => ({}));
    pinConfigured = !!(data && data.configured);
  } catch { pinConfigured = false; }
  if (mainWindow) evaluateGate(mainWindow.webContents.getURL());
}

// The PIN is SECONDARY to the account: it only appears once the station is signed
// in (the window is on an authenticated page, not /login). So the order is always
// email login first → then PIN. On the login page we just show the window.
function evaluateGate(url) {
  let p = '';
  try { p = new URL(url).pathname } catch { /* about:blank etc. */ }
  const onLogin = p.startsWith('/login') || p.startsWith('/auth') || p === '' || p === '/'
  if (onLogin) { if (mainWindow) mainWindow.show(); return; }      // account login phase
  if (pinConfigured && !gatePassed) { showLock(); return; }        // signed in → require PIN
  if (mainWindow) mainWindow.show();                               // signed in + PIN done (or none)
}

app.on('window-all-closed', () => { /* keep running in tray (print server + station) */ });
app.on('before-quit', () => { app.isQuitting = true; if (localServer) localServer.close(); });

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
    frame: false, // the portal draws its own white top bar (window controls in the UI)
    backgroundColor: '#FFFFFF',
    webPreferences: { preload: path.join(__dirname, 'app-preload.js'), contextIsolation: true, nodeIntegration: false },
    show: false,
  });
  mainWindow.maximize();
  // Announce we're the desktop app so the portal login hides "Create account"
  // (accounts are made on the web; the app only signs in).
  mainWindow.webContents.setUserAgent(`${mainWindow.webContents.getUserAgent()} reitrnWarehouse/${app.getVersion()}`);
  mainWindow.loadURL(WAREHOUSE_URL);
  // Decide login-vs-PIN on first paint and on every navigation, so the PIN only
  // appears once the station is signed in (account first → then PIN).
  mainWindow.once('ready-to-show', () => evaluateGate(mainWindow.webContents.getURL()));
  mainWindow.webContents.on('did-navigate', (_e, url) => evaluateGate(url));
  mainWindow.webContents.on('did-navigate-in-page', (_e, url) => evaluateGate(url));

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
    width: 1280, height: 832, minWidth: 1024, minHeight: 700, title: 'Sign in — reitrn Warehouse',
    backgroundColor: '#F7F7F9', icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'lock-preload.js'), contextIsolation: true, nodeIntegration: false },
    show: false,
  });
  lockWindow.maximize();           // full size, not a little box — the PIN screen centres itself
  lockWindow.once('ready-to-show', () => lockWindow && lockWindow.show());
  lockWindow.loadFile('lock/index.html');
  applyWeekIcons(true);   // colour the new lock window's icon + catch a week rollover
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
ipcMain.handle('lockStation', () => { lockStation(); });
// Window controls for the portal's custom (frameless) top bar.
ipcMain.handle('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.handle('win:maximize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.isMaximized() ? w.unmaximize() : w.maximize(); });
ipcMain.handle('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
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
      // Reveal the warehouse and close the lock.
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
