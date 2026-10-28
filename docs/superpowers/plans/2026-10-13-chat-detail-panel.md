# 会话右侧栏 tab 化（DetailPanel）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 聊天会话右栏从 ArtifactsPanel（三视图 dropdown）升级为 tab 式 DetailPanel，「+」菜单可开 浏览器/工作空间（文件树）/终端 tab，可多开、可关闭，参照 WorkBuddy detailPanel。

**Architecture:** 前端新增 `detail-panel/` 组件组 + sessionId 隔离的 zustand store；浏览器 tab 组件级复用 `ai/browser` 域；文件树走新 `workspace:listDir` IPC（resolveSafePath 沙箱）；终端为新 `electron/domains/ai/terminal/` 域（node-pty，核心逻辑注入可测，IPC 薄壳 lazy require）。

**Tech Stack:** Electron 44、React 19、zustand、node-pty、@xterm/xterm + @xterm/addon-fit、Vitest（oxc jsx）。

**Spec:** `docs/superpowers/specs/2026-10-13-chat-detail-panel-design.md`

## Global Constraints

- 右栏 340px 挤压式旁挂、TopBar 宽度注册（340）、收起整体移除——外壳语义不变
- tabs 按 sessionId 隔离（`Record<sessionId, DetailPanelState>`），内存态不持久化
- 关到最后一个 tab → `setArtifactsOpen(false)`
- 终端不挂权限门（spec 用户裁定）；`terminal:create` 走 handleUser 鉴权，write/resize/kill 走 send 白名单
- `workspace:listDir` 用 resolveSafePath **沙箱语义**（非 fullAccess），越界抛 `PATH_OUTSIDE_WORKSPACE`
- 隐藏文件（`.` 开头）不列；单目录上限 2000 条
- 禁止 JSX/JS 硬编码用户可见文案，一律 `t()`，zh-CN/en-US 同步；禁止硬编码主题色（用 CSS 变量 `--color-*`）
- Prettier：双引号、分号、tabWidth=2、printWidth=80、无尾随逗号
- 文件名 kebab-case、变量 camelCase、组件 PascalCase
- 每个任务 TDD：先写失败测试再实现；commit 信息 conventional commits
- webview 相关：非受控 src、事件原生 addEventListener、ref 惰性取值不传节点为 prop（既有踩坑结论，勿重写）

---

### Task 1: 依赖安装与 IPC 通道白名单

**Files:**
- Modify: `package.json`（npm i 自动）
- Modify: `vite.config.ts`（external 数组，约 78-88 行）
- Modify: `electron/commons/ipc-channels.ts`（三处白名单）
- Test: `tests/commons/ipc-channels.test.ts`（若已存在则追加用例；不存在则创建）

**Interfaces:**
- Produces: INVOKE 通道 `"terminal:create"`、`"workspace:listDir"`；SEND 通道 `"terminal:write" | "terminal:resize" | "terminal:kill"`；事件前缀 `"terminal:data:"`、`"terminal:exit:"`。后续任务与渲染层 `IPCChannel` 类型自动获得这些通道名。

- [ ] **Step 1: 安装依赖**

```bash
npm i node-pty @xterm/xterm @xterm/addon-fit
```

npm i 会触发既有 `postinstall: electron-builder install-app-deps`，将 node-pty 按 Electron 44 ABI 重编译（本机已装全局 node-gyp）。**注意**：重编译后 node-pty 为 Electron ABI，纯 Node（vitest）下不可 require——这正是 Task 2 采用依赖注入而非直接 import 的原因。

- [ ] **Step 2: vite external 追加 node-pty**

`vite.config.ts` 的 `rolldownOptions.external` 数组（现有 "moment"/"better-sqlite3" 等注释块下方）追加：

```ts
                  // node-pty（原生模块）：bindings 裸 __filename，同 better-sqlite3
                  // 原因，必须外部化走 Node 原生 require
                  "node-pty",
```

- [ ] **Step 3: 写失败测试**

`tests/commons/ipc-channels.test.ts`（若文件已有头部 import 则合并）：

```ts
import { describe, expect, it } from "vitest";
import {
  IPC_INVOKE_ALLOWLIST,
  IPC_SEND_ALLOWLIST,
  IPC_EVENT_PREFIXES,
  isEventAllowed,
} from "../../electron/commons/ipc-channels";

describe("ipc-channels detailPanel 新通道", () => {
  it("invoke 放行 terminal:create 与 workspace:listDir", () => {
    expect(IPC_INVOKE_ALLOWLIST).toContain("terminal:create");
    expect(IPC_INVOKE_ALLOWLIST).toContain("workspace:listDir");
  });

  it("send 放行 terminal 写/缩放/关闭", () => {
    for (const ch of ["terminal:write", "terminal:resize", "terminal:kill"]) {
      expect(IPC_SEND_ALLOWLIST).toContain(ch);
    }
  });

  it("事件动态前缀放行 terminal:data: 与 terminal:exit:", () => {
    expect(IPC_EVENT_PREFIXES).toContain("terminal:data:");
    expect(IPC_EVENT_PREFIXES).toContain("terminal:exit:");
    expect(isEventAllowed("terminal:data:abc123")).toBe(true);
    expect(isEventAllowed("terminal:exit:abc123")).toBe(true);
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

```bash
npx vitest run tests/commons/ipc-channels.test.ts
```

预期：FAIL（通道不在白名单）。

- [ ] **Step 5: 修改 ipc-channels.ts**

① `IPC_INVOKE_ALLOWLIST`：在 `workspace:readFile` 附近（workspace 域注释块内）追加：

```ts
  "workspace:listDir",
```

在文件尾部 AI 通道区域（`browser:clearData` 等所在段落，若无则新起注释块）追加：

```ts
  // 终端域（DetailPanel 终端 tab）：create 走 invoke（鉴权返回 id），
  // 高频 write/resize/kill 走 send
  "terminal:create",
```

② `IPC_SEND_ALLOWLIST` 追加：

```ts
  // 终端域（DetailPanel）：高频流数据不走 invoke；id 仅 create 成功者持有
  "terminal:write",
  "terminal:resize",
  "terminal:kill",
```

③ `IPC_EVENT_PREFIXES`：

```ts
export const IPC_EVENT_PREFIXES = [
  "chat:stream:",
  "terminal:data:",
  "terminal:exit:",
] as const;
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npx vitest run tests/commons/ipc-channels.test.ts
```

预期：PASS。

- [ ] **Step 7: typecheck + commit**

```bash
npm run typecheck
git add package.json package-lock.json vite.config.ts electron/commons/ipc-channels.ts tests/commons/ipc-channels.test.ts
git commit -m "feat(detail-panel): node-pty/xterm 依赖与 terminal/workspace:listDir 通道白名单"
```

---

### Task 2: 终端核心管理器（terminal-core，TDD）

**Files:**
- Create: `electron/domains/ai/terminal/terminal-core.ts`
- Test: `tests/ai/terminal-core.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
}
export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; name: string },
) => PtyProcess;
export type TerminalSender = (channel: string, data: string) => void;
export class TerminalManager {
  constructor(ptyFactory: PtyFactory, send: TerminalSender);
  create(sender: TerminalSender, cwd: string): string; // 返回 id；factory 抛错时向上抛
  write(id: string, data: string): void;  // 未知 id 静默忽略
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;                 // 未知 id 幂等
  killAll(): void;
  count(): number;
}
export function defaultShell(): string;
```

零 electron import（照 browser-session「纯逻辑可测」先例）；node-pty 由 Task 3 的 IPC 薄壳 lazy require 注入。

- [ ] **Step 1: 写失败测试**

`tests/ai/terminal-core.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import {
  TerminalManager,
  defaultShell,
  type PtyFactory,
  type PtyProcess,
} from "../../electron/domains/ai/terminal/terminal-core";

class FakePty implements PtyProcess {
  written: string[] = [];
  killed = false;
  resized: Array<[number, number]> = [];
  dataCb?: (data: string) => void;
  exitCb?: (code: number) => void;
  write(data: string) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.resized.push([cols, rows]);
  }
  kill() {
    this.killed = true;
  }
  onData(cb: (data: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (code: number) => void) {
    this.exitCb = cb;
  }
}

function makeFactory() {
  const ptys: FakePty[] = [];
  const factory = vi.fn((file: string) => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  }) as unknown as PtyFactory & { ptys: FakePty[] };
  (factory as { ptys: FakePty[] }).ptys = ptys;
  return factory as PtyFactory & { ptys: FakePty[] };
}

