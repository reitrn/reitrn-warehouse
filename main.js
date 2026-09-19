const { app, BrowserWindow, Tray, Menu, ipcMain, session, shell, nativeImage } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
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

// Which warehouse this station loads. ONE app for every plan: it lands on the
// portal root and the PORTAL routes by the signed-in account's plan —
// Enterprise–3PL stations → the console Inspect bench, brand plans → the
// workbench (founder, 2026-07-03: the app reflects the enterprise hub).
// Dev: REITRN_PORTAL_URL=http://localhost:3002 npm start
const PORTAL_URL = (process.env.REITRN_PORTAL_URL || 'https://portal.reitrn.com').replace(/\/$/, '');
const WAREHOUSE_URL = process.env.REITRN_WAREHOUSE_URL || `${PORTAL_URL}/`;
const LOCAL_PORT = 3010; // same contract the warehouse UI already calls for printing
// Which merchant account this station belongs to — drives the staff PIN login.
// AUTO-RESOLVED from whoever is signed into the portal in this app (the
// window session's cookies ask /api/warehouse/station-context), so the lock
// checks the RIGHT account with zero setup (founder bug, 2026-07-03: PINs
// "not recognised" because the station still pointed at the default brand).
// Env var and the Station setting remain as explicit overrides.
// Last run's resolved gate facts, persisted — the app decides lock-vs-not
// INSTANTLY on the next boot instead of waiting a server round-trip
// (founder, 2026-07-03: "why can't the pin just instantly load"). The live
// resolution still runs and corrects the cache if the account changed.
const gateCache = store.get('gateCache') || {};
let autoSlug = gateCache.slug || null;
let autoPlan = gateCache.plan || null; // drives printer slots (enterprise = label + 4x6)
const merchantSlug = () => process.env.REITRN_MERCHANT_SLUG || store.get('merchantSlug') || autoSlug || 'reitrntest';
async function resolveSlugFromSession() {
  try {
    // Ask the PAGE, not the network stack: the main window IS the signed-in
    // portal, so a same-origin fetch from inside it always carries the
    // session cookies (main-process fetches silently dropped them — the gate
    // never engaged; founder bug, 2026-07-03).
    if (!mainWindow || mainWindow.webContents.isLoading()) {
      await new Promise((r) => { if (mainWindow) mainWindow.webContents.once('did-stop-loading', r); else r(); });
    }
    const data = await mainWindow.webContents.executeJavaScript(
      `fetch('/api/warehouse/station-context').then(r => r.ok ? r.json() : null).catch(() => null)`,
      true,
    );
    if (data && data.slug) {
      autoSlug = data.slug;
      autoPlan = data.plan || null;
      // Same authed call answers whether this account gates with PINs — the
      // separate pin-status round-trip 401'd from the main process (no
      // cookies) and silently disabled the gate.
      pinConfigured = !!data.pinConfigured;
      // Persist for INSTANT gate decisions on the next boot.
      store.set('gateCache', { slug: autoSlug, plan: autoPlan, pinConfigured });
      pushGateState();
    }
  } catch { /* signed out or offline — keep whatever we had */ }
}
// Auto-lock the station after this much inactivity (no clicks / keys / scans),
// so an unattended station drops back to the PIN screen. Env wins (for testing),
// else the saved Station setting, else 15 min. Read live so changes apply at once.
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const idleLockMs = () => Number(process.env.REITRN_IDLE_LOCK_MS) || store.get('idleLockMs') || DEFAULT_IDLE_MS;

let mainWindow = null;
let lockWindow = null;
let tray = null;
let localServer = null;
let activeUser = null;     // { id, name, role } — the PIN'd user at this station
let idleTimer = null;      // auto-lock countdown (armed only while signed in)
let gatePassed = false;    // PIN gate satisfied this session
let pinConfigured = !!gateCache.pinConfigured; // cached from last run; live-corrected on boot
let recentJobs = (store.get('recentJobs', []) || []).map((j) => ({ ...j, time: j.time ? new Date(j.time) : new Date() }));
let pageConsoleLog = [];   // last ~200 page console entries — served on /console-log
let videoOutboxTimer = null; // store-and-forward upload worker (video-outbox/)

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
    for (const w of [mainWindow, lockWindow]) { if (w && !w.isDestroyed()) w.setIcon(big); }
    if (tray) tray.setImage(small);
    _lastIconKey = key;
  } catch (e) { /* fall back to the static .ico */ }
}

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

