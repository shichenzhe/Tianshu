# 安全中心 SP3（文件安全）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件安全真实生效：路径判定引擎（内置>用户白>用户黑>default）+ read/write/list 三工具判定门（block 无条件审批——read 类首次进审批流；allow 跳审批）+ userData 运行时保护 + 文件安全二级页。

**Architecture:** 纯函数判定引擎 → file-gate 模块单例（command-gate 同款，fail-open 三层，extraBuiltin 运行时注入）→ runToolCall 文件门（与命令门并列互斥：run_command 走命令门、文件三件走文件门）→ RuleSection 提取共享 + FileDetailView 二级页。

**Tech Stack:** Electron 44 主进程 + node:fs/path/os + React 19 + i18next + Vitest。

**Spec:** `docs/superpowers/specs/2026-09-16-security-center-sp3-design.md`（执行者须先读）

## Global Constraints

- 遵循仓库 CLAUDE.md：文件名 kebab-case；函数 ≤20 行；生产禁 console（主进程 Log）；用户可见文本一律 `t()`。
- 排版以 `npm run lint` 零错误为准（prettier v3 默认尾逗号 all）。
- i18n zh-CN/en-US 同步逐 key；**eventType → i18n key 是全部点号换下划线**（`config.fileRules.reset` → `config_fileRules_reset`——SP2 曾因连字符勘误）；新通道三处登记。
- **行为兼容硬约束**：两 gate 均未命中（null/default）时现有链路逐字节不变；既有测试全绿。
- 跨树 import：`electron/domains/security/` 3 层（`../../../src-react/...`）；`electron/domains/ai/chat|agent|automation/` 4 层（`../../../../`）；domains 兄弟目录互引 2 层（`../../security/...`）。
- 取证原始输出（rtk proxy）。每任务一 commit，conventional 中文，无 footer。

---

### Task 1: 路径判定引擎纯函数（file-policy）

**Files:**
- Create: `electron/domains/security/file-policy.ts`
- Test: `tests/security/file-policy.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 2/3 依赖，签名逐字）:
  - `type FileAccessDecision = "block" | "allow" | "default"`
  - `interface FileAccessRules { builtinBlocklist: string[]; fileBlocklist: string[]; fileAllowlist: string[] }`
  - `normalizeRulePath(entry: string, workspacePath: string): string`（~/ 展开、绝对原样、相对 resolve、去尾分隔符与 `*`）
  - `pathMatchesRule(absPath: string, ruleAbs: string): boolean`（精确相等 或 `startsWith(rule + path.sep)`——目录/文件双匹配）
  - `decideFileAccess(absPath: string, workspacePath: string, rules: FileAccessRules): FileAccessDecision`

- [ ] **Step 1: 写失败测试** — `tests/security/file-policy.test.ts`：

```ts
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideFileAccess,
  normalizeRulePath,
  pathMatchesRule,
  type FileAccessRules,
} from "../../electron/domains/security/file-policy";

const WS = "/tmp/ws";
const HOME = os.homedir();

const rules = (over: Partial<FileAccessRules> = {}): FileAccessRules => ({
  builtinBlocklist: [path.join(HOME, ".ssh")],
  fileBlocklist: ["/secret"],
  fileAllowlist: ["/tmp/ws/build"],
  ...over,
});

describe("normalizeRulePath", () => {
  it("~ 展开 / 绝对原样 / 相对按 workspace resolve / 去尾分隔符与通配符", () => {
    expect(normalizeRulePath("~/.ssh/", WS)).toBe(path.join(HOME, ".ssh"));
    expect(normalizeRulePath("~/.ssh/config*", WS)).toBe(
      path.join(HOME, ".ssh", "config"),
    );
    expect(normalizeRulePath("/abs/dir", WS)).toBe(path.normalize("/abs/dir"));
    expect(normalizeRulePath("rel/dir", WS)).toBe(path.resolve(WS, "rel/dir"));
  });
});

describe("pathMatchesRule", () => {
  it("精确文件与目录前缀双匹配；同级不同名不误伤", () => {
    expect(pathMatchesRule("/a/b/file", "/a/b")).toBe(true);
    expect(pathMatchesRule("/a/b", "/a/b")).toBe(true);
    expect(pathMatchesRule("/a/b2/file", "/a/b")).toBe(false);
    expect(pathMatchesRule("/x", "")).toBe(false);
  });
});

