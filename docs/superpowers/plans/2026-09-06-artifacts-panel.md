# 右侧产物面板 (Artifacts Panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 聊天主界面右侧可切换视图（概览/产物文件/工作空间文件）的产物面板，文件从会话消息纯前端派生，支持内嵌预览与全屏。

**Architecture:** 数据零迁移——`deriveSessionFiles` 纯函数从消息 blocks（write_file tool_call + `[引用文件 x]` 前缀）与流式 tools 派生文件列表；主进程新增 3 个只读 IPC（readFile/revealFile/exportFile）；UI 为 ChatView 行布局挤压出 340px 面板。

**Tech Stack:** React 19 + Zustand + React Query + Tailwind 4（shadcn/ui 无 Accordion，自实现轻量折叠）、Electron ipcMain + dialog/shell、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-06-artifacts-panel-design.md`

## Global Constraints

- **渲染进程禁止 import 主进程代码**（类型也不可）——主进程/前端类型各自定义同构副本（既有惯例，见 `chat/model/blocks.ts` 头注释）
- **禁止 JSX/JS 中硬编码用户可见文案**——全部 `t("chat:artifacts.*")`，zh-CN 与 en-US 同步添加
- **禁止硬编码主题色**（`bg-blue-*` 等）——用 `bg-primary-subtle`、`hover:text-primary`、`border-border/50` 等主题变量
- 弹出层边框 `border border-border/50 rounded-lg shadow-lg`；悬停 `hover:bg-primary-subtle hover:text-primary`
- 文件名 kebab-case；变量 camelCase；每函数 ≤20 行、单一职责；`useCallback`/`useMemo` 内用 `t()` 须入依赖数组
- Prettier：双引号、分号、tabWidth=2、printWidth=80、无尾随逗号
- 测试放 `tests/ai/*.test.ts`（vitest，`@/` 别名 → `src-react`）；纯逻辑才写单测，视图组件靠 typecheck + 手动冒烟（项目现状）
- 主进程新文件禁止 import electron（纯 Node 可测，模式同 `file-tools.ts`）
- IPC 命名前缀 `workspace:`；错误一律抛 `Error(中文文案)` 回传（与 `workspace:openDirectory` 同模式）

---

### Task 1: deriveSessionFiles 纯函数（文件列表派生核心）

**Files:**
- Create: `src-react/domains/ai/chat/lib/artifacts.ts`
- Test: `tests/ai/artifacts.test.ts`

**Interfaces:**
- Consumes: `parseBlocks` from `@/domains/ai/chat/model/blocks`；类型 `MessageRecord`（`{ id, role, blocks: string, ... }`）、`ToolStreamMap`（`{ order: string[]; map: Record<string, ToolStreamState> }`，`ToolStreamState = { toolName: string; args?: unknown; state: string; ... }`）
- Produces:
  ```ts
  interface SessionFile {
    path: string;                            // 工作空间相对路径（跨组去重 key）
    group: "artifact" | "workspace";         // 产物(AI write_file) / 工作空间(用户 @ 引用)
    status: "written" | "writing";           // writing 仅流式期间
    messageId: number;                       // 源消息 id；流式条目为 -1（排序置顶）
  }
  function deriveSessionFiles(
    messages: MessageRecord[],
    tools?: ToolStreamMap,
  ): SessionFile[]
  ```
  （spec 写 `stream?: StreamContent`，实现收窄为只取 `.tools`——面板 selector 只订 tools，避免 text delta 触发重渲染；语义不变）

- [ ] **Step 1: Write the failing test**

```ts
/**
 * 产物面板文件派生测试:write_file 收录/引用前缀解析/去重/流式合并
 */
import { describe, expect, it } from "vitest";

import { deriveSessionFiles } from "@/domains/ai/chat/lib/artifacts";
import {
  serializeBlocks,
  type MessageBlock,
  type ToolCallBlock,
} from "@/domains/ai/chat/model/blocks";
import type { MessageRecord } from "@/domains/ai/api/session.api";
import type { ToolStreamMap } from "@/domains/ai/chat/store/chat.store";

function msg(
  id: number,
  role: "user" | "assistant",
  blocks: MessageBlock[],
): MessageRecord {
  return {
    id,
    sessionId: 1,
    role,
    blocks: serializeBlocks(blocks),
    createdAt: "2026-09-06T00:00:00.000Z",
  };
}

function writeCall(
  path: string,
  state: ToolCallBlock["state"] = "done",
): ToolCallBlock {
  return {
    type: "tool_call",
    toolCallId: `call-${path}-${state}`,
    toolName: "write_file",
    args: { path, content: "x" },
    state,
  };
}

function streamTools(
  entries: Array<{ state: string; path?: string; toolName?: string }>,
): ToolStreamMap {
  return {
    order: entries.map((_, i) => `t${i}`),
    map: Object.fromEntries(
      entries.map((e, i) => [
        `t${i}`,
        {
          toolName: e.toolName ?? "write_file",
          args: e.path === undefined ? undefined : { path: e.path },
          state: e.state,
        },
      ]),
    ),
  };
}

