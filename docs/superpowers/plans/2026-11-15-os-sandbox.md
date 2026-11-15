# OS 级沙箱(macOS Seatbelt)首批落地 Implementation Plan

> **⚠️ 状态:本计划未被执行——实施已由并行会话 mirror-2f 完成(`worktree-os-sandbox` 分支 4f9258dc,2026-11-15),且实施批平台实测发现本计划代码块的两处错误:①profile 模板缺 `(allow default)` 头(macOS 26 上 sbpl 未提及操作不再默认放行,缺它 execvp EPERM)+ subpath 须 realpath 归一;②`exec()` 在 Node 26 丢弃 detached 选项,须 spawn("/bin/sh", ["-c", …]) 适配层且收割挂 exit 事件。本计划留作设计过程记录,代码块一律以 `docs/design/os-sandbox.md` 勘误后版本为准,勿照抄。**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bash 工具的 shell 命令在 macOS 上经 Seatbelt(sandbox-exec)执行,工作空间与临时目录之外的文件写入被 OS 级拒绝——兜住应用层静态分析的固有极限(命令替换混淆/引号误分/换壳)。

**Architecture:** 纯加法:`security/sandbox/` 新模块(profile 纯函数 + seatbelt 实现 + runner 单例门禁合成),`command-tool.ts` runExec 一处消费;判定链(tool-gate 七步)、危险命令正则、cwd 钳制、child-monitor 全部不动。fail-open:任何环节未启用/不可用/异常一律原样透传回落现有防线。

**Tech Stack:** Node 内置 `node:child_process`(sandbox-exec/spawnSync/kill)、TypeScript、vitest、React + i18next(security 命名空间)。

**Spec:** `docs/design/os-sandbox.md`(2026-11-14 已批;两裁定:默认关 + 沙箱内网络全放行)

## 与 spec 的两处实现偏差(已按项目惯例收敛)

1. **装配从「CommandContext 注入面」改为「模块单例直调」**:spec §5 原写 CommandContext 加 `osSandbox` 注入;实现改为 command-tool 直调 `osSandboxWrap()` 模块函数(先例:command-tool.ts:14 `getNetworkGate()`、command-gate 模块单例)。收益:AgentStreamOptions / chat.service / automation-runner / executeToolSafe **零改动**;可测性经 vi.mock 达成(先例充分)。语义不变:enabled × available × 非 full 三条件合成 + fail-open。
2. **SandboxWrapResult 不含 reapProcessGroup**:进程组收割在 command-tool 通用实现(仅 `sandboxed=true` 时 exec 加 `detached: true`,超时/异常结算时 `kill(-pid)`),runner 接口更小。

## Global Constraints

- 路径基准:`apps/tianshu-desktop/`(测试在 `tests/`,经 `../../electron/...` 相对 import)
- Prettier:双引号、分号、tabWidth 2、printWidth 80、**无尾随逗号**
- ESLint:生产代码禁 `console`/`debugger`
- i18n:用户可见文案必须 `t()` + zh-CN/en-US **同任务内双补**;禁止硬编码中文/英文
- 主题:禁止硬编码 `bg-blue-*` 等具体色类,用主题变量类
- 跨平台纪律:新代码不得假设平台(runner 内显式 `process.platform` 分支除外);测试对非 darwin 环境必须 `describe.skipIf` 守卫
- 测试命令统一在 `apps/tianshu-desktop` 目录执行:`cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npx vitest run <file>`
- commit message:中文,格式 `feat(desktop): …` / `test(desktop): …`(仓库 recent commits 同款)
- worktree 内 git 被 rtk hook 拦截:**一律用 `/usr/bin/git` 绝对路径**
- fail-open 铁律:osSandboxWrap 任何异常 catch 后返回原命令,绝不阻断执行

## 执行注记(执行者先读)

- 本计划在 **worktree** 中执行(用户 2026-10-28 裁定:默认 worktree)。执行前**第一步**是把主树未提交的三个 docs 文件先 commit 到 main(用户批准本计划即含此项):
  ```bash
  cd /Users/hjx/workspace/mirror && /usr/bin/git add docs/design/os-sandbox.md docs/design/security.md docs/design/README.md && /usr/bin/git commit -m "docs(design): OS 级沙箱技术方案立项——Seatbelt 首批spec+挂账联动"
  ```
  然后建 worktree(基于最新 main),避免 worktree 内缺 spec 文件。
- 每个 Task 结尾 commit 一次,消息已给出,可按实际微调但保持中文 conventional 格式。

---

### Task 1: sbpl profile 生成纯函数

**Files:**
- Create: `electron/domains/security/sandbox/profile.ts`
- Test: `tests/security/os-sandbox-profile.test.ts`

**Interfaces:**
- Produces: `escapeSbplLiteral(value: string): string`、`buildSeatbeltProfile(workspacePath: string, tmpDir: string): string`(Task 2 的 seatbelt.ts 消费)