describe("decideFileAccess 优先级矩阵", () => {
  it("内置最高：不可被用户白名单绕过", () => {
    const r = rules({
      fileAllowlist: [path.join(HOME, ".ssh")],
    });
    expect(decideFileAccess(path.join(HOME, ".ssh", "id_rsa"), WS, r)).toBe(
      "block",
    );
  });
  it("用户白名单优先于用户黑名单", () => {
    const r = rules({
      fileBlocklist: ["/data"],
      fileAllowlist: ["/data/public"],
    });
    expect(decideFileAccess("/data/public/a.txt", WS, r)).toBe("allow");
    expect(decideFileAccess("/data/private/a.txt", WS, r)).toBe("block");
  });
  it("用户黑名单目录前缀命中 → block；未命中 → default", () => {
    expect(decideFileAccess("/secret/key.pem", WS, rules())).toBe("block");
    expect(decideFileAccess("/tmp/ws/src/a.ts", WS, rules())).toBe("default");
  });
  it("相对条目按 workspace 解析", () => {
    const r = rules({ fileBlocklist: ["secrets"] });
    expect(decideFileAccess(path.join(WS, "secrets", "k"), WS, r)).toBe(
      "block",
    );
  });
});
```

- [ ] **Step 2: 跑 RED** — Run: `npx vitest run tests/security/file-policy.test.ts`；Expected: FAIL。

- [ ] **Step 3: 实现** — `electron/domains/security/file-policy.ts`：

```ts
/**
 * 文件路径判定引擎（SP3 spec §3，纯函数）：
 * 优先级 内置清单（静态+运行时）> 用户白名单 > 用户黑名单 > default。
 * 匹配：条目归一化（~/ 展开/绝对原样/相对按 workspace/去尾分隔符与 *）后，
 * 精确文件与目录前缀双匹配（无尾分隔符条目同时保护同名目录——偏安全的
 * 两段式）。不做 glob（spec §1 已知边界）。
 */
import os from "node:os";
import path from "node:path";

export type FileAccessDecision = "block" | "allow" | "default";

export interface FileAccessRules {
  builtinBlocklist: string[];
  fileBlocklist: string[];
  fileAllowlist: string[];
}

/** 条目归一化：去首尾空白/尾分隔符/尾通配符，~/ 展开，相对按 workspace resolve */
export function normalizeRulePath(
  entry: string,
  workspacePath: string,
): string {
  let value = entry.trim().replace(/[/\\]+$/, "").replace(/\*+$/, "").trim();
  if (value === "" || value === "~") {
    return value === "~" ? os.homedir() : "";
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(os.homedir(), value.slice(2));
  }
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(workspacePath, value);
}

/** 精确文件或目录前缀匹配（ruleAbs 为空恒 false） */
export function pathMatchesRule(absPath: string, ruleAbs: string): boolean {
  if (ruleAbs === "") return false;
  return absPath === ruleAbs || absPath.startsWith(ruleAbs + path.sep);
}

/** 名单命中：任一条目（归一化后）双匹配 */
function hits(absPath: string, workspacePath: string, entries: string[]): boolean {
  return entries.some((entry) =>
    pathMatchesRule(absPath, normalizeRulePath(entry, workspacePath)),
  );
}

/** 文件判定：内置 > 用户白 > 用户黑 > default */
export function decideFileAccess(
  absPath: string,
  workspacePath: string,
  rules: FileAccessRules,
): FileAccessDecision {
  if (hits(absPath, workspacePath, rules.builtinBlocklist)) return "block";
  if (hits(absPath, workspacePath, rules.fileAllowlist)) return "allow";
  if (hits(absPath, workspacePath, rules.fileBlocklist)) return "block";
  return "default";
}
```

- [ ] **Step 4: 跑 GREEN** — Run: `npx vitest run tests/security/file-policy.test.ts`；Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/file-policy.ts tests/security/file-policy.test.ts
git commit -m "feat(安全中心): 文件路径判定引擎——内置>用户白>用户黑>default 与 ~/展开双匹配"
```

---

### Task 2: file-gate 模块单例（extraBuiltin 运行时注入）

**Files:**
- Create: `electron/domains/security/file-gate.ts`
- Test: `tests/security/file-gate.test.ts`

**Interfaces:**
- Consumes: Task 1 `decideFileAccess`/`FileAccessDecision`；`defaultFileBlocklist`（defaults.ts 已有）；`SecurityConfig`
- Produces（Task 3 依赖，签名逐字）:
  - `makeFileDecider(getConfigValue: () => SecurityConfig, extraBuiltin: string[]): (absPath: string, workspacePath: string) => FileAccessDecision`
  - `installFileGate(fn: (absPath: string, workspacePath: string) => FileAccessDecision): void`
  - `fileGate(absPath: string, workspacePath: string): FileAccessDecision`（未安装/异常 → "default"）

