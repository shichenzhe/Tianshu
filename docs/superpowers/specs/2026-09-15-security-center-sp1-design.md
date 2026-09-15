# 安全中心 SP1：安全配置基座 + 安全中心骨架 — 设计文档

- 日期：2026-09-15
- 状态：已批准（用户已确认设计三段与持续授权推进）
- 上游需求：设置面板 - 安全中心模块 PRD（复刻 WorkBuddy 安全中心）
- 参照实现：WorkBuddy v5.5.4（`/Applications/WorkBuddy.app` app.asar 内 prettified 源码，路径注释 `packages/workbuddy-server/src/security-center/*`）

## 1. 背景

天枢是具备代码执行与系统操作能力的 AI Agent 桌面应用，需要一套安全管控机制防止 AI 幻觉、Prompt 注入或误操作导致的数据损失。安全中心按 6 个子项目（SP1–SP6）拆解交付，本文档是 **SP1** 的设计。

## 2. 子项目拆解总览

| SP | 内容 | 状态 |
|---|---|---|
| **SP1** | 安全配置基座 + 安全中心骨架（本文档） | 设计中 |
| SP2 | 命令安全（三名单 + 子进程穿透检测 + 二级页 + 执行接入） | 待设计 |
| SP3 | 文件安全（路径黑白名单 + 内置规则 + 二级页 + 执行接入） | 待设计 |
| SP4 | 数据安全执行层（自动备份、回收站、批量删除审批） | 待设计 |
| SP5 | 网络安全（域名名单、断网、恶意网站拦截 + 二级页） | 待设计 |
| SP6 | 系统授权、内置运行时开关、toolPermission 管理 UI、收尾 | 待设计 |

顺序依据：SP1 的配置存储与审计基座被所有后续依赖；SP2/SP3 有现成接入点（`command-tool.ts`、`ApprovalCoordinator`）；SP5 技术风险最大；SP6 收尾。

## 3. SP1 范围

**做**：

1. 设置面板新增 `security` tab，安全中心首页（沙箱安全卡片 + 数据安全卡片 + 审计中心卡片）
2. 全部 14 项安全配置的持久化（option 表，read-time fallback 默认值）
3. 内置文件敏感路径清单（代码常量，不落盘，三层防删机制）
4. 审计日志：v9 新表 + 哈希链 + 写入服务 + 查询/导出/清空 + 审计中心 UI
5. 现有代码三处事件源接入审计（危险命令拦截、审批决议、cwd 越界回退）
6. i18n 新 `security` namespace（zh-CN/en-US）

**不做**（属 SP2–SP6）：三个二级页内容与名单管理 UI、执行层安全规则消费（除事件源接入）、备份/回收站/批量删除的真实执行、内置运行时与系统授权卡片、toolPermission 管理 UI。

## 4. 架构

```
SettingsDialog（左栏新增 security tab）
  └─ src-react/domains/security/              ← 新前端域
       api/security.api.ts                    ← SecurityApi 静态类
       components/SecurityCenter.tsx          ← 首页卡片流 + Dialog 内视图栈
       components/SandboxCard.tsx             ← 沙箱安全卡片
       components/DataSafetyCard.tsx          ← 数据安全卡片
       components/AuditCenter.tsx             ← 审计中心卡片 + 全量列表视图
       model/types.ts                         ← 前后端共享类型

electron/domains/security/                    ← 新后端域
  security.service.ts                         ← 配置读写 + 内存缓存 + normalize
  audit/audit-log.service.ts                  ← 审计写入/查询/导出/清空
  audit/hash-chain.ts                         ← 哈希链纯函数
  defaults.ts                                 ← 内置清单常量 + 默认值

数据落点：
  option 表（type="security"）                ← 全部开关/名单/阈值
  securityAuditLog 表（v9 新建）              ← 审计日志
```

- 前后端类型共享沿用项目惯例：后端 `import type` 引用 `src-react/domains/security/model/types.ts`（参照 `provider.repo.ts` 做法）。
- 注册：`electron/Application.ts` `registerServices()` 实例化 `SecurityService` 与 `AuditLogService`。
- 前端数据加载照 app-settings 惯例：`useEffect` + `Promise.all` + 本地 `useState` + `useSaveOrRevert`（`src-react/domains/app-settings/model/use-save-or-revert.ts`）乐观保存 + sonner toast。不引入 React Query。

