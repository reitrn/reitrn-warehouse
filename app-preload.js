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
});
