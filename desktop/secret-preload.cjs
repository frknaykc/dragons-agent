const { contextBridge, ipcRenderer } = require('electron');
// This view cannot access the ordinary chat/runtime channels.
contextBridge.exposeInMainWorld('dragonsSecret', Object.freeze({
  submit: (value) => ipcRenderer.invoke('dragons:secret-submit', value),
}));
