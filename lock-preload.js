const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lock', {
  // Returns { ok: true } on success (main then reveals the warehouse) or { error }.
  submit: (value) => ipcRenderer.invoke('pinLogin', value),
  station: () => ipcRenderer.invoke('getStationName'),
});