- [ ] **Step 1: 写失败测试** — `tests/security/file-gate.test.ts`：

```ts
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileGate,
  installFileGate,
  makeFileDecider,
} from "../../electron/domains/security/file-gate";
import { SECURITY_DEFAULTS } from "../../electron/domains/security/defaults";
import type { SecurityConfig } from "../../src-react/domains/security/model/types";

const HOME = os.homedir();
const config = (over: Partial<SecurityConfig>): SecurityConfig => ({
  ...SECURITY_DEFAULTS,
  ...over,
});

describe("makeFileDecider", () => {
  it("内置 ~/.ssh 命中 → block；extraBuiltin（userData）注入生效", () => {
    const decide = makeFileDecider(() => config({}), ["/Users/x/Library/App"]);
    expect(decide(path.join(HOME, ".ssh", "config"), "/tmp/ws")).toBe("block");
    expect(decide("/Users/x/Library/App/db/x.db", "/tmp/ws")).toBe("block");
    expect(decide("/tmp/ws/a.ts", "/tmp/ws")).toBe("default");
  });
  it("用户名单生效：白名单放行、黑名单拦截", () => {
    const decide = makeFileDecider(
      () =>
        config({
          fileAllowlist: ["/tmp/ws/build"],
          fileBlocklist: ["/secret"],
        }),
      [],
    );
    expect(decide("/tmp/ws/build/out.js", "/tmp/ws")).toBe("allow");
    expect(decide("/secret/k", "/tmp/ws")).toBe("block");
  });
  it("sandboxEnabled=false 旁路；getConfigValue 抛错 fail-open", () => {
    const off = makeFileDecider(() => config({ sandboxEnabled: false }), []);
    expect(off(path.join(HOME, ".ssh", "x"), "/tmp/ws")).toBe("default");
    const boom = makeFileDecider(() => {
      throw new Error("boom");
    }, []);
    expect(boom("/secret/k", "/tmp/ws")).toBe("default");
  });
});

describe("fileGate 单例", () => {
  it("未安装 default；安装生效；可替换；gate 抛错 fail-open", () => {
    expect(fileGate("/secret/k", "/tmp/ws")).toBe("default");
    installFileGate(() => "block");
    expect(fileGate("/secret/k", "/tmp/ws")).toBe("block");
    installFileGate(() => {
      throw new Error("boom");
    });
    expect(fileGate("/x", "/tmp/ws")).toBe("default");
    installFileGate(() => "default");
  });
});
```

- [ ] **Step 2: 跑 RED** — Run: `npx vitest run tests/security/file-gate.test.ts`；Expected: FAIL。

- [ ] **Step 3: 实现** — `electron/domains/security/file-gate.ts`：

```ts
/**
 * 文件判定门模块单例（SP3 spec §4.1，command-gate 同款模式）：
 * Application 装配时 install（闭包读 SecurityService 缓存 + extraBuiltin
 * 运行时内置清单——userData 自我保护）；fail-open 三层 → "default"。
 */
import type { SecurityConfig } from "../../../src-react/domains/security/model/types";
import { defaultFileBlocklist } from "./defaults";
import { decideFileAccess, type FileAccessDecision } from "./file-policy";

export function makeFileDecider(
  getConfigValue: () => SecurityConfig,
  extraBuiltin: string[],
): (absPath: string, workspacePath: string) => FileAccessDecision {
  return (absPath, workspacePath) => {
    try {
      const config = getConfigValue();
      if (!config.sandboxEnabled) return "default";
      return decideFileAccess(absPath, workspacePath, {
        builtinBlocklist: [
          ...defaultFileBlocklist(process.platform),
          ...extraBuiltin,
        ],
        fileBlocklist: config.fileBlocklist,
        fileAllowlist: config.fileAllowlist,
      });
    } catch {
      return "default";
    }
  };
}

let installed:
  | ((absPath: string, workspacePath: string) => FileAccessDecision)
  | null = null;

export function installFileGate(
  fn: (absPath: string, workspacePath: string) => FileAccessDecision,
): void {
  installed = fn;
}

export function fileGate(
  absPath: string,
  workspacePath: string,
): FileAccessDecision {
  try {
    return installed?.(absPath, workspacePath) ?? "default";
  } catch {
    return "default";
  }
}
```