app.on('ready', () => {
  grantMediaPermissions();
  createSplash();     // instant local brand splash — no blank seconds while the portal loads
  createTray();
  createWindow();
  startLocalServer();
  // NOTE: pin-status is resolved in ready-to-show BEFORE anything is shown —
  // account first, then the gate decision, so a worker cold-starting the app
  // meets the PIN lock, never a flash of the bench (founder, 2026-07-03).
  app.setLoginItemSettings({ openAtLogin: store.get('autoStart', true), name: 'reitrn Warehouse' });
  // Colour the running window + tray icon for this week, and re-check every 6h so an
  // always-on station rolls over to the new colour without ever being restarted.
  applyWeekIcons(true);
  setInterval(() => applyWeekIcons(false), 6 * 60 * 60 * 1000);
});

// Does this merchant use PIN login? (No users → never gate.) Runs INSIDE the
// signed-in window — pin-status is authed and main-process fetches carry no
// cookies (the silent 401 that kept the gate off; founder bug, 2026-07-03).
// Only needed when the Station setting overrides the slug manually; the
// normal path gets pinConfigured from station-context in one call.
async function fetchPinConfigured(silent) {
  try {
    const data = await mainWindow.webContents.executeJavaScript(
      `fetch('/api/warehouse/pin-status?merchant=${encodeURIComponent(merchantSlug())}').then(r => r.ok ? r.json() : null).catch(() => null)`,
      true,
    );
    if (data) pinConfigured = !!data.configured;
  } catch { /* keep the last known state */ }
  if (!silent && mainWindow) evaluateGate(mainWindow.webContents.getURL());
}

// The PIN is SECONDARY to the account: it only appears once the station is signed
// in (the window is on an authenticated page, not /login). So the order is always
// email login first → then PIN. On the login page we just show the window.
// NOTHING shows until BOTH are true: the boot resolution (account + PIN
// policy) completed AND the page's in-page lock overlay reported it is
// mounted and covering (lockUiReady). The shell finishing first means nothing
// if React inside hasn't painted the lock yet — that gap was exactly the
// founder's flash (2026-07-03). A worker's first pixel is the lock or the
// login. A fallback timer force-shows after 8s so a broken page can never
// leave the station windowless.
let bootResolved = false;
let pageReady = false;   // the page's lock overlay is mounted & covering
let showForced = false;  // fallback fired — show whatever we have
function evaluateGate(url) {
  if (!bootResolved) return;
  let p = '';
  try { p = new URL(url).pathname } catch { /* about:blank etc. */ }
  // NOTE: '/' is NOT a login path — signed in, the root REDIRECTS to the
  // bench, and showing during that redirect was the last bench flash
  // (founder, 2026-07-03). '' = about:blank/initial: decide nothing yet.
  if (p === '' || p === '/') return;
  const onLogin = p.startsWith('/login') || p.startsWith('/auth')
  if (onLogin) { showMain(); return; }                             // account login phase (no bench to leak)
  if (!pageReady && !showForced) return;                           // wait for the page's lock to be up
  if (pinConfigured && !gatePassed) { showLock(); return; }        // signed in → require PIN
  showMain();                                                      // signed in + PIN done (or none)
}
function showMain() {
  closeSplash();
  if (!mainWindow) return;
  // maximize() also SHOWS the window (it force-showed at creation and was the
  // true source of every boot flash) — so it happens HERE, at the reveal.
  if (!mainWindow.isVisible()) mainWindow.maximize();
  mainWindow.show();
  mainWindow.focus();
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

// ── Splash — a tiny LOCAL window shown instantly at launch (no network),
// closed the moment the real window (lock or login) is ready. The cold start
// is wordmark → lock, never a blank pause (founder, 2026-07-03). ────────────
let splashWindow = null;
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420, height: 240, frame: false, resizable: false, center: true,
    backgroundColor: '#FFFFFF', skipTaskbar: true, alwaysOnTop: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile('splash/index.html');
  splashWindow.on('closed', () => { splashWindow = null; });
}
function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
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
  // NOTE: no maximize() here — on Windows it force-shows the hidden window
  // (the source of every boot flash). showMain() maximizes at the reveal.
  // Announce we're the desktop app so the portal login hides "Create account"
  // (accounts are made on the web; the app only signs in).
  mainWindow.webContents.setUserAgent(`${mainWindow.webContents.getUserAgent()} reitrnWarehouse/${app.getVersion()}`);
  // Page-console tap → GET /console-log on the local server. The page is a
  // remote site (no devtools in production), so this is the only window into
  // client-side errors on stations.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    pageConsoleLog.push({ at: new Date().toISOString(), level, message: String(message).slice(0, 500), source: `${sourceId}:${line}` });
    if (pageConsoleLog.length > 200) pageConsoleLog.shift();
  });
  mainWindow.loadURL(WAREHOUSE_URL);
  // Decide login-vs-PIN on first paint and on every navigation, so the PIN only
  // appears once the station is signed in (account first → then PIN).
  // Cold start: resolve WHOSE account this station is (window-session cookies),
  // then whether that account gates with PINs, THEN decide lock-vs-show. The
  // window stays hidden until this completes — no flash of the bench.
  mainWindow.once('ready-to-show', async () => {
    if (gateCache.slug) {
      // Cached facts from the last run → gate decisions are INSTANT; the live
      // resolution below corrects the cache in the background if it changed.
      bootResolved = true;
      pushGateState();
      evaluateGate(mainWindow.webContents.getURL());
      resolveSlugFromSession(); // background revalidate (pushes updates itself)
    } else {
      await resolveSlugFromSession(); // first run — no facts yet, resolve first
      bootResolved = true;
      pushGateState();
      evaluateGate(mainWindow.webContents.getURL());
    }
    // Fallback: if the page never signals lockUiReady (old build, error page,
    // dead wifi), show anyway after 8s — a station must never be windowless
    // and the splash must never outlive the boot.
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        showForced = true;
        showMain();
      }
    }, 8000);
  });
  mainWindow.webContents.on('did-navigate', (_e, url) => { evaluateGate(url); resolveSlugFromSession(); });
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
      { label: 'Station settings…', click: openSettings },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { app.isQuitting = true; app.quit(); } },
    ] },
  ]);
  Menu.setApplicationMenu(menu);
}

