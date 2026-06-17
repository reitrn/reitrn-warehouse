const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reitrn', {
  getState: () => ipcRenderer.invoke('getState'),
  refreshPrinters: () => ipcRenderer.invoke('refreshPrinters'),
  testPrint: (printer) => ipcRenderer.invoke('testPrint', printer),
  setSetting: (key, value) => ipcRenderer.invoke('setSetting', key, value),
  minimizeToTray: () => ipcRenderer.invoke('minimizeToTray'),
  onJobsUpdate: (callback) => ipcRenderer.on('jobsUpdate', (event, jobs) => callback(jobs)),
});
