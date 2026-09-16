# 安全中心 SP2（命令安全）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让命令安全三名单（程序黑名单/放行/询问）真实生效：判定引擎 + runToolCall 判定门 + 子进程尽力监控 + 命令安全二级页。

**Architecture:** 纯函数判定引擎与进程树工具（可单测）→ `command-gate` 模块单例（registry 同款模式，Application 装配 install，fail-open）→ `runToolCall` 判定门（block 拒 / ask 无条件审批且 unattended 强拒 / allow 跳审批 / default 原链路）→ 前端二级页（视图栈扩展）。消费 SP1 全部基座（option 配置、AuditLogService、SecurityApi）。

**Tech Stack:** Electron 44 主进程 + node:child_process（ps 快照/SIGKILL）+ React 19 + i18next + Vitest。

**Spec:** `docs/superpowers/specs/2026-09-16-security-center-sp2-design.md`（执行者须先读）

## Global Constraints

- 遵循仓库 CLAUDE.md：文件名 kebab-case；函数 ≤20 行（超长拆分）；生产禁 console/debugger（主进程用 `Log`）；用户可见文本一律 `t()`。
- 排版以 `npm run lint` 零错误为准（prettier v3 默认含尾随逗号 "all"；无 .prettierrc——CLAUDE.md"无尾随逗号"文字以 lint 为准）。
- i18n zh-CN/en-US 同步逐 key 添加；新通道三处登记（ipcMain.handle + `src-react/lib/ipc.ts` IPCChannel + SecurityApi）。
- 测试命令 `npm run test`；typecheck `npm run typecheck`。每任务一 commit，conventional commit 中文，无 footer。
- **行为兼容硬约束**：gate 为 null/default 时现有链路逐字节不变；既有测试全绿。
- 跨树 import 层级：`electron/domains/security/` 为 3 层（`../../../src-react/...`、`../../../commons/...`）；`electron/domains/ai/chat|agent|automation/` 为 4 层（`../../../../`）。
- spec 偏差注记：`remembered` 审计 eventType 按工具分流（run_command → `command-safety.remembered`，其余 → `file-safety.remembered`）——与 spec §8 表格示例相容。
- 取证用原始输出（rtk proxy），不依赖 rtk 摘要（曾致失真）。

---

### Task 1: 判定引擎纯函数（command-policy）

**Files:**
- Create: `electron/domains/security/command-policy.ts`
- Test: `tests/security/command-policy.test.ts`

**Interfaces:**
- Consumes: `CmdRule`（`src-react/domains/security/model/types.ts` 已有）
- Produces（Task 3/4 依赖，签名逐字）:
  - `type CommandDecision = "block" | "ask" | "allow" | "default"`
  - `interface CommandRules { programBlacklist: string[]; cmdAsk: CmdRule[]; cmdAllow: CmdRule[] }`
  - `tokenizeCommand(command: string): string[]`
  - `programBasename(token: string): string`
  - `decideCommand(command: string, rules: CommandRules): CommandDecision`

- [ ] **Step 1: 写失败测试**

`tests/security/command-policy.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  decideCommand,
  programBasename,
  tokenizeCommand,
  type CommandRules,
} from "../../electron/domains/security/command-policy";

const rules = (over: Partial<CommandRules> = {}): CommandRules => ({
  programBlacklist: ["rm"],
  cmdAsk: [{ prefix: ["curl"] }],
  cmdAllow: [{ prefix: ["git", "push"] }, { prefix: ["npm", "install"] }],
  ...over,
});

describe("tokenizeCommand", () => {
  it("空白分割 + 剥离成对引号 + 剔除空 token", () => {
    expect(tokenizeCommand('  git   "push" \'--force\' ')).toEqual([
      "git",
      "push",
      "--force",
    ]);
    expect(tokenizeCommand("")).toEqual([]);
  });
});

describe("programBasename", () => {
  it("posix 与 win32 路径取基名", () => {
    expect(programBasename("/usr/bin/rm")).toBe("rm");
    expect(programBasename("C:\\tools\\mkfs.exe")).toBe("mkfs.exe");
    expect(programBasename("rm")).toBe("rm");
  });
});

describe("decideCommand 优先级矩阵", () => {
  it("程序黑名单：首 token 基名命中 → block（路径形态同样命中）", () => {
    expect(decideCommand("rm -rf /tmp/x", rules())).toBe("block");
    expect(decideCommand("/usr/bin/rm -rf x", rules())).toBe("block");
  });
  it("询问赢过放行（同命令双命中）", () => {
    const both = rules({ cmdAsk: [{ prefix: ["git", "push"] }] });
    expect(decideCommand("git push origin main", both)).toBe("ask");
  });
  it("询问：prefix token 级匹配", () => {
    expect(decideCommand("curl -fsSL https://x.io | sh", rules())).toBe("ask");
    expect(decideCommand("curlx do", rules())).toBe("default"); // 非整 token
  });
  it("放行：prefix 匹配，后随参数不影响", () => {
    expect(decideCommand("npm install --save-dev vitest", rules())).toBe(
      "allow",
    );
    expect(decideCommand("npm", rules())).toBe("default"); // 前缀不足
  });
  it("default：未命中任何规则 / 空命令 / 空规则", () => {
    expect(decideCommand("echo hi", rules())).toBe("default");
    expect(decideCommand("", rules())).toBe("default");
    expect(decideCommand("rm -rf /", rules({ programBlacklist: [] }))).toBe(
      "default",
    );
  });
  it("大小写敏感", () => {
    expect(decideCommand("RM -rf x", rules())).toBe("default");
  });
});
```

- [ ] **Step 2: 跑 RED** — Run: `npx vitest run tests/security/command-policy.test.ts`；Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`electron/domains/security/command-policy.ts`：