## 5. 数据模型

### 5.1 option 配置项（type = `"security"`）

| key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `sandboxEnabled` | bool | `true` | 沙箱总开关（已拍板默认开，与 WorkBuddy 一致） |
| `fileAllowlist` | JSON string[] | `[]` | 文件白名单（用户自定义，自动放行） |
| `fileBlocklist` | JSON string[] | `[]` | 文件黑名单（用户自定义，强制审批） |
| `cmdAllow` | JSON CmdRule[] | `[]` | 命令放行名单 |
| `cmdAsk` | JSON CmdRule[] | `[]` | 命令询问名单 |
| `programBlacklist` | JSON string[] | `["rm"]` | 程序禁止名单（SP2 复核扩充） |
| `domainAllow` | JSON string[] | `[]` | 允许域名 |
| `domainDeny` | JSON string[] | `[]` | 拒绝域名 |
| `blockAllNetwork` | bool | `false` | 阻断所有网络 |
| `maliciousDomainProtection` | bool | `true` | 拦截恶意网站 |
| `fileBackupEnabled` | bool | `true` | 自动备份 |
| `fileBackupMaxSizeMB` | number | `3000` | 备份配额（钳制 ≥1000） |
| `deleteProtection` | bool | `true` | 删除保护（⚠️ 与 WorkBuddy 的 false 不同：天枢作为正式功能且 `shell.trashItem()` 零成本） |
| `bulkDeleteThreshold` | number | `50` | 批量删除阈值（钳制 1–99999，非法回落 50） |

`CmdRule = { prefix: string[]; reason?: string }`（prefix 为命令 token 数组，如 `["git","push"]`）。

**read-time fallback，不播种数据**：option 行不存在或损坏时由服务层返回默认值。升级零数据迁移，未来调整默认值不碰存量数据。v9 迁移只建审计表。

### 5.2 内置清单（代码常量，永不落盘）

`DEFAULT_FILE_BLOCKLIST`（照抄 WorkBuddy 清单 A，17 条，PRD 同源）：

```
~/.ssh/  ~/.aws/  ~/.gnupg/  ~/.gpg/  ~/.kube/config
~/.docker/config.json  ~/.docker/daemon.json
~/.netrc  ~/.npmrc  ~/.pypirc  ~/.gem/credentials
~/.config/gh/hosts.yml  ~/.git-credentials  ~/.config/gcloud/
~/.azure/  ~/.terraform.d/credentials.tfrc.json  ~/Library/Keychains/（仅 mac）
```

- 按平台过滤（Windows 剔除 `~/Library/Keychains/` 等 macOS 专属项；路径匹配语义在 SP3 定义）
- 三层防删机制（照 WorkBuddy）：
  1. `getConfig` 返回 `{ defaults, config }` 分离，内置项不与用户数据混合
  2. 前端合并展示（内置在前、"内置"标签替代删除按钮），保存时自动剔除内置项再落盘
  3. 执行层兜底硬编码（SP2/SP3 落实，含把天枢自身数据目录列入默认保护——参照 WorkBuddy denyWrite 自身 settings.json）

命令/域名的内置清单留待 SP2/SP5 定义。

### 5.3 securityAuditLog 表与 v9 迁移

```sql
CREATE TABLE security_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence INTEGER NOT NULL UNIQUE,
  category TEXT NOT NULL,
  eventType TEXT NOT NULL,
  decision TEXT NOT NULL,
  detail TEXT,
  commandPreview TEXT,
  commandHash TEXT,
  sessionId INTEGER,
  prevHash TEXT,
  hash TEXT NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_createdAt ON security_audit_log (createdAt);
CREATE INDEX idx_audit_category ON security_audit_log (category);
```

- 迁移目录 `electron/infrastructure/script/v9/upgrade-table.sql`（无 data 脚本）
- `electron/Constants.ts` `DATABASE_VERSION` 8 → 9
- `prisma/schema.prisma` 同步新增 model，`npx prisma generate`

