const { contextBridge, ipcRenderer } = require('electron');
// The sandbox gets only two fixed channels, never ipcRenderer or a Node capability.
contextBridge.exposeInMainWorld('dragons', Object.freeze({
  request: (message) => ipcRenderer.invoke('dragons:request', message),
  events: () => ipcRenderer.invoke('dragons:events'),
}));