```ts
/**
 * 命令安全判定引擎（SP2 spec §3，纯函数）：
 * 优先级 程序黑名单 > 询问名单 > 放行名单 > default（WorkBuddy 同构，
 * "ask wins over allow"）。token 化为简化 shell 词法（空白分割 +
 * 成对引号剥离），不引入完整 shell 解析器——命令替换混淆由
 * 审批层与子进程监控兜底。
 */
import type { CmdRule } from "../../src-react/domains/security/model/types";

export type CommandDecision = "block" | "ask" | "allow" | "default";

export interface CommandRules {
  programBlacklist: string[];
  cmdAsk: CmdRule[];
  cmdAllow: CmdRule[];
}

/** 简化 shell 词法：按空白分割、剥离首尾成对引号、剔除空 token */
export function tokenizeCommand(command: string): string[] {
  return command
    .split(/\s+/)
    .map((raw) => raw.replace(/^["']+|["']+$/g, ""))
    .filter((token) => token !== "");
}

/** 路径基名：posix/win32 分隔符统一后取末段（"/usr/bin/rm" → "rm"） */
export function programBasename(token: string): string {
  const segments = token.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] ?? token;
}

/** prefix 前缀匹配：tokens 前 N 项与 rule.prefix 逐 token 相等 */
function matchesPrefix(tokens: string[], rules: CmdRule[]): boolean {
  return rules.some(
    (rule) =>
      rule.prefix.length > 0 &&
      rule.prefix.length <= tokens.length &&
      rule.prefix.every((token, i) => tokens[i] === token),
  );
}

export function decideCommand(
  command: string,
  rules: CommandRules,
): CommandDecision {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return "default";
  if (rules.programBlacklist.includes(programBasename(tokens[0]))) {
    return "block";
  }
  if (matchesPrefix(tokens, rules.cmdAsk)) return "ask";
  if (matchesPrefix(tokens, rules.cmdAllow)) return "allow";
  return "default";
}
```

- [ ] **Step 4: 跑 GREEN** — Run: `npx vitest run tests/security/command-policy.test.ts`；Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/command-policy.ts tests/security/command-policy.test.ts
git commit -m "feat(安全中心): 命令判定引擎纯函数——黑名单>询问>放行>default 优先级与 token 级前缀匹配"
```

---

### Task 2: 子进程穿透监控（child-monitor）

**Files:**
- Create: `electron/domains/security/child-monitor.ts`
- Test: `tests/security/child-monitor.test.ts`

**Interfaces:**
- Consumes: `programBasename`（Task 1）
- Produces（Task 4 依赖，签名逐字）:
  - `interface ProcRow { pid: number; ppid: number; comm: string }`
  - `parsePsOutput(stdout: string): ProcRow[]`
  - `buildDescendantPids(rows: ProcRow[], rootPid: number): Set<number>`（成环/孤儿安全）
  - `matchBlacklistProgram(comm: string, blacklist: string[]): boolean`
  - `watchCommandTree(rootPid: number, blacklist: string[], onViolation: (v: { pid: number; program: string }) => void, opts?: { intervalMs?: number }): () => void`（win32 no-op；root 退出自动停；连续 3 次快照失败自动停；返回停止函数）

- [ ] **Step 1: 写失败测试**

`tests/security/child-monitor.test.ts`：

```ts
import { exec } from "node:child_process";
import { sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  buildDescendantPids,
  matchBlacklistProgram,
  parsePsOutput,
  watchCommandTree,
  type ProcRow,
} from "../../electron/domains/security/child-monitor";

const rows: ProcRow[] = [
  { pid: 1, ppid: 0, comm: "launchd" },
  { pid: 10, ppid: 1, comm: "zsh" },
  { pid: 11, ppid: 10, comm: "node" },
  { pid: 12, ppid: 11, comm: "sh" },
  { pid: 13, ppid: 12, comm: "sleep" },
  { pid: 99, ppid: 1, comm: "unrelated" },
];

describe("parsePsOutput", () => {
  it("解析 PID PPID COMM 表（含空格 comm）", () => {
    const out = parsePsOutput(
      "  PID  PPID COMM\n   10     1 zsh\n   13    12 My Program\n",
    );
    expect(out).toEqual([
      { pid: 10, ppid: 1, comm: "zsh" },
      { pid: 13, ppid: 12, comm: "My Program" },
    ]);
  });
});

describe("buildDescendantPids", () => {
  it("root 的全部后代（多层），不含 root 与无关进程", () => {
    const desc = buildDescendantPids(rows, 10);
    expect(desc.has(11)).toBe(true);
    expect(desc.has(12)).toBe(true);
    expect(desc.has(13)).toBe(true);
    expect(desc.has(10)).toBe(false);
    expect(desc.has(99)).toBe(false);
  });
  it("成环不死循环", () => {
    const cyclic: ProcRow[] = [
      { pid: 20, ppid: 21, comm: "a" },
      { pid: 21, ppid: 20, comm: "b" },
    ];
    expect(() => buildDescendantPids(cyclic, 20)).not.toThrow();
  });
});

describe("matchBlacklistProgram", () => {
  it("comm 基名 ∈ 黑名单（含路径形态 comm）", () => {
    expect(matchBlacklistProgram("rm", ["rm"])).toBe(true);
    expect(matchBlacklistProgram("/usr/bin/rm", ["rm"])).toBe(true);
    expect(matchBlacklistProgram("rmrf", ["rm"])).toBe(false);
  });
});

describe("watchCommandTree（真实进程，unix only）", () => {
  it.runIf(process.platform !== "win32")(
    "黑名单子进程被 kill 并回调",
    async () => {
      const child = exec("sh -c 'sleep 30'");
      const pid = child.pid!;
      const violations: Array<{ pid: number; program: string }> = [];
      const stop = watchCommandTree(pid, ["sleep"], (v) => violations.push(v), {
        intervalMs: 100,
      });
      // sleep 由 sh 子进程启动，等待 watcher 至少扫到一轮
      await sleep(1500);
      stop();
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].program).toBe("sleep");
      child.kill();
    },
    10_000,
  );
});
```

- [ ] **Step 2: 跑 RED** — Run: `npx vitest run tests/security/child-monitor.test.ts`；Expected: FAIL。

- [ ] **Step 3: 实现**

`electron/domains/security/child-monitor.ts`：

```ts
/**
 * 子进程穿透监控（SP2 spec §5，尽力检测）：轮询 ps 快照构建进程树，
 * root 命令的后代命中程序黑名单 → SIGKILL 该子树并回调。
 * 平台：darwin/linux；win32 为 no-op（顶层拦截不受影响，spec §5 诚实声明）。
 */
import { exec as execCb, execFile } from "node:child_process";
import { promisify } from "node:util";
import { programBasename } from "./command-policy";

const execFileAsync = promisify(execFile);

export interface ProcRow {
  pid: number;
  ppid: number;
  comm: string;
}