// ── Station settings — IN-APP (founder, 2026-07-03: the separate settings
// window is retired; the tray/menu open the portal's own slide-over panel
// via the bridge event). settings/ + settings-preload.js are unused.
function openSettings() {
  openStation(); // shows the lock if nobody's signed in — settings live behind it
  if (mainWindow) mainWindow.webContents.send('openStationSettings');
}

// ── PIN lock — IN-PAGE, one window always ─────────────────────────────────────
// The lock is a full-screen overlay RENDERED BY THE PORTAL PAGE inside the one
// app window (founder, 2026-07-03: the separate lock window felt like "a new
// screen entirely" — self-contained or nothing). The shell owns the STATE
// (locked / who) and pushes it; the page draws it. lock/index.html and
// lock-preload.js are retired.
function gateStatePayload() {
  return { locked: pinConfigured && !gatePassed, pinConfigured, user: activeUser, station: stationName(), bootResolved };
}
function pushGateState() {
  if (mainWindow) mainWindow.webContents.send('gateState', gateStatePayload());
}
function showLock() {
  pushGateState();                                  // the page covers itself
  showMain();
}

function lockStation() {
  gatePassed = false;
  activeUser = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (tray) tray.setToolTip(`reitrn Warehouse · ${stationName()}`);
  if (mainWindow) mainWindow.webContents.send('staffChanged', null);
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
    { label: 'Station settings…', click: openSettings },
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

// ── Video outbox upload worker (store-and-forward, the video-agent pattern) ──
// Every 30s: for each {file}.webm + {file}.json pair, ask the portal for a
// fresh presigned URL (the signed token in the sidecar is the auth — main
// carries no cookies), stream the file to R2, mark the inspection uploaded,
// delete the pair. Any failure leaves the pair for the next tick — a station
// can sit in a dead zone over a weekend and lose nothing.
// Quarantine: a recording we could not deliver is MOVED, never deleted. The
// pair lands in video-outbox/failed/ with a reason file, so it can be
// recovered by hand and so a real problem is visible instead of silent.
function quarantineVideoEntry(filePath, sidecarPath, reason) {
  try {
    const dir = path.join(app.getPath('userData'), 'video-outbox', 'failed');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(filePath);
    if (fs.existsSync(filePath)) fs.renameSync(filePath, path.join(dir, base));
    if (fs.existsSync(sidecarPath)) fs.renameSync(sidecarPath, path.join(dir, base + '.json'));
    fs.writeFileSync(path.join(dir, base + '.reason.txt'), `${new Date().toISOString()}  ${reason}
`);
    console.error(`[VideoOutbox] QUARANTINED ${base}: ${reason} — file kept in failed/`);
  } catch (err) {
    // Even quarantine failing must not delete anything — leave it where it is.
    console.error('[VideoOutbox] quarantine failed, entry left in place:', err.message);
  }
}

// Reap by AGE, not by one bad response. A sidecar older than this cannot be
// signed any more (the portal token lifetime is 7 days), so it is genuinely
// undeliverable — but it is still quarantined rather than deleted.
const VIDEO_ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let videoDraining = false;
async function drainVideoOutbox() {
  if (videoDraining) return;
  videoDraining = true;
  try {
    const dir = path.join(app.getPath('userData'), 'video-outbox');
    if (!fs.existsSync(dir)) return;
    const sidecars = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const sc of sidecars) {
      const sidecarPath = path.join(dir, sc);
      const filePath = sidecarPath.replace(/\.json$/, '');
      try {
        if (!fs.existsSync(filePath)) { fs.unlinkSync(sidecarPath); continue; } // orphan sidecar
        const meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        // Too old to ever be signed — quarantine so it stops being retried
        // forever, but keep the file: it may still be wanted as evidence.
        const ageMs = Date.now() - (Number(meta.createdAt) || fs.statSync(sidecarPath).mtimeMs);
        if (ageMs > VIDEO_ENTRY_MAX_AGE_MS) { quarantineVideoEntry(filePath, sidecarPath, `undeliverable for ${Math.round(ageMs / 86400000)} days`); continue; }
        // 1) Fresh presigned URL (they expire — never stored).
        const signRes = await fetch(`${meta.origin}/api/video-outbox`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: meta.token, action: 'sign' }),
        });
        // NEVER delete a recording because of one HTTP response. A 401 was
        // treated as "token expired (7d), dead entry" and unlinked the file —
        // but 401 also means a rotated signing secret, a deploy that changed
        // token validation, or a transient auth misconfiguration. In every one
        // of those cases this destroyed the ONLY copy of an inspection video:
        // the evidence kept to defend a disputed refund, gone silently.
        // Quarantine instead — the file stays, the backlog is visible, and a
        // genuinely dead entry is reaped on AGE below, not on one 401.
        if (signRes.status === 401) { quarantineVideoEntry(filePath, sidecarPath, 'sign rejected (401)'); continue; }
        if (!signRes.ok) continue; // 503 unconfigured / transient — retry next tick
        const { url } = await signRes.json().catch(() => ({}));
        if (!url) continue;
        // 2) Stream the file to R2 (native https — clean stream upload).
        const ok = await new Promise((resolve) => {
          try {
            const u = new URL(url);
            const put = https.request({
              hostname: u.hostname, path: u.pathname + u.search, method: 'PUT',
              headers: { 'Content-Type': meta.contentType || 'video/webm', 'Content-Length': fs.statSync(filePath).size },
            }, (r) => { r.resume(); resolve(r.statusCode >= 200 && r.statusCode < 300); });
            put.on('error', () => resolve(false));
            fs.createReadStream(filePath).pipe(put);
          } catch { resolve(false); }
        });
        if (!ok) continue;
        // 3) Mark uploaded, THEN delete — a failed mark keeps the pair (re-PUT
        // of the same key is idempotent).
        const markRes = await fetch(`${meta.origin}/api/video-outbox`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: meta.token, action: 'uploaded' }),
        });
        if (!markRes.ok) continue;
        fs.unlinkSync(filePath);
        fs.unlinkSync(sidecarPath);
        console.log(`[VideoOutbox] uploaded ${meta.key}`);
      } catch (err) {
        console.error('[VideoOutbox] entry failed:', err.message);
      }
    }
  } finally {
    videoDraining = false;
  }
}
function videoOutboxCount() {
  try {
    const dir = path.join(app.getPath('userData'), 'video-outbox');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
  } catch { return 0; }
}

