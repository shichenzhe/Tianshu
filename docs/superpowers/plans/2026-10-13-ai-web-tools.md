# AI 网页阅读与面板联动（web_fetch / open_browser）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 新增 `web_fetch`（读网页回喂模型）与 `open_browser`（右栏 DetailPanel 自动开浏览器 tab 展示给用户）两个内置工具。

**Architecture:** 纯 Node 可测的 web-tools 工厂（fetch 注入，照 makeRunCommandTool 先例）；ToolContext/AgentStreamOptions 加 `emitPanel` 装配回调（agent 域零 electron 依赖）；主进程事件 `detailPanel:openBrowser` → 前端 hook 复用最后一个 browser tab 回写 url。

**Tech Stack:** undici（global fetch，经 proxy-dispatcher/NetworkGate 全局 dispatcher）、zod、zustand（既有 detail-panel store）、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-13-ai-web-tools-design.md`

## Global Constraints

- web_fetch：超时 15s、响应体 ≤1MB、Content-Type 仅 text/html 或 text/plain、正文截断 32KB、SSRF 复用 browser-session 清单（提取公共模块，不复制）、协议仅 http/https
- open_browser：`ctx.emitPanel?.("detailPanel:openBrowser", { url })`；emitPanel 缺省返回「面板不可用」文案
- 两工具 kind: "read"（免审批）；工具失败统一文案回喂模型不抛出（file-tools fail 模式）
- agent 域文件禁止 import electron（web-tools/tool-registry/file-tools 均纯 Node 可测）
- 事件通道 `detailPanel:openBrowser` 进 IPC_EVENT_ALLOWLIST；payload `{ sessionId: number, url: string }`
- 前端联动：仅当前选中会话响应；复用最后一个 browser tab；右栏未开自动 setArtifactsOpen(true)
- Prettier：双引号、分号、tabWidth=2、printWidth=80（尾随逗号照仓库 trailingComma all）；i18n 双语同步、禁硬编码文案/颜色
- 每任务 TDD；conventional commits

---

### Task 1: SSRF 公共模块提取 + fail 导出 + 全局 dispatcher 验证

**Files:**
- Create: `electron/domains/security/ssrf-hosts.ts`
- Modify: `electron/domains/ai/browser/browser-session.ts`（SSRF 段改为 re-export/引用）
- Modify: `electron/domains/ai/agent/file-tools.ts:60`（`function fail` → `export function fail`，注释同步「web-tools 复用」）
- Test: `tests/security/ssrf-hosts.test.ts`

**Interfaces:**
- Produces: `electron/domains/security/ssrf-hosts.ts` 导出 `SSRF_HOSTS: ReadonlySet<string>` 与 `isSsrfHost(hostname: string): boolean`；`export function fail(message: string): string`（file-tools）

- [ ] **Step 1: 写失败测试**

`tests/security/ssrf-hosts.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { SSRF_HOSTS, isSsrfHost } from "../../electron/domains/security/ssrf-hosts";

