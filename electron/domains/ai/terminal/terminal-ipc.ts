/**
 * 终端域 IPC 薄壳：node-pty 仅在此 lazy require（Electron ABI，纯 Node
 * 不可载，见 terminal-core 头注释）。create 走 handleUser 鉴权（token →
 * userId，虽无用户语义，沿用通道惯例防未登录直达）；write/resize/kill
 * 为 send 白名单通道——terminal id 只有 create 成功者持有，风险面可控
 * （spec 用户裁定：终端不挂额外权限门）。
 */
import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import os from "node:os";
import { handleUser } from "../../../commons/ipc-user";
import { TerminalManager, type PtyFactory } from "./terminal-core";

/** event.sender 安全推送（销毁后 send 会抛，静默丢弃） */
function senderOf(event: IpcMainInvokeEvent) {
  return (channel: string, data: string) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, data);
  };
}

export function registerTerminalIpc(): void {
  const factory: PtyFactory = (file, args, opts) => {
    // rolldown 外部化 + CJS 互操作：具名导入经 require 取（同 better-sqlite3 处理口径）
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pty 原生 ABI 须运行时懒加载
    const pty = require("node-pty") as {
      spawn: (
        file: string,
        args: string[],
        opts: { cwd: string; name: string },
      ) => {
        write: (data: string) => void;
        resize: (cols: number, rows: number) => void;
        kill: () => void;
        onData: (cb: (data: string) => void) => void;
        onExit: (cb: (event: { exitCode: number }) => void) => void;
      };
    };
    const ptyProc = pty.spawn(file, args, opts);
    // IPty.onExit 回调实收 {exitCode, signal}——翻译为契约的 number
    return {
      write: (data) => ptyProc.write(data),
      resize: (cols, rows) => ptyProc.resize(cols, rows),
      kill: () => ptyProc.kill(),
      onData: (cb) => ptyProc.onData(cb),
      onExit: (cb) => ptyProc.onExit((event) => cb(event.exitCode)),
    };
  };
  const manager = new TerminalManager(factory, () => {});

  handleUser("terminal:create", (event, _userId, cwd: string) => {
    // 渲染端 DetailPanel cwd 空串（无工作空间目录）落家目录
    const cwdSafe = typeof cwd === "string" && cwd ? cwd : os.homedir();
    return manager.create(senderOf(event), cwdSafe);
  });

  // 挂起重挂探活：pty 已退出（登记移除）返回 false，渲染端直接显示退出态
  handleUser("terminal:probe", (_event, _userId, id: string) =>
    typeof id === "string" ? manager.has(id) : false,
  );

  // 重挂回放：一次性拉取 cap 内累计输出；id 不存在抛错 → 渲染端转退出态
  handleUser("terminal:replay", (_event, _userId, id: string) =>
    manager.replay(id),
  );

  ipcMain.on("terminal:write", (_event, id: unknown, data: unknown) => {
    if (typeof id === "string" && typeof data === "string") {
      manager.write(id, data);
    }
  });
  ipcMain.on(
    "terminal:resize",
    (_event, id: unknown, cols: unknown, rows: unknown) => {
      if (
        typeof id === "string" &&
        typeof cols === "number" &&
        typeof rows === "number"
      ) {
        manager.resize(id, Math.floor(cols), Math.floor(rows));
      }
    },
  );
  ipcMain.on("terminal:kill", (_event, id: unknown) => {
    if (typeof id === "string") manager.kill(id);
  });

  // 应用退出全清（防 shell 孤儿进程）
  app.on("will-quit", () => manager.killAll());
}