// Recordings that could NOT be delivered and are sitting in failed/. This must
// be surfaced: a quarantined video is a real problem (evidence that never
// reached R2), and the plain pending count cannot distinguish "nothing to do"
// from "everything failed".
function videoQuarantineCount() {
  try {
    const dir = path.join(app.getPath('userData'), 'video-outbox', 'failed');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
  } catch { return 0; }
}

// ── Local print server (localhost:3010) — same /ping + /print contract the
// warehouse UI already uses, so printing works with no separate agent. ────────
function startLocalServer() {
  localServer = http.createServer(handleRequest);
  localServer.listen(LOCAL_PORT, '127.0.0.1', () => console.log(`[PrintServer] http://localhost:${LOCAL_PORT}`));
  localServer.on('error', (err) => console.error('[PrintServer] failed:', err.message));
  // Video outbox worker: drain on boot (files left from a previous run) and
  // every 30s — the retry half of the store-and-forward pattern.
  drainVideoOutbox();
  videoOutboxTimer = setInterval(drainVideoOutbox, 30_000);
}

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome Private Network Access: an https portal page fetching localhost
  // sends a PNA preflight — answer it or detection breaks quietly.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, app: 'reitrn-warehouse', station: stationName() })); return; }
  // The portal's browser pages call this to hand the bench over to the app:
  // brings the station window forward (or the PIN lock if nobody's signed in).
  if (req.method === 'GET' && req.url === '/open') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    openStation();
    return;
  }
  if (req.method === 'GET' && req.url === '/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, printer: store.get('printer', ''), station: stationName(), machine: machineName, user: activeUser, videoOutbox: videoOutboxCount(), videoQuarantined: videoQuarantineCount(), gate: { slug: merchantSlug(), autoSlug, pinConfigured, gatePassed, bootResolved, pageReady, windowVisible: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) } })); return; }
  // The page's own console (errors and all) — the only debugging window into a
  // remote production page on a station. ?url=1 adds the page's current URL.
  if (req.method === 'GET' && req.url.startsWith('/console-log')) {
    const currentUrl = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url: currentUrl, log: pageConsoleLog }));
    return;
  }
  // Read page state (localhost-only, same trust as /open): POST a JS
  // expression, get its JSON result — the self-verify hook for app-side work.
  if (req.method === 'POST' && req.url === '/eval') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const expr = JSON.parse(body).js;
        const result = await mainWindow.webContents.executeJavaScript(`Promise.resolve((() => { ${expr} })()).then(v => JSON.stringify(v ?? null))`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: JSON.parse(result) }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  // Store-and-forward video handoff (the README's unified-video-upload item,
  // the video-agent pattern): the bench POSTs the recorded webm here; it
  // streams to disk with a .json sidecar (signed portal token + key + origin)
  // and the upload worker owns retries — uploads survive page closes/crashes.
  if (req.method === 'POST' && req.url.startsWith('/video-outbox')) {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const token = q.get('token');
      const key = q.get('key');
      const origin = q.get('origin');
      if (!token || !key || !origin) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'token/key/origin required' }));
        return;
      }
      const dir = path.join(app.getPath('userData'), 'video-outbox');
      fs.mkdirSync(dir, { recursive: true });
      const base = key.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(dir, `${base}.webm`);
      const out = fs.createWriteStream(`${filePath}.part`);
      req.pipe(out);
      out.on('finish', () => {
        try {
          fs.renameSync(`${filePath}.part`, filePath);
          fs.writeFileSync(`${filePath}.json`, JSON.stringify({
            token, key, origin,
            contentType: req.headers['content-type'] || 'video/webm',
            receivedAt: new Date().toISOString(),
          }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          drainVideoOutbox(); // try immediately; the worker retries otherwise
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      out.on('error', (err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  // Drive the station page to a portal path (localhost-only server — same
  // trust as /open). Debugging + future remote-assist hook.
  if (req.method === 'GET' && req.url.startsWith('/goto')) {
    const target = new URL(req.url, 'http://localhost').searchParams.get('path') || '/';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`window.location.href = ${JSON.stringify(target)}`).catch(() => {});
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, target }));
    return;
  }
  if (req.method === 'POST' && req.url === '/print') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const job = JSON.parse(body);
        // Role routing (the FULL print-agent contract): 'courier' → the 4x6
        // printer (dispatch/courier labels), anything else / no role → the
        // small-label printer. Role-less jobs from the self-serve workbench
        // keep working unchanged.
        const role = job.role === 'courier' ? 'courier' : 'barcode';
        const printerName = role === 'courier' ? store.get('courierPrinter', '') : store.get('printer', '');
        if (!printerName) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: role === 'courier' ? 'No 4x6 courier printer configured' : 'No label printer configured' })); return; }
        res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
        // encoding 'base64' = binary job (courier label bitmap): decode before it hits the printer
        const data = job.encoding === 'base64' && job.data ? Buffer.from(String(job.data), 'base64') : (job.data || job.zpl || job.tspl || '');
        const id = `local_${Date.now()}`;
        if (!data) { addRecentJob({ id, printer: printerName, printerRole: role, status: 'error', time: new Date(), error: 'No printable data' }); return; }
        addRecentJob({ id, printer: printerName, printerRole: role, status: 'printing', time: new Date() });
        printRaw(printerName, data)
          .then(() => addRecentJob({ id, printer: printerName, printerRole: role, status: 'done', time: new Date() }))
          .catch((err) => addRecentJob({ id, printer: printerName, printerRole: role, status: 'error', time: new Date(), error: err.message }));
      } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: err.message })); }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

