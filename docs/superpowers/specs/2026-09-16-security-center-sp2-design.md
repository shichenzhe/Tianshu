# 安全中心 SP2：命令安全 — 设计文档

- 日期：2026-09-16
- 状态：已批准（用户确认设计两段与关键裁定 A）
- 上游：安全中心 PRD §3.1.2 / §4；SP1 设计 `2026-09-15-security-center-sp1-design.md`（配置基座、审计链、设置面板骨架——本文档直接消费其全部产物）
- 参照实现：WorkBuddy v5.5.4（`SandboxOrchestrator.decideCommandSafety`：forbidden→deny、ask 前缀命中→ask、allow→跳过敏感检测；programBlacklist 含子进程拦截；"The ask list wins over the allow list"）

## 1. 背景与范围

SP1 交付了配置基座（`cmdAllow`/`cmdAsk`/`programBlacklist` 三名单已持久化，`sandboxEnabled` 总开关默认开但尚无执行层消费）与审计链。SP2 让命令安全**真实生效**：

**做**：
1. 判定引擎纯函数（程序黑名单 → 询问 → 放行 → default）
2. 执行接入：`runToolCall` 层判定门（在现有审批门之前）
3. 子进程穿透监控（darwin/linux，尽力检测）
4. 命令安全二级页 UI（三名单 CRUD + 重置默认）
5. 默认值演进（cmdAsk/cmdAllow 对齐 PRD 示例）
6. 新增审计事件 4 类 + `remembered` 注脚补齐（SP1 终审归档项）

**不做**：文件/网络二级页与规则消费（SP3/SP5）、备份/回收站执行（SP4）、Windows 子进程监控（顶层拦截完整生效；子进程 SP6 评估 PowerShell CIM）、断网。

## 2. 关键裁定（已获用户确认）

- **裁定 A：询问名单绝对优先**——ask 命中无条件弹审批，覆盖完全访问（full）模式与工作空间工具记忆（toolPermission）。安全底线与权限模式正交。
- **裁定 A 配套：automation（无人值守）下询问命中一律视为拒绝**。
- **实现修正（探索发现）**：automation 的 `requestApproval` 现状是按 `accessMode` 分流——`full` 任务返回 **true**（自动放行）、`default` 返回 false（`automation-runner.ts:71-84`）。若 ask 路径直接复用 `awaitApproval`，无人值守 full 任务会穿透询问底线。因此 `AgentStreamOptions` 新增 `unattended?: boolean`（automation 装配处置 true，会话流缺省），ask 分支对 `unattended` 强制拒绝（审计 detail 注明 `{reason: "unattended"}`）。automation 的常规审批分流行为保持不变。
- **程序黑名单绝对禁止**，与权限模式无关（同危险命令正则），并检查子进程。
- `sandboxEnabled=false` 时判定引擎整体旁路（回到 SP1 前行为：危险命令正则仍常开——它与总开关无关，属 P3 既有语义）。

## 3. 判定引擎（electron/domains/security/command-policy.ts，纯函数）

```ts
import type { CmdRule } from "../../src-react/domains/security/model/types";

export type CommandDecision = "block" | "ask" | "allow" | "default";

export interface CommandRules {
  programBlacklist: string[];
  cmdAsk: CmdRule[];
  cmdAllow: CmdRule[];
}

/** 命令判定：程序黑名单 → 询问 → 放行 → default（优先级从高到低） */
export function decideCommand(command: string, rules: CommandRules): CommandDecision;

/** 简化 shell 词法：空白分割 + 成对引号剥离（不引入完整 shell 解析器） */
export function tokenizeCommand(command: string): string[];

/** 路径基名："/usr/bin/rm" → "rm"（win32 反斜杠同样处理） */
export function programBasename(token: string): string;
```

匹配语义：
- **programBlacklist**：首 token 的 `programBasename` 精确等于黑名单项 → `block`
- **cmdAsk / cmdAllow**：`tokens` 的前缀序列等于 `rule.prefix`（大小写敏感、token 级精确）→ `ask` / `allow`；两条名单都命中时 **ask 赢**
- 空 token（引号内空串等）在 tokenize 后剔除；空命令/空规则 → `default`

## 4. 执行接入（chat.service，判定门在审批门之前）

### 4.1 AgentStreamOptions 注入

