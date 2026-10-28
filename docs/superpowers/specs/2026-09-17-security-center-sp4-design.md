# 安全中心 SP4：数据安全执行层 — 设计文档

## 1. 背景与范围

SP1 落了数据安全卡片的配置面（备份开关/配额展示/删除保护开关/批量删除阈值）与审计基座，但三件套的**真实执行**留给 SP4：

1. **自动备份**：`write_file` 覆盖前快照原文件到 `userData/file-history`（WorkBuddy 同构语义：单文件 <100MB、会话目录、内容寻址、LRU 字节配额）
2. **回收站（删除保护）**：新增 `delete_file` 结构化删除工具——`deleteProtection=true` 走 `shell.trashItem()`（系统回收站可找回），`false` 走"先备份后永久删除"
3. **批量删除审批**：`delete_file` 递归删目录前预估文件总数，≥ `bulkDeleteThreshold`（默认 50）升级**强制审批**（完全访问模式也弹、unattended 强拒）

**不做**（边界）：
- 恢复 UI（文件历史二级页/一键还原）——恢复入口 = SP1 已有「打开备份目录」手工取回；恢复 UI 记 SP6 收尾候选
- `run_command` 侧 rm 的参数级删除预估——rm 维持 SP2 黑名单语义（默认拦 + 审批），`bash -c`/`find -delete` 等形态防不住，预估只做在结构化工具这一条可信通道上
- 时间维度清理（如 Claude Code 的 30 天 retention）——先做已承诺的字节配额 LRU
- trashItem 模式下的重复备份（系统回收站已是兜底）
- 新 UI / 新 IPC 通道（配置面与打开目录 SP1 已齐）

## 2. 关键裁定

| # | 裁定 | 依据 |
|---|---|---|
| 1 | 删除走新增 `delete_file` 工具，rm 保持默认黑名单不变 | 结构化可控；黑名单引导模型改用工具 |
| 2 | 批量阈值按**单次操作**预估（目录树文件数），非会话累计 | 贴近防 `rm -rf` 大目录误删动机；对齐 SP3 block 审批语义 |
| 3 | 备份只挂"系统回收站兜不住的丢失点"：write_file 覆盖前 + 永久删除前；trashItem 不重复备份 | 每个丢失点恰好一道兜底（Claude Code 哲学：checkpoint 与权限解耦） |
| 4 | 备份 fail-open：备份失败不阻塞写操作，winston error + 审计 warn | 备份是兜底层非准入层 |
| 5 | 内容寻址快照名（sha256 前 32 hex）+ 每会话 manifest 记原路径 | 忠实 SP1 表 14 承诺语义；无 manifest 则用户无法追溯原路径 |
| 6 | trashItem 失败报错保留文件，不降级硬删 | 安全优先 |
| 7 | 预估计数带上限（10000 达限即停）——≥ 阈值即触发，无需精确数 | 恶劣大目录下门层不做无限遍历 |

## 3. backup-policy 纯函数（`electron/domains/security/backup-policy.ts`）

无 I/O 的决策与数据操作层（Vitest 直测）：

```ts
/** 单文件备份上限（WorkBuddy 同构语义） */
export const BACKUP_FILE_LIMIT = 100 * 1024 * 1024;
/** 目录预估计数上限（达限即停） */
export const ESTIMATE_COUNT_LIMIT = 10000;

/** manifest 条目：原路径 + 快照名 + 备份时间戳(ms) + 字节 */
export interface BackupEntry {
  path: string;
  hash: string;
  at: number;
  size: number;
}

/** 快照文件名 = sha256(content) 前 32 hex */
export function snapshotName(content: Buffer): string;

/** manifest 追加条目（不去重——同内容多时间点各记一行，LRU 需要最新 at） */
export function appendEntry(entries: BackupEntry[], entry: BackupEntry): BackupEntry[];

/** 全局已用字节 = 所有条目 size 之和（快照与条目一一对应或被共享） */
export function totalSize(entries: BackupEntry[]): number;

/** LRU 淘汰选择：按 at 升序累计，返回需删除的条目集合（至总量 ≤ maxBytes） */
export function selectEvictions(entries: BackupEntry[], maxBytes: number): BackupEntry[];

/** 淘汰条目中 hash 不再被剩余条目引用的（→ 可删快照文件） */
export function orphanedHashes(remaining: BackupEntry[], evicted: BackupEntry[]): string[];
```

## 4. FileHistoryService（`electron/domains/security/file-history.ts`）

class 服务（照 AuditLogService 构造注入模式；不挂 IPC——纯执行层内部依赖）：

