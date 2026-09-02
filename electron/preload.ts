import { ipcRenderer, contextBridge } from "electron";

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld("ipcRenderer", {
  on(channel: string, listener: (...args: unknown[]) => void) {
    const wrappedListener = (
      event: Electron.IpcRendererEvent,
      ...args: unknown[]
    ) => listener(event, ...args);
    ipcRenderer.on(channel, wrappedListener);
    // 返回取消监听的函数
    return () => ipcRenderer.off(channel, wrappedListener);
  },
  once(...args: Parameters<typeof ipcRenderer.once>) {
    const [channel, ...omit] = args;
    return ipcRenderer.once(channel, ...omit);
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args;
    return ipcRenderer.off(channel, ...omit);
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args;
    return ipcRenderer.send(channel, ...omit);
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args;
    return ipcRenderer.invoke(channel, ...omit);
  },
  removeAllListeners(channel: string) {
    return ipcRenderer.removeAllListeners(channel);
  },

  // You can expose other APTs you need here.
  // ...
});

// 暴露当前操作系统平台，供渲染进程做平台分支（如 macOS 红绿灯布局）
contextBridge.exposeInMainWorld("platform", process.platform);

// const api = {};

// // Use `contextBridge` APIs to expose Electron APIs to
// // renderer only if context isolation is enabled, otherwise
// // just add to the DOM global.
// if (process.contextIsolated) {
//   try {
//     contextBridge.exposeInMainWorld("electron", electronAPI);
//     contextBridge.exposeInMainWorld("api", api);
//   } catch (error) {
//     console.error(error);
//   }
// } else {
//   // @ts-ignore (define in dts)
//   window.electron = electronAPI;
//   // @ts-ignore (define in dts)
//   window.api = api;
// }