字段语义：

- `category`：`command-safety | file-safety | network | data-safety | config`
- `decision`：`approved | rejected | blocked | allowed | failed | info`
- `eventType`：点分命名，如 `command-safety.blocked`、`config.sandboxEnabled.updated`、`audit.cleared`
- `detail`：结构化 JSON 字符串（如 `{"command":"rm -rf /","remembered":false}`），渲染时经 i18n messageKey 插值，落库不存本地化文本
- `commandPreview`：命令截断预览；`commandHash`：sha256（仅命令类事件）
- `hash`：`sha256(stableStringify(entry 除 hash 外全部字段，key 排序))`

## 6. 后端服务

### 6.1 SecurityService（security.service.ts）

**内存缓存 + 写时失效**：

```
启动：registerServices() 时全量读 option(type="security") → 内存 config
读取：getConfig() → 纯内存读（执行层 SP2-SP6 消费，零 DB 开销）
写入：setConfig(key, value) → normalize 校验 → 剔除内置项 → upsert option
      → 更新内存缓存 → audit(config.<key>.updated)
```

- upsert 照 `option-store.ts` 的 `setAppOption` 模式（updateMany 命中 0 行则 create）
- `getConfig()` 返回 `SecurityConfigState = { defaults: { fileBlocklist: string[] }, config: SecurityConfig }`

**normalize 校验族**（纯函数，export 供单测）：

- `normalizeFileBackupMaxSizeMB(v)`：`max(1000, Math.round(v))`
- `normalizeBulkDeleteThreshold(v)`：整数且 1–99999，否则回落 50
- `pickCommandRuleArray(v)`：CmdRule[] 校验（prefix 非空字符串数组，空 token 剔除，reason 可选）
- `pickStringArray(v)`：string[] 校验
- bool 类复用现有 `parseBoolOption`

### 6.2 AuditLogService（audit/audit-log.service.ts）

**写入（异步缓冲，不阻塞执行链）**：

```
audit(category, eventType, decision, opts)   ← 同步签名，内部入队
  → 内存队列（≥50 条 或 500ms 定时 → flush）
  → flush：逐条编 sequence/hash 批量落库 → 超 5000 条裁剪最旧 → 更新链 state
  → app 退出钩子（will-quit）兜底 flush
```

- `opts`：`{ detail?, commandPreview?, commandHash?, sessionId? }`
- 链 state `{sequence, lastHash}` 常驻内存，启动时 `SELECT … ORDER BY sequence DESC LIMIT 1` 恢复；恢复失败（表空/损坏）→ 链从头开始 + winston error，不阻塞
- 裁剪（>5000 条）只写 winston 日志，不进链（避免自我循环）
- `clear()`：deleteMany 全清 → 立即 append 一条 `audit.cleared`（decision=info）留痕（成为新链头）
- flush 落库异常：队列保留、下轮重试 + winston error

**查询**：`list({ page, pageSize?, keyword? })` → `createdAt DESC, id DESC` 倒序分页；pageSize 默认 100、上限 500；keyword 匹配 detail/commandPreview（LIKE），截断 200 字符。

**导出**：`export(format: "json" | "csv")` → `dialog.showSaveDialog`（默认名 `security-audit-log-YYYYMMDD.json/.csv`）→ 分页循环流式写 → `shell.showItemInFolder`；用户取消 → 静默。JSON 形状 `{"entries":[…原字段]}`；CSV 列：id, sequence, category, eventType, decision, detail, commandPreview, commandHash, sessionId, prevHash, hash, createdAt。

### 6.3 hash-chain（audit/hash-chain.ts）

纯函数：

- `stableStringify(entry)`：key 排序、去 undefined 的规范化 JSON
- `computeHash(prevHash, entry)`：`sha256(stableStringify(entry 除 hash 外))`
- `verify(entries)`：按 sequence 顺序校验链完整性
- 使用 `node:crypto`，不引入依赖

### 6.4 共享类型（src-react/domains/security/model/types.ts）

