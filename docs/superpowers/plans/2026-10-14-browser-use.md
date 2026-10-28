# AI 页面操控（browser_use 工具组）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 四工具 browser_snapshot/click/type/navigate 操控会话绑定的右栏浏览器 tab（guest WebContents），形成打开→快照→操作→再快照循环。

**Architecture:** 主进程 BrowserGuestRegistry 捕获 persist:browser-webview guest（web-contents-created 注入工厂）；browser-tools 工厂注入 GuestLike（executeJavaScript 注入采集/操作脚本，JSON.stringify 转义）；前端 webview dom-ready 上报 getWebContentsId 绑定会话。

**Tech Stack:** Electron WebContents.executeJavaScript/loadURL、send 通道 browser:bindSession、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-14-browser-use-design.md`（Rulings R19-R23，用户持久授权免确认）

## Global Constraints

- AI 仅操控会话绑定 guest（R19）；无绑定时统一 fail「先用 open_browser 打开页面」
- 注入参数 JSON.stringify 转义；脚本仅元素定位/赋值/事件派发（R23）；快照 ≤200 元素/元素文本 ≤80/body 摘要 ≤4KB（R20）
- browser_click/browser_type kind: "write"（走既有审批+工作空间记忆豁免）；snapshot/navigate kind: "read"（R21）
- browser_navigate 的 url 过 assertUrl 语义校验（协议+SSRF，复用 web-tools 的 isSsrfHost；可直接 import assertUrl 若已导出，否则复制其 10 行逻辑并注明来源）
- 采集标记 `data-ts-ai` 属性；失效（NOT_FOUND）提示重新 snapshot
- guest-registry/browser-tools electron 依赖注入可测（照 terminal-core/ssrf 先例）；i18n 双语；Prettier 仓库口径；每任务 TDD；conventional commits

---

### Task 1: BrowserGuestRegistry（TDD）

**Files:**
- Create: `electron/domains/ai/browser/guest-registry.ts`
- Test: `tests/browser/guest-registry.test.ts`

**Interfaces:**
- Produces:

```ts
export interface GuestWebContentsLike {
  id: number;
  getURL(): string;
  isDestroyed(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
}
export interface GuestEntry {
  id: number;
  url: string;
  sessionId: number | null; // 绑定的会话（null=未绑定，如用户手动 tab 早期）
}
/** 注册表核心（纯逻辑，事件源经参数注入可测） */
export class GuestRegistry {
  /** guest 创建（web-contents-created 侧调用；partition 判定在薄壳） */
  trackGuest(contents: GuestWebContentsLike): void;
  /** 渲染层 dom-ready 上报：把 guest 绑定到会话（重绑覆盖） */
  bindSession(sessionId: number, webContentsId: number): boolean;
  /** 会话当前绑定 guest（destroyed 自动解绑清空）；无 null */
  forSession(sessionId: number): GuestEntry | null;
  /** 诊断/测试 */
  list(): GuestEntry[];
}
```

- [ ] **Step 1: 写失败测试**

`tests/browser/guest-registry.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  GuestRegistry,
  type GuestWebContentsLike,
} from "../../electron/domains/ai/browser/guest-registry";

/** 可编程 fake guest：事件可手动触发 */
function fakeGuest(id: number, url = "https://example.com/") {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const guest: GuestWebContentsLike & {
    emit(event: string, ...args: unknown[]): void;
    alive: boolean;
  } = {
    id,
    alive: true,
    getURL: () => url,
    isDestroyed: () => !guest.alive,
    on: (event, listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
    },
    emit: (event, ...args) => {
      for (const l of listeners.get(event) ?? []) l(...args);
    },
  };
  return guest;
}

