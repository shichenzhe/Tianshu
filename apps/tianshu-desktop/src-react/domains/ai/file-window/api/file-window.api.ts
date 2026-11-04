/**
 * 文件窗口 IPC 封装（通道常量与主进程 file-window.service 对齐）。
 * onXxx 返回退订函数（preload on 的既定形态）。
 */
import { invoke } from "@/lib/ipc";
import type { FileWindowResource } from "../model/resource";

export interface DeliverPayload {
  resources: FileWindowResource[];
}

const FileWindowApi = {
  open: (resources: FileWindowResource[], targetWindowId?: string) =>
    invoke<{ windowId: string }>("fileWindow:open", {
      resources,
      targetWindowId,
    }),
  markCloseReady: (windowId: string) =>
    invoke<null>("fileWindow:close-ready", { windowId }),
  confirmClose: (windowId: string) =>
    invoke<null>("fileWindow:confirmClose", { windowId }),
  cancelClose: (windowId: string) =>
    invoke<null>("fileWindow:cancelClose", { windowId }),
  saveSessionState: (windowId: string, snapshot: unknown) =>
    invoke<null>("fileWindow:setSessionState", { windowId, snapshot }),
  restoreSessionState: (windowId: string) =>
    invoke<unknown>("fileWindow:getSessionState", { windowId }),
  grantFilePath: (sessionId: number, absPath: string) =>
    invoke<null>("fileWindow:grantFilePath", { sessionId, absPath }),
  /** 会话路径授权回收（关 library tab 时尽力而为，spec 允许懒清理） */
  revokeSession: (sessionId: number) =>
    invoke<null>("fileWindow:revokeSession", { sessionId }),
  /** 「打开主页」（T18，spec §12 项 5）：唤起主窗（show+focus） */
  focusMain: () => invoke<null>("fileWindow:focusMain"),
  onDeliver: (cb: (payload: DeliverPayload) => void) => {
    const off = window.ipcRenderer?.on("fileWindow:deliver", (_e, payload) =>
      cb(payload as DeliverPayload),
    );
    return () => off?.();
  },
  onCloseRequest: (cb: () => void) => {
    const off = window.ipcRenderer?.on("fileWindow:close-request", () => cb());
    return () => off?.();
  },
};

export default FileWindowApi;