```ts
export type CmdRule = { prefix: string[]; reason?: string };
export type SecurityConfigKey = keyof SecurityConfig;
export type SecurityConfig = {
  sandboxEnabled: boolean; fileAllowlist: string[]; fileBlocklist: string[];
  cmdAllow: CmdRule[]; cmdAsk: CmdRule[]; programBlacklist: string[];
  domainAllow: string[]; domainDeny: string[];
  blockAllNetwork: boolean; maliciousDomainProtection: boolean;
  fileBackupEnabled: boolean; fileBackupMaxSizeMB: number;
  deleteProtection: boolean; bulkDeleteThreshold: number;
};
export type SecurityConfigState = {
  defaults: { fileBlocklist: string[] };
  config: SecurityConfig;
};
export type AuditCategory = "command-safety" | "file-safety" | "network" | "data-safety" | "config";
export type AuditDecision = "approved" | "rejected" | "blocked" | "allowed" | "failed" | "info";
export type AuditEntry = {
  id: number; sequence: number; category: AuditCategory; eventType: string;
  decision: AuditDecision; detail: string | null; commandPreview: string | null;
  commandHash: string | null; sessionId: number | null;
  prevHash: string | null; hash: string; createdAt: string;
};
export type AuditListResult = { entries: AuditEntry[]; total: number; page: number; pageSize: number };
```

## 7. IPC 通道

三处登记：`ipcMain.handle` + `src-react/lib/ipc.ts` 的 `IPCChannel` 联合类型 + `src-react/domains/security/api/security.api.ts`。

| channel | 签名 | 说明 |
|---|---|---|
| `security:getConfig` | `() => SecurityConfigState` | 读配置（含 defaults 分离） |
| `security:setConfig` | `(key: SecurityConfigKey, value) => SecurityConfig` | 单 key 整组替换，返回更新后 config |
| `security:auditList` | `(params) => AuditListResult` | 分页查询 |
| `security:auditExport` | `(format: "json"\|"csv") => { ok: boolean; filePath?: string }` | 导出 |
| `security:auditClear` | `() => void` | 清空 |

## 8. 事件源接入（现有代码三处，各加 audit 调用）

| 接入点 | 事件 |
|---|---|
| `electron/domains/ai/agent/command-tool.ts` `isDangerousCommand` 命中 | `command-safety.blocked` / blocked / commandPreview+commandHash |
| `electron/domains/ai/chat/chat.service.ts` 审批决议处 | decision=approved/rejected；category 按工具名映射：`run_command`→command-safety，文件写工具→file-safety，兜底 file-safety；detail 记 `{remembered}`（"允许并记住"时 true） |
| `command-tool.ts` `resolveCwd` 越界回退 | `command-safety.cwd-fallback` / info |

sessionId 可空传入。SP2–SP6 再接入各执行层完整判定事件，`audit()` 接口一次定义好。

## 9. 前端

### 9.1 入口

`SettingsDialog.tsx`：`SettingsTab` 联合类型加 `"security"`；`NAV_ITEMS` 加项（lucide `Shield` 图标）；右栏渲染 `<SecurityCenter />`；i18n key `settings:nav.security`。

### 9.2 首页 = 三张卡片（垂直流，复用 SettingsGroup / SettingSwitchRow）

1. **沙箱安全**（SandboxCard）：总开关（`sandboxEnabled`）+ 说明文案；三个入口行（文件安全/命令安全/网络安全）SP1 阶段 disabled + 「即将上线」badge。二级页在 Dialog 内用视图栈切换（`useState` 子视图，参照 WorkBuddy FileDetail 模式，不新开路由）——SP1 只实现视图栈骨架与占位。
2. **数据安全**（DataSafetyCard，SP1 全部可用，纯持久化，SP4 接执行层）：
   - 自动备份 Toggle + 配额展示（"备份总上限 3000 MB"）+「打开备份目录」按钮（`shell.openPath`，约定路径 `app.getPath("userData")/file-history`，不存在则先 mkdir 再打开；SP4 落实目录结构）
   - 删除保护 Toggle
   - 批量删除阈值数字输入（失焦保存，校验失败 toast 并还原）
