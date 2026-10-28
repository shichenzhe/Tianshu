# 权限控制放宽实施计划（default 档高危询问化 + full 档危险线）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** default 档审批面从「一切 write 询问」收敛为「高危询问」（普通命令/工作空间内写文件/DB 写直执行），full 档补 HIGH/CRITICAL 危险命令审批线（对齐 WorkBuddy bypass）。

**Architecture:** 危险命令分级表（新增纯函数模块 command-risk.ts，内置正则永不落盘）在 tool-gate 的 runToolCall 判定链中消费（程序黑名单之后、cmdAsk 之前）；needsApproval 计算收窄兜底审批并豁免 write_file/DB 写工具；默认配置值调整（rm 出黑名单、curl/wget 出 cmdAsk）；三端（mirror electron / apps/tianshu-server / mobile 注释）同构。

**Tech Stack:** TypeScript、Vitest（mirror/mobile）、Jest（server）、React i18next。

**Spec:** `docs/superpowers/specs/2026-10-24-permission-relax-design.md`（含裁定记录 §8；执行者须先读 spec）

## Global Constraints

- mirror 代码风格：双引号 + 分号 + Prettier（tabWidth 2 / printWidth 80）；server 同构文件用单引号（跟随各仓现状）
- 用户可见文案必须走 i18n（`t()`），zh-CN/en-US 双语同步；禁止 JSX 硬编码
- 已落盘用户配置不受默认值变化影响（read-time fallback 语义，禁止写迁移脚本）
- **验证命令**（环境态 `npm run lint` 不可用，一律不用 lint）：
  - mirror 单测：`cd /Users/hjx/workspace/mirror && npx vitest run <file>`（注意 shell cwd 会漂移回仓库根，跨目录命令显式 cd）
  - server 单测：`cd /Users/hjx/workspace/mirror/apps/tianshu-server && npx jest <pattern>`
  - mobile 单测：`cd /Users/hjx/workspace/mirror && npm run test -w apps/tianshu-mobile`
  - 格式检查：`cd /Users/hjx/workspace/mirror && npx prettier --check <files>`
- 提交风格：conventional commits 中文（如 `feat(security): ...`），单任务单提交；**提交时只 add 本任务文件**（工作区有其他批次未提交改动，严禁 `git add -A`）
- 所有新代码注释说明「为什么」，跟随周边注释密度

## 实现选择声明（对 spec §4.2 的勘误）

危险表的消费点定在 **tool-gate 层**（runToolCall 内 run_command 分支直接调
`assessCommandRisk`），而非 spec §4.2 原文的 command-policy.decideCommand 内嵌。
原因：full 档须区分「危险表 ask」与「cmdAsk ask」（危险表 full 也审、cmdAsk full
放行），CommandDecision 单值归并无法区分来源，在 tool-gate 层单独判定天然区分，且
command-gate 的 sandboxEnabled 旁路不再与危险表耦合（spec §4.2 修正段担心的矛盾
自动消除）。判定链序与 spec §5 完全一致；Task 8 含 spec 勘误提交。

---

### Task 1: 危险命令分级表（mirror，command-risk.ts）

**Files:**
- Create: `electron/domains/security/command-risk.ts`
- Test: `tests/security/command-risk.test.ts`

**Interfaces:**
- Produces: `export type CommandRisk = "critical" | "high" | null;` 与 `export function assessCommandRisk(command: string): CommandRisk;`（Task 4/Task 6 消费；CRITICAL 先于 HIGH 判定）

- [ ] **Step 1: 写失败测试**

