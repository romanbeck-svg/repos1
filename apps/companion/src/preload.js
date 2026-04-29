import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('makoCompanion', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  startBackend: () => ipcRenderer.invoke('backend:start'),
  stopBackend: () => ipcRenderer.invoke('backend:stop'),
  restartBackend: () => ipcRenderer.invoke('backend:restart'),
  testKimi: () => ipcRenderer.invoke('kimi:test'),
  checkOllama: () => ipcRenderer.invoke('ollama:check'),
  pullModel: () => ipcRenderer.invoke('ollama:pull'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  openHealth: () => ipcRenderer.invoke('health:open'),
  copyDiagnostics: () => ipcRenderer.invoke('diagnostics:copy'),
  toggleLaunchAtLogin: (enabled) => ipcRenderer.invoke('login:toggle', enabled),
  onStatusUpdate: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status:update', listener);
    return () => ipcRenderer.off('status:update', listener);
  }
});