describe("deriveSessionFiles", () => {
  it("无消息返回空数组", () => {
    expect(deriveSessionFiles([])).toEqual([]);
  });

  it("write_file done 收录为产物文件", () => {
    const files = deriveSessionFiles([
      msg(1, "assistant", [writeCall("src/a.ts")]),
    ]);
    expect(files).toEqual([
      { path: "src/a.ts", group: "artifact", status: "written", messageId: 1 },
    ]);
  });

  it("write_file denied/error 不收录（未写成功）", () => {
    const files = deriveSessionFiles([
      msg(1, "assistant", [
        writeCall("a.ts", "denied"),
        writeCall("b.ts", "error"),
      ]),
    ]);
    expect(files).toEqual([]);
  });

  it("非 write_file 工具忽略", () => {
    const files = deriveSessionFiles([
      msg(1, "assistant", [
        {
          type: "tool_call",
          toolCallId: "c1",
          toolName: "read_file",
          args: { path: "a.ts" },
          state: "done",
        },
      ]),
    ]);
    expect(files).toEqual([]);
  });

  it("user 消息引用前缀解析为工作空间文件（多文件）", () => {
    const files = deriveSessionFiles([
      msg(2, "user", [
        {
          type: "text",
          text: "[引用文件 readme.md]\n内容A\n\n[引用文件 docs/guide.md]\n内容B\n\n正题",
        },
      ]),
    ]);
    expect(files).toEqual([
      { path: "docs/guide.md", group: "workspace", status: "written", messageId: 2 },
      { path: "readme.md", group: "workspace", status: "written", messageId: 2 },
    ]);
  });

  it("引用技能前缀与 assistant 文本不解析", () => {
    const files = deriveSessionFiles([
      msg(1, "user", [
        { type: "text", text: "[引用技能 skill-a]\n正文" },
      ]),
      msg(2, "assistant", [
        { type: "text", text: "[引用文件 fake.md]\n回复" },
      ]),
    ]);
    expect(files).toEqual([]);
  });

  it("同 path 跨组去重取源消息最新者", () => {
    const files = deriveSessionFiles([
      msg(1, "user", [{ type: "text", text: "[引用文件 a.md]\n旧" }]),
      msg(3, "assistant", [writeCall("a.md")]),
    ]);
    expect(files).toEqual([
      { path: "a.md", group: "artifact", status: "written", messageId: 3 },
    ]);
  });

  it("同组同 path 重复写入取最新消息", () => {
    const files = deriveSessionFiles([
      msg(1, "assistant", [writeCall("a.ts")]),
      msg(5, "assistant", [writeCall("a.ts")]),
    ]);
    expect(files).toEqual([
      { path: "a.ts", group: "artifact", status: "written", messageId: 5 },
    ]);
  });

  it("流式 running 合并为 writing 且置顶", () => {
    const files = deriveSessionFiles(
      [msg(1, "assistant", [writeCall("old.ts")])],
      streamTools([{ state: "running", path: "new.ts" }]),
    );
    expect(files).toEqual([
      { path: "new.ts", group: "artifact", status: "writing", messageId: -1 },
      { path: "old.ts", group: "artifact", status: "written", messageId: 1 },
    ]);
  });

  it("流式 done 覆盖历史同 path 为 written", () => {
    const files = deriveSessionFiles(
      [msg(1, "user", [{ type: "text", text: "[引用文件 a.md]\n旧" }])],
      streamTools([{ state: "done", path: "a.md" }]),
    );
    expect(files).toEqual([
      { path: "a.md", group: "artifact", status: "written", messageId: -1 },
    ]);
  });

  it("流式 denied/error 与 args 缺 path 忽略", () => {
    const files = deriveSessionFiles(
      [],
      streamTools([
        { state: "denied", path: "a.ts" },
        { state: "error", path: "b.ts" },
        { state: "running" },
        { state: "running", path: "", toolName: "write_file" },
      ]),
    );
    expect(files).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/ai/artifacts.test.ts`
Expected: FAIL（`Cannot find module '@/domains/ai/chat/lib/artifacts'`）

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * 产物面板文件派生（纯函数）：
 * - 产物文件 = write_file tool_call(state=done) 的 args.path
 * - 工作空间文件 = user 消息 text 块的 [引用文件 x] 行首前缀（注入格式固定）
 * - 流式期间合并 streams 的 tools（running→writing / done→written）
 * - 同 path 跨组去重（取源消息最新者），按 messageId 降序（流式 -1 置顶）
 */
import { parseBlocks } from "../model/blocks";
import type { MessageRecord } from "../../api/session.api";
import type { ToolStreamMap } from "../store/chat.store";

export interface SessionFile {
  path: string;
  group: "artifact" | "workspace";
  status: "written" | "writing";
  messageId: number;
}

/** 行首行尾锚定（消息为多文件前缀逐段拼接，各占一行） */
const REFERENCE_LINE = /^\[引用文件 (.+?)\]$/gm;

/** 流式工具态 → 收录结果；denied/error/args 缺失返回 null */
function streamEntryToFiles(entry: {
  toolName: string;
  args?: unknown;
  state: string;
}): { path: string; status: "written" | "writing" } | null {
  if (entry.toolName !== "write_file") return null;
  const path = (entry.args as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || !path.trim()) return null;
  if (entry.state === "done") return { path, status: "written" };
  if (entry.state === "denied" || entry.state === "error") return null;
  return { path, status: "writing" };
}

export function deriveSessionFiles(
  messages: MessageRecord[],
  tools?: ToolStreamMap,
): SessionFile[] {
  const byPath = new Map<string, SessionFile>();
  const add = (file: SessionFile) => {
    const existing = byPath.get(file.path);
    if (!existing || file.messageId >= existing.messageId) {
      byPath.set(file.path, file);
    }
  };

  for (const message of messages) {
    if (message.role === "system") continue;
    for (const block of parseBlocks(message.blocks)) {
      if (block.type === "tool_call" && block.toolName === "write_file") {
        const parsed = streamEntryToFiles(block);
        if (parsed && block.state === "done") {
          add({
            path: parsed.path,
            group: "artifact",
            status: "written",
            messageId: message.id,
          });
        }
      }
      if (block.type === "text" && message.role === "user") {
        for (const match of block.text.matchAll(REFERENCE_LINE)) {
          add({
            path: match[1],
            group: "workspace",
            status: "written",
            messageId: message.id,
          });
        }
      }
    }
  }

  if (tools) {
    for (const id of tools.order) {
      const entry = tools.map[id];
      if (!entry) continue;
      const parsed = streamEntryToFiles(entry);
      if (parsed) {
        add({
          path: parsed.path,
          group: "artifact",
          status: parsed.status,
          messageId: -1,
        });
      }
    }
  }

  return [...byPath.values()].sort((a, b) => b.messageId - a.messageId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/ai/artifacts.test.ts`
Expected: PASS（11 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/chat/lib/artifacts.ts tests/ai/artifacts.test.ts
git commit -m "feat(chat): 产物面板文件派生纯函数(write_file/引用前缀/流式合并)"
```

---

### Task 2: 主进程文件读取纯逻辑（workspace-files.ts）

**Files:**
- Create: `electron/domains/ai/chat/workspace-files.ts`
- Test: `tests/ai/workspace-files.test.ts`

**Interfaces:**
- Consumes: 无（纯 Node）
- Produces:
  ```ts
  interface WorkspaceFileContent {
    kind: "text" | "image";
    content?: string;  // kind=text 时文件全文
    dataUrl?: string;  // kind=image 时 base64 dataURL
    size: number;      // 字节
  }
  function resolveFilePath(workspacePath: string, relPath: string): string
  // 绝对路径直接 resolve，相对路径以 workspacePath 为基（fullAccess 语义，不做越界拒绝）
  function readWorkspaceFile(absPath: string): Promise<WorkspaceFileContent>
  // ENOENT → throw Error("文件不存在")；目录 → throw Error("目标是目录，无法预览")
  // >512KB → throw Error("文件超过 512KB 预览上限")；NUL 二进制 → throw Error("该格式暂不支持预览，请另存查看")
  ```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * 工作空间文件读取测试:文本/图片 dataUrl/二进制/ENOENT/超限/路径 resolve
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  readWorkspaceFile,
  resolveFilePath,
} from "../../electron/domains/ai/chat/workspace-files";

const base = await mkdtemp(path.join(tmpdir(), "ws-files-"));
afterAll(async () => {
  await writeFile(path.join(base, ".keep"), "");
});

describe("resolveFilePath", () => {
  it("相对路径以工作空间为基", () => {
    expect(resolveFilePath("/tmp/ws", "a/b.ts")).toBe(
      path.resolve("/tmp/ws", "a/b.ts"),
    );
  });
  it("绝对路径直接 resolve（fullAccess 语义）", () => {
    expect(resolveFilePath("/tmp/ws", "/etc/hosts")).toBe(
      path.resolve("/etc/hosts"),
    );
  });
});

describe("readWorkspaceFile", () => {
  it("文本文件返回全文", async () => {
    const p = path.join(base, "a.md");
    await writeFile(p, "# hi");
    const r = await readWorkspaceFile(p);
    expect(r).toEqual({ kind: "text", content: "# hi", size: 4 });
  });

  it("图片转 base64 dataUrl", async () => {
    const p = path.join(base, "logo.png");
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await readWorkspaceFile(p);
    expect(r.kind).toBe("image");
    expect(r.dataUrl).toBe("data:image/png;base64,iVBORw===");
  });

  it("ENOENT 抛中文文案", async () => {
    await expect(readWorkspaceFile(path.join(base, "nope"))).rejects.toThrow(
      "文件不存在",
    );
  });

  it("目录抛中文文案", async () => {
    await mkdir(path.join(base, "dir"), { recursive: true });
    await expect(readWorkspaceFile(path.join(base, "dir"))).rejects.toThrow(
      "目标是目录，无法预览",
    );
  });

  it("NUL 二进制抛不支持预览", async () => {
    const p = path.join(base, "bin.dat");
    await writeFile(p, Buffer.from([0x00, 0x01]));
    await expect(readWorkspaceFile(p)).rejects.toThrow(
      "该格式暂不支持预览，请另存查看",
    );
  });

  it("超过 512KB 抛上限", async () => {
    const p = path.join(base, "big.txt");
    await writeFile(p, "a".repeat(512 * 1024 + 1));
    await expect(readWorkspaceFile(p)).rejects.toThrow(
      "文件超过 512KB 预览上限",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/ai/workspace-files.test.ts`
Expected: FAIL（`Cannot find module '../../electron/domains/ai/chat/workspace-files'`）

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * 工作空间文件读取（产物面板预览）：纯 Node 实现（禁止 import electron），
 * vitest 可直接测试。路径 resolve 取 fullAccess 语义——绝对路径直接用，
 * 相对以 workspacePath 为基，不做越界拒绝（读操作，路径源自会话内
 * write_file 记录；full access 模式可写工作空间外绝对路径，须放行）。
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface WorkspaceFileContent {
  kind: "text" | "image";
  content?: string;
  dataUrl?: string;
  size: number;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const READ_LIMIT = 512 * 1024;

export function resolveFilePath(
  workspacePath: string,
  relPath: string,
): string {
  return path.isAbsolute(relPath)
    ? path.resolve(relPath)
    : path.resolve(workspacePath, relPath);
}

export async function readWorkspaceFile(
  absPath: string,
): Promise<WorkspaceFileContent> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new Error("文件不存在");
  }
  if (!stat.isFile()) throw new Error("目标是目录，无法预览");
  if (stat.size > READ_LIMIT) throw new Error("文件超过 512KB 预览上限");
  const buf = await fs.readFile(absPath);
  if (buf.includes(0)) {
    throw new Error("该格式暂不支持预览，请另存查看");
  }
  const ext = path.extname(absPath).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime) {
    return {
      kind: "image",
      dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
      size: stat.size,
    };
  }
  return { kind: "text", content: buf.toString("utf8"), size: stat.size };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/ai/workspace-files.test.ts`
Expected: PASS（8 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/chat/workspace-files.ts tests/ai/workspace-files.test.ts
git commit -m "feat(ai): 工作空间文件读取纯逻辑(文本/图片/二进制/上限)"
```

---

### Task 3: IPC 注册 + 前端 ArtifactApi

**Files:**
- Modify: `electron/domains/ai/chat/session.repo.ts`（import 区、`registerIpcHandlers()`、`openWorkspaceDirectory` 方法后）
- Create: `src-react/domains/ai/api/artifact.api.ts`

**Interfaces:**
- Consumes: Task 2 的 `resolveFilePath` / `readWorkspaceFile` / `WorkspaceFileContent`；`session.repo.ts` 现有 `this.getWorkspace(workspaceId)`（返回 `WorkspaceRecord | null`，`directoryPath?: string`）与 `shell` import
- Produces（前端，后续任务用）:
  ```ts
  interface WorkspaceFileContent { kind: "text" | "image"; content?: string; dataUrl?: string; size: number; }  // 前端同构副本（禁 import 主进程）
  class ArtifactApi {
    static readFile(workspaceId: number, relPath: string): Promise<WorkspaceFileContent>;
    static revealFile(workspaceId: number, relPath: string): Promise<void>;
    static exportFile(workspaceId: number, relPath: string): Promise<string | null>;  // 用户取消返回 null
  }
  ```

- [ ] **Step 1: Modify session.repo.ts imports**

文件顶部第 1 行改为（加 `dialog`）：

```ts
import { dialog, ipcMain, shell } from "electron";
```

在现有 prisma import 后追加：

```ts
import fs from "node:fs/promises";
import path from "node:path";

import {
  readWorkspaceFile,
  resolveFilePath,
  type WorkspaceFileContent,
} from "./workspace-files";
```

（注意：若文件已有 `path`/`fs` import 则合并，勿重复声明）

- [ ] **Step 2: Register IPC handlers**

在 `registerIpcHandlers()` 内 `workspace:openDirectory` handler 之后追加：

```ts
    ipcMain.handle(
      "workspace:readFile",
      (_, workspaceId: number, relPath: string) =>
        this.readWorkspaceFileById(workspaceId, relPath),
    );
    ipcMain.handle(
      "workspace:revealFile",
      (_, workspaceId: number, relPath: string) =>
        this.revealWorkspaceFile(workspaceId, relPath),
    );
    ipcMain.handle(
      "workspace:exportFile",
      (_, workspaceId: number, relPath: string) =>
        this.exportWorkspaceFile(workspaceId, relPath),
    );
```

- [ ] **Step 3: Add repository methods**

在 `openWorkspaceDirectory` 方法之后追加：

```ts
  /** 产物面板：读工作空间文件（预览）。ENOENT/二进制等由纯逻辑抛中文文案 */
  async readWorkspaceFileById(
    workspaceId: number,
    relPath: string,
  ): Promise<WorkspaceFileContent> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace?.directoryPath) throw new Error("工作空间未绑定目录");
    return readWorkspaceFile(
      resolveFilePath(workspace.directoryPath, relPath),
    );
  }

  /** 产物面板：Finder 定位文件 */
  async revealWorkspaceFile(
    workspaceId: number,
    relPath: string,
  ): Promise<void> {
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace?.directoryPath) {
      shell.showItemInFolder(
        resolveFilePath(workspace.directoryPath, relPath),
      );
    }
  }

  /** 产物面板：另存为副本（"下载"）。用户取消返回 null */
  async exportWorkspaceFile(
    workspaceId: number,
    relPath: string,
  ): Promise<string | null> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace?.directoryPath) throw new Error("工作空间未绑定目录");
    const absPath = resolveFilePath(workspace.directoryPath, relPath);
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.basename(absPath),
    });
    if (canceled || !filePath) return null;
    await fs.copyFile(absPath, filePath);
    return filePath;
  }
```

- [ ] **Step 4: Create artifact.api.ts**

```ts
/**
 * 产物面板文件 API（前端；WorkspaceFileContent 为主进程同构副本，
 * 渲染进程不 import 主进程代码）
 */

import { invoke } from "@/lib/ipc";

export interface WorkspaceFileContent {
  kind: "text" | "image";
  content?: string;
  dataUrl?: string;
  size: number;
}

export class ArtifactApi {
  /** 读工作空间文件（预览）；不存在/二进制/超限由主进程抛中文文案 */
  static async readFile(
    workspaceId: number,
    relPath: string,
  ): Promise<WorkspaceFileContent> {
    return invoke<WorkspaceFileContent>(
      "workspace:readFile",
      workspaceId,
      relPath,
    );
  }

  /** 在 Finder 中定位文件 */
  static async revealFile(
    workspaceId: number,
    relPath: string,
  ): Promise<void> {
    await invoke<void>("workspace:revealFile", workspaceId, relPath);
  }

  /** 另存为副本（"下载"）；用户取消返回 null */
  static async exportFile(
    workspaceId: number,
    relPath: string,
  ): Promise<string | null> {
    return invoke<string | null>(
      "workspace:exportFile",
      workspaceId,
      relPath,
    );
  }
}

export default ArtifactApi;
```

- [ ] **Step 5: Verify with typecheck**

Run: `npm run typecheck`
Expected: 无错误（ipcMain.handle 多参 handler 与现有 `session:rename` 同模式）

- [ ] **Step 6: Commit**

```bash
git add electron/domains/ai/chat/session.repo.ts src-react/domains/ai/api/artifact.api.ts
git commit -m "feat(ai): 产物面板文件 IPC(readFile/revealFile/exportFile)与前端 API"
```

---

### Task 4: ai-ui.store 状态 + i18n 词条

**Files:**
- Modify: `src-react/domains/ai/store/ai-ui.store.ts`
- Modify: `src-react/i18n/locales/zh-CN/chat.json`
- Modify: `src-react/i18n/locales/en-US/chat.json`

**Interfaces:**
- Produces:
  ```ts
  export type AiArtifactsView = "overview" | "artifacts" | "workspace";
  // useAiUiStore 增加：
  artifactsOpen: boolean;                          // 面板开关（内存态，跨会话保持、刷新重置）
  artifactsView: AiArtifactsView;                  // 所选视图（默认 "overview"）
  toggleArtifacts: () => void;
  setArtifactsView: (view: AiArtifactsView) => void;
  ```
  i18n key `chat:artifacts.*`（后续所有 UI 任务使用）

- [ ] **Step 1: Extend ai-ui.store.ts**

接口 `AiUiState` 追加字段与方法（放在 `setSearchOpen` 之后）：

```ts
  artifactsOpen: boolean;
  artifactsView: AiArtifactsView;
  toggleArtifacts: () => void;
  setArtifactsView: (view: AiArtifactsView) => void;
```

文件顶部（`TimeFilter` import 后）追加类型导出：

```ts
/** 产物面板视图（概览总览 / 产物文件 / 工作空间文件） */
export type AiArtifactsView = "overview" | "artifacts" | "workspace";
```

store 初始值（`searchOpen: false,` 之后）追加：

```ts
  artifactsOpen: false,
  artifactsView: "overview",
```

实现（`setSearchOpen` 之后）：

```ts
  toggleArtifacts: () => set((state) => ({ artifactsOpen: !state.artifactsOpen })),
  setArtifactsView: (view) => set({ artifactsView: view }),
```

- [ ] **Step 2: Add zh-CN i18n keys**

`src-react/i18n/locales/zh-CN/chat.json` 顶层对象内追加（与既有 `"usage"` 块同级）：

```json
  "artifacts": {
    "open": "展开产物面板",
    "close": "收起产物面板",
    "overview": "概览",
    "artifacts": "产物文件",
    "workspace": "工作空间文件",
    "emptyFiles": "暂无文件",
    "writing": "写入中",
    "back": "返回列表",
    "fullscreen": "全屏",
    "exitFullscreen": "退出全屏",
    "previewFailed": "无法预览该文件",
    "actionPreview": "预览",
    "actionExport": "另存为副本…",
    "actionReveal": "在 Finder 中显示",
    "actionCopyPath": "复制路径",
    "copyPathSuccess": "路径已复制",
    "exportSuccess": "已另存为副本"
  }
```

注意：顶层不得再出现名为 `artifacts` 的其他 key（与嵌套重名会互相覆盖）。

- [ ] **Step 3: Add en-US i18n keys**

`src-react/i18n/locales/en-US/chat.json` 同位置追加：

```json
  "artifacts": {
    "open": "Open artifacts panel",
    "close": "Close artifacts panel",
    "overview": "Overview",
    "artifacts": "Artifacts",
    "workspace": "Workspace Files",
    "emptyFiles": "No files yet",
    "writing": "Writing",
    "back": "Back to list",
    "fullscreen": "Fullscreen",
    "exitFullscreen": "Exit fullscreen",
    "previewFailed": "Unable to preview this file",
    "actionPreview": "Preview",
    "actionExport": "Save a copy…",
    "actionReveal": "Reveal in Finder",
    "actionCopyPath": "Copy path",
    "copyPathSuccess": "Path copied",
    "exportSuccess": "Saved a copy"
  }
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run test`
Expected: 均通过（JSON 合法、无类型错误）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/store/ai-ui.store.ts src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(chat): 产物面板 UI 状态与双语词条"
```

---

### Task 5: 文件图标与列表组件

**Files:**
- Create: `src-react/domains/ai/chat/components/artifacts/file-icon.tsx`
- Create: `src-react/domains/ai/chat/components/artifacts/FileListItem.tsx`
- Create: `src-react/domains/ai/chat/components/artifacts/FileListGroup.tsx`

**Interfaces:**
- Consumes: Task 1 `SessionFile`；Task 3 `ArtifactApi`；`mapIpcError` from `../../lib/error-message`（签名 `(e: unknown) => string`）；i18n `chat:artifacts.*`
- Produces:
  ```tsx
  function fileIconFor(name: string): LucideIcon;                       // file-icon.tsx
  function FileListItem({ file, workspaceId, onPreview }: {
    file: SessionFile; workspaceId: number;
    onPreview: (file: SessionFile) => void;
  }): JSX.Element;                                                      // FileListItem.tsx（default export）
  function FileListGroup({ title, files, defaultOpen, workspaceId, onPreview }: {
    title: string; files: SessionFile[]; defaultOpen: boolean;
    workspaceId: number; onPreview: (file: SessionFile) => void;
  }): JSX.Element;                                                      // FileListGroup.tsx（default export）
  ```

- [ ] **Step 1: Create file-icon.tsx**

```tsx
/**
 * 文件扩展名 → Lucide 图标（产物面板列表/预览共用）
 */
import {
  File,
  FileCode,
  FileImage,
  FileText,
  type LucideIcon,
} from "lucide-react";

const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
]);
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".py", ".rs", ".go", ".java",
  ".css", ".scss", ".html", ".sh", ".yml", ".yaml", ".toml", ".sql",
]);
const DOC_EXT = new Set([".md", ".markdown", ".txt", ".log", ".csv"]);