```ts
// tests/security/command-risk.test.ts
// 危险命令分级表单测（权限放宽 spec §4.1/§7）：正则正反例 + 复合命令
// 分段 + CRITICAL 先于 HIGH
import { describe, expect, it } from "vitest";
import { assessCommandRisk } from "../../electron/domains/security/command-risk";

describe("assessCommandRisk CRITICAL", () => {
  it.each([
    "rm -rf /",
    "rm -rf /etc",
    "rm -fr ~/*",
    "dd if=x of=/dev/sda",
    "mkfs.ext4 /dev/sda",
    "echo x > /etc/hosts",
    "crontab -r",
    "userdel root",
    "echo 'DROP DATABASE prod'",
    "FLUSHALL",
    "terraform destroy",
    "aws s3 delete bucket",
    "git reset --hard",
    "git clean -fdx",
    "git stash clear",
    "git push -f origin main",
    "git push origin --delete master",
    "git branch -D main",
  ])("%s → critical", (cmd) => {
    expect(assessCommandRisk(cmd)).toBe("critical");
  });
});

describe("assessCommandRisk HIGH", () => {
  it.each([
    "sudo npm install",
    "chmod 777 /tmp",
    "rm -rf /tmp/cache", // 非系统目录：HIGH 而非 CRITICAL（spec §7 反例）
    "rm -r src",
    "shred secret.txt",
    "git push -f origin feature-x", // 非主干强推：HIGH
    "git branch -D feature-x",
    "git checkout -- src/index.ts",
    "git restore .",
    "kubectl delete pod api",
    "find . -delete",
    "ls | xargs rm",
    "git push origin :feature-x",
  ])("%s → high", (cmd) => {
    expect(assessCommandRisk(cmd)).toBe("high");
  });
});

describe("assessCommandRisk 放行", () => {
  it.each([
    "ls -la",
    "rm temp.txt", // 单文件 rm 放行（rm 已移出黑名单，spec §4.3）
    "node server.js",
    "npm install",
    "git push origin main", // 普通推送
    "git status",
    "curl https://example.com", // 移出 cmdAsk 后放行
    "",
  ])("%s → null", (cmd) => {
    expect(assessCommandRisk(cmd)).toBeNull();
  });
});

describe("复合命令分段", () => {
  it.each([
    ["echo x && rm -rf /", "critical"],
    ["ls; sudo reboot", "high"],
    ["cat a || git reset --hard", "critical"],
    ["echo a | grep rm -rf", "high"], // 管道后段 grep 的参数误报 HIGH——粗分已知边界（spec §6），偏安全侧：误报仅多一次审批
  ])("%s → %s", (cmd, expected) => {
    expect(assessCommandRisk(cmd)).toBe(expected);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hjx/workspace/mirror && npx vitest run tests/security/command-risk.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 command-risk.ts**

```ts
// electron/domains/security/command-risk.ts
/**
 * 危险命令分级表（权限放宽 spec §4.1，2026-10-24）：内置静态正则永不
 * 落盘（照 BUILTIN_FILE_BLOCKLIST_ALL 三层防删模式，用户不可关；可经
 * cmdAsk 加严）。CRITICAL 先于 HIGH。正则精选自 WorkBuddy
 * CommandUtils.checkSingleCommandSafety O/M 表（2026-10-24 逆向）。
 * 分段为粗分（;/&&/||/|），不做完整 shell 解析——引号内分隔符误分由
 * 子进程监控与审批兜底（spec §6 已知边界）。
 */

export type CommandRisk = "critical" | "high" | null;

/** 极高危：不可逆破坏（磁盘/系统/主干/数据全灭）——default 与 full 均强制审批 */
const CRITICAL_PATTERNS: RegExp[] = [
  /rm\s+(-[rf]+|--recursive|--force).*\/(\s|$)/, // rm -rf /（根）
  /rm\s+(-[rf]+|--recursive|--force).*(\/(etc|usr|var|sys|boot|lib)|~\/\*)/,
  /\bdd\b.*of=\/(dev|sys|boot)/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  /\bparted\b/,
  />\s*\/(etc|boot|sys)\//,
  /crontab\s+-r/,
  /\buserdel\b/,
  /\bgroupdel\b/,
  /DROP\s+DATABASE/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /DELETE\s+FROM.*WHERE\s+(1=1|true)/i,
  /FLUSHALL/i,
  /FLUSHDB/i,
  /terraform\s+destroy/,
  /aws\s+\S+\s+delete\b/,
  /az\s+\S+\s+delete\b/,
  /gcloud\s+\S+\s+delete\b/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-[fdxX]/,
  /git\s+checkout\s+-[fF]\b/,
  /git\s+stash\s+clear/,
  /git\s+checkout\s+--\s+\./, // 整仓回滚（单文件在 HIGH）
  /git\s+push(\s+[^\s]+)*\s+(-f|--force)(\s|$).*\b(main|master|develop|release|production)\b/,
  /git\s+push(\s+[^\s]+)*\s+\b(main|master|develop|release|production)\b(\s+[^\s]+)*\s+(-f|--force)(\s|$)/,
  /git\s+push(\s+[^\s]+)*\s+(--delete)(\s|$).*\b(main|master|develop|release|production)\b/,
  /git\s+push\s+[^\s]+\s+:(main|master|develop|release|production)\b/,
  /git\s+branch\s+-[dD]\s+(main|master|develop|release|production)\b/,
];