const PS_ARGS = ["-eo", "pid,ppid,comm"];

/** 解析 `ps -eo pid,ppid,comm` 输出（首行表头；comm 取行尾余量） */
export function parsePsOutput(stdout: string): ProcRow[] {
  const out: ProcRow[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match) {
      out.push({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] });
    }
  }
  return out;
}

/** rootPid 的全部后代 pid（BFS + seen 防环；孤儿行/缺父行安全） */
export function buildDescendantPids(rows: ProcRow[], rootPid: number): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const row of rows) {
    const list = childrenOf.get(row.ppid) ?? [];
    list.push(row.pid);
    childrenOf.set(row.ppid, list);
  }
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  const out = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/** comm 基名 ∈ 黑名单 */
export function matchBlacklistProgram(
  comm: string,
  blacklist: string[],
): boolean {
  return blacklist.includes(programBasename(comm));
}

/** kill pid 及其后代（已退出/无权限忽略——尽力而为） */
function killTree(rows: ProcRow[], pid: number): void {
  const victims = buildDescendantPids(rows, pid);
  for (const target of [pid, ...victims]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // 已退出或权限不足：尽力而为
    }
  }
}

/** 轮询监控：命中即 kill 子树并回调；返回停止函数（root 退出/连续 3 次失败自动停） */
export function watchCommandTree(
  rootPid: number,
  blacklist: string[],
  onViolation: (v: { pid: number; program: string }) => void,
  opts: { intervalMs?: number } = {},
): () => void {
  if (process.platform === "win32") {
    return () => {};
  }
  let stopped = false;
  let failures = 0;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    void patrol();
  }, opts.intervalMs ?? 250);
  async function patrol(): Promise<void> {
    try {
      const { stdout } = await execFileAsync("ps", PS_ARGS);
      failures = 0;
      const rows = parsePsOutput(stdout);
      if (!rows.some((row) => row.pid === rootPid)) {
        stop();
        return;
      }
      const descendants = buildDescendantPids(rows, rootPid);
      for (const row of rows) {
        if (descendants.has(row.pid) && matchBlacklistProgram(row.comm, blacklist)) {
          killTree(rows, row.pid);
          onViolation({ pid: row.pid, program: programBasename(row.comm) });
        }
      }
    } catch {
      failures += 1;
      if (failures >= 3) stop();
    }
  }
  return stop;
}

/** exec 的便捷 re-export（command-tool 改造用，保持单一 child_process 入口） */
export { execCb };
```

（实现后若 lint 报 `patrol` 等函数行数/复杂度，可微拆；测试为准。若 `execCb` re-export 未被 Task 4 使用则删掉该行——以最终被消费为准，不留死代码。）

- [ ] **Step 4: 跑 GREEN** — Run: `npx vitest run tests/security/child-monitor.test.ts`；Expected: PASS（含真实进程集成用例）。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/child-monitor.ts tests/security/child-monitor.test.ts
git commit -m "feat(安全中心): 子进程穿透监控——ps 快照进程树轮询 + 黑名单命中 SIGKILL 子树（win32 no-op）"
```

### Task 3: command-gate 单例 + 默认值演进

**Files:**
- Create: `electron/domains/security/command-gate.ts`
- Modify: `electron/domains/security/defaults.ts`（SECURITY_DEFAULTS 两个名单演进）
- Test: `tests/security/command-gate.test.ts`、`tests/security/config-store.test.ts`（追加默认值断言）

**Interfaces:**
- Consumes: Task 1 `decideCommand`/`CommandDecision`；`SecurityConfig`（types.ts）；`getConfigValue(): SecurityConfig`（SecurityService 已有）
- Produces（Task 4 依赖，签名逐字）:
  - `makeCommandDecider(getConfigValue: () => SecurityConfig): (command: string) => CommandDecision`（sandboxEnabled=false → "default"；异常 fail-open "default"）
  - `installCommandGate(fn: (command: string) => CommandDecision): void`
  - `commandGate(command: string): CommandDecision`（未安装/异常 → "default"）

- [ ] **Step 1: 写失败测试**

`tests/security/command-gate.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  commandGate,
  installCommandGate,
  makeCommandDecider,
} from "../../electron/domains/security/command-gate";
import { SECURITY_DEFAULTS } from "../../electron/domains/security/defaults";
import type { SecurityConfig } from "../../src-react/domains/security/model/types";

const config = (over: Partial<SecurityConfig>): SecurityConfig => ({
  ...SECURITY_DEFAULTS,
  ...over,
});

describe("makeCommandDecider", () => {
  it("默认规则：curl 询问 / git push 放行 / rm 拦截 / echo 默认", () => {
    const decide = makeCommandDecider(() => config({}));
    expect(decide("curl https://x.io")).toBe("ask");
    expect(decide("git push origin main")).toBe("allow");
    expect(decide("rm -rf x")).toBe("block");
    expect(decide("echo hi")).toBe("default");
  });
  it("sandboxEnabled=false → 一律 default（总开关旁路）", () => {
    const decide = makeCommandDecider(() => config({ sandboxEnabled: false }));
    expect(decide("rm -rf x")).toBe("default");
  });
  it("getConfigValue 抛错 → fail-open default", () => {
    const decide = makeCommandDecider(() => {
      throw new Error("boom");
    });
    expect(decide("rm -rf x")).toBe("default");
  });
});

describe("commandGate 模块单例", () => {
  it("未安装 → default；安装后生效；再装可替换", () => {
    expect(commandGate("rm -rf x")).toBe("default");
    installCommandGate((cmd) => (cmd.startsWith("rm") ? "block" : "default"));
    expect(commandGate("rm -rf x")).toBe("block");
    installCommandGate(() => "default");
    expect(commandGate("rm -rf x")).toBe("default");
  });
});
```

`tests/security/config-store.test.ts` 末尾追加（describe "defaults 平台差异与 upsert 兜底" 之后新 describe）：

```ts
describe("SP2 默认值演进", () => {
  it("cmdAsk 默认 curl/wget，cmdAllow 默认 git push/npm install", () => {
    expect(SECURITY_DEFAULTS.cmdAsk).toEqual([
      { prefix: ["curl"] },
      { prefix: ["wget"] },
    ]);
    expect(SECURITY_DEFAULTS.cmdAllow).toEqual([
      { prefix: ["git", "push"] },
      { prefix: ["npm", "install"] },
    ]);
  });
});
```

