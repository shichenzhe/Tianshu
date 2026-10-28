# 权限控制放宽设计（对齐 WorkBuddy 分层，2026-10-24）

## 1. 背景与诊断

天枢会话权限现为二档（default/full，`permission-mode.ts`），网络域免审已在前批落地
（2026-10-24 裁定：web 双工具 + browser 四件 + mcp__ 前缀任何档位直执行）。但 default
档的审批面仍比 WorkBuddy 桌面默认档（craft=bypassPermissions）严格一整档：

| 能力 | 天枢 default（现状） | WorkBuddy craft（参照） |
|---|---|---|
| 普通命令（ls/node/git status） | 每次审批（run_command kind=write 兜底） | 免审 |
| `rm file.txt` | 黑名单硬拒（programBlacklist=["rm"]） | 免审（MEDIUM） |
| `curl`/`wget` | cmdAsk 强制审批 | 免审 |
| write_file 工作空间内写 | 每次审批 | 免审（write=allow） |
| delete_file | 审批 + 批量阈值 50 | 审批（delete=ask，一致） |
| 高危命令（sudo/git push -f/rm -r） | 审批（兜底全覆盖） | 强制审批（HIGH/CRITICAL 表） |
| 敏感路径（~/.ssh 等 18 条） | 强制审批 | 写/删审批（一致） |
| plan/skill/expert 类 DB 写工具 | 每次审批（kind=write 一刀切） | N/A |

同时 full 档比 WorkBuddy bypass 裸：WorkBuddy bypass 下 HIGH/CRITICAL 危险命令仍强制
审批（"requires confirmation every time"），天枢 full 仅剩 rm 黑名单硬拒。**两端都
偏离参照系**。

### 逆向参照结论（WorkBuddy，2026-10-24）

- GUI 默认 `{mode:"craft", permissionMode:"bypassPermissions"}`；命令安全五档分级
  （SAFE/CRITICAL/HIGH/MEDIUM/LOW）由四张正则表判定（`CommandUtils.checkSingleCommandSafety`）
- bypass 档：普通命令免审，**HIGH/CRITICAL 仍强制审批**；程序黑名单独立硬拒
- 文件策略层：未命中默认 `read=allow/write=allow/delete=ask`；敏感路径写删 ask
- 引擎详见记忆 `workbuddy-permission-mode-and-network-policy.md`

## 2. 目标 / 非目标

**目标**：default 档从「一切 write 询问」收敛为「高危询问」——常用命令与工作空间内
文件写入直执行；同时 full 档补上危险命令审批线（用户已裁定对齐 WorkBuddy bypass）。

**非目标**：
- 不引入沙箱执行（WorkBuddy 的 sandbox-exec/bubblewrap 体系整体不在本批范围）
- 不改二档模式结构（不加 acceptEdits 中间档）
- 不动网络域免审、删除保护/备份、批量删除阈值、敏感路径表、toolPermission 记忆、
  审计上报等既有安全资产
- 不推翻 2026-10-23「full 豁免批量删除审批（回收站/备份照常兜底）」裁定

## 3. 总体设计：两档语义表（改后）

| 判定 | default | full |
|---|---|---|
| 程序黑名单（programBlacklist） | 硬拒（不变） | 硬拒（不变） |
| 危险分级表 HIGH/CRITICAL 命中 | **审批（新增）** | **审批（新增，对齐 WorkBuddy bypass）** |
| cmdAsk 用户名单命中 | 审批（不变） | 放行（本批改为 full 豁免，原为无条件审批） |
| cmdAllow 命中 / 命令无规则 | **直执行（原审批）** | 直执行（不变） |
| write_file（工作空间内、非敏感路径） | **直执行（原审批）** | 直执行（不变） |
| write_file 命中文件门 block | 审批（不变） | 直执行（本批改为 full 豁免，原为无条件审批） |
| delete_file | 审批 + 批量阈值（不变） | 直执行（审批豁免沿用 2026-10-23 裁定；批量阈值本批改为 full 豁免，原为无条件审批） |
| plan/skill/expert 组 DB 写 | **直执行（原审批）** | 直执行（不变） |
| 网络域工具 | 直执行（不变，前批） | 直执行（不变） |
| 其余 write（mcp__ 写类等） | 审批（不变） | 直执行（不变） |

## 4. 详细设计

### 4.1 危险命令分级表（新增）

新文件 `electron/domains/security/command-risk.ts`（纯函数，无 electron 依赖）+
server 侧同构 `apps/tianshu-server/src/core/security/command-risk.ts`：