- [ ] **Step 1: 写失败测试**

```ts
// tests/security/os-sandbox-profile.test.ts
import { describe, expect, it } from "vitest";
import {
  buildSeatbeltProfile,
  escapeSbplLiteral,
} from "../../electron/domains/security/sandbox/profile";

describe("escapeSbplLiteral", () => {
  it("转义反斜杠与双引号", () => {
    expect(escapeSbplLiteral('a"b\\c')).toBe('a\\"b\\\\c');
  });
  it("空格/中文/常规字符原样", () => {
    expect(escapeSbplLiteral("/Users/hjx/工作 空间")).toBe(
      "/Users/hjx/工作 空间",
    );
  });
});

describe("buildSeatbeltProfile", () => {
  it("含 deny 兜底与 workspace/TMPDIR 写白名单及设备节点", () => {
    const p = buildSeatbeltProfile("/tmp/ws", "/private/var/folders/ab/T");
    expect(p).toContain("(version 1)");
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain('(allow file-write* (subpath "/tmp/ws"))');
    expect(p).toContain(
      '(allow file-write* (subpath "/private/var/folders/ab/T"))',
    );
    expect(p).toContain('(allow file-write* (literal "/dev/null"))');
    expect(p).toContain('(allow file-write* (literal "/dev/tty"))');
  });
  it("workspace 含双引号时被转义(不产生裸引号闭合)", () => {
    const p = buildSeatbeltProfile('/tmp/w"s', "/tmp");
    expect(p).toContain('\\"');
    expect(p).not.toMatch(/\(subpath "\/tmp\/w"s"\)/);
  });
  it("不含任何 network 条目(裁定#2:沙箱内网络全放行)", () => {
    const p = buildSeatbeltProfile("/tmp/ws", "/tmp");
    expect(p).not.toMatch(/network/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npx vitest run tests/security/os-sandbox-profile.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

```ts
// electron/domains/security/sandbox/profile.ts
/**
 * Seatbelt sbpl profile 生成(纯函数,os-sandbox spec §4.2/§4.3)。
 * workspace-write 语义:deny file-write* 兜底,白名单 = workspace 子树
 * + TMPDIR + 基础设备节点;读/进程执行/网络零约束(裁定#2 网络全放行)。
 * sbpl 为黑名单语义,未提及的操作默认允许。
 */

/** sbpl 字符串字面量转义:反斜杠与双引号 */
export function escapeSbplLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 生成 workspace-write 语义的 sbpl profile 文本 */
export function buildSeatbeltProfile(
  workspacePath: string,
  tmpDir: string,
): string {
  return [
    "(version 1)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${escapeSbplLiteral(workspacePath)}"))`,
    `(allow file-write* (subpath "${escapeSbplLiteral(tmpDir)}"))`,
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/tty"))',
  ].join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS(7 例)

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/tianshu-desktop/electron/domains/security/sandbox/profile.ts apps/tianshu-desktop/tests/security/os-sandbox-profile.test.ts
/usr/bin/git commit -m "feat(desktop): sbpl profile 生成纯函数——workspace-write 白名单与转义"
```

---

### Task 2: runner 门禁合成 + Seatbelt 实现

**Files:**
- Create: `electron/domains/security/sandbox/runner.ts`
- Create: `electron/domains/security/sandbox/seatbelt.ts`
- Test: `tests/security/os-sandbox-runner.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `buildSeatbeltProfile`
- Produces(Task 4/5 消费):
  - `type SandboxWrapOptions = { workspacePath: string; fullAccess: boolean }`
  - `type SandboxWrapResult = { command: string; sandboxed: boolean; workspace: string }`(workspace=沙箱锚点,透传时空串)
  - `interface SandboxRunner { available(): boolean; wrap(command: string, opts: SandboxWrapOptions): SandboxWrapResult }`
  - `installSandboxRunner(r: SandboxRunner): void` / `installOsSandboxGate(getEnabled: () => boolean): void`(Application.ts 装配)
  - `osSandboxWrap(command: string, opts: SandboxWrapOptions): SandboxWrapResult`(command-tool 直调)
  - `seatbeltRunner: SandboxRunner`(seatbelt.ts 导出)

- [ ] **Step 1: 写失败测试**

```ts
// tests/security/os-sandbox-runner.test.ts
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installOsSandboxGate,
  installSandboxRunner,
  osSandboxWrap,
} from "../../electron/domains/security/sandbox/runner";
import { seatbeltRunner } from "../../electron/domains/security/sandbox/seatbelt";

const stubRunner = (available: boolean) => ({
  available: () => available,
  wrap: (command: string) => ({
    command: `WRAPPED(${command})`,
    sandboxed: true,
    workspace: "/tmp/ws",
  }),
});