（import 处补 `SECURITY_DEFAULTS` 若未引入。）

- [ ] **Step 2: 跑 RED** — Run: `npx vitest run tests/security/command-gate.test.ts tests/security/config-store.test.ts`；Expected: 新文件 FAIL（模块不存在）、config-store 新 describe FAIL。

- [ ] **Step 3: 实现**

`electron/domains/security/command-gate.ts`：

```ts
/**
 * 命令判定门模块单例（SP2 spec §4.1）：registry 同款模块级单例模式，
 * Application 装配时 install（闭包读 SecurityService 内存缓存）；
 * chat.service 与 automation-runner 两处装配直接 import commandGate。
 * fail-open：未安装/异常一律 "default"（回到既有审批链，不阻断执行）。
 */
import type { SecurityConfig } from "../../src-react/domains/security/model/types";
import { decideCommand, type CommandDecision } from "./command-policy";

/** 由配置读函数构造判定器：总开关旁路 + 规则判定 + 异常 fail-open */
export function makeCommandDecider(
  getConfigValue: () => SecurityConfig,
): (command: string) => CommandDecision {
  return (command) => {
    try {
      const config = getConfigValue();
      if (!config.sandboxEnabled) return "default";
      return decideCommand(command, {
        programBlacklist: config.programBlacklist,
        cmdAsk: config.cmdAsk,
        cmdAllow: config.cmdAllow,
      });
    } catch {
      return "default";
    }
  };
}

let installed: ((command: string) => CommandDecision) | null = null;

export function installCommandGate(
  fn: (command: string) => CommandDecision,
): void {
  installed = fn;
}

export function commandGate(command: string): CommandDecision {
  try {
    return installed?.(command) ?? "default";
  } catch {
    return "default";
  }
}
```

`defaults.ts` 的 `SECURITY_DEFAULTS` 演进（spec §6）：

```ts
  cmdAllow: [
    { prefix: ["git", "push"] },
    { prefix: ["npm", "install"] },
  ],
  cmdAsk: [
    { prefix: ["curl"] },
    { prefix: ["wget"] },
  ],
```

（替换原 `cmdAllow: []` / `cmdAsk: []` 两行；`programBlacklist: ["rm"]` 不变。）

- [ ] **Step 4: 跑 GREEN** — Run: `npx vitest run tests/security/command-gate.test.ts tests/security/config-store.test.ts && npm run test`；Expected: 全 PASS（既有 parseSecurityConfig 空行集用例引用常量自动跟随新默认）。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/command-gate.ts electron/domains/security/defaults.ts tests/security/command-gate.test.ts tests/security/config-store.test.ts
git commit -m "feat(安全中心): 命令判定门模块单例（fail-open）+ 默认名单演进（询问 curl/wget、放行 git push/npm install）"
```

---

### Task 4: 执行接入（runToolCall 判定门 + 子进程挂载 + automation + remembered）

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`（AgentStreamOptions 两字段、runToolCall 判定门重构、装配、remembered 审计）
- Modify: `electron/domains/ai/agent/command-tool.ts`（危险命令 detail.source、子进程 watcher 挂载）
- Modify: `electron/domains/ai/agent/file-tools.ts`（ToolContext 加 commandWatchBlacklist 可选字段）
- Modify: `electron/domains/ai/automation/automation-runner.ts`（装配 decideCommand + unattended）
- Modify: `electron/Application.ts`（installCommandGate）
- Test: `tests/security/command-gate-integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `CommandDecision`、Task 2 `watchCommandTree`、Task 3 `commandGate`/`installCommandGate`/`makeCommandDecider`；SP1 `SecurityEventSink`
- Produces: 全部执行语义（block 拒/ask 无条件审批/unattended 强拒/allow 跳审批/default 不变）；`ToolContext.commandWatchBlacklist?: string[]`

**Step 1: 写失败测试** — `tests/security/command-gate-integration.test.ts`：

（前提：chat.service 需 `export` `runToolCall`——照 `runChatStream` 已有导出先例（模块头注释"可注入 model 与工具，供单测"），无需绕 ai-sdk 管线即可直测判定门分支。）

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/prisma-client", () => ({ default: {} }));

import {
  runToolCall,
  type AgentStreamOptions,
} from "../../electron/domains/ai/chat/chat.service";
import { makeRunCommandTool } from "../../electron/domains/ai/agent/command-tool";
import type { SecurityEvent } from "../../src-react/domains/security/model/types";

function makeAgent(
  over: Partial<AgentStreamOptions>,
): AgentStreamOptions & { events: SecurityEvent[]; approvals: string[] } {
  const events: SecurityEvent[] = [];
  const approvals: string[] = [];
  return {
    sessionId: 1,
    workspacePath: "/tmp/ws",
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

const CMD = { command: "echo hi" };

describe("runToolCall 命令判定门", () => {
  it("block：直接拒绝 + blocked 审计（source=blacklist），不触审批", async () => {
    const agent = makeAgent({ decideCommand: () => "block" });
    const out = await runToolCall(makeRunCommandTool(), agent, "t1", CMD);
    expect(out).toContain("程序黑名单");
    expect(agent.approvals).toHaveLength(0);
    expect(agent.events[0]).toMatchObject({
      eventType: "command-safety.blocked",
      decision: "blocked",
    });
    expect(agent.events[0].detail).toMatchObject({ source: "blacklist" });
  });

  it("ask + fullAccess：审批仍被强制触发（不被完全访问短路）", async () => {
    const agent = makeAgent({
      decideCommand: () => "ask",
      fullAccess: () => true,
    });
    await runToolCall(makeRunCommandTool(), agent, "t2", CMD);
    expect(agent.approvals).toHaveLength(1);
    expect(agent.events.some((e) => e.eventType === "command-safety.needs-approval")).toBe(true);
  });

  it("ask + unattended：强制拒绝（reason=unattended），不触审批", async () => {
    const agent = makeAgent({
      decideCommand: () => "ask",
      unattended: true,
      fullAccess: () => true,
    });
    const out = await runToolCall(makeRunCommandTool(), agent, "t3", CMD);
    expect(out).toContain("无人值守");
    expect(agent.approvals).toHaveLength(0);
    expect(agent.events[0]).toMatchObject({
      eventType: "command-safety.rejected",
      decision: "rejected",
    });
    expect(agent.events[0].detail).toMatchObject({ reason: "unattended" });
  });

  it("allow：跳过审批直执行 + allow-listed 审计", async () => {
    const agent = makeAgent({ decideCommand: () => "allow" });
    const out = await runToolCall(makeRunCommandTool(), agent, "t4", CMD);
    expect(agent.approvals).toHaveLength(0);
    expect(out).toContain("退出码 0");
    expect(agent.events.some((e) => e.eventType === "command-safety.allow-listed")).toBe(true);
  });

  it("default：行为与 SP1 一致（未记忆→审批；fullAccess→直执行）", async () => {
    const gated = makeAgent({ decideCommand: () => "default" });
    await runToolCall(makeRunCommandTool(), gated, "t5", CMD);
    expect(gated.approvals).toHaveLength(1);
    const full = makeAgent({
      decideCommand: () => "default",
      fullAccess: () => true,
    });
    await runToolCall(makeRunCommandTool(), full, "t6", CMD);
    expect(full.approvals).toHaveLength(0);
  });
});

describe("run_command 危险命令 source 标注", () => {
  it("危险命令拦截事件 detail.source=dangerous", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    const out = await tool.execute(
      {
        workspacePath: "/tmp/ws",
        sessionId: 1,
        onSecurityEvent: (e) => events.push(e),
      },
      { command: "rm -rf /Users/x/data" },
    );
    expect(out).toContain("安全策略拦截");
    expect(events[0].detail).toMatchObject({ source: "dangerous" });
  });

  it("无 commandWatchBlacklist 时正常执行零事件", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    await tool.execute(
      {
        workspacePath: "/tmp/ws",
        sessionId: 1,
        onSecurityEvent: (e) => events.push(e),
      },
      { command: "echo ok" },
    );
    expect(events).toHaveLength(0);
  });
});
```