export function fileIconFor(name: string): LucideIcon {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  if (IMAGE_EXT.has(ext)) return FileImage;
  if (CODE_EXT.has(ext)) return FileCode;
  if (DOC_EXT.has(ext)) return FileText;
  return File;
}
```

- [ ] **Step 2: Create FileListItem.tsx**

```tsx
/**
 * 产物面板文件项：类型图标 + 截断文件名（Tooltip 全名）+ hover "..." 菜单
 * （预览/另存为副本/在 Finder 中显示/复制路径）；写入中禁用预览
 */
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import ArtifactApi from "../../../api/artifact.api";
import type { SessionFile } from "../../lib/artifacts";
import { mapIpcError } from "../../lib/error-message";
import { fileIconFor } from "./file-icon";

interface FileListItemProps {
  file: SessionFile;
  workspaceId: number;
  onPreview: (file: SessionFile) => void;
}

function FileListItemImpl({ file, workspaceId, onPreview }: FileListItemProps) {
  const { t } = useTranslation(["chat", "common"]);
  const Icon = fileIconFor(file.path);
  const writing = file.status === "writing";

  const handleExport = async () => {
    try {
      const saved = await ArtifactApi.exportFile(workspaceId, file.path);
      if (saved) toast.success(t("chat:artifacts.exportSuccess"));
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleReveal = async () => {
    try {
      await ArtifactApi.revealFile(workspaceId, file.path);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      toast.success(t("chat:artifacts.copyPathSuccess"));
    } catch {
      toast.error(t("chat:artifacts.previewFailed"));
    }
  };

  return (
    <li
      className="group relative flex items-center gap-2 rounded-md px-2 py-1.5"
      role="button"
      tabIndex={0}
      aria-disabled={writing}
      onClick={() => !writing && onPreview(file)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !writing) onPreview(file);
      }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm">{file.path}</span>
              {writing && (
                <span className="shrink-0 rounded-full bg-primary-subtle px-1.5 py-0.5 text-[10px] text-primary">
                  {t("chat:artifacts.writing")}
                </span>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{file.path}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("chat:artifacts.actionPreview")}
            className="absolute right-1 hidden shrink-0 rounded p-0.5 text-muted-foreground group-hover:block hover:text-primary"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="border border-border/50 rounded-lg shadow-lg"
        >
          <DropdownMenuItem
            disabled={writing}
            onClick={() => onPreview(file)}
          >
            {t("chat:artifacts.actionPreview")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void handleExport()}>
            {t("chat:artifacts.actionExport")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void handleReveal()}>
            {t("chat:artifacts.actionReveal")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void handleCopyPath()}>
            {t("chat:artifacts.actionCopyPath")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export default FileListItem;
```

- [ ] **Step 3: Create FileListGroup.tsx**

```tsx
/**
 * 产物面板文件分组：轻量折叠（头部 ChevronDown 旋转 + 计数），展开渲染
 * FileListItem 列表；空分组展开时显示"暂无文件"占位
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SessionFile } from "../../lib/artifacts";
import FileListItem from "./FileListItem";

interface FileListGroupProps {
  title: string;
  files: SessionFile[];
  defaultOpen: boolean;
  workspaceId: number;
  onPreview: (file: SessionFile) => void;
}

function FileListGroupImpl({
  title,
  files,
  defaultOpen,
  workspaceId,
  onPreview,
}: FileListGroupProps) {
  const { t } = useTranslation(["chat"]);
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1 rounded px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-primary-subtle hover:text-primary"
      >
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span>{title}</span>
        <span className="tabular-nums">({files.length})</span>
      </button>
      {open &&
        (files.length > 0 ? (
          <ul className="mt-0.5 space-y-0.5 px-1">
            {files.map((file) => (
              <FileListItem
                key={`${file.group}:${file.path}`}
                file={file}
                workspaceId={workspaceId}
                onPreview={onPreview}
              />
            ))}
          </ul>
        ) : (
          <p className="px-3 pb-2 pt-1 text-xs text-muted-foreground">
            {t("chat:artifacts.emptyFiles")}
          </p>
        ))}
    </section>
  );
}

export default FileListGroup;
```

- [ ] **Step 4: Verify with typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 均通过

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/chat/components/artifacts/
git commit -m "feat(chat): 产物面板文件图标/文件项/分组列表组件"
```

---

### Task 6: FilePreview（内嵌预览 + 全屏）

**Files:**
- Create: `src-react/domains/ai/chat/components/artifacts/FilePreview.tsx`

**Interfaces:**
- Consumes: Task 1 `SessionFile`；Task 3 `ArtifactApi` + `WorkspaceFileContent`；`MarkdownView`（default export，props `{ text: string; hitOffset?: number }`）from `../MarkdownView`；`mapIpcError` from `../../lib/error-message`
- Produces:
  ```tsx
  function FilePreview({ file, workspaceId, onBack }: {
    file: SessionFile; workspaceId: number; onBack: () => void;
  }): JSX.Element;  // default export
  // 内部管理 fullscreen 态；fullscreen 时根 div 为
  // "absolute inset-0 z-40 flex flex-col bg-background"——定位祖先是
  // ChatView 行布局容器（Task 7 加 relative），覆盖整个聊天主区域
  ```

- [ ] **Step 1: Create FilePreview.tsx**

```tsx
/**
 * 产物面板内嵌预览：返回/文件名/全屏切换工具栏 + 内容区（文本走
 * MarkdownView，图片直渲）。全屏 = absolute inset-0 覆盖聊天主区域
 * （定位祖先为 ChatView 行布局容器）。读取失败显示通用空态并 toast
 * 具体原因（spec §6：ENOENT/二进制统一此路径，toast 文案区分）
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, FileX, Maximize2, Minimize2 } from "lucide-react";

import ArtifactApi from "../../../api/artifact.api";
import type { SessionFile } from "../../lib/artifacts";
import { mapIpcError } from "../../lib/error-message";
import MarkdownView from "../MarkdownView";

interface FilePreviewProps {
  file: SessionFile;
  workspaceId: number;
  onBack: () => void;
}

function FilePreviewImpl({ file, workspaceId, onBack }: FilePreviewProps) {
  const { t } = useTranslation(["chat"]);
  const [fullscreen, setFullscreen] = useState(false);

  const fileQuery = useQuery({
    queryKey: ["artifact-file", workspaceId, file.path],
    queryFn: () => ArtifactApi.readFile(workspaceId, file.path),
    retry: false,
    staleTime: 5_000,
  });

  // 错误只 toast 一次（空态由渲染分支兜底，文案不依赖错误分类）
  useEffect(() => {
    if (fileQuery.error) {
      toast.error(mapIpcError(fileQuery.error));
    }
  }, [fileQuery.error]);

  return (
    <div
      className={
        fullscreen
          ? "absolute inset-0 z-40 flex flex-col bg-background"
          : "flex h-full min-h-0 flex-col"
      }
    >
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
        <button
          type="button"
          aria-label={t("chat:artifacts.back")}
          title={t("chat:artifacts.back")}
          onClick={onBack}
          className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
          {file.path}
        </span>
        <button
          type="button"
          aria-label={
            fullscreen
              ? t("chat:artifacts.exitFullscreen")
              : t("chat:artifacts.fullscreen")
          }
          title={
            fullscreen
              ? t("chat:artifacts.exitFullscreen")
              : t("chat:artifacts.fullscreen")
          }
          onClick={() => setFullscreen((prev) => !prev)}
          className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          {fullscreen ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {fileQuery.isPending ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : fileQuery.data ? (
          fileQuery.data.kind === "image" ? (
            <img
              src={fileQuery.data.dataUrl}
              alt={file.path}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <MarkdownView text={fileQuery.data.content ?? ""} />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <FileX className="h-8 w-8" />
            <p className="text-xs">{t("chat:artifacts.previewFailed")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default FilePreview;
```

- [ ] **Step 2: Verify with typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 均通过

- [ ] **Step 3: Commit**

```bash
git add src-react/domains/ai/chat/components/artifacts/FilePreview.tsx
git commit -m "feat(chat): 产物面板内嵌预览(文本/图片/全屏切换)"
```

---

### Task 7: ArtifactsPanel 容器 + ChatView 接线

**Files:**
- Create: `src-react/domains/ai/chat/components/artifacts/ArtifactsPanel.tsx`
- Modify: `src-react/domains/ai/chat/views/ChatView.tsx`
- Modify: `src-react/domains/ai/chat/components/WorkspacePathChip.tsx:45`

**Interfaces:**
- Consumes: Task 1 `deriveSessionFiles` + `SessionFile`；Task 4 `useAiUiStore`（`artifactsOpen`/`artifactsView`/`toggleArtifacts`/`setArtifactsView`）+ `AiArtifactsView`；Task 5 `FileListGroup`；Task 6 `FilePreview`；`useChatStore` selector `s.streams[sessionId]?.tools`；`SessionApi.listMessages`（React Query key `["messages", sessionId]` 与 MessageList 共享缓存）
- Produces:
  ```tsx
  export default function ArtifactsPanel({ sessionId, workspaceId }: {
    sessionId: number; workspaceId: number;
  }): JSX.Element;                       // 面板（340px 右列）
  export function ArtifactsPanelToggle(): JSX.Element;  // 顶栏开关按钮（ChatView 用）
  ```

- [ ] **Step 1: Create ArtifactsPanel.tsx**

```tsx
/**
 * 右侧产物面板：头部视图 dropdown（概览/产物文件/工作空间文件，当前项打钩）
 * + 内容区路由（列表三视图 / preview 本地瞬时态）。文件列表从消息缓存与
 * 流式 tools 派生（deriveSessionFiles），selector 只订 tools 避免 text
 * delta 重渲染。preview 返回后回到前一列表视图（不落入 artifactsView）
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, PanelRight } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SessionApi from "../../../api/session.api";
import { useAiUiStore, type AiArtifactsView } from "../../../store/ai-ui.store";
import { useChatStore } from "../../store/chat.store";
import { deriveSessionFiles, type SessionFile } from "../../lib/artifacts";
import FileListGroup from "./FileListGroup";
import FilePreview from "./FilePreview";

const VIEWS: readonly AiArtifactsView[] = ["overview", "artifacts", "workspace"];

interface ArtifactsPanelProps {
  sessionId: number;
  workspaceId: number;
}

export default function ArtifactsPanel({
  sessionId,
  workspaceId,
}: ArtifactsPanelProps) {
  const { t } = useTranslation(["chat"]);
  const view = useAiUiStore((s) => s.artifactsView);
  const setView = useAiUiStore((s) => s.setArtifactsView);
  const toggleOpen = useAiUiStore((s) => s.toggleArtifacts);
  const [previewFile, setPreviewFile] = useState<SessionFile | null>(null);

  // 与 MessageList 共享 ["messages", sessionId] 缓存；流结束既有 invalidate 链路刷新
  const messagesQuery = useQuery({
    queryKey: ["messages", sessionId],
    queryFn: () => SessionApi.listMessages(sessionId),
  });
  // 只订 tools：text/thinking delta 不改变 tools 引用，不触发重渲染
  const tools = useChatStore((s) => s.streams[sessionId]?.tools);

  const files = useMemo(
    () => deriveSessionFiles(messagesQuery.data ?? [], tools),
    [messagesQuery.data, tools],
  );
  const artifactFiles = useMemo(
    () => files.filter((f) => f.group === "artifact"),
    [files],
  );
  const workspaceFiles = useMemo(
    () => files.filter((f) => f.group === "workspace"),
    [files],
  );

  const closePreview = () => setPreviewFile(null);

  return (
    <div className="flex h-full w-[340px] shrink-0 flex-col border-l border-border/50">
      <div className="flex items-center justify-between border-b border-border/50 px-2 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-1 text-sm font-medium hover:bg-primary-subtle hover:text-primary"
            >
              {t(`chat:artifacts.${view}`)}
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="border border-border/50 rounded-lg shadow-lg"
          >
            {VIEWS.map((item) => (
              <DropdownMenuItem
                key={item}
                onClick={() => {
                  setView(item);
                  closePreview();
                }}
              >
                {t(`chat:artifacts.${item}`)}
                {view === item && (
                  <Check className="ml-auto h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={t("chat:artifacts.close")}
          title={t("chat:artifacts.close")}
          onClick={toggleOpen}
          className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <PanelRight className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {previewFile ? (
          <FilePreview
            file={previewFile}
            workspaceId={workspaceId}
            onBack={closePreview}
          />
        ) : view === "overview" ? (
          <>
            <FileListGroup
              title={t("chat:artifacts.artifacts")}
              files={artifactFiles}
              defaultOpen
              workspaceId={workspaceId}
              onPreview={setPreviewFile}
            />
            <FileListGroup
              title={t("chat:artifacts.workspace")}
              files={workspaceFiles}
              defaultOpen
              workspaceId={workspaceId}
              onPreview={setPreviewFile}
            />
          </>
        ) : view === "artifacts" ? (
          <FileListGroup
            title={t("chat:artifacts.artifacts")}
            files={artifactFiles}
            defaultOpen
            workspaceId={workspaceId}
            onPreview={setPreviewFile}
          />
        ) : (
          <FileListGroup
            title={t("chat:artifacts.workspace")}
            files={workspaceFiles}
            defaultOpen
            workspaceId={workspaceId}
            onPreview={setPreviewFile}
          />
        )}
      </div>
    </div>
  );
}

/** 顶栏开关按钮（ChatView 顶行右侧） */
export function ArtifactsPanelToggle() {
  const { t } = useTranslation(["chat"]);
  const open = useAiUiStore((s) => s.artifactsOpen);
  const toggle = useAiUiStore((s) => s.toggleArtifacts);
  return (
    <button
      type="button"
      aria-label={open ? t("chat:artifacts.close") : t("chat:artifacts.open")}
      title={open ? t("chat:artifacts.close") : t("chat:artifacts.open")}
      onClick={toggle}
      className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
    >
      <PanelRight className="h-4 w-4" />
    </button>
  );
}
```

- [ ] **Step 2: Adjust WorkspacePathChip outer padding**

`WorkspacePathChip.tsx:45` 根 div（`UnbindDirectoryDialog` 的父级）：

```tsx
    <div className="flex items-center px-4 pt-2">
```

改为（padding 移交 ChatView 顶行容器统一提供）：

```tsx
    <div className="flex items-center">
```

- [ ] **Step 3: Rewire ChatView top row + row layout**

`ChatView.tsx` 顶部 import 追加：

```tsx
import ArtifactsPanel, {
  ArtifactsPanelToggle,
} from "../components/artifacts/ArtifactsPanel";
import { useAiUiStore } from "../../store/ai-ui.store";
```

`ChatView` 组件内（`activeWorkspace` 派生之后）追加：

```tsx
  const artifactsOpen = useAiUiStore((s) => s.artifactsOpen);
```

返回结构中，原条件渲染 chip 的三行：

```tsx
      {activeWorkspace?.directoryPath && (
        <WorkspacePathChip workspace={activeWorkspace} />
      )}
```

改为（有会话才渲染顶行；左 chip 右开关两端对齐）：

```tsx
      {selectedSession && (
        <div className="flex items-center justify-between px-4 pt-2">
          {activeWorkspace?.directoryPath ? (
            <WorkspacePathChip workspace={activeWorkspace} />
          ) : (
            <span />
          )}
          <ArtifactsPanelToggle />
        </div>
      )}
```

`ChatPane` 返回结构（原 `<MessageList/>…<div className="p-4">…</div>` 的 fragment）改为行布局（`relative` 为 FilePreview 全屏提供定位祖先）：

```tsx
  return (
    <div className="relative flex h-full min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageList
          sessionId={session.id}
          workspaceId={workspace?.id ?? null}
          compactedUpToId={session.compactedUpToId ?? null}
          onRegenerate={handleRegenerate}
        />
        {sending && (
          <AgentProgress stepCount={stepCount} activeTool={activeTool} />
        )}
        <div className="p-4">
          <ChatInput
            hasModel={hasModel}
            sending={sending}
            sessionId={session.id}
            accessMode={accessMode}
            currentMode={session.mode}
            currentAssistantId={session.assistantId}
            currentModelId={session.currentModelId}
            workspaceId={workspace?.id ?? null}
            onAccessModeChange={(mode) => void handleAccessModeChange(mode)}
            onOpenMcp={() => onOpenSettings("mcp")}
            onRunCommand={handleRunCommand}
            onSend={handleSend}
            onStop={stop}
          />
        </div>
      </div>
      {artifactsOpen && workspace && (
        <ArtifactsPanel sessionId={session.id} workspaceId={workspace.id} />
      )}
    </div>
  );
```

并在 `ChatPane` 内 `const [accessMode, setAccessMode] = useState<AccessMode>("default");` 之后追加：

```tsx
  const artifactsOpen = useAiUiStore((s) => s.artifactsOpen);
```

- [ ] **Step 4: Verify with typecheck + lint + tests**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: 均通过

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/chat/components/artifacts/ArtifactsPanel.tsx src-react/domains/ai/chat/views/ChatView.tsx src-react/domains/ai/chat/components/WorkspacePathChip.tsx
git commit -m "feat(chat): 右侧产物面板(视图切换/列表/预览)接入聊天布局"
```

---

### Task 8: 全量验证 + 手动冒烟

**Files:**
- 无新增（验证任务）

**Interfaces:**
- Consumes: 全部前置任务的产出

- [ ] **Step 1: Run full checks**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: 全部通过

- [ ] **Step 2: Manual smoke test（npm run dev，绑定了目录的工作空间 + 已有 write_file 历史的会话）**

逐项核对（对照 spec §1/§4/§6）：

1. 有会话时聊天顶部右侧出现 PanelRight 按钮；无会话（空态）不出现
2. 点击开关面板：聊天区收缩，340px 面板出现/消失；再点击恢复
3. 头部 dropdown：概览/产物文件/工作空间文件三项，当前项打钩；切换后标题随变，切会话再切回选择保持
4. 概览视图：两组折叠卡片（产物文件/工作空间文件 各带计数），可展开收起；无文件组显示"暂无文件"
5. 历史会话：AI 曾 write_file 的文件出现在"产物文件"；@ 引用过的文件出现在"工作空间文件"
6. 流式期间让 AI 写文件：列表实时出现该文件并标"写入中"，完成后变正常态
7. 点击文本文件：面板内嵌预览（markdown/代码高亮正常）；图片文件直接显示
8. 预览态点全屏：铺满聊天主区域（不含侧边栏）；退出回到内嵌；返回按钮回列表且视图保持
9. hover 文件项出现 "..."：预览/另存为副本（弹保存框，副本可打开）/在 Finder 中显示（定位到文件）/复制路径（粘贴验证）
10. 超长路径截断显示，hover Tooltip 显示全名
11. 面板打开状态下删除工作空间内某文件后预览：显示"无法预览该文件"空态 + toast
12. 二进制文件（如造一个含 NUL 的文件路径让 AI write 或手动场景）：预览 toast"该格式暂不支持预览，请另存查看"
13. 中英文切换：面板全部文案跟随语言

- [ ] **Step 3: Fix any issues found, re-run checks, commit**

```bash
git add -A
git commit -m "fix(chat): 产物面板冒烟问题修复"
```

（无问题则跳过此步）

---

## Self-Review 记录

- **Spec 覆盖**：§2 数据流→Task 1；§5 IPC→Task 2/3；§3 布局状态→Task 4/7；§4 组件→Task 5/6/7；§6 边界→Task 1（writing）/2（ENOENT/二进制/超限）/5（Tooltip）/6（空态+toast）；§7 i18n→Task 4；§8 测试→Task 1/2/8。偏差两处已在计划内注明：流式参数收窄为 `tools`（Task 1 Interfaces）；ENOENT/二进制的空态文案统一为"无法预览"+toast 区分（Task 6 头注释），避免依赖错误文案字符串分类。
- **类型一致性**：`SessionFile` 四字段（Task 1 定义 = Task 5/6/7 使用）；`WorkspaceFileContent` 主/前端双副本字段一致（Task 2/3）；`AiArtifactsView` 三值（Task 4 = Task 7）；`ArtifactApi` 三方法签名（Task 3 = Task 5/6 使用）。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码。