// ── IPC for the printer-settings window ─────────────────────────────────────
ipcMain.handle('getState', async () => ({ printers: await getInstalledPrinters(), printer: store.get('printer', ''), courierPrinter: store.get('courierPrinter', ''), autoStart: store.get('autoStart', true), recentJobs: recentJobs.slice(0, 20), stationName: stationName(), machineName, idleLockMin: Math.round(idleLockMs() / 60000), merchantSlug: merchantSlug(), plan: autoPlan, gradient: weekGradient() }));
ipcMain.handle('refreshPrinters', async () => ({ printers: await getInstalledPrinters(), printer: store.get('printer', ''), courierPrinter: store.get('courierPrinter', '') }));
ipcMain.handle('testPrint', async (e, printerName) => {
  try { await printRaw(printerName, generateTestLabel()); addRecentJob({ id: `test_${Date.now()}`, printer: printerName, status: 'done', time: new Date() }); return true; }
  catch (err) { addRecentJob({ id: `test_${Date.now()}`, printer: printerName, status: 'error', time: new Date(), error: err.message }); return false; }
});
ipcMain.handle('setSetting', async (e, key, value) => {
  store.set(key, value);
  if (key === 'autoStart') app.setLoginItemSettings({ openAtLogin: value, name: 'reitrn Warehouse' });
  if (key === 'stationName' && tray) tray.setToolTip(`reitrn Warehouse · ${stationName()}`);
  if (key === 'idleLockMs') armIdle(); // apply the new timeout immediately
  if (key === 'merchantSlug') fetchPinConfigured(); // re-check the PIN gate for the new account
});