- [ ] **Step 4: 跑 GREEN** — Run: `npx vitest run tests/security/file-gate.test.ts`；Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/file-gate.ts tests/security/file-gate.test.ts
git commit -m "feat(安全中心): 文件判定门单例——extraBuiltin 运行时内置（userData）+ fail-open 三层"
```

---

### Task 3: 执行接入（runToolCall 文件门 + 装配 + AuditCenter path 变量）

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`
- Modify: `electron/domains/ai/automation/automation-runner.ts`（装配）
- Modify: `electron/Application.ts`（installFileGate）
- Modify: `src-react/domains/security/components/AuditCenter.tsx`（entryText 兜底变量加 path）
- Test: `tests/security/file-gate-integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `FileAccessDecision`、Task 2 `fileGate`；`resolveSafePath`（file-tools.ts 已 export）；SP2 的命令门结构（resolveCommandGate/emitCommandEvent/COMMAND_*_OUTPUT/needsApproval 组合）
- Produces: 文件门执行语义；`AgentStreamOptions.decideFileAccess?: (absPath: string, workspacePath: string) => FileAccessDecision`

**Step 1: 写失败测试** — `tests/security/file-gate-integration.test.ts`：

（前提：chat.service 的 `runToolCall` 已 export（SP2 落地）；`makeRunFileTool(name)` 需从 file-tools 新增导出——见 Step 3d。测试用真实临时目录。）

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, app: { on: vi.fn(), getPath: vi.fn(() => "/tmp") } }));
vi.mock("../../electron/commons/prisma-client", () => ({ default: {} }));

import {
  runToolCall,
  type AgentStreamOptions,
} from "../../electron/domains/ai/chat/chat.service";
import { makeFileTool } from "../../electron/domains/ai/agent/file-tools";
import type { SecurityEvent } from "../../src-react/domains/security/model/types";

let WS = "";
let SECRET = "";
beforeAll(() => {
  WS = fs.mkdtempSync(path.join(os.tmpdir(), "sp3-ws-"));
  SECRET = path.join(WS, "secret");
  fs.mkdirSync(SECRET);
  fs.writeFileSync(path.join(SECRET, "k.pem"), "x");
  fs.writeFileSync(path.join(WS, "normal.txt"), "hello");
});
afterAll(() => fs.rmSync(WS, { recursive: true, force: true }));

function makeAgent(
  over: Partial<AgentStreamOptions>,
): AgentStreamOptions & { events: SecurityEvent[]; approvals: string[] } {
  const events: SecurityEvent[] = [];
  const approvals: string[] = [];
  return {
    sessionId: 1,
    workspacePath: WS,
    fullAccess: () => false,
    isToolAllowed: async () => false,
    requestApproval: async (id) => {
      approvals.push(id);
      return true;
    },
    onSecurityEvent: (e) => events.push(e),
    ...over,
  } as never;
}

describe("runToolCall 文件判定门", () => {
  it("read_file 黑名单路径 fullAccess 下仍弹审批（read 首次进审批）+ needs-approval 事件", async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      decideFileAccess: () => "block",
    });
    const out = await runToolCall(
      makeFileTool("read_file"),
      agent,
      "f1",
      { path: "secret/k.pem" },
    );
    expect(agent.approvals).toHaveLength(1);
    expect(
      agent.events.some((e) => e.eventType === "file-safety.needs-approval"),
    ).toBe(true);
    expect(out).toContain("k.pem");
  });

  it("block + unattended：强制拒绝，不触审批", async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      unattended: true,
      decideFileAccess: () => "block",
    });
    const out = await runToolCall(
      makeFileTool("read_file"),
      agent,
      "f2",
      { path: "secret/k.pem" },
    );
    expect(out).toContain("无人值守");
    expect(agent.approvals).toHaveLength(0);
    expect(agent.events[0]).toMatchObject({
      eventType: "file-safety.rejected",
      decision: "rejected",
    });
    expect(agent.events[0].detail).toMatchObject({ reason: "unattended" });
  });

  it("write_file 白名单路径跳过审批 + allow-listed 事件", async () => {
    const agent = makeAgent({ decideFileAccess: () => "allow" });
    const out = await runToolCall(
      makeFileTool("write_file"),
      agent,
      "f3",
      { path: "out.txt", content: "hi" },
    );
    expect(agent.approvals).toHaveLength(0);
    expect(out).toContain("已写入");
    expect(
      agent.events.some((e) => e.eventType === "file-safety.allow-listed"),
    ).toBe(true);
  });

  it("default：write 未记忆→审批（现状）；read→直执行免审（现状）", async () => {
    const w = makeAgent({ decideFileAccess: () => "default" });
    await runToolCall(makeFileTool("write_file"), w, "f4", {
      path: "out2.txt",
      content: "x",
    });
    expect(w.approvals).toHaveLength(1);
    const r = makeAgent({ decideFileAccess: () => "default" });
    const out = await runToolCall(makeFileTool("read_file"), r, "f5", {
      path: "normal.txt",
    });
    expect(r.approvals).toHaveLength(0);
    expect(out).toContain("hello");
  });

  it("list_dir 无 path 参数不判定（直执行）；search_files 不在门内", async () => {
    const agent = makeAgent({ decideFileAccess: () => "block" });
    const out = await runToolCall(makeFileTool("list_dir"), agent, "f6", {});
    expect(agent.approvals).toHaveLength(0);
    expect(out).not.toContain("错误");
  });
});
```

