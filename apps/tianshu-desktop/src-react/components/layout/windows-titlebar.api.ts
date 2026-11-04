import { invoke } from "@/lib/ipc";
import type { WindowControlState } from "../../../electron/commons/window.service";

/** 自绘标题栏 IPC：主进程按调用方 webContents 定位目标窗口 */
const WindowApi = {
  getState: () => invoke<WindowControlState>("window:getState"),
  minimize: () => invoke<void>("window:minimize"),
  toggleMaximize: () => invoke<WindowControlState>("window:toggleMaximize"),
  close: () => invoke<void>("window:close"),
};

export default WindowApi;
export type { WindowControlState };