```ts
export class FileHistoryService {
  constructor(rootDir: string); // Application: path.join(userData, "file-history")

  /** 覆盖/永久删除前调用：>100MB 或读失败 → { skipped: reason }；成功 → 落快照 + manifest + 配额检查 */
  async backupFile(absPath: string, sessionId: number): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** 批量预估（模块级函数，无状态）：walk 计数，达 ESTIMATE_COUNT_LIMIT 即停 */
export async function countFilesForEstimate(root: string): Promise<number>;
```

- **目录结构**：

```
file-history/<sessionId>/manifest.json      # BackupEntry[]（读改写，单写者主进程）
file-history/<sessionId>/<sha256前32hex>    # 快照文件 = 原文件字节原文
```

- backupFile 流程：stat → 超限 skip → 读内容 → hash → 快照已存在则复用（内容寻址天然去重）→ manifest 追加 → `enforceQuota`
- **配额 LRU 跨会话**：读全部会话 manifest 合并 → `selectEvictions` → 逐会话写回剩余条目 → 删 orphan 快照文件。会话目录数量级小（JSON 每次全扫可接受）
- 服务内部不审计、不上报——返回值交调用方（工具层）决定审计事件，保持"纯副作用 + 判定分离"
- 全程异常捕获 → `{ ok: false, reason }`（fail-open 由调用方落实：写操作不中断）

## 5. delete_file 工具（file-tools.ts 新增）

```ts
// schema
z.object({ path: z.string().describe("要删除的文件或目录（工作空间内相对路径；目录递归删除）") })

// ToolDefinition
name: "delete_file"
description: "删除文件或目录（目录递归）。默认移入系统回收站（可在安全中心-数据安全调整）；大目录会请求确认。优先使用本工具而非 rm 命令。"
kind: "write"
```

执行序（execute 内）：
1. `resolveSafePath` 解析（越界照旧报错；fullAccess 放行）
2. 不存在 → 报错文案（对齐 toToolResult）
3. `ctx.deleteProtection !== false`（缺省 true，与 SECURITY_DEFAULTS 一致）→ `shell.trashItem(target)`；失败 → `fail("移入回收站失败: …")` 保留文件 + 审计 `data-safety.delete-failed`
4. 否则（永久删除）：walk 逐文件 `ctx.onBackupFile` 备份（文件即可，目录结构无需快照——manifest.path 记原路径即可还原到任意位置），再 `fs.rm(target, { recursive: true, force: false })`
5. 返回文案含删除对象与模式（"已移入回收站"/"已永久删除（N 个文件，已备份 M 个）"）

**ToolContext 扩展**（照 `commandWatchBlacklist` 装配快照注入模式；运行中改配置下个会话生效）：

```ts
/** 删除保护（SP4）：true=trashItem；装配时从 SecurityService 缓存快照，缺省 true */
deleteProtection?: boolean;
/** 备份回调（SP4）：write_file 覆盖前 / delete_file 永久删除前调用；缺省不备份 */
onBackupFile?: (absPath: string, sessionId: number) => void;
```

**write_file 接入**：`resolveSafePath` 成功且目标**已存在**时，写入前 `await ctx.onBackupFile?.(target, ctx.sessionId)`——备份失败不中断（fail-open，服务返回 reason 时发 `data-safety.backup-skipped`）。

## 6. 执行链接入（chat.service.ts 门层）

1. `FILE_GATE_TOOLS` 加 `"delete_file"`（SP3 文件门自然覆盖：黑名单路径删除 = block → 无条件审批）
2. **批量强审批**（文件门之后、needsApproval 之前）：

```ts
/** 批量删除预估（SP4）：delete_file + 目录预估 ≥ 阈值 → 强制审批（null=不涉及） */
function resolveBulkDelete(agent: AgentStreamOptions, toolName: string, input: unknown): number | null;
// 内部：toolName !== "delete_file" 或无 path → null；
// resolveSafePath 解析（失败 null）→ stat 非目录 → null；
// countFilesForEstimate ≥ agent.bulkDeleteThreshold → 返回估值；否则 null
```

- `estimated !== null && agent.unattended` → 强拒（denied + `data-safety.bulk-delete-rejected`，reason: unattended，文案对齐 FILE_UNATTENDED_OUTPUT 风格）
- `estimated !== null` → `data-safety.bulk-delete-needs-approval`（info）
- `needsApproval` 组合追加 `|| estimated !== null`（完全访问模式也弹）
- `AgentStreamOptions` 加可选字段 `bulkDeleteThreshold?: number`（装配注入，缺省 50 与 SECURITY_DEFAULTS 一致）——阈值仅门层消费故走 agent；预估计数直接 import `file-history.ts` 的 `countFilesForEstimate`（纯 I/O 函数，跨树 import 照 file-gate 先例；集成测试用真实临时目录，无需替身）