```ts
export type CommandRisk = "critical" | "high" | null;
export function assessCommandRisk(command: string): CommandRisk;
```

- 两张正则表（照 WorkBuddy O/M 表精选搬运，逐条注释）；CRITICAL 先于 HIGH 判定
- **分段匹配**：按 `;` `&&` `||` `|` 粗分（与现有 tokenizeCommand 同精度级别，不做
  完整 shell 解析），逐段全文正则——覆盖 `echo x && rm -rf /` 复合命令；引号内分隔
  符误分是已知边界（与 WorkBuddy stripHeredocBodies/splitCommandRespectingQuotes
  的精度差距在 spec §6 声明）
- 表为**内置静态常量永不落盘**（照 BUILTIN_FILE_BLOCKLIST_ALL 三层防删模式）；用户
  cmdAsk/cmdAllow 名单在其外层叠加（cmdAsk 可加严，不可放宽内置表）

**CRITICAL 表**（~28 条）：`rm -rf /`（根/系统目录/`~/*`）、`dd of=/dev|/sys|/boot`、
`mkfs`、`fdisk`、`parted`、`> /etc|/boot|/sys` 重定向、`crontab -r`、`userdel`、
`groupdel`、`DROP DATABASE`、`TRUNCATE TABLE`、`DELETE FROM ... WHERE 1=1|true`、
`FLUSHALL`、`FLUSHDB`、`terraform destroy`、`aws/az/gcloud ... delete`、
`git reset --hard`、`git clean -fdxX`、`git checkout -f`、`git stash clear`、
`git checkout -- ./*`、强推主干（`git push -f|--force|--delete` 且目标含
main/master/develop/release/production）、`git branch -d|-D <主干>`、
`git push :<主干>`

**HIGH 表**（~24 条）：`sudo`、`su`、`chmod 777`、`rm -r|-R|--recursive`（含 -rf）、
`shred`、`wipe`、`truncate -s 0`、`git branch -d|-D`（任意；大小写归一后 -d 折叠含
-D，终审 fix 2026-10-24）、`git push -f|--force`、
`git push --delete`（任意分支）、`git push :branch`、`git filter-branch`、
`git filter-repo`、`git worktree remove|prune`、`git reflog delete|expire`、
`git checkout -- <path>`、`git restore`、`git stash drop`、`kubectl delete`、
`kubectl drain`、`docker system prune`、`docker volume rm`、`find -delete`、
`find -exec rm`、`xargs rm`、`rm` 带通配符

### 4.2 命令判定链重排（command-policy.ts）

> **实现勘误（2026-10-24）**：危险表消费点定在 tool-gate 层（runToolCall 内 run_command 分支），非 decideCommand 内嵌——full 档须区分危险表 ask 与 cmdAsk ask，单值归并无法区分来源；判定链序与 §5 一致。

`decideCommand` 判定链改为：

```
程序黑名单(block) > 危险分级表(critical/high → ask) > cmdAsk(ask) > cmdAllow(allow) > default
```

- `CommandDecision` 四值不变（危险表命中归并为 "ask"，审计 detail 不区分 source——
  现有 needs-approval 事件照发，见 §4.6）
- **default 返回值的消费语义变化**：tool-gate 中 run_command 的兜底从「kind=write →
  审批」改为「直执行」——危险面已由分级表前置捕获
- makeCommandDecider 的 `!config.sandboxEnabled → "default"` 旁路保留，但**旁路分支
  须单独调用 assessCommandRisk**（危险表独立于 sandboxEnabled，用户名单段才被旁
  路）——否则旁路整条短路会把危险表一并跳过，违背 §5 链序

### 4.3 默认值变化（defaults.ts）

- `programBlacklist`: `["rm"]` → `[]`（rm 语义移入危险表：`rm -r` HIGH；单文件 rm
  放行——对齐 WorkBuddy rm=MEDIUM）。**已落盘用户配置不动**（read-time fallback 仅
  影响未配置用户）
- `cmdAsk`: `[curl, wget]` → `[]`（网络域整体免审的前批裁定顺延到命令行下载；
  WorkBuddy 侧 curl/wget 为 MEDIUM 放行）
- `cmdAllow` 默认 `[git push, npm install]` 保留不动（default 兜底已直执行，名单仅
  保留 allow-listed 审计事件价值）

### 4.4 tool-gate 审批面收窄（mirror + server 同构）

`runToolCall` 的 needsApproval 计算改造：