**Step 2: 跑 RED** — Run: `npx vitest run tests/security/command-gate-integration.test.ts`；Expected: FAIL（detail 无 source 字段）。

**Step 3: 实现（逐文件）**

3a. `chat.service.ts`：

- import 追加：`import { commandGate, type CommandDecision } from "../../security/command-gate";`（chat/ 4 层到 security/：`../../security/command-gate`——同 domains 下兄弟目录，2 层）
- `AgentStreamOptions` 追加两字段（照现有注释风格）：

```ts
/** 命令安全判定门（SP2）：缺省走 commandGate 模块单例 */
decideCommand?: (command: string) => CommandDecision;
/** 无人值守流（automation，SP2）：ask 命中强制拒绝而非挂起审批 */
unattended?: boolean;
```

- 模块级常量与辅助函数（放 runToolCall 附近）：

```ts
const COMMAND_BLOCKED_OUTPUT = "错误: 该命令被命令安全策略禁止（程序黑名单）";
const COMMAND_UNATTENDED_OUTPUT =
  "错误: 无人值守任务不可执行询问名单命令，请从询问名单移除或改为人工会话执行";

/** run_command 判定门：非 run_command 或无命令返回 null */
function resolveCommandGate(
  agent: AgentStreamOptions,
  toolName: string,
  input: unknown,
): CommandDecision | null {
  if (toolName !== "run_command") return null;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string" || command === "") return null;
  return (agent.decideCommand ?? commandGate)(command);
}
```

- `runToolCall` **加 `export`**（照 runChatStream "供单测"先例，函数体签名不变）+ 判定门重构：在 write 审批判定前插判定门，审批条件改为 gate 感知（结构如下——denied/approved 的既有 onChunk/finalStates/审计路径逐字保留）：

```ts
const gate = resolveCommandGate(agent, def.name, input);
if (gate === "block") {
  finalStates?.set(toolCallId, "denied");
  onChunk?.({
    type: "tool-update", toolCallId, toolName: def.name,
    state: "denied", output: COMMAND_BLOCKED_OUTPUT,
  });
  emitCommandEvent(agent, input, "command-safety.blocked", "blocked", { source: "blacklist" });
  return COMMAND_BLOCKED_OUTPUT;
}
if (gate === "ask" && agent.unattended) {
  finalStates?.set(toolCallId, "denied");
  onChunk?.({
    type: "tool-update", toolCallId, toolName: def.name,
    state: "denied", output: COMMAND_UNATTENDED_OUTPUT,
  });
  emitCommandEvent(agent, input, "command-safety.rejected", "rejected", { reason: "unattended" });
  return COMMAND_UNATTENDED_OUTPUT;
}
if (gate === "ask") {
  emitCommandEvent(agent, input, "command-safety.needs-approval", "info", {});
}
const bypassNormalApproval = gate === "allow";
if (gate === "allow") {
  emitCommandEvent(agent, input, "command-safety.allow-listed", "allowed", {});
}
const needsApproval =
  gate === "ask" ||
  (!bypassNormalApproval &&
    def.kind === "write" &&
    !agent.fullAccess() &&
    !(await agent.isToolAllowed(def.name)));
if (needsApproval) {
  // ……awaitApproval 既有路径原样保留（aborted/denied/approved 三分支不动）
}
```

`emitCommandEvent` 辅助（模块级，复用 commandSha256 语义——从 command-tool 提出或本地实现）：

```ts
function emitCommandEvent(
  agent: AgentStreamOptions,
  input: unknown,
  eventType: string,
  decision: "blocked" | "rejected" | "info" | "allowed",
  extra: Record<string, unknown>,
): void {
  const command = String((input as { command?: unknown } | null)?.command ?? "");
  agent.onSecurityEvent?.({
    eventType,
    decision,
    detail: { command: command.slice(0, 200), ...extra },
    commandPreview: command.slice(0, 100),
    sessionId: agent.sessionId,
  });
}
```

- `resolveAgentOptions` 装配字面量追加：`decideCommand: commandGate,`（会话流不设 unattended）
- `permission:rememberTool` handler 追加 remembered 审计（spec §8 补齐项）：

```ts
this.auditSink?.({
  eventType: `${toolName === "run_command" ? "command-safety" : "file-safety"}.remembered`,
  decision: "info",
  detail: { tool: toolName, workspaceId },
});
```

3b. `command-tool.ts`：