3. **装配**：`Application.ts` 实例化 `FileHistoryService`；`chat.service` 的 `resolveAgentOptions` 与 `automation-runner` 装配字面量同步加 `deleteProtection` / `onBackupFile` / `bulkDeleteThreshold`（从 SecurityService 缓存读）。

## 7. 审计事件与 i18n

eventType → i18n key **全点换下划线**（SP2 教训）；守卫测试 known 列表同步：

| eventType | decision | detail | 触发点 |
|---|---|---|---|
| `data-safety.backup-created` | info | path, size | 工具层备份成功 |
| `data-safety.backup-skipped` | info | path, reason(oversize/failed) | 工具层备份跳过/失败 |
| `data-safety.delete-trashed` | info | path | trashItem 成功 |
| `data-safety.delete-permanent` | info | path, files | 永久删除完成 |
| `data-safety.delete-failed` | failed | path, error | trashItem 失败 |
| `data-safety.bulk-delete-needs-approval` | info | path, estimated | 门层预估超阈值 |
| `data-safety.bulk-delete-rejected` | rejected | path, estimated, reason | unattended 强拒 |

zh-CN/en-US `security.json` `audit.events` 加 7 key（插值变量一致）；工具描述与返回文案为**模型可见文本**（中文，照既有工具，不走 i18n）。

## 8. 错误处理

| 场景 | 处理 |
|---|---|
| 备份读/写/manifest 失败 | fail-open：返回 reason，写操作继续 + 审计 backup-skipped + winston error |
| trashItem 失败 | 报错保留文件（不降级硬删）+ 审计 delete-failed |
| 目录预估失败（权限等） | 返回 null（视为未超阈值，走常规审批）+ winston error——预估是增强非准入 |
| manifest 损坏 | 丢弃该会话 manifest 重建（快照文件成孤儿，占配额但不致损）；LRU 下轮自然淘汰 |
| 快照写半途崩溃 | 内容寻址文件名不匹配即无效，下轮 orphan 清理不识别——保守：写临时名 + rename |

## 9. 测试策略

- **纯函数单测**（`tests/security/backup-policy.test.ts`）：snapshotName 稳定性；appendEntry/totalSize；selectEvictions（恰好达标/全淘汰/空表）；orphanedHashes（共享 hash 不误删）
- **服务集成**（`tests/security/file-history.test.ts`，真实临时目录）：backupFile 落盘/复用/超限 skip；跨会话配额 LRU + orphan 清理；manifest 损坏重建；countFilesForEstimate 上限
- **工具与门层集成**（`tests/security/delete-file-gate.test.ts`，mock electron shell）：trashItem 模式；永久模式先备份后删；预估超阈值 → 强制审批（fullAccess 也弹）/ unattended 强拒；SP3 门回归（delete_file 黑名单路径 block）；write_file 覆盖前备份（default 模式行为不变）
- **守卫测试**：audit-event-message known 列表 +7 key
- **手工验收清单**：备份目录结构走查（会话目录/快照名/manifest）、阈值审批弹窗、双语审计渲染、DataSafetyCard 开关联动（关备份→不再快照；关删除保护→永久删+备份）

## 10. 与 Claude Code / WorkBuddy 的对照

| 维度 | Claude Code | WorkBuddy（SP1 记载） | 天枢 SP4 |
|---|---|---|---|
| 触发 | 轮次 checkpoint + pre-edit 快照 | —（无记载） | 工具级 pre-edit/删除前快照 |
| 覆盖 | 仅自家编辑工具，Bash 不追踪 | — | write_file + delete_file（永久模式）；trashItem 模式交系统回收站 |
| 结构 | `<sessionId>/<路径哈希>@v<N>` 无 manifest | 会话目录 + 内容寻址 | `<sessionId>/<内容哈希>` + manifest 记原路径 |
| 恢复 | /rewind UI（checkpoint 粒度三档） | 无记载 | 打开备份目录手工取回（UI 记 SP6 候选） |
| 清理 | 100 checkpoint + 30 天 | LRU 字节配额 | 3000MB（可配）LRU 字节配额（已承诺语义） |
| 删除 | 无删除工具（rm 走 Bash 权限） | deleteProtection 默认 false（实验） | delete_file 工具 + trashItem（默认开） |