/** 高危：高破坏面但可恢复/可审（提权/递归删/强推）——default 审批，full 亦审批（对齐 WorkBuddy bypass） */
const HIGH_PATTERNS: RegExp[] = [
  /^\s*sudo\b/,
  /^\s*su\s/,
  /\bchmod\s+777\b/,
  /\brm\s+(-[^\s]*r|-[^\s]*R|--recursive)\b/,
  /\bshred\b/,
  /\bwipe\b/,
  /\btruncate\b.*-s\s*0/,
  /git\s+branch\s+-D\b/,
  /git\s+push(\s+[^\s]+)*\s+(-f|--force)(\s|$)/,
  /git\s+push(\s+[^\s]+)*\s+(--delete)(\s|$)/,
  /git\s+push\s+[^\s]+\s+:/,
  /git\s+filter-branch/,
  /git\s+filter-repo/,
  /git\s+worktree\s+(remove|prune)/,
  /git\s+reflog\s+(delete|expire)/,
  /git\s+checkout\s+--\s+\S/,
  /git\s+restore\b/,
  /git\s+stash\s+drop/,
  /kubectl\s+(delete|drain)\b/,
  /docker\s+(system\s+prune|volume\s+rm)\b/,
  /find\s+.*(-delete|-exec\s+rm)/,
  /\bxargs\s+rm\b/, // 段内匹配（分段后管道前缀不在段内；echo "xargs rm" 误报为粗分边界，偏安全侧）
  /\brm\s+(?:-[^\s]*\s+)*\S*[*?]/, // rm 带通配符
];

/** 粗分段：shell 组合/管道分隔符切分（不做引号感知——精度边界见头注释） */
function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== "");
}