```ts
/** 命令安全（SP2）：run_command 判定门——闭包读 SecurityService 内存缓存 */
decideCommand?: (command: string) => CommandDecision;
/** 无人值守流（automation）：ask 命中强制拒绝而非挂起审批 */
unattended?: boolean;
```

装配（ChatService 内 `resolveAgentOptions`，会话流）：

```ts
decideCommand: (command) =>
  config.sandboxEnabled
    ? decideCommand(command, pickCommandRules(config))
    : "default",
```

（`config` 每次 call 现读 `securityService.getConfigValue()`——写时失效缓存，规则变更即刻生效。）automation 装配（automation-runner.ts）：同样注入 `decideCommand`（读同一单例）+ `unattended: true`。

### 4.2 runToolCall 判定门

对 `def.name === "run_command"`，在现有 write 审批判定**之前**：

- **block** → `finalStates` denied + 回喂 `"错误: 该命令被命令安全策略禁止（程序黑名单）"` + 审计 `command-safety.blocked`（detail `{command, source: "blacklist"}`）
- **ask**：
  - `agent.unattended` → 回喂拒绝文案（`"错误: 无人值守任务不可执行询问名单命令"`）+ 审计 `command-safety.rejected`（detail `{reason: "unattended", ...}`）
  - 否则 → 审计 `command-safety.needs-approval` 后**无条件**走 `awaitApproval`（不经 fullAccess/isToolAllowed 短路）；拒绝/批准走既有决议事件路径
- **allow** → 审计 `command-safety.allow-listed` 后**跳过**常规审批直执行
- **default** → 现有判定链不变（危险命令正则在 command-tool 内、fullAccess/toolPermission/常规审批在 runToolCall 内）

实现建议：抽 `resolveCommandGate(agent, input): "block" | "ask" | "allow" | "default" | null`（非 run_command 返回 null），runToolCall 按返回值分流，保持函数行数约束。

### 4.3 危险命令正则的 detail 演进

`command-safety.blocked` 的 detail 增加 `source: "dangerous"`（既有事件，兼容）。

## 5. 子进程穿透监控（electron/domains/security/child-monitor.ts）

```ts
export interface ProcRow { pid: number; ppid: number; comm: string; }
/** 由快照行构建 rootPid 的全部后代 pid（孤儿行/成环安全） */
export function buildDescendantPids(rows: ProcRow[], rootPid: number): Set<number>;
/** comm 基名 ∈ blacklist */
export function matchBlacklistProgram(comm: string, blacklist: string[]): boolean;
/** 轮询监控：命中即 kill 违规 pid 及其子树并回调；返回停止函数 */
export function watchCommandTree(rootPid: number, blacklist: string[],
  onViolation: (v: { pid: number; program: string }) => void): () => void;
```

- 快照命令：`ps -eo pid,ppid,comm`（darwin/linux；**win32 下 watchCommandTree 为 no-op**，直接返回空停止函数——平台差异诚实声明）
- 轮询间隔 250ms；命令执行期间挂载、`finally` 停止
- 命中 → 对违规 pid 及其后代逐个 `process.kill(pid, "SIGKILL")`（已退出/权限失败 → 忽略并计入 detail）→ 审计 `command-safety.child-blocked`（detail `{program, pid, rootCommand}`）
- 快照执行失败：静默跳过本轮；**连续 3 次失败自动停止** watcher（命令多半已结束）
- 挂载条件：`sandboxEnabled && programBlacklist 非空 && platform ≠ win32`

### 5.1 runExec 改造（command-tool.ts）

`exec(...)` 返回 `ChildProcess`，捕获 `child.pid`；`execute` 中按挂载条件启停 watcher（`CommandContext` 已有 `onSecurityEvent`，`sessionId` 已有——黑名单经装配注入：`CommandContext.commandWatchBlacklist?: string[]`，`executeToolSafe` 透传 `agent` 装配的动态黑名单 getter 结果）。

## 6. 默认值演进（defaults.ts，SECURITY_DEFAULTS 变更）

| key | SP1 | SP2（对齐 PRD 示例） |
|---|---|---|
| `cmdAsk` | `[]` | `[{prefix:["curl"]},{prefix:["wget"]}]` |
| `cmdAllow` | `[]` | `[{prefix:["git","push"]},{prefix:["npm","install"]}]` |
| `programBlacklist` | `["rm"]` | 不变 |

read-time fallback：已自行存过名单的用户不受影响。

## 7. 二级页 UI（CommandDetailView）

