import { ipcRenderer, contextBridge, webUtils } from "electron";
import {
  isEventAllowed,
  isInvokeAllowed,
  isSendAllowed,
} from "./commons/ipc-channels";

// --------- Expose some API to the Renderer process ---------
// 通道白名单（commons/ipc-channels.ts 单一事实源）：渲染层被 XSS 注入时，
// 也只能触达白名单内的业务通道；白名单外 invoke 抛错、send/监听拒绝并告警
contextBridge.exposeInMainWorld("ipcRenderer", {
  on(channel: string, listener: (...args: unknown[]) => void) {
    if (!isEventAllowed(channel)) {
      console.error(`[ipc] 拒绝非白名单事件监听: ${channel}`);
      return () => {};
    }
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
    if (!isEventAllowed(channel)) {
      console.error(`[ipc] 拒绝非白名单事件监听: ${channel}`);
      return;
    }
    return ipcRenderer.once(channel, ...omit);
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args;
    // off 仅移除监听无副作用，任意通道放行（含动态通道清理）
    return ipcRenderer.off(channel, ...omit);
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args;
    if (!isSendAllowed(channel)) {
      console.error(`[ipc] 拒绝非白名单消息: ${channel}`);
      return;
    }
    return ipcRenderer.send(channel, ...omit);
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args;
    if (!isInvokeAllowed(channel)) {
      console.error(`[ipc] 拒绝非白名单调用: ${channel}`);
      return Promise.reject(new Error(`IPC 通道未开放: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...omit);
  },
  removeAllListeners(channel: string) {
    // 清理类操作无副作用，任意通道放行
    return ipcRenderer.removeAllListeners(channel);
  },

  // You can expose other APTs you need here.
  // ...
});

// 暴露当前操作系统平台，供渲染进程做平台分支（如 macOS 红绿灯布局）
contextBridge.exposeInMainWorld("platform", process.platform);

// 拖拽文件取本地绝对路径：File.path 属性已在 Electron 32 移除，
// webUtils.getPathForFile 是官方替代且仅能在 preload 调用（见 SkillImportDialog）
contextBridge.exposeInMainWorld("filePath", {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
});

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