// PIN login from the lock screen. A 4–8 digit value is a typed PIN; anything else
// (a scanned ID-card barcode) is sent as a token. Validated server-side.
ipcMain.handle('getStationName', () => stationName());
// The bench inherits the lock-screen identity — PIN once at app level, then
// roam (founder, 2026-07-03). Null when locked/nobody signed in.
ipcMain.handle('getActiveUser', () => activeUser);
// The in-page lock overlay pulls this on mount, then listens for pushes.
ipcMain.handle('getGateState', () => gateStatePayload());
// The page's lock overlay is mounted and covering — the window may show now
// (the other half of the no-flash handshake).
ipcMain.handle('lockUiReady', () => {
  pageReady = true;
  pushGateState();
  if (mainWindow) evaluateGate(mainWindow.webContents.getURL());
});
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
      body: JSON.stringify({ merchantSlug: merchantSlug(), ...(isPin ? { pin: v } : { token: v }) }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.user) {
      activeUser = data.user;
      gatePassed = true;
      armIdle(); // start the inactivity countdown for this session
      if (tray) tray.setToolTip(`reitrn Warehouse · ${stationName()} · ${activeUser.name}`);
      // Tell the portal page who's at the bench (it inherits this identity)
      // and that the in-page lock may dismiss.
      if (mainWindow) mainWindow.webContents.send('staffChanged', activeUser);
      pushGateState();
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
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
  // The in-app Station settings panel shows the live print log.
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('jobsUpdate', recentJobs.slice(0, 20));
}