- `SecurityCenter` 视图栈扩展：`"home" | "audit-all" | "command"`
- SandboxCard「命令安全」入口**启用**（点击 `setView("command")`；文件/网络安全维持占位）
- 页面（PRD §3.1.2 交互）：
  - 顶部说明：「询问名单优先于放行名单；程序黑名单绝对禁止（含子进程监控）」
  - 右上「重置为默认」→ IPC `security:resetCommandRules`（三名单恢复 SECURITY_DEFAULTS + 审计 `config.commandRules.reset` + toast）
  - 三名单区块（程序黑名单 / 放行名单 / 询问名单）：各含说明、列表（cmdAllow/cmdAsk 展示 `prefix.join(" ")` + reason）、添加行——点「添加」出现输入框（placeholder：黑名单 `mkfs`、放行 `git push`、询问 `curl`）→ 对勾保存 / 叉号取消；列表项带删除
  - 校验：黑名单仅裸程序名（拒绝含 `/`、`\`、空白的输入，toast 具体原因）；放行/询问按空白分词为 prefix（至少 1 token）
- CRUD 走 `security:setConfig`（整组替换，`pickStringArray`/`pickCommandRuleArray` 在服务端二次清洗）
- 新 IPC `security:resetCommandRules`（SecurityService 注册，三 key 逐一 setConfig 到默认值）

## 8. 审计事件汇总（新增 4 + 复用 3 + 补齐 1）

| eventType | decision | 说明 |
|---|---|---|
| `command-safety.blocked` | blocked | 危险命令（detail.source="dangerous"）/ 黑名单（source="blacklist"） |
| `command-safety.needs-approval` | info | 询问名单命中、发起审批 |
| `command-safety.allow-listed` | allowed | 放行名单命中、跳过审批 |
| `command-safety.child-blocked` | blocked | 子进程监控命中并 kill |
| `command-safety.rejected`（复用） | rejected | 审批拒绝 / unattended 强制拒（detail.reason） |
| `command-safety.approved`（复用） | approved | 审批通过 |
| `command-safety.remembered`（补齐 SP1 归档） | info | `permission:rememberTool` handler 直接审计 |
| `config.commandRules.reset` | info | 重置名单 |

i18n：`security.json` events 补 6 key 双语（needs-approval/allow-listed/child-blocked/remembered/commandRules-reset 类），二级页全部文案（含三名单标题/说明/placeholder/校验提示/重置确认）。

## 9. 错误处理

| 场景 | 处理 |
|---|---|
| ps 快照失败 | 跳过本轮；连续 3 次停 watcher |
| kill 失败（已退出/权限） | 忽略并计入 detail（killed: false） |
| decideCommand 抛错（不应发生，纯函数） | 装配闭包 catch → 返回 "default"（fail-open 到现有链路，记录 winston） |
| 黑名单输入非法 | toast 具体原因，不落库 |
| reset 失败 | toast |

fail-open 说明：判定引擎异常时回到 SP1 行为（现有审批链仍在），不因新功能故障阻断命令执行。

## 10. 测试策略

- **纯函数单测**（tests/security/）：command-policy 判定矩阵（优先级 block>ask>allow>default、基名匹配含路径形态、前缀 token 匹配、引号 token 化、空规则/空命令、ask-allow 双命中）；child-monitor（树构建含孤儿/成环、基名匹配、后代集合）
- **集成单测**：runToolCall 命令门（block 拒绝文案与审计、**ask 在 fullAccess 下仍调 requestApproval**、ask+unattended 直接拒绝、allow 跳过审批断言 requestApproval 未被调、default 回归现状既有测试全绿）；defaults 演进断言
- **手工验收**：二级页 CRUD/重置/校验 toast；真实触发询问名单弹审批（full 模式下同样弹）；黑名单直拒；子进程穿透（`sh -c 'sleep 30'` + 黑名单临时加 `sleep` → 观察被 kill + 审计 + 命令输出异常）；automation full 任务 + 询问命令 → 拒绝反馈

## 11. 对 WorkBuddy 的对照

判定语义与其 `decideCommandSafety` 同构（forbidden/ask/allow 优先级一致）；差异：天枢无 macOS sandbox-exec 进程隔离，子进程监控为**尽力检测**（轮询 kill）而非内核级拦截——已在 §5 诚实声明；WorkBuddy 的 allow"自动放行沙箱文件拦截"部分待 SP3 文件层落地时对齐。