- 危险命令分支 detail 追加 `source: "dangerous"`
- `CommandContext` 追加 `commandWatchBlacklist?: string[]`
- **runExec 重构（pid 传递的定稿方案）**：签名改为 `function runExec(command: string, cwd: string | undefined): { promise: Promise<ExecOutcome>; child: ChildProcess }`——内部 `const child = exec(...)` 照旧挂回调，返回 `{ promise, child }`（行为不变，只是把 child 暴露给调用方）。import 类型 `import type { ChildProcess } from "node:child_process";`
- `execute` 挂载 watcher（定稿结构）：

```ts
const { promise, child } = runExec(args.command, resolveCwd(ctx, args.cwd));
const stopWatch = startChildWatch(ctx, args.command, child.pid);
try {
  const { code, label, stdout, stderr } = await promise;
  /* 既有输出组装逻辑不变 */
} finally {
  stopWatch?.();
}
```

（`startChildWatch` 签名：`function startChildWatch(ctx: CommandContext, command: string, pid: number | undefined): (() => void) | undefined`——watcher 在 exec 同步返回 child 后立刻挂载、覆盖整个执行期；内部条件 `pid && blacklist.length > 0 && process.platform !== "win32"`，命中回调发 `command-safety.child-blocked` 审计，detail `{program, pid, rootCommand: command.slice(0,200)}`。）

3c. `command-gate.ts` 追加 watchlist 单例（黑名单 getter）：

```ts
let watchlistGetter: (() => string[]) | null = null;

export function installCommandWatchlist(fn: () => string[]): void {
  watchlistGetter = fn;
}

export function commandWatchBlacklist(): string[] {
  try {
    return watchlistGetter?.() ?? [];
  } catch {
    return [];
  }
}
```

`file-tools.ts`：`ToolContext` 追加 `commandWatchBlacklist?: string[]`；`chat.service.ts` 的 `executeToolSafe` ctx 字面量追加：

```ts
// SP2 子进程黑名单（会话与 automation 统一监控；win32 在 child-monitor 内 no-op）
commandWatchBlacklist: commandWatchBlacklist(),
```

3d. `automation-runner.ts`：agent 装配字面量（263-267 附近）追加：

```ts
decideCommand: commandGate,
unattended: true,
```

（import commandGate from security/command-gate，4 层：`../../../../domains/security/command-gate`——automation 在 electron/domains/ai/automation/，到 security 是 `../../security/command-gate`。）

3e. `Application.ts`：接线处（SecurityService init 之后）追加：

```ts
// 命令安全判定门（SP2）：install 后 chat/automation 两处装配共享
installCommandGate(makeCommandDecider(() => securityService.getConfigValue()));
installCommandWatchlist(() =>
  securityService.getConfigValue().sandboxEnabled
    ? securityService.getConfigValue().programBlacklist
    : [],
);
```

**Step 4: 全量验证** — Run: `npm run test && npm run typecheck && npm run lint`；Expected: 全绿（既有 tests/ai 回归——判定门 null/default 路径行为不变）。

**Step 5: Commit**

```bash
git add electron/domains/ai/chat/chat.service.ts electron/domains/ai/agent/command-tool.ts electron/domains/ai/agent/file-tools.ts electron/domains/ai/automation/automation-runner.ts electron/Application.ts electron/domains/security/command-gate.ts tests/security/command-gate-integration.test.ts
git commit -m "feat(安全中心): 命令判定门接入执行链——block 拒/ask 无条件审批（unattended 强拒）/allow 跳审批 + 子进程黑名单挂载 + remembered 审计"
```

### Task 5: 重置 IPC + i18n 扩展

**Files:**
- Modify: `electron/domains/security/security.service.ts`（`security:resetCommandRules` handler）
- Modify: `src-react/lib/ipc.ts`（IPCChannel 追加 1 通道）
- Modify: `src-react/domains/security/api/security.api.ts`（`resetCommandRules()`）
- Modify: `src-react/i18n/locales/zh-CN/security.json`、`en-US/security.json`（events 6 key + commandDetail 文案族）

**Interfaces:**
- Consumes: `SECURITY_DEFAULTS`、`setConfig`（既有）
- Produces（Task 6 依赖）:
  - `SecurityApi.resetCommandRules(): Promise<SecurityConfig>`
  - i18n：`security:commandDetail.*` 全族 + `security:audit.events.*` 6 个新 key

**Step 1: 主进程 handler** — `security.service.ts` 的 `registerHandlers` 追加：

```ts
ipcMain.handle(
  "security:resetCommandRules",
  async (): Promise<SecurityConfig> => this.resetCommandRules(),
);
```

类内新增方法（复用 setConfig 的审计联动）：

```ts
/** 三名单恢复默认（spec §7）：逐 key 走 setConfig（各发 updated 审计）+ 一条 reset 事件 */
async resetCommandRules(): Promise<SecurityConfig> {
  const keys: SecurityConfigKey[] = ["programBlacklist", "cmdAllow", "cmdAsk"];
  let config = this.getConfigValue();
  for (const key of keys) {
    config = await this.setConfig(key, SECURITY_DEFAULTS[key]);
  }
  this.opts.audit?.({
    eventType: "config.commandRules.reset",
    decision: "info",
    detail: { keys },
  });
  return copySecurityConfig(config);
}
```

（`SECURITY_DEFAULTS`/`copySecurityConfig` 若未 import 则补。）

**Step 2: 前端三处** — `src-react/lib/ipc.ts` 的 security 注释块追加 `| "security:resetCommandRules";`；`security.api.ts` 追加：

```ts
static resetCommandRules(): Promise<SecurityConfig> {
  return invoke<SecurityConfig>("security:resetCommandRules");
}
```

**Step 3: i18n** — zh-CN `security.json` 追加（`audit.events` 对象内补 6 key；顶层加 `commandDetail` 对象）：

```json
"commandDetail": {
  "title": "命令安全",
  "priorityNote": "优先级：程序黑名单（绝对禁止，含子进程）＞ 询问名单 ＞ 放行名单 ＞ 默认审批",
  "reset": "重置为默认",
  "resetDone": "已重置为默认名单",
  "programBlacklist": {
    "title": "程序黑名单",
    "desc": "绝对禁止运行的程序（含子进程检测）；仅填程序名，不含路径或参数",
    "placeholder": "如 mkfs",
    "invalid": "仅接受程序名（不含 / \\ 或空白）"
  },
  "allow": {
    "title": "放行名单",
    "desc": "命中后跳过审批直接执行（视为可信命令；不匹配子进程）",
    "placeholder": "如 git push"
  },
  "ask": {
    "title": "询问名单",
    "desc": "命中后先弹审批（完全访问模式下同样生效）；批准后继续执行",
    "placeholder": "如 curl"
  },
  "add": "添加",
  "confirm": "保存",
  "cancel": "取消",
  "remove": "删除",
  "empty": "暂无条目"
}
```

