const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the warehouse UI (the portal) running inside the app: lets the
// in-page sidebar trigger the native PIN lock / switch-user.
contextBridge.exposeInMainWorld('reitrnApp', {
  lock: () => ipcRenderer.invoke('lockStation'),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  maximize: () => ipcRenderer.invoke('win:maximize'),
  close: () => ipcRenderer.invoke('win:close'),
  // Station identity (configured name, falling back to the machine hostname) —
  // the console binds inspections to a station from this automatically; the
  // in-page station picker is only a browser fallback.
  stationName: () => ipcRenderer.invoke('getStationName'),
  // Who PIN'd in at the lock screen — the bench inherits this identity
  // (PIN once at app level, then roam; founder 2026-07-03). Null when locked.
  activeUser: () => ipcRenderer.invoke('getActiveUser'),
  onStaffChanged: (cb) => ipcRenderer.on('staffChanged', (_e, user) => cb(user)),
  // The IN-PAGE lock (one window, no separate lock screen): the page renders
  // the full-screen lock from this state and validates PINs via pinLogin.
  gateState: () => ipcRenderer.invoke('getGateState'),
  onGateState: (cb) => ipcRenderer.on('gateState', (_e, state) => cb(state)),
  pinLogin: (value) => ipcRenderer.invoke('pinLogin', value),
  // No-flash handshake: the page calls this once its lock overlay is mounted
  // and covering — only then does the shell make the window visible.
  lockUiReady: () => ipcRenderer.invoke('lockUiReady'),
  // Station settings INSIDE the app (founder, 2026-07-03: one window, no
  // separate panel) — same IPC the tray settings window uses.
  getState: () => ipcRenderer.invoke('getState'),
  setSetting: (key, value) => ipcRenderer.invoke('setSetting', key, value),
  refreshPrinters: () => ipcRenderer.invoke('refreshPrinters'),
  testPrint: (printer) => ipcRenderer.invoke('testPrint', printer),
});
