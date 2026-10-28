/**
 * guest 注册表 IPC 薄壳：web-contents-created 捕获 browser partition 的
 * guest（判定照 browser-session isBrowserGuestSession——session 实例同一性，
 * 不读 webPreferences 形状，与 guest 弹窗拦截同口径）→ trackGuest；渲染层
 * webview dom-ready 经 browser:bindSession 上报会话绑定（spec R19——AI 仅
 * 操控绑定 tab）。electron 依赖集中于此，registry 核心保持纯逻辑可测。
 */
import { app, ipcMain, webContents, type WebContents } from "electron";
import type { GuestControl } from "../agent/browser-tools";
import { isBrowserGuestSession } from "./browser-session";
import { GuestRegistry, type GuestWebContentsLike } from "./guest-registry";

let registry: GuestRegistry | null = null;

/** Electron WebContents → registry 期望的 GuestWebContentsLike：
 *  did-navigate 原生签名 (event, url) 转形为 ({ url })（registry 回调读
 *  args[0].url），其余事件与能力直通 */
export function toGuestLike(contents: WebContents): GuestWebContentsLike {
  // WebContents.on 重载按字面量事件键收窄，generic 事件名须经
  // EventEmitter 通用签名转发（bind 保 this）
  const onAny = contents.on.bind(contents) as (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
  return {
    id: contents.id,
    getURL: () => contents.getURL(),
    isDestroyed: () => contents.isDestroyed(),
    on: (event, listener) => {
      if (event === "did-navigate") {
        onAny(event, (_event, url) => listener({ url }));
        return;
      }
      onAny(event, listener);
    },
  };
}

/** 装配（Application 启动调一次；幂等——重复调用返回既有实例） */
export function installGuestRegistry(): GuestRegistry {
  if (registry) return registry;
  const created = new GuestRegistry();
  app.on("web-contents-created", (_event, contents) => {
    // guest webview 创建时 session 已定（partition 即刻生效）；非 browser partition 忽略
    if (!isBrowserGuestSession(contents.session)) return;
    created.trackGuest(toGuestLike(contents));
  });
  ipcMain.on(
    "browser:bindSession",
    (_event, webContentsId: unknown, sessionId: unknown) => {
      if (typeof webContentsId === "number" && typeof sessionId === "number") {
        created.bindSession(sessionId, webContentsId);
      }
    },
  );
  registry = created;
  return created;
}

/** browser_use 工具组的 GuestControl 解析器（tool-registry 消费）：registry
 *  查会话绑定，fromId 取活实例；destroyed 双查（forSession 内查注册表，
 *  fromId 后再查实例——fromId 对已销毁 id 可能返回残壳）；
 *  null（图执行无会话，2026-10-28 去会话化）无绑定可言直 null */
export function guestControlResolver(
  sessionId: number | null,
): GuestControl | null {
  const reg = registry;
  if (!reg || sessionId === null) return null;
  const entry = reg.forSession(sessionId);
  if (!entry) return null;
  const contents = webContents.fromId(entry.id);
  if (!contents || contents.isDestroyed()) return null;
  return {
    executeJavaScript: (code: string) => contents.executeJavaScript(code),
    loadURL: (url: string) => contents.loadURL(url),
  };
}