3. **审计中心**（AuditCenter）：
   - 卡片内最近 8 条：类型 badge（`[命令安全]` 等）+ 动作文案（eventType→messageKey，t() 插值）+ 时间戳（`yyyy/M/d HH:mm:ss`）
   - 「查看全部」→ 视图栈切换到全量分页视图（keyword 搜索 + 分页 100/页）
   - 「导出日志」JSON/CSV 二选一；「清空记录」AlertDialog 确认
   - 面板打开期间 30s 轮询 + 手动刷新按钮（不做 IPC 推送）

4. 内置运行时/系统授权卡片 SP1 不渲染（SP6 加）——避免假开关。

### 9.3 交互细节（PRD 附录）

保存成功/失败、重置成功等用 sonner toast 轻量反馈。

## 10. i18n

- 新建 `src-react/i18n/locales/{zh-CN,en-US}/security.json`，`src-react/i18n/index.ts` 登记 `security` namespace
- key 结构（camelCase 嵌套）：
  - `security:title`、`security:sandbox.*`（总开关、入口名）、`security:dataSafety.*`、`security:audit.*`（标题、操作、messageKey 族 `security:audit.commandSafety.blocked` 等）
- 审计动作文案 messageKey 模式：落库存结构化 JSON，渲染时 `eventType` → `t("security:audit.<…>", detail)` 插值，切语言历史日志正确显示
- 禁止 JSX 硬编码文案；遵循项目 i18n 全部规范（双语言同步添加、无顶层 key 与嵌套 key 重名）

## 11. 错误处理

| 场景 | 处理 |
|---|---|
| option JSON 损坏 | read-time 回退默认 + winston error + audit `failed`，不阻塞 |
| setConfig 校验失败 | IPC 抛错 → 前端 toast 具体原因（如"阈值需为 1–99999 的整数"） |
| 审计 flush DB 异常 | 队列保留、下轮重试 + winston error |
| 导出取消保存框 | 静默；写文件失败 → toast |
| 打开备份目录失败 | toast 提示路径 |

## 12. 测试策略

- **纯函数单测**（Vitest，`tests/security/`，照 `tests/ai/` 模式）：
  - normalize 族：钳制/回落/非法输入
  - hash-chain：顺序生成、verify、断链恢复、stableStringify 稳定性（key 顺序无关）
  - 内置项 merge/strip 逻辑
  - 审计 list 参数规范化（pageSize 上限、keyword 截断——实现在纯函数 normalizeAuditListParams）
- **服务层单测**：SecurityService 读写/缓存失效/损坏回退；AuditLogService 缓冲 flush/裁剪/清空留痕（照项目现有测试基建处理 Prisma 依赖，参照 `tests/ai/approval.test.ts` 做法）
- **UI 手工验收**：项目惯例，交付时附验收文档

## 13. SP1 明确不做

三个二级页内容与名单 CRUD UI、执行层安全规则消费（除第 8 节三处事件源）、备份/回收站/批量删除真实执行、内置运行时与系统授权卡片、toolPermission 管理 UI、审计 IPC 推送——分别属 SP2–SP6。

## 14. 对 WorkBuddy 的参照与差异

| 项 | WorkBuddy | 天枢 SP1 | 理由 |
|---|---|---|---|
| 配置载体 | `~/.workbuddy/settings.json`（JSON 文件，CLI 子进程独立读） | option 表（SQLite） | 天枢规则消费方全在主进程，走项目 Prisma 惯例 |
| 沙箱总开关默认 | true（`app-config.json` `sandboxSafetyEnabled`） | true | 一致 |
| 删除保护默认 | false（实验特性） | **true** | 天枢做正式功能，`shell.trashItem()` 零成本 |
| 内置规则 | 代码常量不落盘 + 三层防删 | 相同 | 相同 |
| 审计载体 | JSONL 哈希链分段文件（CLI spool 汇入） | SQLite 表 + 轻量哈希链 | 单写者主进程，表天然支持分页查询 |
| 审计上限 | 90 天/500MB 滚动 + 5000 条返回上限 | 5000 条滚动裁剪 | 简化，必要时后续加时间维度 |
| 备份语义 | 单文件 <100MB、会话目录、内容寻址、LRU | SP1 只约定目录路径，执行 SP4 | 边界清晰 |