```ts
// 伪代码：needsApproval =
//   gate === "ask"（cmdAsk/危险表/黑名单外 ask 源）→ 审批
//   fileGateDecision === "block" → 审批
//   bulkEstimate !== null → 审批
//   run_command（gate 为 allow/default）→ 直执行          // ← 兜底审批移除
//   write_file 且 fileGateDecision !== "block" → 直执行   // ← 工作空间内免审
//   AUTO_EXEMPT_WRITE_TOOLS 命中 → 直执行                 // ← DB 写免审
//   其余 write（mcp__ 写类）→ isToolAllowed 记忆或审批     // 不变
// 且危险表命中时无视 fullAccess 短路（见 §4.5）
```

- **AUTO_EXEMPT_WRITE_TOOLS**（常量，tool-gate 内，与 NETWORK_TOOL_NAMES 同模式）：
  `plan_create_item`、`plan_update_status`、`plan_append_summary`、`create_skill`、
  `create_expert`、`update_expert`（DB 写无文件系统风险；`read_skill`/
  `recommend_experts`/`dispatch_member` 本就 kind=read 不在列）
- write_file 免审边界：resolveFileGate 正常返回（resolveSafePath 成功=工作空间内或
  full 态授权路径）；block（敏感路径）仍审批；备份 onBackupFile 与审计照常兜底
- delete_file：default 档审批不变（与 WorkBuddy delete=ask 一致）
- mcp__ 写类工具：保持 default 档审批 + isToolAllowed 记忆（连接器生态不可控，
  不随本批放宽）

> **实现勘误（2026-10-24 终审）**：mcp__ 前缀已随网络域免审裁定整体豁免（spec
> §3/Task 3.5），任何档位直执行；本条『保持审批』与 §3 矛盾，以 §3 为准。

### 4.5 full 档补危险审批线（对齐 WorkBuddy bypass）

- 现状 `!agent.fullAccess() && (...)` 短路一切询问——改为：**危险分级命中（ask）与
  程序黑名单（block）在 full 档依然生效**；cmdAsk 用户名单、文件门 block、批量
  阈值、write 兜底在 full 档继续豁免（full=用户显式免责+内置硬线，2026-10-23 裁定
  语义不变）
- 实现：needsApproval 计算前先判 `assessCommandRisk`（run_command 时），危险命中
  的审批分支不乘 `!fullAccess()`；FullAccessModal 与 PermissionCapsule descFull
  文案补「极高危命令仍会请求确认」

### 4.6 unattended（automation）联动

- 危险表命中（ask）在 unattended 强拒——复用现有 `gate === "ask" && unattended`
  分支（判定链归并后自动获得），文案沿用 COMMAND_UNATTENDED_OUTPUT
- 普通命令 / write_file / DB 写直执行 → automation 场景不再挂起（现状 write 兜底
  审批在 automation 下依赖 requestApproval 装配，放宽后此痛点消失）
- delete_file 批量阈值 unattended 强拒（不变）
- server 侧 allowDangerousTools=false 前置门不变（false 时 run_command 整体拒绝，
  危险表在其内层）

### 4.7 审计与监控

- 危险表/cmdAsk 命中审批 → 现有 `command-safety.needs-approval` info 事件照发
  （detail.command 截断 200）；**不新增** source 字段区分（CommandDecision 单值
  归并，避免改返回类型扩散）
- 程序黑名单硬拒 → `command-safety.blocked` 不变
- write_file 直执行路径补一条 `file-safety.auto-allowed` info 事件（决策可追溯，
  对齐 WorkBuddy audit.network.autoApproved 文案族）

### 4.8 UI 与 i18n（三端）

- **PermissionCapsule（桌面）**：descDefault 改为「文件写入与常用命令直执行；删除、
  高危命令等敏感操作询问」；descFull 补「极高危命令仍会请求确认」；标题档位名不变
- **PermissionChip（mobile）**：同步 descDefault/descFull 文案
- **FullAccessModal**：免责文案同步补危险线说明
- **write_file 工具描述**（file-tools.ts）："写操作需批准" → 删除该句（描述与实际
  行为一致，避免模型预期偏差）
- **安全中心命令页**：默认名单展示变化（黑名单默认空、cmdAsk 默认空）——UI 读
  defaults 动态渲染，无需改代码；内置危险分级表**不进**安全中心 UI（WorkBuddy 亦
  不暴露其内置正则表）
- i18n：zh-CN/en-US 双语同步（chat.json 命名空间）