describe("GuestRegistry", () => {
  it("trackGuest 登记；did-navigate 更新 url；destroyed 移除并解绑会话", () => {
    const registry = new GuestRegistry();
    const guest = fakeGuest(11);
    registry.trackGuest(guest);
    expect(registry.list()).toEqual([
      { id: 11, url: "https://example.com/", sessionId: null },
    ]);
    guest.emit("did-navigate", { url: "https://example.com/next" });
    expect(registry.list()[0].url).toBe("https://example.com/next");
    registry.bindSession(7, 11);
    expect(registry.forSession(7)?.id).toBe(11);
    guest.alive = false;
    guest.emit("destroyed");
    expect(registry.list()).toHaveLength(0);
    expect(registry.forSession(7)).toBeNull();
  });

  it("bindSession：未知 id false；重绑覆盖；他话独占", () => {
    const registry = new GuestRegistry();
    registry.trackGuest(fakeGuest(21));
    registry.trackGuest(fakeGuest(22));
    expect(registry.bindSession(1, 999)).toBe(false);
    expect(registry.bindSession(1, 21)).toBe(true);
    expect(registry.bindSession(2, 21)).toBe(true); // 21 改绑 2
    expect(registry.forSession(1)).toBeNull();
    expect(registry.forSession(2)?.id).toBe(21);
    expect(registry.bindSession(1, 22)).toBe(true); // 1 绑 22
    expect(registry.list().find((g) => g.id === 21)?.sessionId).toBe(2);
  });

  it("forSession 返回快照（后续 trackGuest 不污染已取引用语义）", () => {
    const registry = new GuestRegistry();
    registry.trackGuest(fakeGuest(31));
    registry.bindSession(3, 31);
    const entry = registry.forSession(3);
    registry.trackGuest(fakeGuest(32));
    expect(entry?.id).toBe(31);
    expect(registry.forSession(3)?.id).toBe(31);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run tests/browser/guest-registry.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
/**
 * 内置浏览器 guest 注册表（browser_use 工具组地基）：捕获
 * persist:browser-webview 的 guest WebContents（登记/URL 跟踪/销毁清理），
 * 并维护「会话 → 操控目标 guest」绑定（渲染层 dom-ready 上报，spec R19——
 * AI 仅操控绑定 tab）。纯逻辑：web-contents-created 事件源由薄壳
 * （Task 3 Application 装配）经 trackGuest 注入，vitest 零 electron。
 */
import type { GuestWebContentsLike } from "./guest-registry";

interface RegistryEntry {
  contents: GuestWebContentsLike;
  url: string;
  sessionId: number | null;
}

export interface GuestEntry {
  id: number;
  url: string;
  sessionId: number | null;
}

export class GuestRegistry {
  private guests = new Map<number, RegistryEntry>();
  /** sessionId → guestId（bindSession 写；guest destroyed 清） */
  private sessionBinding = new Map<number, number>();

  trackGuest(contents: GuestWebContentsLike): void {
    const entry: RegistryEntry = {
      contents,
      url: contents.getURL(),
      sessionId: null,
    };
    this.guests.set(contents.id, entry);
    contents.on("did-navigate", (...args: unknown[]) => {
      const url = (args[0] as { url?: string } | undefined)?.url;
      if (typeof url === "string") entry.url = url;
    });
    contents.on("destroyed", () => {
      this.guests.delete(contents.id);
      for (const [sid, gid] of this.sessionBinding) {
        if (gid === contents.id) this.sessionBinding.delete(sid);
      }
    });
  }

  bindSession(sessionId: number, webContentsId: number): boolean {
    if (!this.guests.has(webContentsId)) return false;
    // 一个 guest 同一时刻只归属一个会话（改绑先清旧）
    for (const [sid, gid] of this.sessionBinding) {
      if (gid === webContentsId && sid !== sessionId) {
        this.sessionBinding.delete(sid);
      }
    }
    this.sessionBinding.set(sessionId, webContentsId);
    const entry = this.guests.get(webContentsId);
    if (entry) entry.sessionId = sessionId;
    return true;
  }

  forSession(sessionId: number): GuestEntry | null {
    const gid = this.sessionBinding.get(sessionId);
    if (gid === undefined) return null;
    const entry = this.guests.get(gid);
    if (!entry || entry.contents.isDestroyed()) {
      this.sessionBinding.delete(sessionId);
      this.guests.delete(gid);
      return null;
    }
    return { id: gid, url: entry.url, sessionId };
  }

  list(): GuestEntry[] {
    return [...this.guests.entries()].map(([id, e]) => ({
      id,
      url: e.url,
      sessionId: e.sessionId,
    }));
  }
}
```

（GuestWebContentsLike interface 定义于本文件顶部 export——测试 import 它。）

- [ ] **Step 4: 跑确认通过 → Commit**

```bash
npx vitest run tests/browser/guest-registry.test.ts
git add electron/domains/ai/browser/guest-registry.ts tests/browser/guest-registry.test.ts
git commit -m "feat(browser-use): guest 注册表——登记/URL 跟踪/会话绑定"
```

---

### Task 2: browser-tools 工厂（TDD）

**Files:**
- Create: `electron/domains/ai/agent/browser-tools.ts`
- Test: `tests/ai/browser-tools.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition`/`ToolContext`/`fail`（file-tools）、`isSsrfHost`（security/ssrf-hosts）、`GuestRegistry`（Task 1）
- Produces:

```ts
export interface GuestControl {
  /** 执行页面脚本（guest executeJavaScript 包装；返回值 JSON/字符串） */
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
}
export type GuestControlResolver = (sessionId: number) => GuestControl | null;
export function makeBrowserTools(resolve: GuestControlResolver): ToolDefinition[];
// [browser_snapshot(read), browser_navigate(read), browser_click(write), browser_type(write)]
// click/type 参数 { idx: number }（快照序号）；type 另有 { text }
```

- [ ] **Step 1: 写失败测试**

`tests/ai/browser-tools.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { makeBrowserTools } from "../../electron/domains/ai/agent/browser-tools";
import type { ToolContext } from "../../electron/domains/ai/agent/file-tools";

function fakeControl() {
  const exec = vi.fn(async (code: string) => {
    if (code.includes("SNAPSHOT_MARKER")) {
      return JSON.stringify({
        title: "示例页",
        url: "https://example.com/",
        items: [{ idx: 3, tag: "a", text: "关于我们", href: "/about" }],
        body: "页面正文摘要",
      });
    }
    return "OK";
  });
  const loadURL = vi.fn(async () => {});
  return { exec, loadURL, control: { executeJavaScript: exec, loadURL } };
}

const ctx = { workspacePath: "/tmp", sessionId: 7 } as ToolContext;

describe("browser_snapshot", () => {
  it("无绑定返回引导文案；有绑定返回快照结构", async () => {
    const tools = makeBrowserTools(() => null);
    const out = await tools[0].execute(ctx, {});
    expect(out).toMatch(/open_browser/);
    const { exec, control } = fakeControl();
    const tools2 = makeBrowserTools(() => control);
    const out2 = await tools2[0].execute(ctx, {});
    expect(out2).toContain("示例页");
    expect(out2).toContain("关于我们");
    expect(out2).toContain("idx: 3");
    expect(exec.mock.calls[0][0]).toContain("SNAPSHOT_MARKER");
  });

  it("脚本失败回 fail 不抛", async () => {
    const tools = makeBrowserTools(() => ({
      executeJavaScript: async () => {
        throw new Error("page gone");
      },
      loadURL: async () => {},
    }));
    const out = await tools[0].execute(ctx, {});
    expect(out).toMatch(/失败|错误/);
  });
});

describe("browser_click / browser_type", () => {
  it("write 工具按序号定位；脚本经 JSON.stringify 注入序号", async () => {
    const { exec, control } = fakeControl();
    const tools = makeBrowserTools(() => control);
    const click = tools.find((t) => t.name === "browser_click")!;
    expect(click.kind).toBe("write");
    const out = await click.execute(ctx, { idx: 3 });
    expect(out).toBe("OK");
    expect(exec.mock.calls[0][0]).toContain('data-ts-ai="3"');
  });

  it("type 携带 text 注入；NOT_FOUND 提示重新快照", async () => {
    const { exec, control } = fakeControl();
    exec.mockResolvedValue("NOT_FOUND");
    const tools = makeBrowserTools(() => control);
    const type = tools.find((t) => t.name === "browser_type")!;
    expect(type.kind).toBe("write");
    const out = await type.execute(ctx, { idx: 5, text: 'a"b\\c' });
    expect(out).toMatch(/重新|snapshot|快照/);
    expect(exec.mock.calls[0][0]).toContain('"5"');
    expect(exec.mock.calls[0][0]).toContain(JSON.stringify('a"b\\c'));
  });
});

describe("browser_navigate", () => {
  it("校验协议与 SSRF；合法 url 走 loadURL", async () => {
    const { loadURL, control } = fakeControl();
    const tools = makeBrowserTools(() => control);
    const nav = tools.find((t) => t.name === "browser_navigate")!;
    expect(nav.kind).toBe("read");
    const bad = await nav.execute(ctx, { url: "http://169.254.169.254/x" });
    expect(bad).toMatch(/内网|metadata/i);
    expect(loadURL).not.toHaveBeenCalled();
    const bad2 = await nav.execute(ctx, { url: "file:///etc" });
    expect(bad2).toMatch(/http/i);
    const ok = await nav.execute(ctx, { url: "https://example.com/" });
    expect(ok).toMatch(/https:\/\/example.com\//);
    expect(loadURL).toHaveBeenCalledWith("https://example.com/");
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run tests/ai/browser-tools.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
/**
 * browser_use 工具组（spec R19-R23）：操控会话绑定的右栏浏览器 tab。
 * 页面脚本注入铁律：所有动态参数（序号/文本）JSON.stringify 转义后嵌
 * 模板；脚本仅元素定位/赋值/事件派发。快照文本化（≤200 元素/80 字符
 * 文本/4KB 摘要，R20）；click/type 为 write（R21 走审批链）。
 */
import { z } from "zod";
import { isSsrfHost } from "../../security/ssrf-hosts";
import type { ToolContext, ToolDefinition } from "./file-tools";
import { fail } from "./file-tools";

export interface GuestControl {
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
}
export type GuestControlResolver = (sessionId: number) => GuestControl | null;

const SNAPSHOT_ITEMS_LIMIT = 200;
const SNAPSHOT_BODY_LIMIT = 4096;

/** 页面内采集脚本（IIFE 字符串；SNAPSHOT_MARKER 供测试识别） */
const SNAPSHOT_SCRIPT = `(() => { /* SNAPSHOT_MARKER */
  const sel = 'a, button, input, select, textarea, [onclick], [role="button"], [role="link"]';
  const els = Array.from(document.querySelectorAll(sel)).slice(0, ${SNAPSHOT_ITEMS_LIMIT});
  els.forEach((el, i) => el.setAttribute("data-ts-ai", String(i)));
  const items = els.map((el, i) => ({
    idx: i,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    text: String(el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80),
    href: el.tagName === "A" ? String(el.getAttribute("href") || "").slice(0, 120) : "",
  }));
  return JSON.stringify({
    title: document.title,
    url: location.href,
    items,
    body: String(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, ${SNAPSHOT_BODY_LIMIT}),
  });
})()`;

function clickScript(idx: number): string {
  return `((sel) => {
  const el = document.querySelector(sel);
  if (!el) return "NOT_FOUND";
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  el.dispatchEvent(new MouseEvent("mousedown", o));
  el.dispatchEvent(new MouseEvent("mouseup", o));
  el.dispatchEvent(new MouseEvent("click", o));
  return "OK";
})('[data-ts-ai="' + ${JSON.stringify(String(idx))} + '"]')`;
}

function typeScript(idx: number, text: string): string {
  return `((sel, text) => {
  const el = document.querySelector(sel);
  if (!el) return "NOT_FOUND";
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value");
  if (setter && setter.set) setter.set.call(el, text); else el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "OK";
})('[data-ts-ai="' + ${JSON.stringify(String(idx))} + '"]', ${JSON.stringify(text)})`;
}

/** url 校验（与 web-tools assertUrl 同语义；未导出故本地同构实现） */
function assertUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "无效 URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "仅支持 http/https";
  }
  if (isSsrfHost(parsed.hostname)) {
    return "禁止访问云 metadata 内网地址";
  }
  return null;
}

const NO_TAB = "当前会话没有可操控的浏览器页——先调用 open_browser 打开页面";

export function makeBrowserTools(resolve: GuestControlResolver): ToolDefinition[] {
  const snapshot: ToolDefinition<Record<string, never>> = {
    name: "browser_snapshot",
    description:
      "读取当前会话浏览器页的结构快照：可交互元素列表（序号/标签/文本）与正文摘要。点击/输入用快照里的序号定位。",
    parameters: z.object({}),
    kind: "read",
    execute: async (ctx) => {
      const control = resolve(ctx.sessionId);
      if (!control) return fail(NO_TAB);
      try {
        const raw = await control.executeJavaScript(SNAPSHOT_SCRIPT);
        if (typeof raw !== "string") return fail("页面快照返回异常");
        const parsed = JSON.parse(raw) as {
          title: string;
          url: string;
          items: Array<Record<string, unknown>>;
          body: string;
        };
        const lines = parsed.items
          .map((i) => `idx: ${i.idx} [${i.tag}${i.type ? ":" + i.type : ""}] ${i.text}${i.href ? ` → ${i.href}` : ""}`)
          .join("\n");
        return `标题: ${parsed.title}\nURL: ${parsed.url}\n\n[可交互元素]\n${lines || "（无）"}\n\n[正文摘要]\n${parsed.body}`;
      } catch (e) {
        return fail(`页面快照失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const navigate: ToolDefinition<{ url: string }> = {
    name: "browser_navigate",
    description: "当前会话浏览器页导航到新地址（http/https）。",
    parameters: z.object({ url: z.string().describe("目标地址") }),
    kind: "read",
    execute: async (ctx, { url }) => {
      const bad = assertUrl(url);
      if (bad) return fail(bad);
      const control = resolve(ctx.sessionId);
      if (!control) return fail(NO_TAB);
      try {
        await control.loadURL(url);
        return `已导航到 ${url}，可再调用 browser_snapshot 读取新页面`;
      } catch (e) {
        return fail(`导航失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const click: ToolDefinition<{ idx: number }> = {
    name: "browser_click",
    description:
      "点击当前会话浏览器页里快照序号对应的元素（先用 browser_snapshot 取序号）。页面刷新后序号失效需重新快照。",
    parameters: z.object({ idx: z.number().int().describe("快照里的元素序号") }),
    kind: "write",
    execute: async (ctx, { idx }) => {
      const control = resolve(ctx.sessionId);
      if (!control) return fail(NO_TAB);
      try {
        const out = await control.executeJavaScript(clickScript(idx));
        if (out === "NOT_FOUND") return fail("元素不存在（页面可能已变化）——请重新 browser_snapshot");
        return `已点击序号 ${idx}`;
      } catch (e) {
        return fail(`点击失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const type: ToolDefinition<{ idx: number; text: string }> = {
    name: "browser_type",
    description: "在当前会话浏览器页里快照序号对应的输入框填入文本（触发 input/change）。",
    parameters: z.object({
      idx: z.number().int().describe("快照里的输入框序号"),
      text: z.string().describe("要输入的文本"),
    }),
    kind: "write",
    execute: async (ctx, { idx, text }) => {
      const control = resolve(ctx.sessionId);
      if (!control) return fail(NO_TAB);
      try {
        const out = await control.executeJavaScript(typeScript(idx, text));
        if (out === "NOT_FOUND") return fail("元素不存在（页面可能已变化）——请重新 browser_snapshot");
        return `已在序号 ${idx} 输入文本`;
      } catch (e) {
        return fail(`输入失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  return [snapshot, navigate, click, type];
}
```

- [ ] **Step 4: 跑确认通过 → Commit**

```bash
npx vitest run tests/ai/browser-tools.test.ts && npm run typecheck
git add electron/domains/ai/agent/browser-tools.ts tests/ai/browser-tools.test.ts
git commit -m "feat(browser-use): snapshot/click/type/navigate 工具工厂——注入转义与序号定位"
```

---

### Task 3: 装配（registry 单例 + web-contents-created + bindSession 通道 + 注册）

**Files:**
- Create: `electron/domains/ai/browser/guest-registry-ipc.ts`（薄壳：app/webContents 事件接线 + ipcMain.on）
- Modify: `electron/Application.ts`（browser 域装配旁调用 installGuestRegistry()）
- Modify: `electron/domains/ai/agent/tool-registry.ts`（初始集 + makeBrowserTools）
- Modify: `electron/commons/ipc-channels.ts`（SEND 白名单 browser:bindSession）
- Test: `tests/commons/ipc-channels.test.ts`（追加断言）

**Interfaces:**
- Consumes: GuestRegistry（Task 1）、makeBrowserTools/GuestControl（Task 2）
- Produces: `installGuestRegistry(): GuestRegistry`（app.on("web-contents-created") 捕获 `persist:browser-webview` guest→trackGuest；`ipcMain.on("browser:bindSession", (_e, wcId, sid))`→bindSession）；tool-registry 初始集含 browser 工具组（resolver：`registry.forSession(sid)` → GuestControl（`webContents.fromId(id)` 的 executeJavaScript/loadURL 包装））

- [ ] **Step 1: 白名单测试追加（RED）**：`expect(IPC_SEND_ALLOWLIST).toContain("browser:bindSession");`

- [ ] **Step 2: 跑确认失败** → FAIL

- [ ] **Step 3: 实现**

`guest-registry-ipc.ts`：

```ts
/**
 * guest 注册表 IPC 薄壳：web-contents-created 捕获 browser partition 的
 * guest（判定照 browser-session isBrowserGuestSession 语义——读 partition
 * 字符串）；渲染层 dom-ready 上报绑定通道。electron 依赖集中于此，
 * registry 核心保持纯逻辑可测。
 */
import { app, ipcMain, webContents, type WebContents } from "electron";
import { BROWSER_WEBVIEW_PARTITION } from "./browser-session";
import { GuestRegistry } from "./guest-registry";

let registry: GuestRegistry | null = null;

export function installGuestRegistry(): GuestRegistry {
  if (registry) return registry;
  const created = new GuestRegistry();
  app.on("web-contents-created", (_event, contents: WebContents) => {
    // guest webview 创建时 partition 已定（Electron 语义）；非 browser partition 忽略
    const partition = (contents as unknown as { webPreferences?: { partition?: string } })
      .webPreferences?.partition;
    if (partition !== BROWSER_WEBVIEW_PARTITION) return;
    created.trackGuest(contents);
  });
  ipcMain.on("browser:bindSession", (_event, webContentsId: unknown, sessionId: unknown) => {
    if (typeof webContentsId === "number" && typeof sessionId === "number") {
      created.bindSession(sessionId, webContentsId);
    }
  });
  registry = created;
  return created;
}

/** browser_use 工具组的 GuestControl 解析器（tool-registry 消费） */
export function guestControlResolver(sid: number) {
  const reg = registry;
  const entry = reg?.forSession(sid);
  if (!reg || !entry) return null;
  const contents = webContents.fromId(entry.id);
  if (!contents || contents.isDestroyed()) return null;
  return {
    executeJavaScript: (code: string) => contents.executeJavaScript(code),
    loadURL: (url: string) => contents.loadURL(url),
  };
}
```

（webPreferences 读取口径若与实际 Electron 44 API 不符——实现时按 `contents.getWebPreferences()?.partition` 或 session.storagePath 判定调整，保持「仅 browser partition」语义，报告中注明实际采用口径。）

`Application.ts`：browser 域装配旁（installBrowserSessionGuard 附近）：

```ts
    // browser_use 工具组地基：guest 注册表 + 绑定通道
    installGuestRegistry();
```

`tool-registry.ts`：

```ts
import { makeBrowserTools } from "./browser-tools";
import { guestControlResolver } from "../browser/guest-registry-ipc";
const definitions: ToolDefinition[] = [
  ...FILE_TOOLS,
  makeRunCommandTool(),
  ...makeWebTools(),
  ...makeBrowserTools(guestControlResolver),
];
```

`ipc-channels.ts` SEND 白名单：

```ts
  // browser_use：渲染层 webview dom-ready 上报会话绑定（guest 注册表）
  "browser:bindSession",
```

- [ ] **Step 4: 验证 + Commit**

```bash
npx vitest run tests/commons/ipc-channels.test.ts tests/ai/browser-tools.test.ts tests/ai/mcp-integration.test.ts && npm run typecheck && npm run test
git add electron/domains/ai/browser/guest-registry-ipc.ts electron/Application.ts electron/domains/ai/agent/tool-registry.ts electron/commons/ipc-channels.ts tests/commons/ipc-channels.test.ts
git commit -m "feat(browser-use): 装配链路——guest 捕获/绑定通道/工具注册"
```

（mcp-integration.test.ts 若因注册序断言红，照 W3 先例把四个 browser 工具名按实际顺序补进断言。）

---

### Task 4: 前端绑定上报（dom-ready → bindSession）

**Files:**
- Modify: `src-react/domains/ai/browser/lib/webview-api.ts`（WebviewElement 加 getWebContentsId(): number）
- Modify: `src-react/domains/ai/chat/components/detail-panel/BrowserPanelTab.tsx`（dom-ready 上报）
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/chat.json`（工具卡片描述词条若 ToolCallCard 有按名映射——先 grep 确认，通用渲染则零改动）

**Interfaces:**
- Consumes: BrowserWebview 的 onSync 事件层（dom-ready DOM 事件在 BrowserWebview 内原生监听——新增经 onSync 之外的独立回调 prop `onDomReady?: () => void`，由 BrowserPanelTab 传入上报逻辑）

- [ ] **Step 1: webview-api 扩展**

```ts
export interface WebviewElement extends HTMLElement {
  // …既有方法…
  /** guest WebContents id（dom-ready 后有效；browser_use 绑定上报用） */
  getWebContentsId(): number;
}
```

- [ ] **Step 2: BrowserWebview 加 onDomReady prop；BrowserPanelTab 上报**

BrowserWebview props 加 `onDomReady?: () => void`；事件绑定区（did-navigate 旁）：

```ts
    node.addEventListener("dom-ready", () => onDomReadyRef.current?.());
```

（用 ref 存最新回调防重绑；cleanup removeEventListener 同步。）

BrowserPanelTab（有 sessionId 与 webviewRefs）：

```tsx
  // browser_use 绑定上报：dom-ready 后取 guest id 绑定会话（AI 操控目标）
  const handleDomReady = useCallback(() => {
    const node = webviewRefs.current.get(tab.id);
    const wcId = node ? webviewApi(node)?.getWebContentsId() : undefined;
    if (typeof wcId === "number" && Number.isFinite(wcId)) {
      send("browser:bindSession", wcId, sessionId);
    }
  }, [tab.id, sessionId]);
```

（`send` 自 @/lib/ipc；传给 `<BrowserWebview onDomReady={handleDomReady} .../>`。）

- [ ] **Step 3: 验证 + Commit**

```bash
npm run typecheck && npm run test
git add src-react/domains/ai/browser/lib/webview-api.ts src-react/domains/ai/browser/components/BrowserWebview.tsx src-react/domains/ai/chat/components/detail-panel/BrowserPanelTab.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(browser-use): dom-ready 会话绑定上报——AI 操控目标接线"
```

---

### Task 5: 全量验证与冒烟

- [ ] **Step 1:** `npm run lint && npm run typecheck && npm run test` 全绿（预存红仅 monitor 三文件 + worktrees 噪音）
- [ ] **Step 2:** GUI 冒烟（playwright 驱动 + mock provider，照前两轮法）：
  1. 会话让 AI open_browser 打开本地测试页（临时 http server 或 data: URL 转本地——用 `npx http-server` 起临时页含按钮/输入框）
  2. AI 调 browser_snapshot → 断言工具输出含页面元素序号（ToolCallCard 或 store 侧查）
  3. AI 调 browser_click 点按钮（write 审批弹层出现 → 批准）→ 页面状态变化（按钮点击计数由测试页暴露 window 计数，snapshot 再读）
  4. browser_type 输入 → snapshot 含输入值
  5. browser_navigate 到第二页 → snapshot 反映新页
  6. 无绑定会话调 snapshot → 引导文案
  7. 手动开右栏浏览器 tab（非 AI 打开）在另一会话 → AI 操控不串（forSession 隔离）
- [ ] **Step 3:** 杀进程/清理临时 server 与数据；零星修复 commit

---

## Self-Review 结论

- Spec 覆盖：§2→T1；§3→T2（四工具/转义/序号/截断/kind）；§4→T3+T4（bindSession 上报/重绑覆盖）；§5→T3（装配/单例/白名单）；R19-R23 全承载。✓
- 占位符：T3 partition 判定口径注明「按实际 API 调整」为对照性指令；测试页描述具体。✓
- 类型一致性：GuestWebContentsLike/GuestRegistry（T1）↔ 薄壳消费；GuestControl/GuestControlResolver（T2）↔ resolver 产出（T3）；onDomReady 链（T4）。✓
