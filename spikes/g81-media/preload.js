const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  send: (ch, data) => ipcRenderer.send(ch, data),
  on: (ch, cb) => ipcRenderer.on(ch, (_e, data) => cb(data)),
});