### 4.9 改动面清单

| 端 | 文件 | 改动 |
|---|---|---|
| mirror | `electron/domains/security/command-risk.ts` | 新建（危险表+assessCommandRisk） |
| mirror | `electron/domains/security/command-policy.ts` | 判定链插入危险表 |
| mirror | `electron/domains/security/defaults.ts` | programBlacklist/cmdAsk 默认值 |
| mirror | `electron/domains/ai/agent/tool-gate.ts` | 兜底审批收窄+AUTO_EXEMPT+full 危险线+auto-allowed 事件 |
| mirror | `electron/domains/ai/agent/file-tools.ts` | write_file 描述文案 |
| mirror | `src-react/domains/ai/chat/components/PermissionCapsule.tsx` + `FullAccessModal.tsx` | 文案 |
| mirror | `src-react/i18n/locales/{zh-CN,en-US}/chat.json` | 双语 |
| server | `apps/tianshu-server/src/core/security/command-risk.ts` + `command-policy.ts` + `defaults.ts`（同构副本） | 同 mirror |
| server | `apps/tianshu-server/src/core/tools/tool-gate.ts` | 同构（BRIDGE 豁免与 allowDangerousTools 门不变） |
| mobile | `apps/tianshu-mobile/src/components/PermissionChip.tsx` + `i18n/locales/{zh-CN,en-US}/chat.json` | 文案同步 |
| tests | `tests/security/command-gate-integration.test.ts`、`tests/security/file-gate-integration.test.ts`、`tests/ai/permission-mode.test.ts`、`tests/ai/new-task-toolbars.test.tsx` 等 | 语义更新+新增用例 |
| server tests | server 侧 jest 对应用例 | 同构 |

## 5. 判定链总览（改后，run_command）

```
run_command
  ├─ allowDangerousTools=false（仅 server）→ 拒绝
  ├─ programBlacklist 命中 → 硬拒（两档）
  ├─ 危险分级 CRITICAL/HIGH → ask：default/full 均审批；unattended 强拒
  ├─ sandboxEnabled=false → 危险表以外的名单判定旁路，default 直执行
  ├─ cmdAsk 命中 → default 审批 / full 放行
  ├─ cmdAllow 命中 → 直执行（allow-listed 审计）
  └─ default → 直执行
```

## 6. 边界与已知限制

- 分段匹配为粗分（`;`/`&&`/`||`/`|`），不做完整 shell 解析——引号内分隔符误分、
  heredoc 混淆等由子进程监控（commandWatchBlacklist）与审批兜底；与 WorkBuddy
  stripHeredocBodies/splitCommandRespectingQuotes 存在精度差，声明为已知边界
- 危险表内置不可配置（用户不可关）——与程序黑名单内置语义同层；用户可经 cmdAsk 加严
- `mcp__` 写类工具不放宽（连接器生态不可控）
- mobile/server 与 mirror 判定逻辑同构双份，差异点（allowDangerousTools、
  BRIDGE_TOOL_NAMES）保持现状
- write_file 免审不含越界写（default 档 resolveSafePath 越界即报错，行为不变）

## 7. 测试计划

- command-risk 单测：两表逐正则正/反例（WorkBuddy 同款样例：`rm -rf /tmp/x` 反例
  澄清、复合命令分段命中、大小写）
- command-policy 链序：黑名单 > 危险表 > cmdAsk > cmdAllow > default；危险表在
  sandboxEnabled=false 时仍生效
- tool-gate 集成：default 档 run_command/write_file 直执行；危险命中两档均审批；
  cmdAsk default 审批 full 放行；AUTO_EXEMPT 工具直执行；delete_file 审批不变；
  unattended 危险强拒；file-safety.auto-allowed 事件
- defaults 回归：programBlacklist/cmdAsk 新默认值；已落盘配置不受影响
- server 侧同构用例（jest）
- UI 文案快照（permission-mode.test.ts / new-task-toolbars.test.tsx）

## 8. 裁定记录

1. default 档=「高危询问」档（方案 A，用户 2026-10-24 批准）
2. full 档补 HIGH/CRITICAL 审批，对齐 WorkBuddy bypass（用户 2026-10-24 批准）
3. rm 移出默认黑名单入危险表；curl/wget 移出默认 cmdAsk（本 spec §4.3，随方案 A）
4. delete_file default 档审批保留（WorkBuddy delete=ask 同构）
5. 网络域免审、删除保护/备份/阈值、敏感路径表、toolPermission 记忆均不动