**Step 2: 跑 RED** — Run: `npx vitest run tests/security/file-gate-integration.test.ts`；Expected: FAIL（makeFileTool 未导出 / 文件门不存在）。

**Step 3: 实现**

3a. `file-tools.ts` 新增工具工厂导出（测试直调单个工具）：

```ts
/** 按名取内置文件工具（SP3 集成测试直调单工具用） */
export function makeFileTool(
  name: "read_file" | "write_file" | "list_dir" | "search_files",
): ToolDefinition<never> {
  const tool = FILE_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`未知文件工具: ${name}`);
  return tool as ToolDefinition<never>;
}
```

3b. `chat.service.ts`：
- import：`import { fileGate } from "../../security/file-gate";`、`import type { FileAccessDecision } from "../../security/file-policy";`、`import { resolveSafePath } from "../agent/file-tools";`（file-tools 已被 chat.service 引用则补名）
- `AgentStreamOptions` 加字段：

```ts
/** 文件安全判定门（SP3）：缺省走 fileGate 模块单例 */
decideFileAccess?: (absPath: string, workspacePath: string) => FileAccessDecision;
```

- 模块级（命令门旁）：

```ts
const FILE_UNATTENDED_OUTPUT =
  "错误: 无人值守任务不可访问黑名单路径，请调整名单或改为人工会话执行";
const FILE_GATE_TOOLS = new Set(["read_file", "write_file", "list_dir"]);

/** 文件判定门：非文件工具/无 path/解析失败（越界等）返回 null */
function resolveFileGate(
  agent: AgentStreamOptions,
  toolName: string,
  input: unknown,
): FileAccessDecision | null {
  if (!FILE_GATE_TOOLS.has(toolName) || !agent.workspacePath) return null;
  const rel = (input as { path?: unknown } | null)?.path;
  if (typeof rel !== "string" || rel === "") return null;
  try {
    const abs = resolveSafePath(agent.workspacePath, rel, agent.fullAccess());
    return (agent.decideFileAccess ?? fileGate)(abs, agent.workspacePath);
  } catch {
    return null;
  }
}

/** 文件门审计事件（detail.path 截 200 + 附加字段） */
function emitFileEvent(
  agent: AgentStreamOptions,
  input: unknown,
  eventType: string,
  decision: "rejected" | "info" | "allowed",
  extra: Record<string, unknown>,
): void {
  const p = String((input as { path?: unknown } | null)?.path ?? "");
  agent.onSecurityEvent?.({
    eventType,
    decision,
    detail: { path: p.slice(0, 200), ...extra },
    sessionId: agent.sessionId,
  });
}
```

- `runToolCall`（在命令门之后、审批组合处）：文件门与命令门**互斥**（不同工具），组合为统一 force/skip：

```ts
const fileGateDecision = resolveFileGate(agent, def.name, input);
if (fileGateDecision === "block" && agent.unattended) {
  finalStates?.set(toolCallId, "denied");
  onChunk?.({
    type: "tool-update", toolCallId, toolName: def.name,
    state: "denied", output: FILE_UNATTENDED_OUTPUT,
  });
  emitFileEvent(agent, input, "file-safety.rejected", "rejected", {
    reason: "unattended",
  });
  return FILE_UNATTENDED_OUTPUT;
}
if (fileGateDecision === "block") {
  emitFileEvent(agent, input, "file-safety.needs-approval", "info", {
    source: "builtin",
  });
}
if (fileGateDecision === "allow") {
  emitFileEvent(agent, input, "file-safety.allow-listed", "allowed", {});
}
const needsApproval =
  gate === "ask" ||
  fileGateDecision === "block" ||
  (gate !== "allow" &&
    fileGateDecision !== "allow" &&
    def.kind === "write" &&
    !agent.fullAccess() &&
    !(await agent.isToolAllowed(def.name)));
```