describe("ssrf-hosts（云 metadata 封锁清单）", () => {
  it("覆盖三大云 metadata 端点", () => {
    expect(isSsrfHost("169.254.169.254")).toBe(true);
    expect(isSsrfHost("metadata.google.internal")).toBe(true);
    expect(isSsrfHost("metadata.azure.com")).toBe(true);
  });
  it("大小写不敏感；普通域名放行", () => {
    expect(isSsrfHost("Metadata.Google.Internal")).toBe(true);
    expect(isSsrfHost("example.com")).toBe(false);
    expect(isSsrfHost("")).toBe(false);
  });
  it("SSRF_HOSTS 只读快照含三端点", () => {
    expect(SSRF_HOSTS.size).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/security/ssrf-hosts.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`electron/domains/security/ssrf-hosts.ts`：

```ts
/**
 * SSRF 封锁清单（云 metadata 端点，对齐 WorkBuddy）：内置浏览器请求门
 * （browser-session）与 agent web_fetch 共用；提取公共模块防两处清单漂移。
 */
const HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.azure.com",
]);

export const SSRF_HOSTS: ReadonlySet<string> = HOSTS;

export function isSsrfHost(hostname: string): boolean {
  return HOSTS.has(hostname.toLowerCase());
}
```

`browser-session.ts`：删除本地 `SSRF_HOSTS` Set 与 `isSsrfHost` 定义，改为：

```ts
import { isSsrfHost } from "../../security/ssrf-hosts";
export { isSsrfHost };
```

（保留 re-export 使既有 import 与 `tests/browser/browser-session.test.ts` 不破。）

`file-tools.ts:60`：`function fail` 改 `export function fail`，头注释加一行「web-tools 同语义复用」。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/security/ssrf-hosts.test.ts tests/browser/browser-session.test.ts`
Expected: 全 PASS

- [ ] **Step 5: 全局 dispatcher 覆盖验证（信息收集，不写测试）**

Run: `node -e "process.env.NODE_ENV='test'; const {setGlobalDispatcher, getGlobalDispatcher} = require('undici'); console.log('default:', getGlobalDispatcher().constructor.name); require('./electron/domains/app-settings/proxy-dispatcher.ts');" 2>&1 | head -3`（ts 文件 node 直跑不了——改用：读 `electron/domains/app-settings/proxy-dispatcher.ts` 的 `buildDispatcher` 与安装调用，确认 `setGlobalDispatcher(buildDispatcher(lastSpec))` 在应用启动即装（Application.ts 调 installProxyDispatcher 之类），并确认 buildDispatcher 链含 NetworkGate PolicyDispatcher）。把结论写进报告：**若链中含 PolicyDispatcher → Task 2 直接用 global fetch；否则 Task 2 的工厂需接受注入 dispatcher**（以实际代码为准，本步骤只产出结论不产码）。

- [ ] **Step 6: Commit**

```bash
git add electron/domains/security/ssrf-hosts.ts electron/domains/ai/browser/browser-session.ts electron/domains/ai/agent/file-tools.ts tests/security/ssrf-hosts.test.ts
git commit -m "refactor(security): SSRF 清单提取公共模块与 fail 导出——web 工具前置"
```

---

### Task 2: web-tools 工厂（TDD）

**Files:**
- Create: `electron/domains/ai/agent/web-tools.ts`
- Test: `tests/ai/web-tools.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition`/`ToolContext`（file-tools.ts）、`isSsrfHost`（Task 1）、`fail`（Task 1）
- Produces:

```ts
export type PanelEmit = (event: "detailPanel:openBrowser", payload: { url: string }) => void;
export type WebFetcher = (
  url: string,
  opts: { signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  /** 流式读取器（实现负责上限截断） */
  text: () => Promise<string>;
}>;
export function makeWebTools(fetcher?: WebFetcher): ToolDefinition[];
// 返回 [webFetchTool, openBrowserTool]：
//   name: "web_fetch" / "open_browser"，kind: "read"
```

默认 fetcher = global fetch 适配（15s AbortSignal.timeout 包装）；测试注入 fake。**若 Task 1 Step 5 结论为全局链不含 PolicyDispatcher**：默认 fetcher 改为经注入 dispatcher 的 undici request 适配（装配层 Task 3 从 NetworkGate 取）——按结论二选一，报告注明。

- [ ] **Step 1: 写失败测试**

`tests/ai/web-tools.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { makeWebTools, type WebFetcher } from "../../electron/domains/ai/agent/web-tools";
import type { ToolContext } from "../../electron/domains/ai/agent/file-tools";

const CT = { base: 4096 };

function fakeFetcher(over?: Partial<Awaited<ReturnType<WebFetcher>>>): WebFetcher & {
  calls: string[];
} {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () =>
        "<html><head><title>示例</title><style>a{}</style></head><body><h1>标题</h1><script>bad()</script><p>正文 内容</p></body></html>",
      ...over,
    };
  };
  return Object.assign(f, { calls });
}

function ctx(emitPanel?: ToolContext["emitPanel"]): ToolContext {
  return { workspacePath: "/tmp", sessionId: 1, emitPanel };
}

describe("web_fetch", () => {
  it("提取文本：剥 script/style 与标签、压缩空白、附 url 与标题", async () => {
    const tools = makeWebTools(fakeFetcher());
    const out = await tools[0].execute(ctx(), { url: "https://example.com/a" });
    expect(out).toContain("https://example.com/a");
    expect(out).toContain("示例");
    expect(out).toContain("标题");
    expect(out).toContain("正文 内容");
    expect(out).not.toContain("bad()");
    expect(out).not.toContain("a{}");
    expect(out).not.toContain("<p>");
  });

  it("32KB 截断：超长正文截断并附截断标记", async () => {
    const long = "x".repeat(64 * 1024);
    const tools = makeWebTools(fakeFetcher({ text: async () => long }));
    const out = await tools[0].execute(ctx(), { url: "https://example.com/big" });
    expect(out.length).toBeLessThan(40 * 1024);
    expect(out).toContain("已截断");
  });

  it("非 html/plain Content-Type 拒绝（json/二进制）", async () => {
    const tools = makeWebTools(
      fakeFetcher({ headers: { get: () => "application/json" } }),
    );
    const out = await tools[0].execute(ctx(), { url: "https://example.com/api" });
    expect(out).toMatch(/不支持|Content-Type/i);
  });

  it("SSRF 云 metadata 域拒绝", async () => {
    const fetcher = fakeFetcher();
    const tools = makeWebTools(fetcher);
    const out = await tools[0].execute(ctx(), { url: "http://169.254.169.254/latest" });
    expect(out).toMatch(/内网|SSRF|禁止/i);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("仅 http/https 放行（file:// 拒绝）", async () => {
    const tools = makeWebTools(fakeFetcher());
    const out = await tools[0].execute(ctx(), { url: "file:///etc/passwd" });
    expect(out).toMatch(/http/i);
  });

  it("HTTP 状态非 2xx 报状态码；网络错误回喂不抛", async () => {
    const tools = makeWebTools(fakeFetcher({ ok: false, status: 404 }));
    const out = await tools[0].execute(ctx(), { url: "https://example.com/none" });
    expect(out).toContain("404");
    const boom = makeWebTools(async () => {
      throw new Error("timeout");
    });
    const out2 = await boom[0].execute(ctx(), { url: "https://example.com/x" });
    expect(out2).toMatch(/失败|错误/);
  });

  it("响应体 1MB 上限：text() 返回超限内容时拒绝", async () => {
    const huge = "y".repeat(1024 * 1024 + 1);
    const tools = makeWebTools(fakeFetcher({ text: async () => huge }));
    const out = await tools[0].execute(ctx(), { url: "https://example.com/huge" });
    expect(out).toMatch(/过大|1MB/i);
  });
});

describe("open_browser", () => {
  it("emitPanel 推送并返回成功文案", async () => {
    const emitPanel = vi.fn();
    const tools = makeWebTools(fakeFetcher());
    const out = await tools[1].execute(ctx(emitPanel as ToolContext["emitPanel"]), {
      url: "https://example.com/doc",
    });
    expect(emitPanel).toHaveBeenCalledWith("detailPanel:openBrowser", {
      url: "https://example.com/doc",
    });
    expect(out).toContain("https://example.com/doc");
  });

  it("emitPanel 缺省返回面板不可用（不调 fetch）", async () => {
    const fetcher = fakeFetcher();
    const tools = makeWebTools(fetcher);
    const out = await tools[1].execute(ctx(), { url: "https://example.com" });
    expect(out).toMatch(/不可用|未开启/);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("非法 url 同样校验拒绝", async () => {
    const emitPanel = vi.fn();
    const tools = makeWebTools(fakeFetcher());
    const out = await tools[1].execute(ctx(emitPanel as ToolContext["emitPanel"]), {
      url: "javascript:alert(1)",
    });
    expect(emitPanel).not.toHaveBeenCalled();
    expect(out).toMatch(/http/i);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/web-tools.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 web-tools.ts**

```ts
/**
 * agent 网页工具（web_fetch/open_browser，spec 2026-10-13-ai-web-tools）：
 * 纯 Node 可测（fetch 注入照 makeRunCommandTool 工厂先例，零 electron
 * 依赖）。网络层走主进程 global fetch——已由 proxy-dispatcher 的全局
 * dispatcher（含 NetworkGate 域策略/审计）覆盖；SSRF 复用 security 域
 * 公共清单。open_browser 经 ctx.emitPanel 推面板联动事件（装配见
 * chat.service）。
 */
import { z } from "zod";
import { isSsrfHost } from "../../security/ssrf-hosts";
import type { ToolContext, ToolDefinition } from "./file-tools";
import { fail } from "./file-tools";

const FETCH_TIMEOUT_MS = 15_000;
const BODY_LIMIT = 1024 * 1024;
const CONTENT_LIMIT = 32 * 1024;

export type PanelEmit = (
  event: "detailPanel:openBrowser",
  payload: { url: string },
) => void;

export type WebFetcher = (
  url: string,
  opts: { signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text: () => Promise<string>;
}>;

/** 校验放行的 url（协议 + SSRF）；拒绝返回原因文案 */
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

/** HTML→文本：剥 script/style 块与标签、实体折叠、空白压缩（零依赖） */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(html: string): string {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
}

function makeWebFetchTool(fetcher: WebFetcher): ToolDefinition<{ url: string }> {
  return {
    name: "web_fetch",
    description:
      "读取网页正文（纯文本提取）。输入 http/https 链接，返回页面标题与正文（超 32KB 截断）。适合查阅文档、文章、API 说明页。",
    parameters: z.object({ url: z.string().describe("要读取的网页地址") }),
    kind: "read",
    execute: async (_ctx, { url }) => {
      const bad = assertUrl(url);
      if (bad) return fail(bad);
      let res: Awaited<ReturnType<WebFetcher>>;
      try {
        res = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch (e) {
        return fail(`请求失败: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) return fail(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "";
      if (!/text\/html|text\/plain/i.test(contentType)) {
        return fail(`不支持的 Content-Type: ${contentType || "未知"}（仅 text/html、text/plain）`);
      }
      const body = await res.text();
      if (body.length > BODY_LIMIT) return fail("响应体过大（超过 1MB）");
      const isHtml = /text\/html/i.test(contentType);
      const text = isHtml ? htmlToText(body) : body.replace(/\s+/g, " ").trim();
      const title = isHtml ? titleOf(body) : "";
      const header = `URL: ${url}${title ? `\n标题: ${title}` : ""}\n---\n`;
      if (header.length + text.length > CONTENT_LIMIT) {
        return `${header}${text.slice(0, CONTENT_LIMIT - header.length)}\n\n[正文超过 32KB，已截断]`;
      }
      return header + text;
    },
  };
}

function makeOpenBrowserTool(
  fetcher: WebFetcher,
): ToolDefinition<{ url: string }> {
  return {
    name: "open_browser",
    description:
      "在用户当前会话右侧面板的内置浏览器中打开网页（展示给用户看，不返回页面内容）。用于把文档/链接呈现给用户；需要页面内容时用 web_fetch。",
    parameters: z.object({ url: z.string().describe("要展示的网页地址") }),
    kind: "read",
    execute: async (ctx, { url }) => {
      const bad = assertUrl(url);
      if (bad) return fail(bad);
      if (!ctx.emitPanel) return fail("面板不可用（当前环境未开启会话面板联动）");
      ctx.emitPanel("detailPanel:openBrowser", { url });
      return `已在右侧浏览器面板打开 ${url}`;
    },
  };
}

/** 默认 fetcher：global fetch 适配（全局 dispatcher 由 proxy-dispatcher 装配） */
const defaultFetcher: WebFetcher = (url, opts) =>
  fetch(url, { signal: opts.signal }) as unknown as ReturnType<WebFetcher>;

export function makeWebTools(fetcher: WebFetcher = defaultFetcher): ToolDefinition[] {
  return [makeWebFetchTool(fetcher), makeOpenBrowserTool(fetcher)];
}
```

（open_browser 不实际发请求，fetcher 参数仅为两工具同工厂一致性——若审查认为多余可让 openBrowserTool 不接 fetcher，但 makeWebTools 返回两工具的签名以本计划为准。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ai/web-tools.test.ts`
Expected: PASS（10 用例）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/agent/web-tools.ts tests/ai/web-tools.test.ts
git commit -m "feat(agent): web_fetch/open_browser 工厂——网页读取与面板展示（fetch 注入可测）"
```

---

### Task 3: 装配链路与工具注册

**Files:**
- Modify: `electron/domains/ai/agent/file-tools.ts`（ToolContext 追加 emitPanel 字段）
- Modify: `electron/domains/ai/chat/chat.service.ts`（AgentStreamOptions 追加 emitPanel；buildStreamOptions 注入闭包；executeToolSafe 透传）
- Modify: `electron/domains/ai/agent/tool-registry.ts`（初始集加 WEB_TOOLS）
- Modify: `electron/commons/ipc-channels.ts`（EVENT 白名单加 `detailPanel:openBrowser`）
- Test: `tests/commons/ipc-channels.test.ts`（追加断言）

**Interfaces:**
- Consumes: `makeWebTools`/`PanelEmit`（Task 2）
- Produces: 主进程在 open_browser 执行时向会话 sender 推 `detailPanel:openBrowser` `{ sessionId, url }`；模型工具集含 web_fetch/open_browser

- [ ] **Step 1: 追加白名单测试**

`tests/commons/ipc-channels.test.ts` 末尾追加：

```ts
describe("ipc-channels web 工具联动通道", () => {
  it("事件放行 detailPanel:openBrowser", () => {
    expect(IPC_EVENT_ALLOWLIST).toContain("detailPanel:openBrowser");
    expect(isEventAllowed("detailPanel:openBrowser")).toBe(true);
  });
});
```

（文件若已有 import 则合并 describe。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/commons/ipc-channels.test.ts`
Expected: FAIL（通道不在白名单）

- [ ] **Step 3: 实现**

① `file-tools.ts` ToolContext 末尾追加：

```ts
  /** 面板联动（web 工具 open_browser）：ChatService 装配闭包绑定会话
   *  sender；agent 域零 electron 依赖（事件名常量由装配层消费） */
  emitPanel?: (
    event: "detailPanel:openBrowser",
    payload: { url: string },
  ) => void;
```

② `chat.service.ts` AgentStreamOptions 末尾追加：

```ts
  /** 面板联动（web 工具）：sender 销毁安全；sessionId 由装配闭包补进 payload */
  emitPanel?: (
    event: "detailPanel:openBrowser",
    payload: { url: string },
  ) => void;
```

③ `buildStreamOptions` 返回对象追加（sender 依 send/stream 链路实际来源——若 buildStreamOptions 无 sender 参数，在其调用方捕获 sender 后经参数/字段传入；实现时照既有 emit(sender, …) 的 sender 获取路径接线）：

```ts
      emitPanel: sender
        ? (event, payload) => {
            if (event !== "detailPanel:openBrowser") return;
            if (!sender.isDestroyed()) {
              sender.send(event, { sessionId, url: payload.url });
            }
          }
        : undefined,
```

④ `executeToolSafe` 的 ctx 组装追加一行：

```ts
        emitPanel: agent.emitPanel,
```

⑤ `tool-registry.ts`：

```ts
import { makeWebTools } from "./web-tools";
const definitions: ToolDefinition[] = [
  ...FILE_TOOLS,
  makeRunCommandTool(),
  ...makeWebTools(),
];
```

⑥ `ipc-channels.ts` IPC_EVENT_ALLOWLIST 追加：

```ts
  // AI 面板联动（web 工具 open_browser）：主进程 → 渲染层开右栏浏览器 tab
  "detailPanel:openBrowser",
```

- [ ] **Step 4: 验证**

Run: `npx vitest run tests/commons/ipc-channels.test.ts tests/ai/web-tools.test.ts && npm run typecheck && npm run test`
Expected: 全 PASS（全量 0 失败）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/agent/file-tools.ts electron/domains/ai/chat/chat.service.ts electron/domains/ai/agent/tool-registry.ts electron/commons/ipc-channels.ts tests/commons/ipc-channels.test.ts
git commit -m "feat(agent): emitPanel 装配链路——open_browser 推送 detailPanel:openBrowser"
```

---

### Task 4: 前端联动 hook（TDD）

**Files:**
- Create: `src-react/domains/ai/chat/hooks/use-detail-panel-bridge.ts`
- Modify: `src-react/domains/ai/chat/views/ChatView.tsx`（挂载 hook）
- Test: `tests/ai/use-detail-panel-bridge.test.tsx`

**Interfaces:**
- Consumes: `on`（@/lib/ipc）、`useDetailPanelStore`（openTab/syncTab/panels）、`useAiUiStore.setArtifactsOpen`
- Produces: `export function useDetailPanelBridge(activeSessionId: number | null): void`

- [ ] **Step 1: 写失败测试**

`tests/ai/use-detail-panel-bridge.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * use-detail-panel-bridge：detailPanel:openBrowser 事件 → 开/复用浏览器 tab
 * 并回写 url；跨会话静默。mock ipc on 捕获监听器手动触发。
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let listener: ((payload: { sessionId: number; url: string }) => void) | null =
  null;
vi.mock("@/lib/ipc", () => ({
  on: vi.fn(
    (_channel: string, cb: (e: unknown, payload: unknown) => void) => {
      listener = (payload) => cb({}, payload);
      return () => {
        listener = null;
      };
    },
  ),
}));
// react-i18next 照 tests/ai/detail-panel-init.test.tsx 的部分 mock（返回 key）
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { useDetailPanelStore } from "../../src-react/domains/ai/chat/store/detail-panel.store";
import { useAiUiStore } from "../../src-react/domains/ai/store/ai-ui.store";
import { useDetailPanelBridge } from "../../src-react/domains/ai/chat/hooks/use-detail-panel-bridge";

function Probe({ sessionId }: { sessionId: number | null }) {
  useDetailPanelBridge(sessionId);
  return null;
}

function fire(payload: { sessionId: number; url: string }) {
  act(() => listener?.(payload));
}

const S1 = 101;

beforeEach(() => {
  useDetailPanelStore.setState({ panels: {} });
  useAiUiStore.setState({ artifactsOpen: false });
});

describe("useDetailPanelBridge", () => {
  it("当前会话事件：右栏未开自动开；新建 browser tab 并回写 url", () => {
    render(<Probe sessionId={S1} />);
    fire({ sessionId: S1, url: "https://example.com/a" });
    const state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ kind: "browser", url: "https://example.com/a" });
    expect(state.activeTabId).toBe(state.tabs[0].id);
    expect(useAiUiStore.getState().artifactsOpen).toBe(true);
  });

  it("已有 browser tab：复用最后一个回写 url，不开新 tab", () => {
    render(<Probe sessionId={S1} />);
    fire({ sessionId: S1, url: "https://example.com/a" });
    fire({ sessionId: S1, url: "https://example.com/b" });
    const state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].url).toBe("https://example.com/b");
  });

  it("其他会话事件：静默不动", () => {
    render(<Probe sessionId={S1} />);
    fire({ sessionId: 999, url: "https://example.com/x" });
    expect(useDetailPanelStore.getStateOf(S1).tabs).toHaveLength(0);
    expect(useAiUiStore.getState().artifactsOpen).toBe(false);
  });

  it("activeSessionId 切换后按新会话过滤", () => {
    const { rerender } = render(<Probe sessionId={S1} />);
    rerender(<Probe sessionId={102} />);
    fire({ sessionId: 102, url: "https://example.com/c" });
    expect(useDetailPanelStore.getStateOf(102).tabs).toHaveLength(1);
    fire({ sessionId: S1, url: "https://example.com/d" });
    expect(useDetailPanelStore.getStateOf(S1).tabs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/use-detail-panel-bridge.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 hook**

`src-react/domains/ai/chat/hooks/use-detail-panel-bridge.ts`：

```ts
/**
 * 面板联动桥（web 工具 open_browser）：订阅 detailPanel:openBrowser——
 * 仅当前选中会话响应（他话不抢视图）；复用该会话最后一个浏览器 tab 回写
 * url（无则新建并激活）；右栏未开自动展开。tab 标题词条复用
 * detailPanel.browser。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { on } from "@/lib/ipc";
import { useAiUiStore } from "../../../store/ai-ui.store";
import { useDetailPanelStore } from "../store/detail-panel.store";

export function useDetailPanelBridge(activeSessionId: number | null): void {
  const { t } = useTranslation(["chat"]);
  useEffect(() => {
    return on("detailPanel:openBrowser", (_event, payload) => {
      if (
        !payload ||
        typeof payload !== "object" ||
        (payload as { sessionId?: unknown }).sessionId !== activeSessionId ||
        typeof (payload as { url?: unknown }).url !== "string" ||
        !(payload as { url: string }).url
      ) {
        return;
      }
      const url = (payload as { url: string }).url;
      const store = useDetailPanelStore.getState();
      const state = useDetailPanelStore.getStateOf(activeSessionId);
      const existing = [...state.tabs]
        .reverse()
        .find((tab) => tab.kind === "browser");
      if (existing) {
        store.syncTab(activeSessionId, existing.id, { url });
        store.setActive(activeSessionId, existing.id);
      } else {
        store.openTab(activeSessionId, "browser", t("chat:detailPanel.browser"));
        const created = useDetailPanelStore
          .getStateOf(activeSessionId)
          .tabs.at(-1);
        if (created) store.syncTab(activeSessionId, created.id, { url });
      }
      useAiUiStore.getState().setArtifactsOpen(true);
    });
  }, [activeSessionId, t]);
}
```

（openTab 已激活新 tab；syncTab 回写 url 后 BrowserPanelTab 以 tab.url 恢复挂载。）

- [ ] **Step 4: ChatView 挂载**

`ChatView.tsx` import 区加：

```tsx
import { useDetailPanelBridge } from "../hooks/use-detail-panel-bridge";
```

组件体内 `handoverOpen` state 附近加：

```tsx
  // 面板联动桥（web 工具 open_browser）：右栏浏览器 tab 自动开/复用
  useDetailPanelBridge(selectedSession?.id ?? null);
```

- [ ] **Step 5: 运行测试 + 全量**

Run: `npx vitest run tests/ai/use-detail-panel-bridge.test.tsx && npm run typecheck && npm run test`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add src-react/domains/ai/chat/hooks/use-detail-panel-bridge.ts src-react/domains/ai/chat/views/ChatView.tsx tests/ai/use-detail-panel-bridge.test.tsx
git commit -m "feat(detail-panel): openBrowser 联动桥——事件驱动开/复用右栏浏览器 tab"
```

---

### Task 5: 全量验证与冒烟

**Files:** 无新增（验证任务）

- [ ] **Step 1: lint + typecheck + 全量测试**

```bash
npm run lint && npm run typecheck && npm run test
```

Expected: 三者全绿（0 失败）。

- [ ] **Step 2: dev 冒烟（GUI 驱动照 memory 的 nohup dev + playwright-core 法，或人工）**

清单：
1. 会话输入「用 web_fetch 读一下 https://example.com 讲了什么」→ 模型调用 web_fetch 工具卡片出现，回答含页面内容
2. 输入「帮我打开 https://example.com 看看」→ 模型调 open_browser → 右栏自动展开且浏览器 tab 加载该页
3. 再次「打开 https://www.iana.org」→ 复用同一浏览器 tab 导航（不开新 tab）
4. 切到另一会话 → 在旧会话（非当前）触发的联动不抢视图（可经第 2 步快速切换验证，低优先允许标注未验）
5. NetworkGate 审计：security 域审计中心出现 web_fetch 的域访问记录（若 NetworkGate 产审计事件按其现状验证；无则标注）
6. 云 metadata 拒绝：「读 http://169.254.169.254/latest」→ 工具返回拒绝文案

- [ ] **Step 3: 收尾 commit（若冒烟有零星修复）**

```bash
git status && git add -A && git commit -m "fix(agent): web 工具冒烟收尾"
```

---

## Self-Review 结论

- **Spec 覆盖**：§2 web-tools→Task 2（含 Content-Type/超时/1MB/32KB/SSRF/零依赖提取）；§3 装配→Task 3（含 emitPanel 缺省兜底在 Task 2）；§4 通道→Task 3；§5 hook→Task 4（复用最后一个 tab/自动展开/跨会话静默）；§6 权限/i18n→kind read + 既有 detailPanel.browser 词条复用（零新增词条，Task 4 注释已说明）；§7 测试→Task 1/2/4；§8 风险→Task 1 Step 5 dispatcher 验证分叉。✓
- **占位符**：Task 3 Step 3 ③ sender 接线为「依实际链路」的开放指令——这是装配既有 emit 模式的对照性工作（emit(sender,…) 先例就在同文件），非 TBD；其余无占位。✓
- **类型一致性**：`PanelEmit`/`emitPanel(event, payload)` 签名 Task 2/3/4 一致；`makeWebTools()` 返回 ToolDefinition[] 与 registry 消费一致；事件 payload `{sessionId, url}` 在 Task 3 装配（sessionId 闭包补入）与 Task 4 消费一致。✓
