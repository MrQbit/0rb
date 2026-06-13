// Minimal bridge for the first-run setup wizard (setup.html) only.
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('orb2Setup', {
  save: cfg => ipcRenderer.invoke('setup:save', cfg),
  get: () => ipcRenderer.invoke('setup:get'),
  onStatus: cb => ipcRenderer.on('setup:status', (_e, msg) => cb(msg)),
})