（等价性自查：两 gate 均 null/default 时表达式与原条件一致；needs-approval 事件的 source 区分 builtin/user-blocklist 由 gate decider 侧无法得知——**简化为统一 source: "blocklist"**，spec §6 的 builtin/user-blocklist 区分降级为单一 "blocklist" 值，spec 勘误随本计划记录。）

- `resolveAgentOptions` 装配加 `decideFileAccess: fileGate,`

3c. `automation-runner.ts` 装配字面量加 `decideFileAccess: fileGate,`（import 补）。

3d. `Application.ts`（installCommandGate 旁）：

```ts
// 文件安全判定门（SP3）：extraBuiltin = userData 自我保护（spec §4.1）
installFileGate(
  makeFileDecider(() => securityService.getConfigValue(), [
    app.getPath("userData"),
  ]),
);
```

（import 补 installFileGate/makeFileDecider；app 已有 import。）

3e. `AuditCenter.tsx` entryText 兜底变量加 `path: String(detail.path ?? "")`（与 command/summary/key/requested 并列）。

**Step 4: 全量验证** — Run: `npm run test && npm run typecheck && npm run lint`；Expected: 全绿（既有回归——两 gate default 路径不变）。

**Step 5: Commit**

```bash
git add electron/domains/ai/agent/file-tools.ts electron/domains/ai/chat/chat.service.ts electron/domains/ai/automation/automation-runner.ts electron/Application.ts src-react/domains/security/components/AuditCenter.tsx tests/security/file-gate-integration.test.ts
git commit -m "feat(安全中心): 文件判定门接入执行链——read/write/list block 无条件审批（unattended 强拒）/allow 跳审批 + userData 运行时保护 + path 审计变量"
```

### Task 4: resetFileRules IPC + i18n

**Files:**
- Modify: `electron/domains/security/security.service.ts`
- Modify: `src-react/lib/ipc.ts`、`src-react/domains/security/api/security.api.ts`
- Modify: `src-react/i18n/locales/zh-CN/security.json`、`en-US/security.json`

**Interfaces:**
- Consumes: `setConfig`/`SECURITY_DEFAULTS`/`copySecurityConfig`
- Produces（Task 5 依赖）: `SecurityApi.resetFileRules(): Promise<SecurityConfig>`；`fileDetail.*` i18n 全族；events 3 新 key

**Step 1: 主进程** — `security.service.ts` registerHandlers 追加：

```ts
ipcMain.handle(
  "security:resetFileRules",
  async (): Promise<SecurityConfig> => this.resetFileRules(),
);
```

类内（resetCommandRules 旁，同款结构）：

```ts
/** 文件两名单恢复默认（spec §5）：用户部分重置，内置清单不受影响 */
async resetFileRules(): Promise<SecurityConfig> {
  const keys: SecurityConfigKey[] = ["fileBlocklist", "fileAllowlist"];
  let config = this.getConfigValue();
  for (const key of keys) {
    config = await this.setConfig(key, SECURITY_DEFAULTS[key]);
  }
  this.opts.audit?.({
    eventType: "config.fileRules.reset",
    decision: "info",
    detail: { keys },
  });
  return copySecurityConfig(config);
}
```

**Step 2: 前端三处** — IPCChannel security 块加 `| "security:resetFileRules";`；SecurityApi 加：

```ts
static resetFileRules(): Promise<SecurityConfig> {
  return invoke<SecurityConfig>("security:resetFileRules");
}
```

**Step 3: i18n** — zh-CN `security.json` 顶层加 `fileDetail` 对象 + `audit.events` 加 3 key：

```json
"fileDetail": {
  "title": "文件安全",
  "priorityNote": "优先级：内置敏感路径（不可删，含应用数据目录）＞ 用户白名单 ＞ 用户黑名单；命中黑名单的读写均需审批（完全访问模式下同样生效）",
  "reset": "重置为默认",
  "resetDone": "已重置为默认名单",
  "builtin": {
    "title": "内置敏感路径",
    "desc": "系统预置的敏感配置路径（SSH 密钥、云凭证等），不可删除或编辑；读写命中即弹审批"
  },
  "builtinTag": "内置",
  "blocklist": {
    "title": "用户黑名单",
    "desc": "命中路径的读写均强制弹审批；支持 ~/ 开头、绝对或工作空间相对路径",
    "placeholder": "如 ~/.config/myapp"
  },
  "allowlist": {
    "title": "用户白名单",
    "desc": "命中路径的写操作免审批（优先于黑名单，但不能绕过内置清单）",
    "placeholder": "如 ~/projects"
  }
}
```

