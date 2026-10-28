# 安全中心 SP3：文件安全 — 设计文档

- 日期：2026-09-16
- 状态：已批准（用户确认设计两段）
- 上游：安全中心 PRD §3.1.1 / §4；SP1（配置基座、内置清单常量、审计链）、SP2（判定门模式、二级页模式）产物直接消费
- 参照实现：WorkBuddy（fileSafety allowlist/blocklist 纯路径模式；凭据路径 needs-approval；denyWrite 自身 settings.json）

## 1. 背景与范围

SP1 已持久化 `fileAllowlist`/`fileBlocklist`（用户自定义）与内置敏感路径静态清单（17 条，永不落盘）；SP2 建立了判定门/审计/二级页的完整模式。SP3 让文件安全真实生效：

**做**：
1. 路径判定引擎纯函数（内置 > 用户白 > 用户黑 > default；`~` 展开；目录前缀 + 精确文件匹配）
2. 执行接入：`read_file / write_file / list_dir` 三工具判定门（block 无条件审批——read 类首次进审批流；allow 跳过 write 常规审批；default 链路不变）
3. 运行时内置保护：`userData` 绝对路径注入执行层 blocklist（SP1 归档"自身数据目录保护"落地）
4. 文件安全二级页 UI（内置只读区 + 用户黑白名单 CRUD + 重置）
5. `RuleSection` 提取共享组件（CommandDetailView 回归保障）
6. 审计事件 2 新增 + reset 事件

**不做**：通配符 glob（已知边界，UI placeholder 不承诺）、删除保护/回收站/备份执行（SP4）、沙箱级目录隔离、内置清单编辑、`search_files` 判定（无 path 参数、本就限定工作空间非隐藏文件）。

## 2. 关键裁定

- **优先级**（PRD §4"白名单 > 黑名单"+ 内置底座）：内置清单（静态 + 运行时）→ 用户白名单 → 用户黑名单 → default。内置不可被用户白名单绕过（三层防删第 3 层的执行层兜底）。
- **黑名单 = 审批而非拒绝**（PRD："强制弹出审批窗口，允许后执行"）——内置命中同为审批（用户可临时放行，清单不可删）。
- **block 无条件审批**：覆盖 fullAccess 与 toolPermission（与 SP2 ask 绝对优先同构）；automation（unattended）→ 拒绝反馈（挂起即 false/true 分流的 ask 语义由 unattended 标志短路，复用 SP2 机制）。
- **read 类工具进入审批流**：`read_file/list_dir` 命中黑名单时挂审批（PRD"读写都拦"）；ApprovalBanner 按 toolCallId 渲染对 read 工具天然兼容。
- **匹配语义**（WorkBuddy 同构，KISS）：`~/` 前缀展开 os.homedir；绝对路径原样；相对路径按 workspacePath resolve；条目尾分隔符（或解析后）视为目录前缀（`prefix + path.sep`）；无尾分隔符为精确文件匹配。不做 glob。
- `sandboxEnabled=false` → 判定整体旁路。
- 路径解析失败（如 default 态越界）→ 不判定，交工具自身报错（现状语义不变）。

## 3. 判定引擎（electron/domains/security/file-policy.ts，纯函数）

```ts
import type { SecurityConfig } from "../../../src-react/domains/security/model/types";

export type FileAccessDecision = "block" | "allow" | "default";

export interface FileAccessRules {
  builtinBlocklist: string[];  // 静态 17 条（平台过滤）+ userData（运行时注入）
  fileBlocklist: string[];     // 用户自定义
  fileAllowlist: string[];
}

/** 条目归一化：~/ 展开、绝对原样、相对按 workspacePath resolve */
export function normalizeRulePath(entry: string, workspacePath: string): string;

/** 命中判定：目录前缀（尾分隔符或条目即目标前缀 + sep）或精确相等 */
export function pathMatchesRule(absPath: string, ruleAbs: string): boolean;

/** 文件判定：内置 > 用户白 > 用户黑 > default */
export function decideFileAccess(
  absPath: string,
  workspacePath: string,
  rules: FileAccessRules,
): FileAccessDecision;
```

实现要点：全部条目先 `normalizeRulePath`（去尾 `*`（若用户误输入则剔除——不实现语义，仅清洗）、`~` 展开、相对 resolve、统一正斜杠转 `path.sep` 比较）；`pathMatchesRule`：`absPath === rule` 或 `absPath.startsWith(rule + path.sep)`（`rule` 为目录语义时）——以"条目带尾分隔符 → 目录前缀；否则先精确、再试目录前缀"两段式（用户输入 `~/.ssh`（无尾斜杠）也应保护整个目录——**简化：统一目录前缀语义 + 精确文件双匹配**，即无尾分隔符条目同时匹配精确文件与同名目录，误伤面为零风险倾向安全）。

## 4. 执行接入

### 4.1 file-gate 模块单例（electron/domains/security/file-gate.ts，command-gate 同款）

```ts
export function makeFileDecider(
  getConfigValue: () => SecurityConfig,
  extraBuiltin: string[],           // 运行时注入（userData 绝对路径）
): (absPath: string, workspacePath: string) => FileAccessDecision;
export function installFileGate(fn): void;
export function fileGate(absPath: string, workspacePath: string): FileAccessDecision;
```

fail-open 三层同 SP2（getConfigValue 抛错 / 未安装 / gate 抛错 → "default"）；`sandboxEnabled=false` → "default"。

