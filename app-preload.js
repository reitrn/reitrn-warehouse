const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the warehouse UI (the portal) running inside the app: lets the
// in-page sidebar trigger the native PIN lock / switch-user.
contextBridge.exposeInMainWorld('reitrnApp', {
  lock: () => ipcRenderer.invoke('lockStation'),
});