`audit.events` 内追加：

```json
"command-safety_needs-approval": "命令需审批: {{command}}",
"command-safety_allow-listed": "命令已放行: {{command}}",
"command-safety_child-blocked": "已终止黑名单子进程: {{program}}",
"command-safety_remembered": "工具已加入免审记忆: {{tool}}",
"file-safety_remembered": "工具已加入免审记忆: {{tool}}",
"config_commandRules-reset": "命令名单已重置为默认"
```

en-US 镜像（逐 key 对应，示例：`"priorityNote": "Priority: program blocklist (absolute, incl. child processes) > ask list > allow list > default approval"`、`"command-safety_needs-approval": "Command requires approval: {{command}}"` 等，插值变量一致）。

**Step 4: 验证 + Commit** — Run: `npm run typecheck && npm run lint`；Expected: 零错误。

```bash
git add electron/domains/security/security.service.ts src-react/lib/ipc.ts src-react/domains/security/api/security.api.ts src-react/i18n/locales/zh-CN/security.json src-react/i18n/locales/en-US/security.json
git commit -m "feat(安全中心): 命令名单重置 IPC + commandDetail 双语文案与 6 个审计事件 key"
```

---

### Task 6: 命令安全二级页 UI

**Files:**
- Create: `src-react/domains/security/components/CommandDetailView.tsx`
- Modify: `src-react/domains/security/components/SecurityCenter.tsx`（视图栈扩展 "command"）
- Modify: `src-react/domains/security/components/SandboxCard.tsx`（命令安全入口启用）

**Interfaces:**
- Consumes: Task 5 `SecurityApi.resetCommandRules` 与 `commandDetail.*` i18n；既有 `SecurityApi.setConfig/getConfig`；`SecurityConfig`/`CmdRule` 类型
- Produces: `<CommandDetailView config onBack onRulesChange />`；SecurityCenter 视图栈 `"home" | "audit-all" | "command"`

**Step 1: SecurityCenter 视图栈** — `SecurityView` 联合类型加 `"command"`；首页渲染分支前加：

```tsx
if (view === "command") {
  return (
    <div className="p-1">
      <CommandDetailView
        config={config}
        onBack={() => setView("home")}
        onRulesChange={setConfig}
      />
    </div>
  );
}
```

**Step 2: SandboxCard 入口启用** — 三入口 ENTRIES 拆分：命令安全项渲染为可点击行（`onOpenCommand` prop 新增，`aria-disabled`/`opacity-60`/徽标移除，hover 效果 `hover:bg-primary-subtle hover:text-primary`，加 ChevronRight）；文件/网络维持禁用占位。props 加 `onOpenCommand: () => void`。

**Step 3: CommandDetailView 实现**

```tsx
/**
 * 命令安全二级页（SP2 spec §7）：三名单 CRUD（PRD 附录交互——添加行
 * → 输入框 → 对勾/叉号）+ 优先级说明 + 重置为默认。
 * CRUD 走 setConfig 整组替换；黑名单仅接受裸程序名。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, Check, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CmdRule, SecurityConfig, SecurityConfigKey } from "../model/types";
import { SecurityApi } from "../api/security.api";

interface CommandDetailViewProps {
  config: SecurityConfig;
  onBack: () => void;
  onRulesChange: (config: SecurityConfig) => void;
}

/** 单个名单区块：标题/说明/列表/添加行（editing 态内联输入框） */
function RuleSection(props: {
  titleKey: string;
  descKey: string;
  placeholderKey: string;
  items: string[];
  display: (item: string) => string;
  validate: (raw: string) => string | null;
  invalidKey: string;
  onSave: (items: string[]) => Promise<void>;
}) {
  const { t } = useTranslation(["security"]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // ……编辑态渲染：items 为空时空态文案；保存调用 props.onSave([...items, normalized])
  // 删除按钮调用 props.onSave(items.filter(...))；对勾/叉号切换 editing
  // （实现照 PRD 附录交互；完整 JSX 约 60 行——结构：区块标题+desc、
  //   列表行（display 文本 + Trash2 按钮）、添加行（未编辑=「添加」ghost 按钮
  //   带 Plus；编辑=Input + Check/X 两个 icon 按钮））
  return null; // ← 实现时替换为本节完整 JSX（见下）
}
```

**本节完整 JSX（定稿，替换上方 return null）**：

```tsx
const add = async () => {
  const normalized = props.validate(draft);
  if (normalized === null) {
    toast.error(t(props.invalidKey));
    return;
  }
  if (props.items.includes(normalized)) {
    setEditing(false);
    setDraft("");
    return;
  }
  await props.onSave([...props.items, normalized]);
  setEditing(false);
  setDraft("");
};
const remove = async (item: string) => {
  await props.onSave(props.items.filter((it) => it !== item));
};
return (
  <section className="space-y-2">
    <div>
      <h4 className="text-sm font-medium">{t(props.titleKey)}</h4>
      <p className="text-xs text-muted-foreground">{t(props.descKey)}</p>
    </div>
    <div className="space-y-1">
      {props.items.length === 0 && !editing && (
        <p className="text-xs text-muted-foreground">
          {t("security:commandDetail.empty")}
        </p>
      )}
      {props.items.map((item) => (
        <div key={item} className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {props.display(item)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("security:commandDetail.remove")}
            onClick={() => void remove(item)}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      {editing ? (
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            value={draft}
            placeholder={t(props.placeholderKey)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-8"
          />
          <Button variant="ghost" size="sm" aria-label={t("security:commandDetail.confirm")} onClick={() => void add()}>
            <Check size={14} />
          </Button>
          <Button variant="ghost" size="sm" aria-label={t("security:commandDetail.cancel")} onClick={() => setEditing(false)}>
            <X size={14} />
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary"
          onClick={() => setEditing(true)}
        >
          <Plus size={14} />
          {t("security:commandDetail.add")}
        </Button>
      )}
    </div>
  </section>
);
```