describe("TerminalManager", () => {
  it("create 登记并返回不同 id，cwd 透传", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const id1 = manager.create(vi.fn(), "/tmp/a");
    const id2 = manager.create(vi.fn(), "/tmp/b");
    expect(id1).toBeTruthy();
    expect(id1).not.toBe(id2);
    expect(factory).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cwd: "/tmp/a" }),
    );
  });

  it("write/resize 转发到对应 pty", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const id = manager.create(vi.fn(), "/tmp");
    manager.write(id, "ls\r");
    manager.resize(id, 120, 30);
    expect(factory.ptys[0].written).toEqual(["ls\r"]);
    expect(factory.ptys[0].resized).toEqual([[120, 30]]);
  });

  it("未知 id 的 write/resize/kill 静默不抛", () => {
    const manager = new TerminalManager(makeFactory(), vi.fn());
    expect(() => {
      manager.write("nope", "x");
      manager.resize("nope", 1, 1);
      manager.kill("nope");
    }).not.toThrow();
  });

  it("pty data 经各自 sender 推送 terminal:data:<id>", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const sender1 = vi.fn();
    const sender2 = vi.fn();
    const id1 = manager.create(sender1, "/tmp");
    manager.create(sender2, "/tmp");
    factory.ptys[0].dataCb?.("hello");
    factory.ptys[1].dataCb?.("world");
    expect(sender1).toHaveBeenCalledWith(`terminal:data:${id1}`, "hello");
    expect(sender2).toHaveBeenCalledTimes(1);
  });

  it("pty exit 推送 terminal:exit:<id> 并移除登记", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const sender = vi.fn();
    const id = manager.create(sender, "/tmp");
    factory.ptys[0].exitCb?.(0);
    expect(sender).toHaveBeenCalledWith(`terminal:exit:${id}`, "0");
    expect(manager.count()).toBe(0);
    manager.kill(id); // 已移除，幂等
  });

  it("kill 调用 pty.kill；killAll 清空全部", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const id1 = manager.create(vi.fn(), "/tmp");
    manager.create(vi.fn(), "/tmp");
    manager.kill(id1);
    expect(factory.ptys[0].killed).toBe(true);
    expect(factory.ptys[1].killed).toBe(false);
    manager.killAll();
    expect(factory.ptys[1].killed).toBe(true);
    expect(manager.count()).toBe(0);
  });

  it("create 时 factory 抛错向上传播", () => {
    const factory: PtyFactory = () => {
      throw new Error("spawn failed");
    };
    const manager = new TerminalManager(factory, vi.fn());
    expect(() => manager.create(vi.fn(), "/tmp")).toThrow("spawn failed");
  });
});