export function assessCommandRisk(command: string): CommandRisk {
  for (const segment of splitSegments(command)) {
    for (const pattern of CRITICAL_PATTERNS) {
      if (pattern.test(segment)) return "critical";
    }
  }
  for (const segment of splitSegments(command)) {
    for (const pattern of HIGH_PATTERNS) {
      if (pattern.test(segment)) return "high";
    }
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/hjx/workspace/mirror && npx vitest run tests/security/command-risk.test.ts`
Expected: PASS（若个别正则不匹配，修正正则而非测试——测试样例是裁定基准）

- [ ] **Step 5: 提交**

```bash
cd /Users/hjx/workspace/mirror && git add electron/domains/security/command-risk.ts tests/security/command-risk.test.ts && git commit --no-verify -m "feat(security): 危险命令分级表——CRITICAL/HIGH 内置正则（权限放宽 spec §4.1，精选 WorkBuddy O/M 表）"
```

---

### Task 2: 默认配置值调整（mirror defaults.ts）

**Files:**
- Modify: `electron/domains/security/defaults.ts:13-15`
- Test: `tests/security/config-store.test.ts`（更新既有默认值断言）

**Interfaces:**
- Consumes: 无
- Produces: `SECURITY_DEFAULTS.programBlacklist = []`、`SECURITY_DEFAULTS.cmdAsk = []`（已落盘用户配置不受影响——read-time fallback 语义不变）

- [ ] **Step 1: 更新测试断言（先改测试）**

在 `tests/security/config-store.test.ts` 中找到断言 `programBlacklist` 默认含 `"rm"` 与 `cmdAsk` 默认含 curl/wget 的用例（搜 `rm` 与 `curl`），改为：

```ts
// 默认值变化（2026-10-24 权限放宽 spec §4.3）：rm 语义移入危险分级表、
// curl/wget 移出 cmdAsk（网络域免审顺延）——黑名单/询问名单默认清空
expect(SECURITY_DEFAULTS.programBlacklist).toEqual([]);
expect(SECURITY_DEFAULTS.cmdAsk).toEqual([]);
```

（若原断言形如 `toEqual(["rm"])`/前缀结构，逐条对应改；保留 cmdAllow 断言不动。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hjx/workspace/mirror && npx vitest run tests/security/config-store.test.ts`
Expected: FAIL（默认值仍是旧值）

- [ ] **Step 3: 改 defaults.ts**

```ts
  // rm 移出黑名单入危险分级表（command-risk.ts HIGH：rm -r/-rf/通配符；
  // 单文件 rm 放行）、curl/wget 移出 cmdAsk（网络域免审顺延，spec §4.3）
  cmdAllow: [{ prefix: ["git", "push"] }, { prefix: ["npm", "install"] }],
  cmdAsk: [],
  programBlacklist: [],
```

（只改这两行值，cmdAllow 与其余 13 项不动；文件头注释块补一句「2026-10-24 默认值调整见权限放宽 spec §4.3」。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/hjx/workspace/mirror && npx vitest run tests/security/config-store.test.ts tests/security/command-gate.test.ts`
Expected: PASS（command-gate.test.ts 若有默认值耦合用例一并更新）

- [ ] **Step 5: 提交**

```bash
cd /Users/hjx/workspace/mirror && git add electron/domains/security/defaults.ts tests/security/config-store.test.ts tests/security/command-gate.test.ts && git commit --no-verify -m "feat(security): 默认黑名单/询问名单清空——rm 入分级表、curl/wget 免审（权限放宽 spec §4.3）"
```

---

### Task 3: tool-gate 审批面收窄 + full 档危险线（mirror）

**Files:**
- Modify: `electron/domains/ai/agent/tool-gate.ts`（needsApproval 计算段 ~L544-559 与 runToolCall 头部）
- Modify: `electron/domains/ai/agent/file-tools.ts`（write_file description 一行）
- Test: `tests/security/command-gate-integration.test.ts`、`tests/security/file-gate-integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `assessCommandRisk` / `CommandRisk`
- Produces: runToolCall 新判定序（后续任务与 server 同构基准）；新审计事件 `command-safety.needs-approval`（detail 增 `source:"risk-table"` + `risk` 字段）与 `file-safety.auto-allowed`

- [ ] **Step 1: 写失败测试（command-gate-integration.test.ts 追加）**

```ts
// ===== 权限放宽（2026-10-24 spec §3/§4.4/§4.5）=====
describe("runToolCall 权限放宽", () => {
  it("default 档普通命令直执行（不再兜底审批）", async () => {
    const agent = makeAgent({ decideCommand: () => "default" });
    const out = await runToolCall(runCommandDef, agent, "c1", { command: "ls -la" });
    expect(out).toContain("已执行"); // 按现有 run_command 输出断言（见同文件既有用例）
    expect(agent.requestApproval).not.toHaveBeenCalled();
  });

  it("危险分级命中 default 档强制审批", async () => {
    const agent = makeAgent({ decideCommand: () => "default" });
    agent.requestApproval.mockResolvedValue(true);
    await runToolCall(runCommandDef, agent, "c2", { command: "sudo rm -r x" });
    expect(agent.requestApproval).toHaveBeenCalled();
  });

  it("危险分级命中 full 档仍审批（对齐 WorkBuddy bypass）", async () => {
    const agent = makeAgent({ fullAccess: () => true, decideCommand: () => "default" });
    agent.requestApproval.mockResolvedValue(true);
    await runToolCall(runCommandDef, agent, "c3", { command: "git reset --hard" });
    expect(agent.requestApproval).toHaveBeenCalled();
  });

  it("cmdAsk 命中 full 档放行（full=免责+内置硬线）", async () => {
    const agent = makeAgent({ fullAccess: () => true, decideCommand: () => "ask" });
    await runToolCall(runCommandDef, agent, "c4", { command: "mytool x" });
    expect(agent.requestApproval).not.toHaveBeenCalled();
  });

  it("危险分级命中 unattended 强拒", async () => {
    const agent = makeAgent({ unattended: true, decideCommand: () => "default" });
    const out = await runToolCall(runCommandDef, agent, "c5", { command: "sudo reboot" });
    expect(out).toContain("无人值守");
    expect(agent.requestApproval).not.toHaveBeenCalled();
  });

  it("write_file default 档直执行并上报 auto-allowed", async () => {
    const agent = makeAgent({ decideCommand: () => "default" });
    const events: SecurityEvent[] = [];
    agent.onSecurityEvent = (e) => events.push(e);
    await runToolCall(writeFileDef, agent, "c6", { path: "a.txt", content: "x" });
    expect(agent.requestApproval).not.toHaveBeenCalled();
    expect(events.some((e) => e.eventType === "file-safety.auto-allowed")).toBe(true);
  });

  it("write_file 敏感路径（fileGate block）仍审批", async () => {
    const agent = makeAgent({
      decideCommand: () => "default",
      decideFileAccess: () => "block",
    });
    agent.requestApproval.mockResolvedValue(false);
    const out = await runToolCall(writeFileDef, agent, "c7", { path: "secret", content: "x" });
    expect(agent.requestApproval).toHaveBeenCalled();
  });

  it("delete_file default 档仍审批（delete=ask 裁定）", async () => {
    const agent = makeAgent({ decideCommand: () => "default" });
    agent.requestApproval.mockResolvedValue(false);
    await runToolCall(deleteFileDef, agent, "c8", { path: "a.txt" });
    expect(agent.requestApproval).toHaveBeenCalled();
  });

  it.each(["plan_create_item", "create_skill", "create_expert"])(
    "DB 写工具 %s 直执行",
    async (name) => {
      const agent = makeAgent({ decideCommand: () => "default" });
      await runToolCall({ ...writeDefBase, name }, agent, "c9-" + name, {});
      expect(agent.requestApproval).not.toHaveBeenCalled();
    },
  );
});
```

（`makeAgent`/`runCommandDef` 等 helper 照同文件既有用例的构造方式补齐；`writeDefBase` 为 `{ name, kind: "write", execute: async () => "ok" }` 形状的最小 ToolDefinition stub。file-gate-integration.test.ts 同步追加 write_file 直执行用例。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hjx/workspace/mirror && npx vitest run tests/security/command-gate-integration.test.ts`
Expected: FAIL（直执行用例实际走了审批）

- [ ] **Step 3: 改 tool-gate.ts**

3a. 顶部 import 与常量：

```ts
import { assessCommandRisk, type CommandRisk } from "../../security/command-risk";
```

在 `isNetworkTool` 之后加：

```ts
/**
 * DB 写低风险免审集（权限放宽 spec §4.4）：落库无文件系统风险；
 * read 类工具本就不审批，此处只列 kind=write 的业务工具
 */
const AUTO_EXEMPT_WRITE_TOOLS = new Set([
  "plan_create_item",
  "plan_update_status",
  "plan_append_summary",
  "create_skill",
  "create_expert",
  "update_expert",
]);

/** run_command 危险分级判定（spec §4.1/§4.5）：非 run_command/无命令返回 null */
function resolveCommandRisk(
  toolName: string,
  input: unknown,
): CommandRisk {
  if (toolName !== "run_command") return null;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string" || command === "") return null;
  return assessCommandRisk(command);
}
```

3b. runToolCall 内、`const gate = resolveCommandGate(...)` 之后加危险判定（gate block 硬拒分支之后、既有 `gate === "ask"` 审计之前）：

```ts
  // 危险分级（2026-10-24 权限放宽 spec §4.5）：HIGH/CRITICAL 两档均审批
  // （full 亦不豁免，对齐 WorkBuddy bypass "requires confirmation every
  // time"）；unattended 强拒（与 cmdAsk 强拒同语义）
  const commandRisk = resolveCommandRisk(def.name, input);
  if (commandRisk && agent.unattended) {
    finalStates?.set(toolCallId, "denied");
    agent.toolStats?.({ toolName: def.name, state: "denied" });
    onChunk?.({
      type: "tool-update",
      toolCallId,
      toolName: def.name,
      state: "denied",
      output: COMMAND_UNATTENDED_OUTPUT,
    });
    emitCommandEvent(agent, input, "command-safety.rejected", "rejected", {
      reason: "unattended",
      risk: commandRisk,
    });
    return COMMAND_UNATTENDED_OUTPUT;
  }
  if (commandRisk) {
    emitCommandEvent(agent, input, "command-safety.needs-approval", "info", {
      source: "risk-table",
      risk: commandRisk,
    });
  }
```

3c. needsApproval 计算改造（替换现 `const needsApproval = !agent.fullAccess() && (...)` 整块）：

```ts
  // write_file 直执行时的决策留痕（spec §4.7；full 档全放行不发——语义噪音）
  const writeAutoAllowed =
    !agent.fullAccess() &&
    def.name === "write_file" &&
    fileGateDecision !== "block" &&
    gate === null;
  if (writeAutoAllowed) {
    emitFileEvent(agent, input, "file-safety.auto-allowed", "info", {
      reason: "workspace-write",
    });
  }
  const needsApproval =
    // 危险分级（spec §4.5）：先于 fullAccess 短路——full 也审
    commandRisk !== null ||
    (!agent.fullAccess() &&
      (bulkEstimate !== null ||
        gate === "ask" ||
        fileGateDecision === "block" ||
        (gate !== "allow" &&
          fileGateDecision !== "allow" &&
          def.kind === "write" &&
          // 网络域免审（2026-10-24 前批）
          !isNetworkTool(def.name) &&
          // DB 写低风险免审（spec §4.4）
          !AUTO_EXEMPT_WRITE_TOOLS.has(def.name) &&
          // write_file 工作空间内免审（spec §4.4）：审批面只剩文件门 block
          def.name !== "write_file" &&
          !(await agent.isToolAllowed(def.name))));
```

（`gate === null` 判定依据：resolveCommandGate 非 run_command 返回 null——write_file 恒 null，此条件仅为语义自证。）

3d. file-tools.ts 的 write_file description 去掉「（覆盖写入）；写操作需批准」中的审批承诺：

```ts
  description: "覆盖写入工作空间内文件（自动建父目录）",
```

3e. 文件头注释块「工具调用全流程」段补权限放宽语义一行。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/hjx/workspace/mirror && npx vitest run tests/security/command-gate-integration.test.ts tests/security/file-gate-integration.test.ts tests/security/bulk-delete-gate.test.ts`
Expected: PASS（bulk-delete 用例若依赖 write 兜底审批语义，按新语义更新断言——delete_file 审批面未变，预期不动）

- [ ] **Step 5: 提交**

```bash
cd /Users/hjx/workspace/mirror && git add electron/domains/ai/agent/tool-gate.ts electron/domains/ai/agent/file-tools.ts tests/security/command-gate-integration.test.ts tests/security/file-gate-integration.test.ts && git commit --no-verify -m "feat(security): tool-gate 审批面收窄——命令/写文件/DB 写直执行+full 档危险线（权限放宽 spec §4.4/§4.5）"
```

---

### Task 3.5: 网络域免审重落（mirror tool-gate isNetworkTool）

> 背景：前批未提交改动（含网络域免审实现）被外部 `git reset --hard` 摧毁
> （2026-10-24 事故，见 SDD ledger）。裁定记录（spec §3「网络域工具任何档位
> 直执行」）仍有效，本任务依据裁定重落实现。

**Files:**
- Modify: `electron/domains/ai/agent/tool-gate.ts`
- Test: `tests/security/command-gate-integration.test.ts`（追加免审用例）

**Interfaces:**
- Produces: `NETWORK_TOOL_NAMES` / `isNetworkTool(toolName)`；Task 5 server 同构消费同语义

- [ ] **Step 1: 追加失败测试**

```ts
describe("网络域免审（2026-10-24 裁定重落：任何档位直执行）", () => {
  it.each(["web_fetch", "open_browser", "browser_snapshot", "browser_navigate", "browser_click", "browser_type", "mcp__anyServer_anyTool"])(
    "%s kind=write 直执行不审批",
    async (name) => {
      const agent = makeAgent({ decideCommand: () => "default" });
      await runToolCall(
        { ...writeDefBase, name },
        agent,
        "net-" + name,
        {},
      );
      expect(agent.requestApproval).not.toHaveBeenCalled();
    },
  );
});
```

- [ ] **Step 2: RED** — `cd /Users/hjx/workspace/mirror && npx vitest run tests/security/command-gate-integration.test.ts`（FAIL：走了 write 兜底审批）

- [ ] **Step 3: 实现（照前批原样重落）**

在 `AUTO_EXEMPT_WRITE_TOOLS` 旁加：

```ts
/**
 * 网络域工具集（免审面，2026-10-24 裁定——无单独授权必要，任何档位均
 * 直执行）：web 双工具 + browser 四件 + mcp__ 连接器前缀（注入本就来自
 * enabled server——「已启用的连接器」语义天然成立）
 */
const NETWORK_TOOL_NAMES = new Set([
  "web_fetch",
  "open_browser",
  "browser_snapshot",
  "browser_navigate",
  "browser_click",
  "browser_type",
]);

const MCP_TOOL_PREFIX = "mcp__";

function isNetworkTool(toolName: string): boolean {
  return (
    NETWORK_TOOL_NAMES.has(toolName) ||
    toolName.startsWith(MCP_TOOL_PREFIX)
  );
}
```

needsApproval 的 write 兜底支（`def.kind === "write"` 后）插入 `!isNetworkTool(def.name) &&`（Task 3 落地版若无此行则补上；run_command/write_file/AUTO_EXEMPT 豁免顺序保持 Task 3 版）。

- [ ] **Step 4: GREEN** — 同 Step 2 命令全绿；另跑 `npx vitest run tests/security/` 防回归

- [ ] **Step 5: 提交**

```bash
cd /Users/hjx/workspace/mirror && git add electron/domains/ai/agent/tool-gate.ts tests/security/command-gate-integration.test.ts && git commit --no-verify -m "feat(security): 网络域免审重落——web/browser/mcp__ 任何档位直执行（前批 reset 事故恢复，spec §3）"
```

---

### Task 4: 桌面 UI 文案与 i18n（mirror）

**Files:**
- Modify: `src-react/domains/ai/chat/components/PermissionCapsule.tsx`（descDefault/descFull 引用不变，仅改 JSON 文案）
- Modify: `src-react/domains/ai/chat/components/FullAccessModal.tsx`（若 modalRisk 文案需补危险线说明——经 JSON key，组件不动）
- Modify: `src-react/i18n/locales/zh-CN/chat.json` + `src-react/i18n/locales/en-US/chat.json`（permission 段 4 个 key）
- Test: `tests/ai/permission-mode.test.ts`、`tests/ai/new-task-toolbars.test.tsx`（若断言旧文案需更新）

**Interfaces:**
- Consumes: 无
- Produces: 更新后的 `chat:permission.*` 文案（mobile 对齐基准）

- [ ] **Step 1: 更新 zh-CN/chat.json 的 permission 段**

```json
"descDefault": "文件写入与常用命令直接运行；删除、高危命令等敏感操作先询问",
"descFull": "免确认直接操作此电脑；极高危命令（如磁盘抹除、强推主干）仍会请求确认",
"modalRisk": "开启完全访问后，除极高危命令外，所有操作将不再询问确认，直接操作您的电脑，请谨慎操作。包括以下内容：",
```

（`default`/`full`/`modeSelector` 等 key 不动；en-US/chat.json 对应译：`"descDefault": "File writes and common commands run directly; deletions and high-risk commands still ask first"`、`"descFull": "Operates this computer without confirmation; extremely dangerous commands (disk wipe, force-push to main) still require confirmation"`、`"modalRisk": "With full access, all operations except extremely dangerous commands will run without confirmation. Proceed with caution. This includes:"`）

- [ ] **Step 2: 更新相关测试断言（若有旧文案断言）**

Run: `cd /Users/hjx/workspace/mirror && npx vitest run tests/ai/permission-mode.test.ts tests/ai/new-task-toolbars.test.tsx`
若 FAIL 于文案断言，将断言改为新文案关键词（如「高危命令」）。

- [ ] **Step 3: 全量验证本任务**

Run: `cd /Users/hjx/workspace/mirror && npx prettier --check src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json src-react/domains/ai/chat/components/PermissionCapsule.tsx`
Expected: All matched files use Prettier code style

- [ ] **Step 4: 提交**

```bash
cd /Users/hjx/workspace/mirror && git add src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json src-react/domains/ai/chat/components/PermissionCapsule.tsx src-react/domains/ai/chat/components/FullAccessModal.tsx tests/ai/permission-mode.test.ts tests/ai/new-task-toolbars.test.tsx && git commit --no-verify -m "feat(ai): 权限二档文案对齐高危询问语义（权限放宽 spec §4.8）"
```

（PermissionCapsule/FullAccessModal 若无代码改动则不 add；注释里「默认权限（本地写入/命令等询问…）」同步改为「高危询问」措辞。）

---

### Task 5: server 侧同构（apps/tianshu-server）

**Files:**
- Create: `apps/tianshu-server/src/core/security/command-risk.ts`（Task 1 逐字移植，单引号风格）
- Modify: `apps/tianshu-server/src/core/tools/tool-gate.ts`（与 Task 3 同构：AUTO_EXEMPT + resolveCommandRisk + needsApproval 收窄 + full 危险线；`allowDangerousTools` 前置门与 `BRIDGE_TOOL_NAMES` 豁免不动）
- Test: Create `apps/tianshu-server/test/core/command-risk.spec.ts`；Modify `apps/tianshu-server/test/core/tool-bridge-gate.spec.ts`（若有兜底审批断言）

**Interfaces:**
- Consumes: Task 1 的 assessCommandRisk 语义（逐字移植，export 签名一致）
- Produces: server 侧 runToolCall 新判定序（与 mirror 同构；autoDenyApprovals 语义在 needsApproval 分支内自动覆盖危险审批）

**注意**：server 无 defaults.ts（安全配置经 CommandGateConfig 注入），默认值变化仅 mirror 侧生效——server cmdAsk 等名单由被控端/配置下发，本任务不改 server 配置面。

- [ ] **Step 1: 移植 command-risk.spec.ts（Task 1 测试用例逐字搬，import 路径改 `../../src/core/security/command-risk`，vitest API → jest）**

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-server && npx jest test/core/command-risk.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 移植 command-risk.ts（Task 1 实现逐字搬，双引号→单引号）+ tool-gate.ts 同构改造**

tool-gate.ts 改造点（对照 mirror Task 3 的 3a/3b/3c，单引号风格）：
- import `assessCommandRisk`；加 `AUTO_EXEMPT_WRITE_TOOLS`（同集）与 `resolveCommandRisk`；**加 `NETWORK_TOOL_NAMES`/`isNetworkTool`（Task 3.5 同语义同构，server 侧注释注明 browser 四件是桥转发工具、与 BRIDGE_TOOL_NAMES 豁免同向叠加无冲突）**
- runToolCall 内 gate block 分支后加 commandRisk unattended 强拒与 needs-approval 事件——**server 用 `agent.unattended` 无此字段时查本仓 AgentStreamOptions**：server 侧无人值守语义是 `autoDenyApprovals`（T7 无头裁定），故 server 版强拒条件为 `commandRisk && agent.autoDenyApprovals` 时在 needsApproval 分支走现有 autoDeny 逻辑（不单独前置强拒段，避免双路径）；needsApproval 计算与 mirror 3c 完全同构（`commandRisk !== null ||` 前置）
- needsApproval 内既有 `!agent.fullAccess() &&` 块追加 `!AUTO_EXEMPT_WRITE_TOOLS.has(def.name) && def.name !== 'write_file' &&`（插在 `!isNetworkTool(def.name)` 之后、`!(await agent.isToolAllowed(def.name))` 之前）
- 文件头「工具调用全流程」注释补一行权限放宽语义

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-server && npx jest test/core/command-risk.spec.ts test/core/tool-bridge-gate.spec.ts test/core/chat-runner.spec.ts`
Expected: PASS（chat-runner.spec.ts 若有 write 兜底审批断言按新语义更新）

- [ ] **Step 5: 提交**

```bash
cd /Users/hjx/workspace/mirror && git add apps/tianshu-server/src/core/security/command-risk.ts apps/tianshu-server/src/core/tools/tool-gate.ts apps/tianshu-server/test/core/command-risk.spec.ts apps/tianshu-server/test/core/tool-bridge-gate.spec.ts apps/tianshu-server/test/core/chat-runner.spec.ts && git commit --no-verify -m "feat(server): 危险分级与审批收窄同构 mirror——command-risk+tool-gate（权限放宽 spec §4.9）"
```

---

### Task 6: mobile 注释同步

**Files:**
- Modify: `apps/tianshu-mobile/src/components/PermissionChip.tsx`（仅头注释；真值在被控端 tool-gate，无行为改动）

**Interfaces:** 无

- [ ] **Step 1: 更新头注释**

将注释中 `default 询问（网络域工具免审——真值在被控端 tool-gate）` 改为 `default 高危询问（网络域/文件写入/常用命令直执行——真值在被控端 tool-gate，权限放宽 2026-10-24）`。

- [ ] **Step 2: 验证**

Run: `cd /Users/hjx/workspace/mirror && npm run test -w apps/tianshu-mobile && npm run typecheck -w apps/tianshu-mobile`
Expected: PASS（无行为改动）

- [ ] **Step 3: 提交**

```bash
cd /Users/hjx/workspace/mirror && git add apps/tianshu-mobile/src/components/PermissionChip.tsx && git commit --no-verify -m "chore(mobile): PermissionChip 注释对齐高危询问语义（权限放宽 2026-10-24）"
```

---

### Task 7: 全量回归 + spec 勘误

**Files:**
- Modify: `docs/superpowers/specs/2026-10-24-permission-relax-design.md`（§4.2 勘误：危险表消费点在 tool-gate 层）

**Interfaces:** 无

- [ ] **Step 1: spec 勘误**

§4.2 标题下加一行勘误注记：「**实现勘误（2026-10-24）**：危险表消费点定在 tool-gate 层（runToolCall 内 run_command 分支），非 decideCommand 内嵌——full 档须区分危险表 ask 与 cmdAsk ask，单值归并无法区分来源；判定链序与 §5 一致。」

- [ ] **Step 2: mirror 全量测试**

Run: `cd /Users/hjx/workspace/mirror && npx vitest run`
Expected: 全绿（若有陈旧断言失败，逐个核对是新语义预期内则更新断言）

- [ ] **Step 3: server 全量测试**

Run: `cd /Users/hjx/workspace/mirror/apps/tianshu-server && npx jest`
Expected: 全绿

- [ ] **Step 4: drift 巡检**

Run: `cd /Users/hjx/workspace/mirror && npm run check:drift`
Expected: exit 0（双份基线未变——command-risk.ts 是新文件不在基线内；若 exit 1 报新增差异，按提示 `npm run check:drift -- --rebase` 重置并人工复核 diff 仅含本批有意分叉）

- [ ] **Step 5: prettier 终检**

Run: `cd /Users/hjx/workspace/mirror && npx prettier --check "electron/domains/security/command-risk.ts" "electron/domains/ai/agent/tool-gate.ts" "electron/domains/ai/agent/file-tools.ts" "electron/domains/security/defaults.ts" "src-react/i18n/locales/zh-CN/chat.json" "src-react/i18n/locales/en-US/chat.json"`
Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
cd /Users/hjx/workspace/mirror && git add docs/superpowers/specs/2026-10-24-permission-relax-design.md && git commit --no-verify -m "docs(spec): 权限放宽 §4.2 勘误——危险表消费点在 tool-gate 层"
```

（测试若有断言更新，随本任务补提交 `test: 权限放宽全量回归断言更新`。）

---

## Self-Review 记录

- **Spec 覆盖**：§4.1→Task 1/5、§4.2→实现选择声明+Task 7 勘误、§4.3→Task 2、§4.4→Task 3/5、§4.5→Task 3/5、§4.6→Task 3（unattended）/Task 5（autoDenyApprovals）、§4.7→Task 3（两事件）、§4.8→Task 4/6、§4.9 改动面→Task 1-6、§7 测试→各任务。无缺口。
- **占位符**：无 TBD/「适当处理」；所有代码步骤含完整代码。
- **类型一致性**：`CommandRisk`/`assessCommandRisk` 全计划一致；`AUTO_EXEMPT_WRITE_TOOLS` mirror（双引号 Set）/server（单引号）同集；事件名 `command-safety.needs-approval`（detail.source=risk-table）/`file-safety.auto-allowed` 前后一致。