### 4.2 AgentStreamOptions 与 runToolCall

- `AgentStreamOptions` 加 `decideFileAccess?: (absPath: string, workspacePath: string) => FileAccessDecision;`
- `runToolCall` 判定门（与命令门并列，在 write 审批判定之前）：工具名 ∈ {read_file, write_file, list_dir} 且 input.path 存在 → `resolveSafePath(workspacePath, path, fullAccess())` 预解析（try/catch，失败不判定）→ gate：
  - **block** → `agent.unattended` → 拒绝文案（「错误: 无人值守任务不可访问黑名单路径」）+ `file-safety.rejected`（reason=unattended）；否则发 `file-safety.needs-approval`（detail {path 截 200, source}）后**无条件** `awaitApproval`（复用既有三分支；决议事件由 SP1 路径发）
  - **allow** → `file-safety.allow-listed`（detail {path}）→ 跳过 write 常规审批直执行（read 类无变化）
  - **default** → 现有链路逐字节不变（行为兼容硬约束）
- 装配：会话流（resolveAgentOptions 有 workspacePath）与 automation-runner 各注入 `decideFileAccess: fileGate`；Application `installFileGate(makeFileDecider(() => securityService.getConfigValue(), [app.getPath("userData")]))`

### 4.3 与 SP2 命令门的关系

两门并列独立：`run_command` 走命令门，文件三件走文件门；互不干扰；判定顺序无依赖。

## 5. 二级页 UI（FileDetailView）

- 视图栈 `"home" | "audit-all" | "command" | "file"`；SandboxCard 文件安全入口启用
- **RuleSection 提取**：CommandDetailView 内部 RuleSection 提为 `components/RuleSection.tsx`（props 不变），CommandDetailView/FileDetailView 共用——CommandDetailView 改 import，回归由 typecheck+全量测试保障
- 页面结构：
  - 优先级说明文案（§2 语义的中文表述）
  - **内置清单只读区**：`defaults.fileBlocklist`（静态 17 条）渲染，条目带「内置」徽标、无删除钮/无添加行（三层防删第 2 层：展示合并——用户部分与内置分列，天然不可混删）
  - 用户黑名单区 / 用户白名单区：RuleSection CRUD（校验：非空；`~/`、绝对、相对合法）
  - 「重置为默认」→ `security:resetFileRules`
- 新 IPC `security:resetFileRules`（SecurityService，照 resetCommandRules 模式：fileBlocklist/fileAllowlist 两 key 逐一 setConfig + `config.fileRules.reset` 审计 + 返回 config）

## 6. 审计事件

| eventType | decision | detail |
|---|---|---|
| `file-safety.needs-approval` | info | `{path, source: "builtin" \| "user-blocklist"}` |
| `file-safety.allow-listed` | allowed | `{path}` |
| `file-safety.rejected`（复用 SP1） | rejected | unattended 强拒时 `{reason: "unattended", path}` |
| `config.fileRules.reset` | info | `{keys}` |

i18n：`audit.events` 加 `file-safety_needs-approval`（"文件访问需审批: {{path}}"）、`file-safety_allow-listed`（"文件访问已放行: {{path}}"）、`config_fileRules_reset`（"文件名单已重置为默认"）双语；`fileDetail.*` 文案族（title/priorityNote/reset/resetDone/builtin 标题与说明/黑名单区/白名单区 placeholder 与文案）。**AuditCenter entryText 兜底变量补 `path`**（`detail.path` → `{{path}}`，与 command/summary 同级兜底）。

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| 判定异常（gate/解析抛错） | fail-open "default"（三层）；解析越界不判定 |
| 黑名单输入非法（空） | toast |
| reset 失败 | toast |
| 审批 UI 对 read 工具 | ApprovalBanner/ToolCallCard 按 toolCallId 通用，无新组件 |

## 8. 测试策略

- **纯函数**（tests/security/file-policy.test.ts）：判定矩阵（内置>白>黑>default；内置不可被白绕过）、`~` 展开、相对条目 workspace 解析、目录前缀（有无尾分隔符）与精确文件、pathMatchesRule 边界（同级不同名目录不误伤）
- **file-gate**（tests/security/file-gate.test.ts）：makeFileDecider 默认规则矩阵、sandboxEnabled 旁路、extraBuiltin（userData）注入生效、fail-open 三层、单例替换
- **集成**（tests/security/file-gate-integration.test.ts，runToolCall 直调同 SP2）：read_file 黑名单路径 **fullAccess 下仍弹审批**（approvals 被调 + needs-approval 事件）；write_file 白名单路径跳审批（approvals 未调 + allow-listed 事件）；default 回归（write 未记忆→审批；read→直执行）；unattended read→拒绝反馈；search_files 无判定门不回归
- **UI**：typecheck + lint + 手工验收清单（docs/superpowers/acceptance/2026-09-16-security-center-sp3.md：二级页 CRUD/内置只读/重置；full 模式读 ~/.ssh/config 弹审批；白名单写免审；automation 拒绝）

## 9. 与 WorkBuddy 的对照

判定语义同构（needs-approval/approved 决议、allowlist 自动放行）；差异：① 无 macOS sandbox-exec 层，名单直接在工具层生效（WorkBuddy 名单"只在沙箱拦截后生效"的前提在天枢不适用——天枢以工具判定门替代）；② 无 glob（WorkBuddy 文件侧同为纯路径模式）；③ 内置清单 + 自身 userData 运行时保护（对应其 denyWrite 自身配置文件）。