describe("defaultShell", () => {
  it("win32 返回 powershell", () => {
    expect(defaultShell("win32")).toBe("powershell.exe");
  });
  it("darwin 兜底 /bin/zsh，linux 兜底 /bin/bash", () => {
    expect(defaultShell("darwin", undefined)).toBe("/bin/zsh");
    expect(defaultShell("linux", undefined)).toBe("/bin/bash");
  });
  it("SHELL 环境变量优先", () => {
    expect(defaultShell("darwin", "/usr/local/bin/fish")).toBe(
      "/usr/local/bin/fish",
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/ai/terminal-core.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 terminal-core.ts**

`electron/domains/ai/terminal/terminal-core.ts`：

```ts
/**
 * 终端会话管理（DetailPanel 终端 tab）：create/write/resize/kill 与
 * pty 数据/退出推送。零 electron import（node-pty 经工厂注入，vitest
 * 纯 Node 可测——node-pty 已被 install-app-deps 重编译为 Electron ABI，
 * 本模块不得直接 require）。
 */
import { randomUUID } from "node:crypto";

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; name: string },
) => PtyProcess;

export type TerminalSender = (channel: string, data: string) => void;

interface TerminalEntry {
  pty: PtyProcess;
  sender: TerminalSender;
}

export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  shellEnv: string | undefined = process.env.SHELL,
): string {
  if (platform === "win32") return "powershell.exe";
  if (shellEnv && shellEnv.trim()) return shellEnv;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

export class TerminalManager {
  private terminals = new Map<string, TerminalEntry>();

  constructor(
    private readonly ptyFactory: PtyFactory,
    private readonly fallbackSender: TerminalSender,
  ) {}

  create(sender: TerminalSender, cwd: string): string {
    const id = randomUUID();
    const pty = this.ptyFactory(defaultShell(), [], {
      cwd,
      name: "xterm-256color",
    });
    const entry: TerminalEntry = { pty, sender };
    this.terminals.set(id, entry);
    pty.onExit((code) => {
      if (this.terminals.get(id) === entry) this.terminals.delete(id);
      entry.sender(`terminal:exit:${id}`, String(code));
    });
    pty.onData((data) => {
      entry.sender(`terminal:data:${id}`, data);
    });
    return id;
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.pty.resize(cols, rows);
  }

  kill(id: string): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    this.terminals.delete(id);
    entry.pty.kill();
  }

  killAll(): void {
    for (const id of [...this.terminals.keys()]) this.kill(id);
  }

  count(): number {
    return this.terminals.size;
  }
}
```

说明：`fallbackSender` 构造参数在 create 均显式传 sender 的设计下仅作占位（IPC 薄壳传主窗口 sender），保留以备将来主动推送；如实现时确认无用途可从构造中删除，但测试断言以本计划签名 `new TerminalManager(factory, vi.fn())` 为准——**保留该参数**。

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run tests/ai/terminal-core.test.ts
```

预期：PASS（8 个用例）。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/terminal/terminal-core.ts tests/ai/terminal-core.test.ts
git commit -m "feat(terminal): 终端会话管理核心——pty 工厂注入可测"
```

---

### Task 3: 终端 IPC 薄壳与应用注册

**Files:**
- Create: `electron/domains/ai/terminal/terminal-ipc.ts`
- Modify: `electron/Application.ts`（import 区与 browser 域注册行 343-346 附近）

**Interfaces:**
- Consumes: `TerminalManager`/`PtyFactory`/`TerminalSender`（Task 2）
- Produces: `registerTerminalIpc(): void`——注册 `terminal:create`（handleUser 鉴权）与 `terminal:write/resize/kill`（ipcMain.on），挂 app will-quit 全清。

- [ ] **Step 1: 实现 terminal-ipc.ts**

```ts
/**
 * 终端域 IPC 薄壳：node-pty 仅在此 lazy require（Electron ABI，纯 Node
 * 不可载，见 terminal-core 头注释）。create 走 handleUser 鉴权（token →
 * userId，虽无用户语义，沿用通道惯例防未登录直达）；write/resize/kill
 * 为 send 白名单通道——terminal id 只有 create 成功者持有，风险面可控
 * （spec 用户裁定：终端不挂额外权限门）。
 */
import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { handleUser } from "../../../commons/ipc-user";
import {
  TerminalManager,
  type PtyFactory,
  type PtyProcess,
} from "./terminal-core";

/** event.sender 安全推送（销毁后 send 会抛，静默丢弃） */
function senderOf(event: IpcMainInvokeEvent) {
  return (channel: string, data: string) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, data);
  };
}

export function registerTerminalIpc(): void {
  const factory: PtyFactory = (file, args, opts) => {
    // rolldown 外部化 + CJS 互操作：具名导入经 require 取（同 better-sqlite3 处理口径）
    const pty = require("node-pty") as {
      spawn: (
        file: string,
        args: string[],
        opts: { cwd: string; name: string },
      ) => PtyProcess;
    };
    return pty.spawn(file, args, opts);
  };
  const manager = new TerminalManager(factory, () => {});

  handleUser("terminal:create", (event, _userId, cwd: string) =>
    manager.create(senderOf(event), cwd),
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
```

- [ ] **Step 2: Application.ts 注册**

import 区（browser 域 import 附近）追加：

```ts
import { registerTerminalIpc } from "./domains/ai/terminal/terminal-ipc";
```

在 `registerBrowserIpc();` 调用行（约 344 行）后追加：

```ts
    // 终端域（DetailPanel 终端 tab）
    registerTerminalIpc();
```

（注意对齐该处既有缩进。）

- [ ] **Step 3: typecheck + 全量测试**

```bash
npm run typecheck && npm run test
```

预期：全部通过（terminal-ipc 零测试——lazy require 不可纯 Node 测，逻辑全在已测的 terminal-core）。

- [ ] **Step 4: Commit**

```bash
git add electron/domains/ai/terminal/terminal-ipc.ts electron/Application.ts
git commit -m "feat(terminal): IPC 薄壳注册与应用接线——will-quit 全清"
```

---

### Task 4: workspace:listDir（TDD）

**Files:**
- Create: `electron/domains/ai/chat/workspace-dir.ts`
- Modify: `electron/domains/ai/chat/session.repo.ts`（registerIpcHandlers 区域约 156 行附近 + readWorkspaceFileById 方法旁）
- Test: `tests/ai/workspace-dir.test.ts`

**Interfaces:**
- Consumes: `resolveSafePath(workspacePath, relative, fullAccess=false)`（`electron/domains/ai/agent/file-tools.ts:136`）
- Produces:

```ts
// workspace-dir.ts
export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number; // epoch ms
}
export async function listWorkspaceDir(
  rootDir: string,
  relPath: string,
): Promise<DirEntry[]>; // 越界抛 PATH_OUTSIDE_WORKSPACE；目录优先、名自然序；隐藏过滤；上限 2000
```

- [ ] **Step 1: 写失败测试**

`tests/ai/workspace-dir.test.ts`：

```ts
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listWorkspaceDir } from "../../electron/domains/ai/chat/workspace-dir";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ws-dir-test-"));
  await mkdir(path.join(root, "alpha"));
  await mkdir(path.join(root, "beta"));
  await writeFile(path.join(root, "beta", "app.js"), "console.log(1)");
  await writeFile(path.join(root, "readme.md"), "hi");
  await writeFile(path.join(root, ".hidden"), "x");
  await mkdir(path.join(root, "beta", ".git"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listWorkspaceDir", () => {
  it("根目录：目录优先、自然序、隐藏项过滤", async () => {
    const entries = await listWorkspaceDir(root, "");
    expect(entries.map((e) => e.name)).toEqual(["alpha", "beta", "readme.md"]);
    expect(entries[0].isDir).toBe(true);
    expect(entries[2]).toMatchObject({ isDir: false, name: "readme.md" });
    expect(entries[2].size).toBe(2);
    expect(entries[2].mtime).toBeGreaterThan(0);
  });

  it("子目录相对路径", async () => {
    const entries = await listWorkspaceDir(root, "beta");
    expect(entries.map((e) => e.name)).toEqual(["app.js"]);
  });

  it("越界路径抛 PATH_OUTSIDE_WORKSPACE", async () => {
    await expect(listWorkspaceDir(root, "../")).rejects.toThrow(
      "PATH_OUTSIDE_WORKSPACE",
    );
    await expect(listWorkspaceDir(root, "/etc")).rejects.toThrow(
      "PATH_OUTSIDE_WORKSPACE",
    );
  });

  it("绝对路径逃逸（..拼接）同样拒绝", async () => {
    await expect(
      listWorkspaceDir(root, "alpha/../../"),
    ).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
  });

  it("不存在的目录抛 ENOENT 中文可读错误", async () => {
    await expect(listWorkspaceDir(root, "nope")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/ai/workspace-dir.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 workspace-dir.ts**

`electron/domains/ai/chat/workspace-dir.ts`：

```ts
/**
 * 工作空间目录列举（DetailPanel 工作空间 tab 文件树）：resolveSafePath
 * 沙箱语义（越界拒绝，与 file:readWorkspaceFile 同、非产物预览的
 * fullAccess 语义）；纯 Node 实现（禁止 import electron），照
 * workspace-files.ts 可测先例。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSafePath } from "../agent/file-tools";

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** 单目录上限（防超大目录卡 UI） */
export const LIST_DIR_LIMIT = 2000;

export async function listWorkspaceDir(
  rootDir: string,
  relPath: string,
): Promise<DirEntry[]> {
  const absDir = resolveSafePath(rootDir, relPath, false);
  const dirents = await fs.readdir(absDir, { withFileTypes: true });
  const visible = dirents
    .filter((d) => !d.name.startsWith("."))
    .slice(0, LIST_DIR_LIMIT);
  const stats = await Promise.all(
    visible.map((d) => fs.stat(path.join(absDir, d.name)).catch(() => null)),
  );
  return visible
    .map((d, i) => ({
      name: d.name,
      // symlink 指向目录时 stat 为目录，与展开行为一致
      isDir: stats[i]?.isDirectory() ?? d.isDirectory(),
      size: stats[i]?.size ?? 0,
      mtime: stats[i]?.mtimeMs ?? 0,
    }))
    .sort((a, b) =>
      a.isDir === b.isDir
        ? a.name.localeCompare(b.name, "zh-CN", { numeric: true })
        : a.isDir
          ? -1
          : 1,
    );
}
```

（若 `localeCompare` 排序使「自然序」用例不稳定，以实现为准调整测试断言顺序——保持 目录优先 + 字典序 即可。）

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run tests/ai/workspace-dir.test.ts
```

预期：PASS。

- [ ] **Step 5: session.repo.ts 注册通道**

① `registerIpcHandlers()` 内 `workspace:readFile` 注册块后追加：

```ts
    // 工作空间 tab 文件树：沙箱语义列目录（与 readFile 的 fullAccess
    // 双通道差异见 workspace-dir.ts 头注释）
    handleUser(
      "workspace:listDir",
      (_, userId, workspaceId: number, relPath: string) =>
        this.listWorkspaceDirById(workspaceId, relPath, userId),
    );
```

② `readWorkspaceFileById` 方法（约 526 行）后追加方法：

```ts
  /** DetailPanel 工作空间 tab：列目录（resolveSafePath 沙箱） */
  async listWorkspaceDirById(
    workspaceId: number,
    relPath: string,
    userId: number,
  ): Promise<DirEntry[]> {
    await this.assertWorkspaceOwned(workspaceId, userId);
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace?.directoryPath) throw new Error("工作空间未绑定目录");
    return listWorkspaceDir(workspace.directoryPath, relPath ?? "");
  }
```

③ 文件头部 import 区追加：

```ts
import { listWorkspaceDir, type DirEntry } from "./workspace-dir";
```

- [ ] **Step 6: typecheck + Commit**

```bash
npm run typecheck
git add electron/domains/ai/chat/workspace-dir.ts electron/domains/ai/chat/session.repo.ts tests/ai/workspace-dir.test.ts
git commit -m "feat(detail-panel): workspace:listDir 沙箱列目录通道"
```

---

### Task 5: detail-panel.store（TDD）

**Files:**
- Create: `src-react/domains/ai/chat/store/detail-panel.store.ts`
- Test: `tests/ai/detail-panel-store.test.ts`

**Interfaces:**
- Consumes: `useAiUiStore`（`src-react/domains/ai/store/ai-ui.store.ts`——`setArtifactsOpen`）
- Produces:

```ts
export type DetailTabKind = "artifacts" | "browser" | "workspace" | "terminal";
export interface DetailTab {
  id: string;
  kind: DetailTabKind;
  title: string;      // 已 i18n 的展示名（由调用方 t() 后传入）
  createdAt: number;
  url?: string;       // browser：空串=新标签页形态
  terminalId?: string;
}
export interface DetailPanelState {
  tabs: DetailTab[];
  activeTabId: string;
}
export const useDetailPanelStore: UseBoundStore<...>;
// actions（全部按 sessionId 作用域）：
//   openTab(sessionId, kind, title): string       // 新建并激活，返回 id
//   closeTab(sessionId, tabId): void              // 关闭后 active 切相邻；关空联动 setArtifactsOpen(false)
//   setActive(sessionId, tabId): void
//   syncTab(sessionId, tabId, partial: Partial<Pick<DetailTab, "url" | "terminalId">>): void
//   getStateOf(sessionId): DetailPanelState        // 无记录时返回 { tabs: [], activeTabId: "" }（不落记录）
```

- [ ] **Step 1: 写失败测试**

`tests/ai/detail-panel-store.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useDetailPanelStore } from "../../src-react/domains/ai/chat/store/detail-panel.store";
import { useAiUiStore } from "../../src-react/domains/ai/store/ai-ui.store";

const S1 = 1;
const S2 = 2;

beforeEach(() => {
  useDetailPanelStore.setState({});
  useAiUiStore.setState({ artifactsOpen: true });
});

describe("detail-panel store（sessionId 隔离）", () => {
  it("openTab 新建并激活；getStateOf 未初始化返回空态", () => {
    expect(useDetailPanelStore.getStateOf(S1).tabs).toEqual([]);
    const id = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ kind: "artifacts", title: "产物" });
    expect(state.activeTabId).toBe(id);
  });

  it("两个会话互不影响", () => {
    useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    useDetailPanelStore.getState().openTab(S2, "browser", "浏览器");
    expect(useDetailPanelStore.getStateOf(S1).tabs).toHaveLength(1);
    expect(useDetailPanelStore.getStateOf(S1).tabs[0].kind).toBe("terminal");
    expect(useDetailPanelStore.getStateOf(S2).tabs[0].kind).toBe("browser");
  });

  it("closeTab 关 active 切相邻；关最后一个联动收起右栏", () => {
    const a = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const b = useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    useDetailPanelStore.getState().closeTab(S1, b);
    let state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs.map((t) => t.id)).toEqual([a]);
    expect(state.activeTabId).toBe(a);
    useDetailPanelStore.getState().closeTab(S1, a);
    state = useDetailPanelStore.getStateOf(S1);
    expect(state.tabs).toEqual([]);
    expect(useAiUiStore.getState().artifactsOpen).toBe(false);
  });

  it("closeTab 关非 active 不改变 active", () => {
    const a = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const b = useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    useDetailPanelStore.getState().closeTab(S1, a);
    expect(useDetailPanelStore.getStateOf(S1).activeTabId).toBe(b);
  });

  it("syncTab 回写 url/terminalId 负载", () => {
    const id = useDetailPanelStore.getState().openTab(S1, "browser", "浏览器");
    useDetailPanelStore.getState().syncTab(S1, id, { url: "https://example.com" });
    expect(useDetailPanelStore.getStateOf(S1).tabs[0].url).toBe(
      "https://example.com",
    );
  });

  it("setActive 切换", () => {
    const a = useDetailPanelStore.getState().openTab(S1, "artifacts", "产物");
    const b = useDetailPanelStore.getState().openTab(S1, "terminal", "终端");
    useDetailPanelStore.getState().setActive(S1, a);
    expect(useDetailPanelStore.getStateOf(S1).activeTabId).toBe(a);
    expect(b).toBeTruthy();
  });
});
```

注意：`useDetailPanelStore.setState({})` 整表重置——store 以 `panels: Record<number, DetailPanelState>` 为根字段即可。

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/ai/detail-panel-store.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 store**

`src-react/domains/ai/chat/store/detail-panel.store.ts`：

```ts
/**
 * 会话右栏 DetailPanel tab 状态：sessionId 隔离（切会话各自保留，
 * 切回不丢——browser url / terminal pty id 存负载；组件重挂重建视图）。
 * 内存态不持久化（重启重置，同 browser.store 假设）。关到最后一个 tab
 * 联动 ai-ui 的 artifactsOpen 收起右栏。
 */
import { create } from "zustand";
import { useAiUiStore } from "../../store/ai-ui.store";

export type DetailTabKind = "artifacts" | "browser" | "workspace" | "terminal";

export interface DetailTab {
  id: string;
  kind: DetailTabKind;
  title: string;
  createdAt: number;
  /** browser：当前地址（空串/undefined = 新标签页形态） */
  url?: string;
  /** terminal：主进程 pty 会话 id（重挂续连凭据） */
  terminalId?: string;
}

export interface DetailPanelState {
  tabs: DetailTab[];
  activeTabId: string;
}

const EMPTY: DetailPanelState = { tabs: [], activeTabId: "" };

interface DetailPanelStore {
  panels: Record<number, DetailPanelState>;
  openTab: (sessionId: number, kind: DetailTabKind, title: string) => string;
  closeTab: (sessionId: number, tabId: string) => void;
  setActive: (sessionId: number, tabId: string) => void;
  syncTab: (
    sessionId: number,
    tabId: string,
    partial: Partial<Pick<DetailTab, "url" | "terminalId">>,
  ) => void;
}

export const useDetailPanelStore = create<DetailPanelStore & {
  getStateOf: (sessionId: number) => DetailPanelState;
}>((set, get) => ({
  panels: {},
  openTab: (sessionId, kind, title) => {
    const tab: DetailTab = {
      id: crypto.randomUUID(),
      kind,
      title,
      createdAt: Date.now(),
    };
    set((s) => {
      const prev = s.panels[sessionId] ?? EMPTY;
      return {
        panels: {
          ...s.panels,
          [sessionId]: {
            tabs: [...prev.tabs, tab],
            activeTabId: tab.id,
          },
        },
      };
    });
    return tab.id;
  },
  closeTab: (sessionId, tabId) => {
    const prev = get().panels[sessionId] ?? EMPTY;
    if (!prev.tabs.some((t) => t.id === tabId)) return;
    const idx = prev.tabs.findIndex((t) => t.id === tabId);
    const tabs = prev.tabs.filter((t) => t.id !== tabId);
    if (tabs.length === 0) {
      // 关空：移除记录并联动收起右栏（等价 artifactsOpen=false）
      set((s) => {
        const panels = { ...s.panels };
        delete panels[sessionId];
        return { panels };
      });
      useAiUiStore.getState().setArtifactsOpen(false);
      return;
    }
    const activeTabId =
      prev.activeTabId === tabId
        ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? tabs[0].id)
        : prev.activeTabId;
    set((s) => ({
      panels: {
        ...s.panels,
        [sessionId]: { tabs, activeTabId },
      },
    }));
  },
  setActive: (sessionId, tabId) =>
    set((s) => {
      const prev = s.panels[sessionId] ?? EMPTY;
      if (!prev.tabs.some((t) => t.id === tabId)) return s;
      return {
        panels: { ...s.panels, [sessionId]: { ...prev, activeTabId: tabId } },
      };
    }),
  syncTab: (sessionId, tabId, partial) =>
    set((s) => {
      const prev = s.panels[sessionId] ?? EMPTY;
      if (!prev.tabs.some((t) => t.id === tabId)) return s;
      return {
        panels: {
          ...s.panels,
          [sessionId]: {
            ...prev,
            tabs: prev.tabs.map((t) =>
              t.id === tabId ? { ...t, ...partial } : t,
            ),
          },
        },
      };
    }),
  getStateOf: (sessionId) => get().panels[sessionId] ?? EMPTY,
}));
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run tests/ai/detail-panel-store.test.ts
```

预期：PASS（6 个用例）。

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/chat/store/detail-panel.store.ts tests/ai/detail-panel-store.test.ts
git commit -m "feat(detail-panel): sessionId 隔离的右栏 tab store"
```

---

### Task 6: DetailPanel 骨架与产物 tab 等价迁移

**Files:**
- Create: `src-react/domains/ai/chat/components/detail-panel/DetailPanel.tsx`
- Create: `src-react/domains/ai/chat/components/detail-panel/DetailTabBar.tsx`
- Create: `src-react/domains/ai/chat/components/detail-panel/NewTabMenu.tsx`
- Modify: `src-react/domains/ai/chat/components/artifacts/ArtifactsPanel.tsx`（瘦身，导出改名）
- Modify: `src-react/domains/ai/chat/views/ChatView.tsx:196-206`（ArtifactsPanel → DetailPanel）
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`src-react/i18n/locales/en-US/chat.json`
- Test: `tests/ai/detail-tab-bar.test.tsx`

**Interfaces:**
- Consumes: `useDetailPanelStore`（Task 5）、`useAiUiStore.artifactsOpen`
- Produces:

```tsx
// DetailPanel.tsx
export default function DetailPanel(props: {
  sessionId: number;
  workspaceId: number;
  topSection?: ReactNode;
}): JSX.Element;
// ArtifactsPanel.tsx：export default function ArtifactsTab(props: {
//   sessionId: number; workspaceId: number; topSection?: ReactNode;
// }): JSX.Element  （导出名从 ArtifactsPanel 改为 ArtifactsTab）
```

本任务完成后右栏为 tab 式外壳 + 仅产物 tab 可用（+ 菜单三项目前只创建空 tab，browser/workspace/terminal 内容组件在 Task 7/8/9 接入；接入前内容区对这三类 kind 渲染占位「开发中」空态并注释 TODO 属**临时允许**，后续任务替换）。

- [ ] **Step 1: 写 DetailTabBar 失败测试**

`tests/ai/detail-tab-bar.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * DetailTabBar 交互：渲染/切换/关闭回调。kind→图标映射内部消化不测视觉。
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DetailTabBar from "../../src-react/domains/ai/chat/components/detail-panel/DetailTabBar";

const TABS = [
  { id: "a", kind: "artifacts", title: "产物", createdAt: 1 },
  { id: "b", kind: "terminal", title: "终端", createdAt: 2 },
] as const;

describe("DetailTabBar", () => {
  it("渲染各 tab 标题，active 高亮 aria-selected", () => {
    render(
      <DetailTabBar
        tabs={[...TABS]}
        activeTabId="a"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const tabA = screen.getByRole("tab", { name: /产物/ });
    expect(tabA).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("tab", { name: /终端/ }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("点击 tab 触发 onSelect，点关闭触发 onClose 且不冒泡 onSelect", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <DetailTabBar
        tabs={[...TABS]}
        activeTabId="a"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /终端/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByRole("button", { name: /关闭标签页/ }));
    expect(onClose).toHaveBeenCalledWith("b");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/ai/detail-tab-bar.test.tsx
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 DetailTabBar / NewTabMenu / DetailPanel，瘦身 ArtifactsPanel**

`DetailTabBar.tsx`：

```tsx
/**
 * 右栏 tab 条：图标 + 标题 + 悬停关闭（参照 BrowserTabBar 交互形态，
 * 紧凑 h-7）。多 tab 横向滚动（右栏 340px 内），「+」由 NewTabMenu 提供
 * （外层并排，本组件不含）。
 */
import { useTranslation } from "react-i18next";
import {
  FolderTree,
  Globe,
  Package,
  SquareTerminal,
  X,
} from "lucide-react";
import type { DetailTab, DetailTabKind } from "../../store/detail-panel.store";

const KIND_ICON: Record<DetailTabKind, typeof Globe> = {
  artifacts: Package,
  browser: Globe,
  workspace: FolderTree,
  terminal: SquareTerminal,
};

interface DetailTabBarProps {
  tabs: DetailTab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

export default function DetailTabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
}: DetailTabBarProps) {
  const { t } = useTranslation(["chat"]);
  return (
    <div
      role="tablist"
      aria-label={t("chat:detailPanel.tabs")}
      className="flex min-w-0 items-center gap-1 overflow-x-auto"
    >
      {tabs.map((tab) => {
        const Icon = KIND_ICON[tab.kind];
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            aria-label={tab.title}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(tab.id);
            }}
            className={`group flex h-7 max-w-32 min-w-20 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs ${
              active
                ? "border-primary/30 bg-primary-subtle text-primary"
                : "border-transparent text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{tab.title}</span>
            <button
              type="button"
              aria-label={t("chat:detailPanel.closeTab")}
              title={t("chat:detailPanel.closeTab")}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-primary-subtle"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

`NewTabMenu.tsx`：

```tsx
/**
 * 右栏「+」新 tab 菜单：产物/打开浏览器/查看工作空间/打开终端（产物项
 * 供关闭后重开，WorkBuddy 无此项的天枢补充）。
 */
import { useTranslation } from "react-i18next";
import { FolderTree, Globe, Package, Plus, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DetailTabKind } from "../../store/detail-panel.store";

interface NewTabMenuProps {
  onOpen: (kind: DetailTabKind) => void;
}

const KIND_LABEL: Record<DetailTabKind, string> = {
  artifacts: "chat:detailPanel.openArtifacts",
  browser: "chat:detailPanel.openBrowser",
  workspace: "chat:detailPanel.openWorkspaceFiles",
  terminal: "chat:detailPanel.openTerminal",
};

const KIND_ICON: Record<DetailTabKind, typeof Globe> = {
  artifacts: Package,
  browser: Globe,
  workspace: FolderTree,
  terminal: SquareTerminal,
};

export default function NewTabMenu({ onOpen }: NewTabMenuProps) {
  const { t } = useTranslation(["chat"]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("chat:detailPanel.newTab")}
          title={t("chat:detailPanel.newTab")}
          className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-primary"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="border border-border/50 rounded-lg shadow-lg"
      >
        {(Object.keys(KIND_LABEL) as DetailTabKind[]).map((kind) => {
          const Icon = KIND_ICON[kind];
          return (
            <DropdownMenuItem key={kind} onClick={() => onOpen(kind)}>
              <Icon className="h-3.5 w-3.5" />
              {t(KIND_LABEL[kind])}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

`DetailPanel.tsx`：

```tsx
/**
 * 会话右栏（tab 式，参照 WorkBuddy detailPanel）：tab 条 +「+」菜单 +
 * 内容区路由。外壳（340px 列宽/左边框/TopBar 宽度注册/收起整体移除）
 * 沿袭原 ArtifactsPanel 语义；产物内容瘦身为 ArtifactsTab。
 * tab 状态 sessionId 隔离（detail-panel.store）；内容区渲染当前会话
 * 全部 tab（display 隐藏非 active——webview/xterm 常驻保状态，切会话
 * 卸载由 store 负载恢复 url/terminalId）。
 */
import { useEffect, useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAiUiStore } from "../../../store/ai-ui.store";
import {
  useDetailPanelStore,
  type DetailTabKind,
} from "../../store/detail-panel.store";
import ArtifactsTab from "../artifacts/ArtifactsPanel";
import DetailTabBar from "./DetailTabBar";
import NewTabMenu from "./NewTabMenu";

interface DetailPanelProps {
  sessionId: number;
  workspaceId: number;
  topSection?: ReactNode;
}

export default function DetailPanel({
  sessionId,
  workspaceId,
  topSection,
}: DetailPanelProps) {
  const { t } = useTranslation(["chat"]);
  const state = useDetailPanelStore((s) => s.panels[sessionId]);
  const openTab = useDetailPanelStore((s) => s.openTab);
  const closeTab = useDetailPanelStore((s) => s.closeTab);
  const setActive = useDetailPanelStore((s) => s.setActive);

  // 顶部工具栏右段宽度注册（原 ArtifactsPanel 语义原样迁移）：340 与本
  // 面板列宽 w-[340px] 同步维护
  const panelId = useId();
  useEffect(() => {
    useAiUiStore.getState().registerTopbarRightWidth(panelId, 340);
    return () => useAiUiStore.getState().unregisterTopbarRightWidth(panelId);
  }, [panelId]);

  const tabs = state?.tabs ?? [];
  const activeTabId = state?.activeTabId ?? "";

  const handleOpen = (kind: DetailTabKind) => {
    openTab(sessionId, kind, t(`chat:detailPanel.${kind}`));
  };

  const handleClose = (tabId: string) => {
    // 终端 tab：先显式 kill pty（切会话卸载不 kill，仅关闭时杀）
    const tab = tabs.find((item) => item.id === tabId);
    if (tab?.terminalId) {
      window.ipcRenderer?.send("terminal:kill", tab.terminalId);
    }
    closeTab(sessionId, tabId);
  };

  return (
    // 挤压式右列：shrink-0 占位，收起时由外层整体移除
    <div className="flex w-[340px] shrink-0 flex-col border-l border-border/50 bg-background">
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
        <DetailTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={(tabId) => setActive(sessionId, tabId)}
          onClose={handleClose}
        />
        <NewTabMenu onOpen={handleOpen} />
      </div>
      <div className="min-h-0 flex-1">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const style = { display: active ? "flex" : "none" };
          return (
            <div key={tab.id} className="h-full min-h-0" style={style}>
              {tab.kind === "artifacts" ? (
                <ArtifactsTab
                  sessionId={sessionId}
                  workspaceId={workspaceId}
                  topSection={topSection}
                />
              ) : tab.kind === "browser" ? (
                // Task 7 接入 BrowserPanelTab（临时占位）
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  {t("chat:detailPanel.browser")}
                </div>
              ) : tab.kind === "workspace" ? (
                // Task 8 接入 WorkspaceFileTree（临时占位）
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  {t("chat:detailPanel.workspace")}
                </div>
              ) : (
                // Task 9 接入 TerminalTab（临时占位）
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  {t("chat:detailPanel.terminal")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

`ArtifactsPanel.tsx` 瘦身（原文件改动点，保留文件位置与其余实现不动）：
1. 默认导出函数 `ArtifactsPanel` 改名 `ArtifactsTab`，文件头注释第一行改为「产物 tab 内容（原右栏面板瘦身为 DetailPanel 的 tab 内容）：…」
2. 删除：外壳 `<div className="flex w-[340px] shrink-0 flex-col border-l ...">` 与 tab 条行的容器职责——函数返回改为最外层 `<>` 直接包原「视图 dropdown 头 + 内容区滚动体」两块（即删掉原 106 行外层 div 与 187-195 行全屏预览以外的外壳包装，全屏预览 FilePreview 保留）
3. 删除 `panelId`/`registerTopbarRightWidth` 段（已迁 DetailPanel）
4. `ArtifactsPanelToggle`（200-223 行）**原样保留在此文件**（ChatView 仍在用）
5. import 清理：删 `PanelRightClose/PanelRightOpen` 之外不再使用的项（Button 若 Toggle 还用则保留）

`ChatView.tsx` 接线（196-206 行）：

```tsx
      {/* 右列 tab 面板（原产物面板升级，与项目详情右栏同构）：全高挤压式，
          收起时整体移除；任务会话顶部挂「任务概览」折叠区（仅 planItemId 非空） */}
      {selectedSession && artifactsOpen && paneWorkspace && (
        <DetailPanel
          sessionId={selectedSession.id}
          workspaceId={paneWorkspace.id}
          topSection={
            projectId != null && planItem ? (
              <TaskOverview planItem={planItem} projectId={projectId} />
            ) : undefined
          }
        />
      )}
```

import 区将 `import ArtifactsPanel, { ArtifactsPanelToggle } from "../components/artifacts/ArtifactsPanel";` 改为：

```tsx
import { ArtifactsPanelToggle } from "../components/artifacts/ArtifactsPanel";
import DetailPanel from "../components/detail-panel/DetailPanel";
```

- [ ] **Step 4: i18n 词条**

`src-react/i18n/locales/zh-CN/chat.json` 增加（顶层新增 `detailPanel` 对象；注意项目规范禁止顶层 key 与嵌套 key 重名）：

```json
  "detailPanel": {
    "newTab": "新标签页",
    "tabs": "面板标签页",
    "closeTab": "关闭标签页",
    "openArtifacts": "产物",
    "openBrowser": "打开浏览器",
    "openWorkspaceFiles": "查看工作空间",
    "openTerminal": "打开终端",
    "artifacts": "产物",
    "browser": "浏览器",
    "workspace": "工作空间",
    "terminal": "终端",
    "terminalExited": "终端已退出",
    "terminalReopen": "重新打开",
    "terminalCreateFailed": "终端创建失败",
    "workspaceBindHint": "该工作空间未绑定目录，请先在左侧空间菜单绑定目录",
    "loadDirFailed": "目录读取失败"
  },
```

`src-react/i18n/locales/en-US/chat.json` 同键：

```json
  "detailPanel": {
    "newTab": "New tab",
    "tabs": "Panel tabs",
    "closeTab": "Close tab",
    "openArtifacts": "Artifacts",
    "openBrowser": "Open browser",
    "openWorkspaceFiles": "View workspace",
    "openTerminal": "Open terminal",
    "artifacts": "Artifacts",
    "browser": "Browser",
    "workspace": "Workspace",
    "terminal": "Terminal",
    "terminalExited": "Terminal exited",
    "terminalReopen": "Reopen",
    "terminalCreateFailed": "Failed to create terminal",
    "workspaceBindHint": "This workspace has no bound directory. Bind one in the workspace menu first",
    "loadDirFailed": "Failed to read directory"
  },
```

- [ ] **Step 5: 运行测试与 typecheck**

```bash
npx vitest run tests/ai/detail-tab-bar.test.tsx && npm run typecheck
```

预期：tab bar 测试 PASS；typecheck 无错（ArtifactsPanel 改名后全仓引用已同步——仅 ChatView 一处，见 git status 检查 `grep -rn "ArtifactsPanel" src-react`，除 Toggle/文件名注释外不应有残留默认导入）。

- [ ] **Step 6: 全量测试防回归**

```bash
npm run test
```

预期：全绿（重点：既有 artifacts 相关测试若 import 默认导出需同步改名——`grep -rn "from.*artifacts/ArtifactsPanel" tests src-react` 排查）。

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/ai/chat/components/detail-panel/ src-react/domains/ai/chat/components/artifacts/ArtifactsPanel.tsx src-react/domains/ai/chat/views/ChatView.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json tests/ai/detail-tab-bar.test.tsx
git commit -m "feat(detail-panel): 右栏 tab 式外壳与产物 tab 等价迁移"
```

---

### Task 7: 浏览器 tab

**Files:**
- Modify: `src-react/domains/ai/browser/components/BrowserToolbar.tsx:23-66`（onSync 参数化）
- Create: `src-react/domains/ai/chat/components/detail-panel/BrowserPanelTab.tsx`
- Modify: `src-react/domains/ai/chat/components/detail-panel/DetailPanel.tsx`（占位替换）

**Interfaces:**
- Consumes: `BrowserWebview`（props: `tab: BrowserTab; isActive: boolean; registerRef: (id, node|null) => void; onSync: (partial: Partial<BrowserTab>) => void`）、`NewTabPage`、`resolveAddressInput`、`useBrowserStore.BrowserTab` 类型
- Produces: `export default function BrowserPanelTab(props: { tab: DetailTab; isActive: boolean }): JSX.Element`（DetailTab 来自 detail-panel.store）

- [ ] **Step 1: BrowserToolbar onSync 参数化**

`BrowserToolbar.tsx`：

接口追加（23 行后）：

```ts
  /** url 提交通道：缺省回落全局 browser store（/module/ai/browser 页行为不变）；
   *  DetailPanel 内嵌时传右栏 tab 负载回写 */
  onSync?: (partial: Partial<BrowserTab>) => void;
```

`submit` 内 62 行 `useBrowserStore.getState().syncTab(tab.id, { url });` 改为：

```ts
      if (onSync) {
        onSync({ url });
      } else {
        useBrowserStore.getState().syncTab(tab.id, { url });
      }
```

（组件参数解构处加入 `onSync`；`useBrowserStore` import 若仅剩类型使用则改为 `import type`。）

- [ ] **Step 2: 实现 BrowserPanelTab**

`BrowserPanelTab.tsx`：

```tsx
/**
 * 右栏浏览器 tab：BrowserToolbar + BrowserWebview/NewTabPage 组合（props
 * 驱动复用 ai/browser 域组件，不接全局 browser.store——tab 负载 url 存
 * detail-panel.store，其余瞬时状态本地持有；重挂按 url 恢复）。
 * partition 与浏览器页共享（登录态/安全守卫自动生效，spec §4）。
 */
import { useCallback, useRef, useState } from "react";
import type { BrowserTab } from "@/domains/ai/browser/store/browser.store";
import BrowserToolbar from "@/domains/ai/browser/components/BrowserToolbar";
import BrowserWebview from "@/domains/ai/browser/components/BrowserWebview";
import { useDetailPanelStore, type DetailTab } from "../../store/detail-panel.store";

interface BrowserPanelTabProps {
  sessionId: number;
  tab: DetailTab;
  isActive: boolean;
}

export default function BrowserPanelTab({
  sessionId,
  tab,
  isActive,
}: BrowserPanelTabProps) {
  const syncTab = useDetailPanelStore((s) => s.syncTab);
  // 完整 BrowserTab 形状本地持有（title/favicon 等瞬时态）；url 以 store
  // 负载为源（syncTab 回写后经 props 回流保持一致）
  const [browserTab, setBrowserTab] = useState<BrowserTab>(() => ({
    id: tab.id,
    url: tab.url ?? "",
    title: "",
    favicon: "",
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  }));
  const webviewRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerRef = useCallback((id: string, node: HTMLElement | null) => {
    if (node) webviewRefs.current.set(id, node);
    else webviewRefs.current.delete(id);
  }, []);

  const handleSync = useCallback(
    (partial: Partial<BrowserTab>) => {
      setBrowserTab((prev) => ({ ...prev, ...partial }));
      // url 变化回写 store 负载（重挂恢复凭据）
      if (typeof partial.url === "string" && partial.url !== (tab.url ?? "")) {
        syncTab(sessionId, tab.id, { url: partial.url });
      }
    },
    [sessionId, tab.id, tab.url, syncTab],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <BrowserToolbar
        tab={browserTab}
        getWebviewNode={() => webviewRefs.current.get(tab.id) ?? null}
        onSync={handleSync}
      />
      <div className="min-h-0 flex-1">
        <BrowserWebview
          tab={browserTab}
          isActive={isActive}
          registerRef={registerRef}
          onSync={handleSync}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: DetailPanel 占位替换**

`DetailPanel.tsx` 中 browser 占位分支替换为：

```tsx
              ) : tab.kind === "browser" ? (
                <BrowserPanelTab sessionId={sessionId} tab={tab} isActive={active} />
```

（import 区补 `import BrowserPanelTab from "./BrowserPanelTab";`。）

- [ ] **Step 4: typecheck + 全量测试**

```bash
npm run typecheck && npm run test
```

预期：通过（BrowserToolbar 参数化为可选参数，浏览器页测试若有直接渲染 BrowserToolbar 的用例应不受影响——`grep -rn "BrowserToolbar" tests` 确认）。

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/browser/components/BrowserToolbar.tsx src-react/domains/ai/chat/components/detail-panel/
git commit -m "feat(detail-panel): 浏览器 tab——复用 browser 域组件 props 驱动"
```

---

### Task 8: 工作空间 tab（文件树）

**Files:**
- Modify: `src-react/domains/ai/api/workspace.api.ts`（追加 listDir）
- Create: `src-react/domains/ai/chat/components/detail-panel/WorkspaceFileTree.tsx`
- Create: `src-react/domains/ai/chat/components/detail-panel/FileTreeNode.tsx`
- Modify: `src-react/domains/ai/chat/components/detail-panel/DetailPanel.tsx`（占位替换 + workspace 详情 props）

**Interfaces:**
- Consumes: `WorkspaceRecord`（含 `directoryPath`）、`FilePreview`（props: `file: SessionFile; workspaceId: number; onBack: () => void; fullscreen: boolean; onToggleFullscreen: () => void`）、Task 4 的 `workspace:listDir`（返回 `DirEntry[]`）
- Produces: `WorkspaceApi.listDir(workspaceId: number, relPath: string): Promise<DirEntry[]>`；`export default function WorkspaceFileTree(props: { workspace: WorkspaceRecord }): JSX.Element`

- [ ] **Step 1: WorkspaceApi.listDir**

`workspace.api.ts`（WorkspaceRecord 接口后追加）：

```ts
export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}
```

`WorkspaceApi` 类内追加（照既有方法 invoke 模式）：

```ts
  /** DetailPanel 工作空间 tab：列目录（沙箱语义，主进程 workspace-dir.ts） */
  static listDir(workspaceId: number, relPath: string): Promise<DirEntry[]> {
    return invoke<DirEntry[]>("workspace:listDir", workspaceId, relPath);
  }
```

（若该类现有方法为实例方法则保持同风格实例方法；`invoke` 已在同文件 import。）

- [ ] **Step 2: 实现 FileTreeNode + WorkspaceFileTree**

`FileTreeNode.tsx`：

```tsx
/**
 * 文件树递归节点：目录展开懒加载（按需 listDir），文件点击进入预览。
 * 展开态与子项缓存在 WorkspaceFileTree 的树状态里（本组件纯受控）。
 */
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, File as FileIcon, Folder } from "lucide-react";
import type { DirEntry } from "@/domains/ai/api/workspace.api";

export interface TreeState {
  expanded: Set<string>;
  children: Map<string, DirEntry[]>;
}

interface FileTreeNodeProps {
  entry: DirEntry;
  dirPath: string; // 当前目录相对工作空间根的路径（"" 为根）
  tree: TreeState;
  loading: Set<string>;
  onToggle: (dirPath: string) => void;
  onOpenFile: (relPath: string) => void;
}

export default function FileTreeNode({
  entry,
  dirPath,
  tree,
  loading,
  onToggle,
  onOpenFile,
}: FileTreeNodeProps) {
  const { t } = useTranslation(["chat"]);
  const relPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
  const isOpen = tree.expanded.has(relPath);

  if (!entry.isDir) {
    return (
      <button
        type="button"
        onClick={() => onOpenFile(relPath)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
      >
        <FileIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{entry.name}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => onToggle(relPath)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-primary-subtle hover:text-primary"
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{entry.name}</span>
        {loading.has(relPath) && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            …
          </span>
        )}
      </button>
      {isOpen && (
        <div className="ml-3 border-l border-border/50 pl-1">
          {(tree.children.get(relPath) ?? []).map((child) => (
            <FileTreeNode
              key={child.name}
              entry={child}
              dirPath={relPath}
              tree={tree}
              loading={loading}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))}
          {loading.has(relPath) && (
            <p className="px-1.5 py-1 text-[10px] text-muted-foreground">
              {t("chat:detailPanel.loadingDir")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
```

`WorkspaceFileTree.tsx`：

```tsx
/**
 * 工作空间 tab：目录树（懒加载）+ 文件预览（复用产物面板 FilePreview，
 * 构造 SessionFile）。未绑定目录时空态引导（绑定入口在左侧空间菜单）。
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderSearch } from "lucide-react";
import { WorkspaceApi, type DirEntry, type WorkspaceRecord } from "../../../api/workspace.api";
import FilePreview from "../artifacts/FilePreview";
import type { SessionFile } from "../../lib/artifacts";
import { mapIpcError } from "../../lib/error-message";
import FileTreeNode, { type TreeState } from "./FileTreeNode";

interface WorkspaceFileTreeProps {
  workspace: WorkspaceRecord;
}

export default function WorkspaceFileTree({
  workspace,
}: WorkspaceFileTreeProps) {
  const { t } = useTranslation(["chat"]);
  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [tree, setTree] = useState<TreeState>({
    expanded: new Set(),
    children: new Map(),
  });
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [previewFile, setPreviewFile] = useState<SessionFile | null>(null);

  const loadDir = useCallback(async (relPath: string) => {
    setLoading((prev) => new Set(prev).add(relPath));
    try {
      const entries = await WorkspaceApi.listDir(workspace.id, relPath);
      setTree((prev) => {
        const children = new Map(prev.children).set(relPath, entries);
        const expanded = new Set(prev.expanded).add(relPath);
        return { expanded, children };
      });
    } catch (e) {
      toast.error(mapIpcError(e) || t("chat:detailPanel.loadDirFailed"));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(relPath);
        return next;
      });
    }
  }, [workspace.id, t]);

  // 首次挂载拉根目录
  if (rootEntries === null && !loading.has("")) {
    void loadDir("").then(() => undefined);
    setRootEntries([]);
    loadDir("").then(setRootEntries).catch(() => {});
  }

  const handleToggle = useCallback(
    (relPath: string) => {
      if (tree.expanded.has(relPath)) {
        setTree((prev) => {
          const expanded = new Set(prev.expanded);
          expanded.delete(relPath);
          return { ...prev, expanded };
        });
        return;
      }
      if (tree.children.has(relPath)) {
        setTree((prev) => {
          const expanded = new Set(prev.expanded).add(relPath);
          return { ...prev, expanded };
        });
      } else {
        void loadDir(relPath);
      }
    },
    [tree.expanded, tree.children, loadDir],
  );

  const handleOpenFile = useCallback((relPath: string) => {
    setPreviewFile({
      path: relPath,
      group: "workspace",
      status: "written",
      messageId: 0,
    });
  }, []);

  if (!workspace.directoryPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
        <FolderSearch className="h-8 w-8" />
        <p className="text-xs">{t("chat:detailPanel.workspaceBindHint")}</p>
      </div>
    );
  }

  if (previewFile) {
    return (
      <div className="h-full">
        <FilePreview
          file={previewFile}
          workspaceId={workspace.id}
          onBack={() => setPreviewFile(null)}
          fullscreen={false}
          onToggleFullscreen={() => {}}
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2">
      {(rootEntries ?? (tree.children.get("") as DirEntry[] | undefined) ?? []).map(
        (entry) => (
          <FileTreeNode
            key={entry.name}
            entry={entry}
            dirPath=""
            tree={tree}
            loading={loading}
            onToggle={handleToggle}
            onOpenFile={handleOpenFile}
          />
        ),
      )}
    </div>
  );
}
```

**实现注意**：上面「首次挂载拉根目录」的渲染期副作用写法是反模式——落地时改为 `useEffect(() => { void loadDir(""); }, [loadDir])`，根 entries 直接从 `tree.children.get("")` 读（删掉 rootEntries state），测试用例按此实现。i18n 词条补充 `detailPanel.loadingDir`（zh「加载中…」/ en "Loading…"）。

- [ ] **Step 3: DetailPanel 接入 + workspace 详情传递**

`DetailPanel.tsx`：
1. props 追加 `workspace: WorkspaceRecord | null`（ChatView 传 `activeWorkspace`；项目资产会话拿不到完整记录时为 null → workspace tab 显示绑定引导空态）
2. workspace 占位分支替换：

```tsx
              ) : tab.kind === "workspace" ? (
                workspace ? (
                  <WorkspaceFileTree workspace={workspace} />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {t("chat:detailPanel.workspaceBindHint")}
                  </div>
                )
```

`ChatView.tsx`：DetailPanel 调用处追加 `workspace={activeWorkspace}`（activeWorkspace 类型 `WorkspaceRecord | null` 恰好匹配；paneWorkspace 的 `{ id }` 兜底场景由 props 允许 null 表达）。

- [ ] **Step 4: typecheck + 全量测试 + Commit**

```bash
npm run typecheck && npm run test
git add src-react/domains/ai/api/workspace.api.ts src-react/domains/ai/chat/components/detail-panel/ src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json src-react/domains/ai/chat/views/ChatView.tsx
git commit -m "feat(detail-panel): 工作空间 tab——懒加载文件树与预览复用"
```

---

### Task 9: 终端 tab

**Files:**
- Create: `src-react/domains/ai/terminal/api/terminal.api.ts`
- Create: `src-react/domains/ai/chat/components/detail-panel/TerminalTab.tsx`
- Modify: `src-react/domains/ai/chat/components/detail-panel/DetailPanel.tsx`（占位替换 + cwd 计算）

**Interfaces:**
- Consumes: Task 3 的 IPC 通道（`terminal:create` invoke 返回 id；`terminal:write/resize/kill` send；事件 `terminal:data:<id>`/`terminal:exit:<id>`）、Task 5 `DetailTab.terminalId` 负载与 `syncTab`
- Produces:

```ts
// terminal.api.ts
export class TerminalApi {
  static create(cwd: string): Promise<string>;
  static write(id: string, data: string): void;
  static resize(id: string, cols: number, rows: number): void;
  static kill(id: string): void;
}
// TerminalTab.tsx
export default function TerminalTab(props: {
  sessionId: number;
  tab: DetailTab;
  isActive: boolean;
  cwd: string;
}): JSX.Element;
```

- [ ] **Step 1: terminal.api.ts**

`src-react/domains/ai/terminal/api/terminal.api.ts`：

```ts
/**
 * 终端 IPC 封装：create 走 invoke（鉴权 + 拿 id）；write/resize/kill 高频
 * 走 send。数据/退出经 terminal:data:<id> / terminal:exit:<id> 事件订阅
 * （TerminalTab 内 on()）。
 */
import { invoke, send } from "@/lib/ipc";

export class TerminalApi {
  static create(cwd: string): Promise<string> {
    return invoke<string>("terminal:create", cwd);
  }

  static write(id: string, data: string): void {
    send("terminal:write", id, data);
  }

  static resize(id: string, cols: number, rows: number): void {
    send("terminal:resize", id, cols, rows);
  }

  static kill(id: string): void {
    send("terminal:kill", id);
  }
}

export default TerminalApi;
```

- [ ] **Step 2: 实现 TerminalTab**

`TerminalTab.tsx`：

```tsx
/**
 * 终端 tab：@xterm/xterm + fit addon。terminalId 存 DetailTab 负载——
 * 切会话卸载重挂后按负载续连（pty 存活续流，xterm 回滚缓冲重置，spec §3）；
 * 进程退出显示退出态 + 重新打开（换新 terminalId）。主题取 CSS 变量
 * --color-*（Tailwind 4，值可为任意 CSS 颜色函数），跟随 4 主题。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { RotateCw, SquareTerminal } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { on } from "@/lib/ipc";
import TerminalApi from "@/domains/ai/terminal/api/terminal.api";
import { mapIpcError } from "../../lib/error-message";
import { useDetailPanelStore, type DetailTab } from "../../store/detail-panel.store";

interface TerminalTabProps {
  sessionId: number;
  tab: DetailTab;
  isActive: boolean;
  cwd: string;
}

/** 读主题 CSS 变量：值形如 hsl(...)/oklch(...) 直接用，空值回落 */
function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

export default function TerminalTab({
  sessionId,
  tab,
  isActive,
  cwd,
}: TerminalTabProps) {
  const { t } = useTranslation(["chat"]);
  const syncTab = useDetailPanelStore((s) => s.syncTab);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(
    tab.terminalId ?? null,
  );
  const [exited, setExited] = useState(false);
  const [failed, setFailed] = useState(false);

  // 创建（或按负载续连）+ xterm 实例 + 事件订阅：terminalId 生命周期内一次
  useEffect(() => {
    const container = containerRef.current;
    if (!container || terminalId === null || exited) return;

    const term = new Terminal({
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: cssColor("--color-background", "#1f1f1f"),
        foreground: cssColor("--color-foreground", "#cccccc"),
        cursor: cssColor("--color-primary", "#22cba8"),
        selectionBackground: cssColor("--color-primary", "#22cba8"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // 容器尺寸为 0（隐藏 tab）忽略，激活时 refit
    }
    termRef.current = term;
    fitRef.current = fit;

    const offData = on(`terminal:data:${terminalId}`, (_event, data) => {
      if (typeof data === "string") term.write(data);
    });
    const offExit = on(`terminal:exit:${terminalId}`, () => setExited(true));
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        TerminalApi.resize(terminalId, term.cols, term.rows);
      } catch {
        // 隐藏时 fit 抛错忽略
      }
    });
    resizeObserver.observe(container);
    term.onData((data) => TerminalApi.write(terminalId, data));

    return () => {
      resizeObserver.disconnect();
      offData();
      offExit();
      term.dispose();
      termRef.current = null;
    };
  }, [terminalId, exited]);

  // 首次进入：无负载则创建 pty 并回写负载（failed 入守卫/依赖——失败态
  // reopen 置 failed=false 触发重试；失败瞬间 effect 空转由守卫挡住）
  useEffect(() => {
    if (terminalId !== null || exited || failed) return;
    let cancelled = false;
    TerminalApi.create(cwd)
      .then((id) => {
        if (cancelled) {
          TerminalApi.kill(id);
          return;
        }
        setTerminalId(id);
        syncTab(sessionId, tab.id, { terminalId: id });
      })
      .catch((e) => {
        if (!cancelled) {
          setFailed(true);
          toast.error(
            `${t("chat:detailPanel.terminalCreateFailed")}: ${mapIpcError(e)}`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [terminalId, exited, failed, cwd, sessionId, tab.id, syncTab, t]);

  // tab 激活时 refit（隐藏期容器尺寸变化不触发 observer 的场景兜底）
  useEffect(() => {
    if (isActive && fitRef.current) {
      try {
        fitRef.current.fit();
        if (terminalId) {
          TerminalApi.resize(
            terminalId,
            termRef.current?.cols ?? 80,
            termRef.current?.rows ?? 24,
          );
        }
      } catch {
        // 忽略
      }
    }
  }, [isActive, terminalId]);

  const reopen = () => {
    setExited(false);
    setFailed(false);
    setTerminalId(null); // 触发创建 effect 换新 id
  };

  if (failed || exited) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <SquareTerminal className="h-8 w-8" />
        <p className="text-xs">
          {failed
            ? t("chat:detailPanel.terminalCreateFailed")
            : t("chat:detailPanel.terminalExited")}
        </p>
        <button
          type="button"
          onClick={reopen}
          className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        >
          <RotateCw className="h-3.5 w-3.5" />
          {t("chat:detailPanel.terminalReopen")}
        </button>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full min-h-0 w-full p-1" />;
}
```

- [ ] **Step 3: DetailPanel 接入**

`DetailPanel.tsx` terminal 占位分支替换：

```tsx
              ) : (
                <TerminalTab
                  sessionId={sessionId}
                  tab={tab}
                  isActive={active}
                  cwd={workspace?.directoryPath ?? ""}
                />
              )}
```

`TerminalTab` 内部 cwd 空串时主进程侧处理：`terminal-ipc.ts` 的 create handler 前置一行（`const cwdSafe = typeof cwd === "string" && cwd ? cwd : os.homedir();`，import `os`）。

- [ ] **Step 4: typecheck + 全量测试**

```bash
npm run typecheck && npm run test
```

预期：通过（xterm jsdom 不可跑，TerminalTab 不设组件测试；逻辑集中在已测的 terminal-core/store）。

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/terminal/ src-react/domains/ai/chat/components/detail-panel/ electron/domains/ai/terminal/terminal-ipc.ts
git commit -m "feat(detail-panel): 终端 tab——xterm 续连/退出重开/主题跟随"
```

---

### Task 10: 全量验证与手动冒烟

**Files:** 无新增（验证任务）

- [ ] **Step 1: lint + typecheck + 全量测试**

```bash
npm run lint && npm run typecheck && npm run test
```

预期：三者全绿。

- [ ] **Step 2: dev 启动手动冒烟**

```bash
npm run dev
```

手测清单（GUI 驱动可参照 memory 的 nohup dev + playwright-core 法，或直接人工点验）：
1. 选中会话 → 顶行开关展开右栏 → 默认只有「产物」tab，三视图 dropdown 正常
2. 「+」→ 打开终端：`pwd` 输出 = 工作空间目录；`ls` 颜色正常；`vim`/方向键可用；开两个终端互不串流
3. 「+」→ 打开浏览器：输入 baidu.com 可加载、前进/后退/刷新可用；登录某站在 `/module/ai/browser` 页共享登录态
4. 「+」→ 查看工作空间：树展开/收起、点 md 文件预览、返回树
5. 切到另一会话再切回：终端输出续流（回滚缓冲清空属预期）、浏览器回到原 url、tab 不丢
6. 关全部 tab → 右栏自动收起；重新展开只有「产物」tab（该会话记录已清）
7. 未绑定目录的工作空间开工作空间 tab → 显示绑定引导
8. 退出应用 → `ps aux | grep zsh`（mac）确认无孤儿 shell

- [ ] **Step 3: 更新 CLAUDE.md/文档（如涉及）**

本任务无路由/数据表变更，CLAUDE.md 无需改动（确认即可跳过）。

- [ ] **Step 4: 最终 commit（若有收尾改动）**

```bash
git status
# 若有零星修复：
git add -A && git commit -m "fix(detail-panel): 冒烟收尾"
```

---

## Self-Review 结论

- **Spec 覆盖**：§2 布局→Task 6；§3 store→Task 5；§4 浏览器→Task 7；§5 文件树→Task 4/8；§6 终端→Task 1/2/3/9；§7 i18n→Task 6/8；§8 错误处理→各任务内（loadDirFailed/terminalCreateFailed/exited/绑定引导）；§9 测试→Task 2/4/5/6；§10 风险→Task 10 冒烟。✓
- **占位符**：Task 6 的 browser/workspace/terminal 三处占位为**跨任务计划的显式中间态**（Task 7/8/9 逐个替换），非 TBD；无其他占位。✓
- **类型一致性**：`DetailTab`/`DetailTabKind`/`syncTab` 签名在 Task 5 定义、6/7/9 消费一致；`DirEntry` 在 Task 4（electron）与 Task 8（src-react workspace.api.ts 重复声明，因跨包不能直 import electron 内部模块——与项目 `WorkspaceRecord` 前端自声明模式一致）。✓