**组件主体（同文件续）**：

```tsx
/** 黑名单输入校验：裸程序名（无路径分隔符/空白），原样返回或 null */
function validateProgram(raw: string): string | null {
  const v = raw.trim();
  return v !== "" && !/[\/\\\s]/.test(v) ? v : null;
}

export default function CommandDetailView({
  config,
  onBack,
  onRulesChange,
}: CommandDetailViewProps) {
  const { t } = useTranslation(["security"]);
  const save = async (key: SecurityConfigKey, items: string[]) => {
    try {
      const saved = await SecurityApi.setConfig(key, items);
      onRulesChange(saved);
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  const reset = async () => {
    try {
      onRulesChange(await SecurityApi.resetCommandRules());
      toast.success(t("security:commandDetail.resetDone"));
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  const toRules = (items: string[]): CmdRule[] =>
    items.map((line) => ({ prefix: line.trim().split(/\s+/) }));
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
          {t("security:commandDetail.reset")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("security:commandDetail.priorityNote")}
      </p>
      <RuleSection
        titleKey="security:commandDetail.programBlacklist.title"
        descKey="security:commandDetail.programBlacklist.desc"
        placeholderKey="security:commandDetail.programBlacklist.placeholder"
        invalidKey="security:commandDetail.programBlacklist.invalid"
        items={config.programBlacklist}
        display={(it) => it}
        validate={validateProgram}
        onSave={(items) => save("programBlacklist", items)}
      />
      <RuleSection
        titleKey="security:commandDetail.allow.title"
        descKey="security:commandDetail.allow.desc"
        placeholderKey="security:commandDetail.allow.placeholder"
        invalidKey="security:dataSafety.invalidThreshold"
        items={config.cmdAllow.map((r) => r.prefix.join(" "))}
        display={(it) => it}
        validate={(raw) => (raw.trim() !== "" ? raw.trim() : null)}
        onSave={(items) => save("cmdAllow", toRules(items))}
      />
      <RuleSection
        titleKey="security:commandDetail.ask.title"
        descKey="security:commandDetail.ask.desc"
        placeholderKey="security:commandDetail.ask.placeholder"
        invalidKey="security:dataSafety.invalidThreshold"
        items={config.cmdAsk.map((r) => r.prefix.join(" "))}
        display={(it) => it}
        validate={(raw) => (raw.trim() !== "" ? raw.trim() : null)}
        onSave={(items) => save("cmdAsk", toRules(items))}
      />
    </div>
  );
}
```

（放行/询问区共用的"空输入非法"提示复用 `dataSafety.invalidThreshold` 语义不准——**在 commandDetail 加 `"invalidCommand": "请输入有效命令"`** 双语并替换上面两处 invalidKey；Task 5 的 i18n 步骤须包含此 key。）

**Step 4: 验证 + Commit** — Run: `npm run typecheck && npm run lint`；Expected: 零错误。

```bash
git add src-react/domains/security/components
git commit -m "feat(安全中心): 命令安全二级页——三名单 CRUD + 重置默认 + 沙箱卡片入口启用"
```

---

### Task 7: 手工验收 + 收尾

**Files:**
- Create: `docs/superpowers/acceptance/2026-09-16-security-center-sp2.md`

**Step 1: 全量验证** — Run: `npm run test && npm run typecheck && npm run lint`；Expected: 全绿。

**Step 2: 验收文档**（标题样式照 SP1 验收文档）清单：

- 设置 → 安全中心 → 沙箱安全 → 「命令安全」入口可点入二级页
- 三名单显示默认值（黑名单 rm；放行 git push/npm install；询问 curl/wget）；添加/删除/空态交互（对勾/叉号/回车/Esc）；黑名单输入 `a/b` 或含空格被拒 toast
- 「重置为默认」恢复三名单并 toast；审计出现「命令名单已重置为默认」
- 人工会话 default 模式：AI 执行 `curl example.com` → 弹审批（询问名单）；批准后执行、拒绝回喂
- 人工会话 **full 模式**：`curl` 仍弹审批（裁定 A 生效）；`git push` 不弹（放行）；`rm -rf /tmp/xx`（非绝对路径形态）被程序黑名单直拒——注意危险命令正则只拦绝对路径形态，`rm file` 相对路径形态由黑名单拦
- 审计中心：needs-approval / allow-listed / blocked(source=blacklist) 事件可见；切换 en-US 文案跟随
- 子进程穿透：临时把 `sleep` 加入黑名单 → 让 AI 执行 `sh -c 'sleep 30'` → 数秒内命令异常终止 + 审计「已终止黑名单子进程: sleep」
- automation：建 full 模式定时任务让 AI 执行 `curl …` → run 记录显示拒绝反馈（无人值守强拒）

**Step 3: Commit**

```bash
git add docs/superpowers/acceptance/2026-09-16-security-center-sp2.md
git commit -m "docs(安全中心): SP2 手工验收清单"
```

---

## 收尾验证（全部任务完成后）

- [ ] `npm run test` 全绿（新增 tests/security/command-policy|child-monitor|command-gate|command-gate-integration）
- [ ] `npm run typecheck && npm run lint` 零错误
- [ ] 对照 SP2 spec §1「做」六项逐项勾验；「不做」清单未越界
- [ ] 判定门 default 路径与 SP1 行为逐字节一致（既有 tests/ai 全绿佐证）

## Self-Review 记录（计划完成时）

- Spec 覆盖：§3 判定引擎（T1）、§5 子进程监控（T2 + T4 挂载）、§4 执行接入（T3 gate + T4）、§6 默认值（T3）、§7 二级页（T5 IPC/i18n + T6 UI）、§8 审计事件（T4/T5）、§9 错误处理（fail-open 内嵌 T3/T4、watcher 失败策略 T2）、§10 测试（各任务内嵌）——无缺口
- 类型一致性：CommandDecision/CommandRules（T1 定义，T3/T4 消费）、watchCommandTree 签名（T2 定义，T4 消费）、commandGate/installCommandGate/installCommandWatchlist（T3/T4）、resetCommandRules（T5 定义，T6 消费）、CommandDetailView props（T6 内自洽）
- 已知注记：T5 i18n 须含 `commandDetail.invalidCommand`（T6 使用）；T4 集成测试依赖 runToolCall 导出（照 runChatStream 先例）