events 加（en-US 同 key 镜像，插值变量一致）：

```json
"file-safety_needs-approval": "文件访问需审批: {{path}}",
"file-safety_allow-listed": "文件访问已放行: {{path}}",
"config_fileRules_reset": "文件名单已重置为默认"
```

en-US 的 fileDetail 逐 key 镜像（示例 title "File Security"、priorityNote "Priority: builtin sensitive paths (immutable, incl. app data) > user allowlist > user blocklist; reads and writes to blocklisted paths require approval (even in full access mode)"、builtinTag "Built-in"、blocklist.placeholder "e.g. ~/.config/myapp" 等）。

**Step 4: 验证 + Commit** — Run: `npm run typecheck && npm run lint`；双语 key 脚本比对一致。

```bash
git add electron/domains/security/security.service.ts src-react/lib/ipc.ts src-react/domains/security/api/security.api.ts src-react/i18n/locales/zh-CN/security.json src-react/i18n/locales/en-US/security.json
git commit -m "feat(安全中心): 文件名单重置 IPC + fileDetail 双语文案与 3 个审计事件 key"
```

---

### Task 5: RuleSection 提取 + FileDetailView 二级页

**Files:**
- Create: `src-react/domains/security/components/RuleSection.tsx`（从 CommandDetailView 提取）
- Create: `src-react/domains/security/components/FileDetailView.tsx`
- Modify: `src-react/domains/security/components/CommandDetailView.tsx`（改 import）
- Modify: `src-react/domains/security/components/SecurityCenter.tsx`（视图栈 "file"）
- Modify: `src-react/domains/security/components/SandboxCard.tsx`（文件安全入口启用）

**Interfaces:**
- Consumes: Task 4 `resetFileRules`/`fileDetail.*`；SP2 RuleSection 组件逻辑（props 不变）；`getConfig` 的 `defaults.fileBlocklist`（SecurityCenter 已有 config——**注意**：defaults 需透传，SecurityCenter 拉取时保存 `defaults`（目前只存 config——需把 state 扩为 `{config, defaults}` 或单独 state）
- Produces: `<FileDetailView config defaults onBack onRulesChange />`；共享 `<RuleSection />`

**Step 1: RuleSection 提取** — CommandDetailView 内的 RuleSection 函数原样移到新文件 `RuleSection.tsx`（export default，props 与实现逐字保留，含 closeEditor/sameTokens/validate 逻辑——sameTokens/validateProgram 留在 CommandDetailView（其私有），RuleSection 只收 validate prop）；CommandDetailView 改 `import RuleSection from "./RuleSection";` 并删除内部定义。

**Step 2: SecurityCenter** — `SecurityView` 加 `"file"`；新增 defaults state：

```tsx
const [defaults, setDefaults] = useState<{ fileBlocklist: string[] } | null>(null);
// getConfig().then((state) => { setConfig(state.config); setDefaults(state.defaults); })
```

（loadFailed/三态结构不变；"file" 分支在 "command" 旁：

```tsx
if (view === "file") {
  return (
    <div className="p-1">
      <FileDetailView
        config={config}
        defaults={defaults ?? { fileBlocklist: [] }}
        onBack={() => setView("home")}
        onRulesChange={setConfig}
      />
    </div>
  );
}
```

**Step 3: SandboxCard** — 文件安全入口启用（同 SP2 命令入口模式：`onOpenFile` prop、可点击样式、去占位；网络安全维持占位）。

**Step 4: FileDetailView** — 完整代码：

