// orb2 desktop shell — preload (the ONLY bridge between the web console and
// the host). Exposes a small, fixed `window.orb2` capability API. Privileged
// widgets feature-detect these (e.g. `if (window.orb2?.terminal)`); in a plain
// browser `window.orb2` is undefined, so those widgets hide/degrade and every
// other (web-only) widget works identically. Adding a new visual/data widget
// never touches this file.

const { contextBridge, ipcRenderer } = require('electron')

const termListeners = new Map() // id → { onData, onExit }
ipcRenderer.on('term:data', (_e, { id, data }) => termListeners.get(id)?.onData?.(data))
ipcRenderer.on('term:exit', (_e, { id }) => termListeners.get(id)?.onExit?.())

contextBridge.exposeInMainWorld('orb2', {
  // marker so the web UI can detect the desktop shell
  isDesktop: true,
  system: () => ipcRenderer.invoke('system:info'),

  // Terminal widget backend (real shell via pty).
  terminal: {
    async spawn(opts = {}) {
      const { id } = await ipcRenderer.invoke('term:spawn', opts)
      return {
        id,
        write: data => ipcRenderer.invoke('term:write', { id, data }),
        resize: (cols, rows) => ipcRenderer.invoke('term:resize', { id, cols, rows }),
        kill: () => { termListeners.delete(id); return ipcRenderer.invoke('term:kill', { id }) },
        onData: cb => { const l = termListeners.get(id) || {}; l.onData = cb; termListeners.set(id, l) },
        onExit: cb => { const l = termListeners.get(id) || {}; l.onExit = cb; termListeners.set(id, l) },
      }
    },
  },

  // Docker widget backend (CLI shell-out → { ok, stdout, stderr }).
  docker: args => ipcRenderer.invoke('docker:run', args),

  // Restricted filesystem (under ORB2_FS_ROOTS, default $HOME).
  files: {
    read: p => ipcRenderer.invoke('fs:read', p),
    list: p => ipcRenderer.invoke('fs:list', p),
    write: (path, data) => ipcRenderer.invoke('fs:write', { path, data }),
  },

  // Open a URL in the user's real browser.
  openExternal: url => ipcRenderer.invoke('app:openExternal', url),
})