describe("osSandboxWrap 三条件合成(fail-open)", () => {
  beforeEach(() => {
    installOsSandboxGate(() => false);
    installSandboxRunner(stubRunner(true));
  });

  it("未启用 → 原样透传", () => {
    const r = osSandboxWrap("echo hi", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    expect(r).toEqual({ command: "echo hi", sandboxed: false, workspace: "" });
  });

  it("已启用但 runner 不可用 → 透传", () => {
    installOsSandboxGate(() => true);
    installSandboxRunner(stubRunner(false));
    const r = osSandboxWrap("echo hi", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    expect(r.sandboxed).toBe(false);
  });

  it("fullAccess → 透传(裁定假设:full 不进沙箱)", () => {
    installOsSandboxGate(() => true);
    const r = osSandboxWrap("echo hi", {
      workspacePath: "/tmp/ws",
      fullAccess: true,
    });
    expect(r.sandboxed).toBe(false);
    expect(r.command).toBe("echo hi");
  });

  it("三条件满足 → 走 runner.wrap", () => {
    installOsSandboxGate(() => true);
    const r = osSandboxWrap("echo hi", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    expect(r.command).toBe("WRAPPED(echo hi)");
    expect(r.sandboxed).toBe(true);
  });

  it("enabledGetter 抛异常 → 透传(fail-open)", () => {
    installOsSandboxGate(() => {
      throw new Error("config unavailable");
    });
    const r = osSandboxWrap("echo hi", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    expect(r.command).toBe("echo hi");
  });
});

describe("seatbeltRunner", () => {
  it("非 darwin 平台 available=false 并透传", () => {
    if (process.platform === "darwin") return; // darwin 见下组
    expect(seatbeltRunner.available()).toBe(false);
    const r = seatbeltRunner.wrap("echo hi", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    expect(r.sandboxed).toBe(false);
  });

  it("fullAccess 透传(锚点判定前短路)", () => {
    const r = seatbeltRunner.wrap("echo hi", {
      workspacePath: "/tmp/ws",
      fullAccess: true,
    });
    expect(r.command).toBe("echo hi");
  });
});

describe.skipIf(process.platform !== "darwin")("seatbeltRunner(darwin 实跑探测)", () => {
  it("available() 探测 sandbox-exec 可用", () => {
    expect(seatbeltRunner.available()).toBe(true);
  });

  it("wrap 生成 sandbox-exec 包装形态,workspace 空串锚定家目录", () => {
    const r = seatbeltRunner.wrap('echo "hi"', {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    expect(r.command.startsWith("sandbox-exec -p ")).toBe(true);
    expect(r.command).toContain("/bin/zsh -c");
    expect(r.command).toContain('(deny file-write*)');
    expect(r.command).toContain('(subpath "/tmp/ws")');
    expect(r.sandboxed).toBe(true);
    expect(r.workspace).toBe("/tmp/ws");

    const homeAnchored = seatbeltRunner.wrap("echo hi", {
      workspacePath: "",
      fullAccess: false,
    });
    expect(homeAnchored.command).toContain(
      `(subpath "${os.homedir().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`,
    );
  });

  it("原命令含单引号时 sh 层转义不破坏命令结构", () => {
    const r = seatbeltRunner.wrap("echo 'a b'", {
      workspacePath: "/tmp/ws",
      fullAccess: false,
    });
    // 整条命令仍是合法 shell(以 sandbox-exec 起头且以原命令收尾的引号闭合)
    expect(r.command.match(/'/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npx vitest run tests/security/os-sandbox-runner.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 runner.ts**

```ts
// electron/domains/security/sandbox/runner.ts
/**
 * OS 沙箱门禁合成(模块单例,os-sandbox spec §3;先例:command-gate/
 * network-gate 单例直调模式)。fail-open 铁律:未装配/未启用/不可用/
 * 异常一律原样透传,回落既有应用层防线,绝不阻断执行。
 */
export type SandboxWrapOptions = {
  workspacePath: string;
  fullAccess: boolean;
};

export type SandboxWrapResult = {
  /** 包装后的完整命令行(透传时 === 原命令) */
  command: string;
  /** 是否实际进入沙箱(exec detached 与收割的开关) */
  sandboxed: boolean;
  /** 沙箱写白名单锚点(透传时空串) */
  workspace: string;
};

export interface SandboxRunner {
  /** 平台可用性(darwin 且 sandbox-exec 可执行) */
  available(): boolean;
  wrap(command: string, opts: SandboxWrapOptions): SandboxWrapResult;
}

const TRANSPARENT: SandboxWrapResult = {
  command: "",
  sandboxed: false,
  workspace: "",
};

function transparent(command: string): SandboxWrapResult {
  return { ...TRANSPARENT, command };
}

/** 平台 runner 单例:缺省恒透传 no-op */
let installedRunner: SandboxRunner = {
  available: () => false,
  wrap: (command) => transparent(command),
};

export function installSandboxRunner(runner: SandboxRunner): void {
  installedRunner = runner;
}

/** 启用判定闭包单例:Application 装配时 install(实时读 SecurityConfig) */
let enabledGetter: (() => boolean) | null = null;

export function installOsSandboxGate(getEnabled: () => boolean): void {
  enabledGetter = getEnabled;
}

/** 三条件合成入口(enabled × available × 非 full),command-tool 直调 */
export function osSandboxWrap(
  command: string,
  opts: SandboxWrapOptions,
): SandboxWrapResult {
  try {
    if (opts.fullAccess) return transparent(command);
    if (!enabledGetter?.()) return transparent(command);
    if (!installedRunner.available()) return transparent(command);
    return installedRunner.wrap(command, opts);
  } catch {
    return transparent(command);
  }
}
```

- [ ] **Step 4: 实现 seatbelt.ts**

```ts
// electron/domains/security/sandbox/seatbelt.ts
/**
 * macOS Seatbelt 实现(os-sandbox spec §4)。调用形态:
 *   sandbox-exec -p '<sbpl>' /bin/zsh -c '<原命令>'
 * 外层再由 exec() 包 /bin/sh -c,故 sbpl 与原命令均做 sh 单引号安全转义。
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import { buildSeatbeltProfile } from "./profile";
import type { SandboxRunner, SandboxWrapResult } from "./runner";

/** sh 单引号安全包裹(单引号内单引号经 '\'' 序列闭合重开) */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

let availableCache: boolean | null = null;

/** sandbox-exec 存在性探测(结果缓存;真跑一条 allow-default 探针命令) */
function probeAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const probe = spawnSync(
      "sandbox-exec",
      ["-p", "(version 1)(allow default)", "/usr/bin/true"],
      { timeout: 5000 },
    );
    return probe.status === 0;
  } catch {
    return false;
  }
}

export const seatbeltRunner: SandboxRunner = {
  available() {
    if (availableCache === null) availableCache = probeAvailable();
    return availableCache;
  },
  wrap(command, opts): SandboxWrapResult {
    // 锚点与 resolveCwd 同源:未绑定工作空间锚定家目录(spec §4.2 锚点语义边界)
    const workspace = opts.workspacePath || os.homedir();
    // os.tmpdir() 在 darwin 返回 /var/folders/...(symlink),沙箱按真实路径匹配
    const tmpDir = realpathSync(os.tmpdir());
    const profile = buildSeatbeltProfile(workspace, tmpDir);
    return {
      command: `sandbox-exec -p ${shQuote(profile)} /bin/zsh -c ${shQuote(command)}`,
      sandboxed: true,
      workspace,
    };
  },
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS(全部;darwin 机上含 skipIf 组 3 例)

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add apps/tianshu-desktop/electron/domains/security/sandbox/
/usr/bin/git commit -m "feat(desktop): OS 沙箱 runner 门禁合成与 Seatbelt 实现——三条件 fail-open"
```

---

### Task 3: 配置 osSandboxEnabled 三处落点

**Files:**
- Modify: `src-react/domains/security/model/types.ts:8-24`(SecurityConfig 加字段)
- Modify: `electron/domains/security/defaults.ts:10-47`(SECURITY_DEFAULTS 加默认值)
- Modify: `electron/domains/security/security.service.ts:41-57`(NORMALIZERS 加校验行)
- Test: `tests/security/os-sandbox-config.test.ts`

**Interfaces:**
- Produces: `SecurityConfig.osSandboxEnabled: boolean`(Task 5 装配闭包、Task 6 UI 消费);存量 key `sandboxEnabled`(命令判定门)语义不动

- [ ] **Step 1: 写失败测试**

```ts
// tests/security/os-sandbox-config.test.ts
import { describe, expect, it } from "vitest";
import { SECURITY_DEFAULTS } from "../../electron/domains/security/defaults";

describe("osSandboxEnabled 配置", () => {
  it("默认关(裁定#1:安全中心自开)", () => {
    expect(SECURITY_DEFAULTS.osSandboxEnabled).toBe(false);
  });
  it("存量 sandboxEnabled 默认语义不变(命令判定门,与 OS 沙箱互不相干)", () => {
    expect(SECURITY_DEFAULTS.sandboxEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npx vitest run tests/security/os-sandbox-config.test.ts`
Expected: FAIL(类型缺字段,编译错)

- [ ] **Step 3: 三处最小改动**

`types.ts` SecurityConfig(在 `sandboxEnabled: boolean;` 后加一行):

```ts
  sandboxEnabled: boolean;
  /** OS 级沙箱(macOS Seatbelt,os-sandbox spec):与 sandboxEnabled(命令判定门)互不相干 */
  osSandboxEnabled: boolean;
```

`defaults.ts` SECURITY_DEFAULTS(同位置加):

```ts
  sandboxEnabled: true,
  // OS 级沙箱默认关(2026-11-14 裁定#1:安全中心自开,不动存量会话行为)
  osSandboxEnabled: false,
```

`security.service.ts` NORMALIZERS(在 `sandboxEnabled: (v) => v === true,` 后加):

```ts
  sandboxEnabled: (v) => v === true,
  osSandboxEnabled: (v) => v === true,
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npx vitest run tests/security/os-sandbox-config.test.ts && npm run typecheck`
Expected: PASS + typecheck 0 错(SecurityConfig 消费面均经 `config.xxx` 读,新可选性无破坏——布尔必填,装配/UI 未读它之前无影响)

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/tianshu-desktop/src-react/domains/security/model/types.ts apps/tianshu-desktop/electron/domains/security/defaults.ts apps/tianshu-desktop/electron/domains/security/security.service.ts apps/tianshu-desktop/tests/security/os-sandbox-config.test.ts
/usr/bin/git commit -m "feat(desktop): 安全配置新增 osSandboxEnabled——默认关,与命令判定门消歧"
```

---

### Task 4: command-tool 嵌入(包装 + detached + 收割 + 审计)

**Files:**
- Modify: `electron/domains/ai/agent/command-tool.ts`(runExec 148-179、execute 242-256 段)
- Test: `tests/security/os-sandbox-command-tool.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `osSandboxWrap`、`SandboxWrapResult`
- Produces: `killProcessGroup(pid: number): void`(导出,供测试;win32 no-op)

- [ ] **Step 1: 写失败测试**

```ts
// tests/security/os-sandbox-command-tool.test.ts
// 桩测:vi.mock runner 模块,断言 wrap 调用条件与审计事件;
// 真跑 Seatbelt 的行为测试在 Task 5 集成文件
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../electron/domains/security/sandbox/runner", () => ({
  osSandboxWrap: vi.fn(
    (command: string): {
      command: string;
      sandboxed: boolean;
      workspace: string;
    } => ({ command: `SANDBOXED(${command})`, sandboxed: true, workspace: "/tmp/ws" }),
  ),
}));

import { makeRunCommandTool } from "../../electron/domains/ai/agent/command-tool";
import { osSandboxWrap } from "../../electron/domains/security/sandbox/runner";
import type { SecurityEvent } from "../../src-react/domains/security/model/types";

const wrapMock = vi.mocked(osSandboxWrap);

function makeCtx(fullAccess = false) {
  const events: SecurityEvent[] = [];
  return {
    ctx: {
      workspacePath: "/tmp/ws",
      sessionId: 1,
      fullAccess,
      onSecurityEvent: (e: SecurityEvent) => events.push(e),
    },
    events,
  };
}

describe("bash 工具沙箱嵌入", () => {
  beforeEach(() => wrapMock.mockClear());

  it("执行前经 osSandboxWrap 包装(fullAccess 随 ctx 透传)", async () => {
    const tool = makeRunCommandTool();
    const { ctx } = makeCtx(true);
    await tool.execute(ctx, { command: "echo hi" });
    expect(wrapMock).toHaveBeenCalledWith("echo hi", {
      workspacePath: "/tmp/ws",
      fullAccess: true,
    });
  });

  it("进入沙箱时上报 command-safety.sandbox 审计事件", async () => {
    const tool = makeRunCommandTool();
    const { events } = makeCtx();
    await tool.execute(
      { workspacePath: "/tmp/ws", sessionId: 7, onSecurityEvent: (e) => events.push(e) },
      { command: "echo hi" },
    );
    const sandboxEvent = events.find(
      (e) => e.eventType === "command-safety.sandbox",
    );
    expect(sandboxEvent?.decision).toBe("info");
    expect(sandboxEvent?.detail).toContain("workspace-write");
    // SANDBOXED() 包装会执行失败,但工具不炸、返回错误文案
  });

  it("危险命令拦截优先于沙箱(不调 wrap)", async () => {
    const tool = makeRunCommandTool();
    const { ctx } = makeCtx();
    await tool.execute(ctx, { command: "mkfs /dev/sda1" });
    expect(wrapMock).not.toHaveBeenCalled();
  });

  it("wrap 透传时不报沙箱审计事件", async () => {
    wrapMock.mockReturnValueOnce({
      command: "echo hi",
      sandboxed: false,
      workspace: "",
    });
    const tool = makeRunCommandTool();
    const { ctx, events } = makeCtx();
    await tool.execute(ctx, { command: "echo hi" });
    expect(
      events.find((e) => e.eventType === "command-safety.sandbox"),
    ).toBeUndefined();
  });

  it("killProcessGroup 对不存在进程组不抛", async () => {
    const { killProcessGroup } = await import(
      "../../electron/domains/ai/agent/command-tool"
    );
    expect(() => killProcessGroup(999_999)).not.toThrow();
  });
});
```

注:`SecurityEvent` 的实际形状以 `src-react/domains/security/model/types.ts` 的 `SecurityEventSink` 参数类型为准(types.ts:79 附近),若字段名不同(detail 为 string 还是对象)以现状为准调整断言——先例见 command-tool.ts:133-138 现有 `onSecurityEvent` 调用(detail 为对象、含 sessionId 字段)。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npx vitest run tests/security/os-sandbox-command-tool.test.ts`
Expected: FAIL(wrap 未被调用/导出不存在)

- [ ] **Step 3: 改造 command-tool.ts**

3a. import 区加(command-tool.ts:14 附近):

```ts
import { osSandboxWrap } from "../../security/sandbox/runner";
```

3b. 新增进程组收割导出(mergeOutput 函数前):

```ts
/** 进程组收割(spec §4.5):仅超时/异常结算时调用;组长退出后组仍存在,
 * kill(-pgid) 对残留孙进程有效;组已消亡抛 ESRCH 静默吞(win32 no-op) */
export function killProcessGroup(pid: number): void {
  if (process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 组已退出
  }
}
```

3c. `runExec` 签名与实现改造(148-179 行)——加 `sandboxed` 参数,exec 加 `detached`,超时/溢出/失败结算时收割:

```ts
function runExec(
  command: string,
  cwd: string | undefined,
  sandboxed = false,
): { promise: Promise<ExecOutcome>; child: ChildProcess } {
  let child!: ChildProcess;
  const promise = new Promise<ExecOutcome>((resolve, reject) => {
    child = exec(
      command,
      {
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        env: buildChildEnv(),
        // 沙箱态独立进程组:超时/异常收割全组(孙进程不随直接子进程死)
        detached: sandboxed,
      },
      (error, stdout, stderr) => {
        // 超时/溢出结算时补刀收割整组(正常退出不收割——后台进程语义不变,spec §4.5)
        if (error && (error.killed || isMaxBufferError(error)) && sandboxed && child.pid) {
          killProcessGroup(child.pid);
        }
        if (!error) {
          resolve({ code: 0, label: "", stdout, stderr });
        } else if (isMaxBufferError(error)) {
          resolve({ code: null, label: "输出超限", stdout, stderr });
        } else if (error.killed) {
          resolve({ code: null, label: "超时", stdout, stderr });
        } else if (typeof error.code === "number") {
          resolve({ code: error.code, label: "", stdout, stderr });
        } else {
          reject(error);
        }
      },
    );
  });
  return { promise, child };
}
```

3d. `runCommandTool.execute` 的 try 段(242-247 行)替换为:

```ts
    try {
      const wrapped = osSandboxWrap(args.command, {
        workspacePath: ctx.workspacePath,
        fullAccess: !!ctx.fullAccess,
      });
      if (wrapped.sandboxed) {
        ctx.onSecurityEvent?.({
          eventType: "command-safety.sandbox",
          decision: "info",
          detail: { mode: "workspace-write", workspace: wrapped.workspace },
          sessionId: ctx.sessionId,
        });
      }
      const { promise, child } = runExec(
        wrapped.command,
        resolveCwd(ctx, args.cwd),
        wrapped.sandboxed,
      );
```

(其后 `startChildWatch` 起的现有代码不变;catch 分支加启动失败收割:`catch (e)` 内若 last child 存在沙箱态——实现从简:启动失败时 child 未成功 spawn,pid 无效,不收割,保持现状。)

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS(5 例)

- [ ] **Step 5: 跑既有 command-tool 相关测试防回归**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npx vitest run tests/security/command-gate-integration.test.ts`
Expected: PASS(嵌入不改判定链,该套件零变化)

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add apps/tianshu-desktop/electron/domains/ai/agent/command-tool.ts apps/tianshu-desktop/tests/security/os-sandbox-command-tool.test.ts
/usr/bin/git commit -m "feat(desktop): bash 工具嵌入 OS 沙箱包装——detached 进程组收割与审计事件"
```

---

### Task 5: Application 装配 + Seatbelt 真跑集成

**Files:**
- Modify: `electron/Application.ts`(安全装配段,networkGate install 之后)
- Test: `tests/security/os-sandbox-seatbelt.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `installSandboxRunner/installOsSandboxGate/seatbeltRunner/osSandboxWrap`、Task 3 的 `osSandboxEnabled`

- [ ] **Step 1: 写集成测试**

```ts
// tests/security/os-sandbox-seatbelt.integration.test.ts
// macOS 真跑 Seatbelt(os-sandbox spec §10):workspace 写放行、越界写/
// 命令替换混淆越界写被拒、fail-open 透传。非 darwin 全组跳过。
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  installOsSandboxGate,
  installSandboxRunner,
  osSandboxWrap,
} from "../../electron/domains/security/sandbox/runner";
import { seatbeltRunner } from "../../electron/domains/security/sandbox/seatbelt";

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const probes: string[] = [];

describe.skipIf(process.platform !== "darwin")(
  "Seatbelt 真跑集成(macOS)",
  () => {
    let ws: string;

    beforeAll(() => {
      installSandboxRunner(seatbeltRunner);
      installOsSandboxGate(() => true);
      // workspace 用真实路径的 tmp 子目录(自身在 TMPDIR 白名单内,越界探测落家目录)
      ws = mkdtempSync(path.join(realpathSync(os.tmpdir()), "tianshu-sbx-"));
    });

    afterAll(() => {
      rmSync(ws, { recursive: true, force: true });
      for (const p of probes) rmSync(p, { force: true });
    });

    it("workspace 内写文件成功", () => {
      const target = path.join(ws, "ok.txt");
      const wrapped = osSandboxWrap(`echo hi > ${shq(target)}`, {
        workspacePath: ws,
        fullAccess: false,
      });
      expect(wrapped.sandboxed).toBe(true);
      execSync(wrapped.command);
      expect(existsSync(target)).toBe(true);
    });

    it("越界写(家目录探测文件)被系统级拒绝", () => {
      const probe = path.join(os.homedir(), ".tianshu-sbx-probe1");
      probes.push(probe);
      const wrapped = osSandboxWrap(`echo x > ${shq(probe)}`, {
        workspacePath: ws,
        fullAccess: false,
      });
      expect(() => execSync(wrapped.command)).toThrow();
      expect(existsSync(probe)).toBe(false);
    });

    it("命令替换混淆越界写仍被拒(静态分析极限的正面锚)", () => {
      const probe = path.join(os.homedir(), ".tianshu-sbx-probe2");
      probes.push(probe);
      const wrapped = osSandboxWrap(`echo $(whoami) > ${shq(probe)}`, {
        workspacePath: ws,
        fullAccess: false,
      });
      expect(() => execSync(wrapped.command)).toThrow();
      expect(existsSync(probe)).toBe(false);
    });

    it("未启用时原样透传(fail-open)", () => {
      installOsSandboxGate(() => false);
      const wrapped = osSandboxWrap("echo ok", {
        workspacePath: ws,
        fullAccess: false,
      });
      expect(wrapped).toEqual({
        command: "echo ok",
        sandboxed: false,
        workspace: "",
      });
      execSync(wrapped.command);
      installOsSandboxGate(() => true);
    });
  },
);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npx vitest run tests/security/os-sandbox-seatbelt.integration.test.ts`
Expected: FAIL 或 PASS——注意:此时 Application.ts 尚未装配,但集成测试**自行 install**,应直接 PASS。若 PASS 则本步验证的是「不装配主进程也能独立工作」;装配步骤的意义是让生产链路生效。

- [ ] **Step 3: Application.ts 装配**

定位:`installNetworkGate({...})` 调用段(Application.ts:341 附近)之后、SecurityService 声明之后的装配区(与 installCommandGate 同段;用 Grep `installCommandGate(` 找到确切调用行,贴其同段)。新增:

```ts
// OS 级沙箱(os-sandbox spec §3):runner 平台自判可用性,门禁实时读配置
installSandboxRunner(seatbeltRunner);
installOsSandboxGate(
  () => securityService.getConfigValue().osSandboxEnabled,
);
```

并在 Application.ts import 区(45-47 行 command-gate import 附近)加:

```ts
import {
  installOsSandboxGate,
  installSandboxRunner,
} from "./domains/security/sandbox/runner";
import { seatbeltRunner } from "./domains/security/sandbox/seatbelt";
```

装配位置约束:`securityService` 声明之后(闭包引用);不得早于 SecurityService 声明(TDZ,同文件 311 行注释同款约束)。

- [ ] **Step 4: 跑全部沙箱相关测试 + 判定链零变化回归**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npx vitest run tests/security/ && npx vitest run tests/ai/permissions-integration.test.ts`
Expected: 全 PASS(tests/security/ 含既有套件,证明判定链/文件门/命令门行为零变化)

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/tianshu-desktop/electron/Application.ts apps/tianshu-desktop/tests/security/os-sandbox-seatbelt.integration.test.ts
/usr/bin/git commit -m "feat(desktop): Application 装配 OS 沙箱门禁+Seatbelt 真跑集成锚"
```

---

### Task 6: 安全中心 UI 开关 + i18n 双语

**Files:**
- Modify: `src-react/domains/security/components/SandboxCard.tsx`(总开关区块后加系统沙箱区块)
- Modify: `src-react/i18n/locales/zh-CN/security.json`(sandbox 段加 3 key)
- Modify: `src-react/i18n/locales/en-US/security.json`(同)

**Interfaces:**
- Consumes: Task 3 的 `config.osSandboxEnabled`;SandboxCard 既有 props(`config: SecurityConfig`、`onToggle: (key, value) => void`)零新增——onToggle 走既有 setConfig IPC 通道

- [ ] **Step 1: 补 i18n 双语 key**

`zh-CN/security.json` 的 `"sandbox"` 对象内(与 `"enabledDesc"` 同级)追加:

```json
"os": "系统沙箱（macOS）",
"osDesc": "Shell 命令经 macOS Seatbelt 执行：工作空间与临时目录外的写入将被系统级拒绝",
"osUnavailable": "当前平台暂不支持（仅 macOS）"
```

`en-US/security.json` 的 `"sandbox"` 对象内追加:

```json
"os": "OS Sandbox (macOS)",
"osDesc": "Shell commands run under macOS Seatbelt: writes outside the workspace and temp directories are rejected at OS level",
"osUnavailable": "Not available on this platform (macOS only)"
```

- [ ] **Step 2: SandboxCard 加系统沙箱区块**

在总开关 `div`(SandboxCard.tsx:79-93)之后、`ENTRIES` 列表 `div` 之前插入:

```tsx
{/* OS 级沙箱(os-sandbox spec §6.2):与上方总开关(命令判定门)互不相干;
    平台不可用置灰——展示语义,安全判定全在主进程 runner */}
<div className="flex items-center justify-between gap-4 border-t border-border/50 pt-4">
  <div className="space-y-0.5">
    <Label className="text-sm font-normal">
      {t("security:sandbox.os")}
    </Label>
    <p className="text-xs text-muted-foreground">
      {isMac
        ? t("security:sandbox.osDesc")
        : t("security:sandbox.osUnavailable")}
    </p>
  </div>
  <Switch
    aria-label={t("security:sandbox.os")}
    checked={config.osSandboxEnabled}
    disabled={!isMac}
    onCheckedChange={(checked) => onToggle("osSandboxEnabled", checked)}
  />
</div>
```

组件体内(`const { t } = ...` 后)加:

```tsx
const isMac =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
```

- [ ] **Step 3: 验证(typecheck + prettier)**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npm run typecheck && npx prettier --check src-react/domains/security/components/SandboxCard.tsx src-react/i18n/locales/zh-CN/security.json src-react/i18n/locales/en-US/security.json`
Expected: typecheck 0 错;prettier 全过(不过则 `npx prettier --write` 后复检)

- [ ] **Step 4: Commit**

```bash
/usr/bin/git add apps/tianshu-desktop/src-react/domains/security/components/SandboxCard.tsx apps/tianshu-desktop/src-react/i18n/locales/zh-CN/security.json apps/tianshu-desktop/src-react/i18n/locales/en-US/security.json
/usr/bin/git commit -m "feat(desktop): 安全中心系统沙箱开关——平台置灰与双语文案"
```

---

### Task 7: 收尾验证与文档状态同步

**Files:**
- Modify: `docs/design/os-sandbox.md`(文首引言加实施状态行)
- Modify: `docs/design/README.md`(挂账行「实施待排期」→ 已落地)

- [ ] **Step 1: 全量单测**

Run: `cd /Users/hjx/workspace/mirror && npm run test`
Expected: 全绿(桌面端单测 + packages)

- [ ] **Step 2: 新改文件 prettier 复查**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-desktop && npx prettier --check electron/domains/security/sandbox/ electron/domains/ai/agent/command-tool.ts tests/security/os-sandbox-*.test.ts`
(全仓 eslint 在当前环境态会 parse error 全红——known issue,以 prettier + typecheck + vitest 为验收面)

- [ ] **Step 3: 文档状态同步**

`docs/design/os-sandbox.md` 引言块(第 2 行后)加:

```markdown
> **状态:已落地(2026-11-15 首批)**,实施计划见 `docs/superpowers/plans/2026-11-15-os-sandbox.md`;与 spec 的两处实现偏差(装配改模块单例直调、收割通用化)记录于计划头部。
```

`docs/design/README.md` 大工程挂账行改为(替换「实施待排期」):

```markdown
- E2E 密钥双棘轮（前向保密，wire 契约演进）｜#2 #12（OS 级沙箱已落地 2026-11-15，spec [os-sandbox.md](os-sandbox.md)，macOS Seatbelt 首批；Linux/win32 仍诚实 no-op）
```

- [ ] **Step 4: Commit**

```bash
/usr/bin/git add docs/design/os-sandbox.md docs/design/README.md
/usr/bin/git commit -m "docs(design): OS 沙箱首批落地状态同步"
```

---

## Self-Review 记录

- **Spec coverage**:§3 架构→Task 1/2;§4 Seatbelt→Task 1/2/5;§5 嵌入→Task 4;§6 配置/UI→Task 3/6;§7 联动零改动→Task 4 Step 5 回归 + Task 5 Step 4;§8 审计→Task 4;§9 平台矩阵→runner 平台自判 + UI 置灰 + 集成 skipIf;§10 测试→Task 1/2/4/5;§11 限制声明(文档面,无代码项)。spec §4.4 网络收紧预留位=不实现(明确无任务,正确)。
- **Placeholder scan**:无 TBD/TODO;所有代码步骤给全文。
- **Type consistency**:`SandboxWrapResult {command, sandboxed, workspace}` 三字段在 Task 2 定义、Task 4/5 一致;`osSandboxWrap(command, opts)` 签名一致;`killProcessGroup` Task 4 定义并导出、测试同任务内。Task 4 测试的 SecurityEvent 形状已注明以 types.ts 现状为准的校准指令(附行号锚)。