```tsx
/**
 * 文件安全二级页（SP3 spec §5）：内置清单只读区（三层防删第 2 层——
 * 展示合并、内置分列不可删）+ 用户黑/白名单 CRUD + 重置为默认。
 */
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import { SecurityApi } from "../api/security.api";
import RuleSection from "./RuleSection";

interface FileDetailViewProps {
  config: SecurityConfig;
  defaults: { fileBlocklist: string[] };
  onBack: () => void;
  onRulesChange: (config: SecurityConfig) => void;
}

export default function FileDetailView({
  config,
  defaults,
  onBack,
  onRulesChange,
}: FileDetailViewProps) {
  const { t } = useTranslation(["security"]);
  const save = async (key: SecurityConfigKey, items: string[]) => {
    try {
      onRulesChange(await SecurityApi.setConfig(key, items));
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  const reset = async () => {
    try {
      onRulesChange(await SecurityApi.resetFileRules());
      toast.success(t("security:fileDetail.resetDone"));
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} />
          {t("security:audit.back")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() => void reset()}
        >
          <RotateCcw size={14} />
          {t("security:fileDetail.reset")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("security:fileDetail.priorityNote")}
      </p>
      <section className="space-y-2">
        <div>
          <h4 className="text-sm font-medium">
            {t("security:fileDetail.builtin.title")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t("security:fileDetail.builtin.desc")}
          </p>
        </div>
        <div className="space-y-1">
          {defaults.fileBlocklist.map((item) => (
            <div key={item} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {item}
              </span>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {t("security:fileDetail.builtinTag")}
              </Badge>
            </div>
          ))}
        </div>
      </section>
      <RuleSection
        titleKey="security:fileDetail.blocklist.title"
        descKey="security:fileDetail.blocklist.desc"
        placeholderKey="security:fileDetail.blocklist.placeholder"
        invalidKey="security:commandDetail.invalidCommand"
        items={config.fileBlocklist}
        validate={(raw) => (raw.trim() !== "" ? raw.trim() : null)}
        onSave={(items) => save("fileBlocklist", items)}
      />
      <RuleSection
        titleKey="security:fileDetail.allowlist.title"
        descKey="security:fileDetail.allowlist.desc"
        placeholderKey="security:fileDetail.allowlist.placeholder"
        invalidKey="security:commandDetail.invalidCommand"
        items={config.fileAllowlist}
        validate={(raw) => (raw.trim() !== "" ? raw.trim() : null)}
        onSave={(items) => save("fileAllowlist", items)}
      />
    </div>
  );
}
```

（Trash2 import 若 RuleSection 内已用则此处不需要——以 lint 无未用 import 为准。）

**Step 5: 验证 + Commit** — Run: `npm run typecheck && npm run lint && npm run test`；Expected: 全绿（CommandDetailView 改 import 回归）。

```bash
git add src-react/domains/security/components
git commit -m "feat(安全中心): 文件安全二级页——内置只读区 + 黑白名单 CRUD + RuleSection 提取共享"
```

---

### Task 6: 手工验收 + 收尾

**Files:**
- Create: `docs/superpowers/acceptance/2026-09-16-security-center-sp3.md`

**Step 1: 全量验证** — `npm run test && npm run typecheck && npm run lint` 三绿。

**Step 2: 验收清单**（样式照 SP2）：
- 二级页入口/内置只读区（17 条 + 内置徽标无删除钮）/黑白名单 CRUD/重置 toast
- full 模式让 AI 读 `~/.ssh/config`（或任一内置路径）→ 弹审批；拒绝回喂、批准可读
- 用户黑名单加 `~/secrets` → AI 读写其下文件均弹审批（full 模式同样）
- 白名单加工作空间子目录 → AI 写该目录文件免审批（default 模式原本要审批）
- 审计中心：needs-approval/allow-listed 事件可见（{{path}} 渲染）；en-US 跟随
- automation：任务让 AI 读黑名单路径 → 拒绝反馈

**Step 3: Commit**

```bash
git add docs/superpowers/acceptance/2026-09-16-security-center-sp3.md
git commit -m "docs(安全中心): SP3 手工验收清单"
```

---

## 收尾验证

- [ ] 全量三绿（新增 tests/security/file-policy|file-gate|file-gate-integration）
- [ ] spec §1 六项对照；不做清单未越界
- [ ] 两 gate default 路径与 SP2 行为逐字节一致（既有测试全绿佐证）

## Self-Review 记录

- Spec 覆盖：§3 引擎（T1）、§4.1 gate（T2）、§4.2 接入（T3）、§5 二级页（T4 i18n/IPC + T5 UI）、§6 审计（T3/T4）、§7 错误处理（fail-open 内嵌 T2/T3）、§8 测试（各任务）——无缺口
- **spec 勘误（计划期裁定）**：§6 的 needs-approval detail.source 从 "builtin"/"user-blocklist" 二值降级为统一 `"blocklist"`——gate decider 无法区分命中来源（内置与用户黑名单同为 block），区分需判定引擎返回来源信息（过度设计）；spec §6 表格相应理解为单值
- 类型一致性：FileAccessDecision/FileAccessRules（T1→T2/T3）、fileGate/installFileGate/makeFileDecider（T2→T3）、resetFileRules + fileDetail.*（T4→T5）、FileDetailView props（T5 内自洽）
- 已知注记：T5 SecurityCenter 需扩 defaults state（SP1 只存 config）；T3 测试需 makeFileTool 工厂（file-tools 新增导出）

