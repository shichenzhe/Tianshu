# 安全中心 SP6：系统授权 + 内置运行时开关 + 收尾 — 设计文档

## 1. 背景与范围

SP1–SP5 已交付配置基座、命令/文件/数据/网络四个执行层与二级页。SP6 是安全中心最后一子项目（SP1 §2 拆解表），四块内容：

1. **内置运行时开关**：13 个内置工具（文件五件 + `run_command` + 技能两件 + plan 五件）逐工具启用/禁用，禁用=注入层过滤（模型不可见）
2. **系统授权卡片**：AI 已被授予权限的总览与管理——活跃完全访问（full）会话列表与一键收回 + 工作空间工具记忆（toolPermission 表，"允许并记住"的产物）查看/撤销（即 SP1 拆解表的「toolPermission 管理 UI」）
3. **SP5 移交项**（SP5 终审裁定必办/建议）：
   - **fetch 拒绝回喂文案解包 cause**——策略文案在 `error.cause.message`，MCP 工具回喂与技能市场错误当前只见顶层文案
   - **本地代理加固**——`stop()` 清 idle 隧道（closeAllConnections）+ 明文转发 FIN 断流悬置
4. **收尾**：安全中心首页四卡齐整 + SP6 手工验收清单（SP2–SP5 四份清单一并提示人工执行）

**不做**（边界）：
- OS 级沙箱（Seatbelt/bubblewrap/@anthropic-ai/sandbox-runtime）——新二进制依赖 + 跨平台矩阵风险，收尾子项目不引入大件；SP5 spec §1 已文档化为路线图候选，绕过面防护现状（env 注入代理 + 程序名单 + 审批）不变
- 审计 IPC 推送——30s 轮询先例（SP1 §9.2）维持
- mcp__* 动态工具的禁用——工具开关只管内置 13 个（MCP 准入已有连接器白名单与 http 入口预判两道门）
- PermissionStore 持久化——full 模式保持进程内存态（P3 语义：随会话生命周期），SP6 只做总览与收回

## 2. 关键裁定

| # | 裁定 | 依据 |
|---|---|---|
| 1 | 禁用工具 = **注入层过滤（模型不可见）**，非调用拦截回喂 | 仓内双先例同构：MCP 连接器白名单硬隔离（chat.service.ts:1542 注入过滤）、技能禁用"对模型=不存在"（collectEnabledSkills）；模型看不到被禁工具就不会浪费轮次重试；工具集变化与 allowedMcpServers 过滤发生在同一单点 |
| 2 | 过滤函数放 tool-registry 导出纯函数，chat 流与 automation 两个注入点共用 | DRY；automation:62 与 chat.service:1536 都调 `registry.getDefinitions()` |
| 3 | `disabledTools` 只收已知内置工具名（normalize 白名单过滤），mcp__ 前缀一律不收 | 防配置漂移（历史名/拼错名静默无效）；MCP 准入不属本开关（裁定 1 边界） |
| 4 | 系统授权卡 = full 会话总览 + toolPermission 管理，不新增 AuditCategory；`permission.*` 事件落缺省 `config` category | 最小扰动收尾；权限管理语义上属配置域；categoryOf 缺省路径零 schema 变更 |
| 5 | toolPermission 管理 IPC 就近注册在 chat.service（PermissionStore 属主 + rememberTool 写点同文件） | 同族 `permission:*` IPC 已在此注册（chat.service.ts:1039）；避免跨域新建服务 |
| 6 | cause 解包用共享 `errorMessageWithCause(err)`（electron commons），主进程两消费点（mcp-manager callTool 回喂、skillhub-client 上抛）；前端经 IPC 透传文案不自行解包 | SP5 裁定 5（模型看到被拒对象才能自我修正）在 MCP/技能市场面的落地；解包逻辑单点 |
| 7 | proxy 加固：`stop()` 先 `closeAllConnections()` 再 close；明文转发 `upRes.on("aborted")` 销毁客户端 | SP5 终审 ③（idle 隧道）与 fix 实现者 FIN 断流观察；Node 18.2+ API，Electron 44/Node 22 可用 |
| 8 | 内置运行时开关默认全启用（`disabledTools: []`） | 现状行为零变化；族语义与 SP2–SP5 默认态一致 |

## 3. 内置运行时开关（disabledTools）

### 3.1 配置与常量

- `SecurityConfig` 加 `disabledTools: string[]`（types.ts，前后端共享）
- `defaults.ts` 加内置工具注册表（展示与 normalize 白名单共用）：

```ts
export const BUILTIN_TOOLS: ReadonlyArray<{
  name: string;
  group: "file" | "command" | "skill" | "plan";
  kind: "read" | "write";
}> = [
  { name: "read_file", group: "file", kind: "read" },
  { name: "list_dir", group: "file", kind: "read" },
  { name: "search_files", group: "file", kind: "read" },
  { name: "write_file", group: "file", kind: "write" },
  { name: "delete_file", group: "file", kind: "write" },
  { name: "run_command", group: "command", kind: "write" },
  { name: "read_skill", group: "skill", kind: "read" },
  { name: "create_skill", group: "skill", kind: "write" },
  { name: "plan_create_item", group: "plan", kind: "write" },
  { name: "plan_update_status", group: "plan", kind: "write" },
  { name: "plan_append_summary", group: "plan", kind: "write" },
  { name: "plan_list_items", group: "plan", kind: "read" },
  { name: "plan_get_item", group: "plan", kind: "read" },
];
```

- `config-store.ts` 加 `pickDisabledTools(v): string[]`——数组元素只收 BUILTIN_TOOLS 内已知名，去重（次序保持注册表序）；非数组回落 `[]`
- defaults 快照 `SecurityConfigState.defaults` 加 `builtinTools: BUILTIN_TOOLS`（只读常量下发，照 maliciousDomains 先例）

### 3.2 过滤函数（tool-registry.ts）

```ts
/** 注入层过滤：禁用=对模型不存在（SP6 裁定 1）；只作用于内置工具名 */
export function filterDisabledTools<T extends { name: string }>(
  defs: T[],
  disabled: Iterable<string>,
): T[];
```

### 3.3 注入接入（两点）

- `chat.service.ts` `collectToolDefinitions` 尾部：`filterDisabledTools([makeReadSkillTool(skills), ...injected], disabledTools())`——`disabledTools` 闭包照 `deleteProtection` 注入先例（构造可选注入，缺省 `() => []` 测试兼容）；read_skill 一并受滤
- `automation-runner.ts` 注入点（:62 附近）同样应用
- 闭包实时读配置——改动即刻生效（下一轮注入即新工具集），与 SP4 dataSafety 同款无需重启
- setConfig 既有审计 `config.disabledTools.updated` 自动覆盖

## 4. 系统授权卡片（SystemGrantCard）

首页第四卡（DataSafetyCard 之后），两区块：

### 4.1 活跃完全访问会话

- `PermissionStore` 加 `listFull(): number[]`（纯内存遍历，可单测）
- IPC（chat.service 注册，返回 join session 标题）：

```
permission:listFullGrants → { sessionId: number; title: string }[]
permission:revokeAllFull  → void（全部 set 回 default；无 full 时 no-op）
```

- UI：列表（会话标题 + 「完全访问」badge）+ 空态文案 +「一键收回全部」按钮（AlertDialog 确认）
- 收回审计：`permission.full-revoked` / decision=info / detail `{ count }`（count=0 时 UI 按钮禁用不触发）

### 4.2 工作空间工具记忆（toolPermission 管理 UI）

- IPC（chat.service 注册）：

```
permission:listRemembered → { id, workspaceName, toolName, createdAt }[]
permission:revokeRemembered(id)   → void（删单行；不存在时 no-op 成功）
permission:revokeAllRemembered() → void（deleteMany 全表）
```

- UI：列表（工作空间名 + 工具名 + 时间）+ 空态 + 单行撤销 +「全部撤销」（AlertDialog 确认）
- 撤销审计：`permission.remembered-revoked` / info / detail `{ tool, workspace }`（全部撤销时 detail `{ count }`，eventType 同 key 或 `permission.remembered-revoked-all`——**裁定用后者**，文案区分）
- 说明文案点明语义：撤销后该工具回到逐次审批流

### 4.3 卡片头部

说明行：管理 AI 当前被授予的权限（会话级完全访问 / 工作空间级工具免审）。

## 5. 内置运行时二级页（RuntimeDetailView）

- SandboxCard 第四入口行「运行时工具」（view 栈 `"runtime"`），与文件/命令/网络三行同款
- 页面：标题 + 返回 + 说明（"关闭的工具对本机所有 AI 会话隐藏（含自动化），注入层生效即刻生效"）+ 按 group 分四组（文件/命令/技能/计划）的开关行（组名小标题 + 每工具一行：工具名（等宽字体）+ kind badge（读/写）+ 开关 + 工具一句话说明）
- 开关写 `disabledTools` 数组（toggle 单工具名；保存走既有 setConfig 链路，审计自动）
- kind badge 与组名文案进 i18n；工具说明文案每工具一条（13 条 ×2 语言）

## 6. SP5 移交项

### 6.1 fetch 拒绝回喂文案解包（终审判定必办）

- 新共享函数 `electron/commons/error-message-with-cause.ts`：

```ts
/** 顶层 message + cause 链拼接（SP5 移交：undici 拒绝的策略文案在 cause） */
export function errorMessageWithCause(err: unknown): string;
```

- **mcp-manager.ts callTool catch**：现统一文案 `"错误: MCP 服务不可用（name）"` → 后附 `errorMessageWithCause(err)` 的 cause 段（策略拒绝时模型可见"网络安全策略已拒绝 host（规则：rule）"，SP5 裁定 5 闭环）
- **skillhub-client.ts** catch 重试穷尽上抛处：错误对象 message 换 `errorMessageWithCause(err)`；IPC handler 既有错误透传到前端，技能市场页错误 toast 直接展示返回文案（前端兜底文案改为透传优先）
- 测试：network-gate 真实 fetch 基建复用——deny 域 fetch → `errorMessageWithCause` 断言含 host 与规则；mcp-manager 单测断言回喂文案含策略段

### 6.2 本地代理加固

- `LocalConnectProxy.stop()`：close 前调 `server.closeAllConnections()`（idle 存活隧道即时终结，SP5 终审 ③）
- `handlePlainRequest`：`upRes.on("aborted", () => res.destroy())`（FIN 断流——普通 destroy 不触发 upstream error 事件，客户端当前悬置）
- 测试：FIN 断流场景（目标 server 回包后 `socket.end()` 平滑关闭）→ 客户端连接终结；stop 后无残留连接句柄（server.closed 断言）

## 7. 审计与 i18n

| eventType | decision | detail | 触发点 |
|---|---|---|---|
| `permission.full-revoked` | info | count | 收回全部 full 会话 |
| `permission.remembered-revoked` | info | tool, workspace | 撤销单条工具记忆 |
| `permission.remembered-revoked-all` | info | count | 全部撤销 |

- category 走 `categoryOf` 缺省 → `config`（裁定 4，零 schema 变更）
- i18n（security.json 双语同步）：`security:systemGrant.*`（卡片两区块、空态、按钮、确认弹窗）、`security:runtimeDetail.*`（页面、四组名、13 工具说明、kind badge）、`security:audit.events.permission_full-revoked` / `permission_remembered-revoked` / `permission_remembered-revoked-all`
- eventType→messageKey 映射只把点替换为下划线、连字符保留（AuditCenter.tsx `replace(/\./g, "_")`；先例 `command-safety_cwd-fallback`），故 `permission.full-revoked` → `permission_full-revoked`
- 守卫测试 known 列表 +3

## 8. 错误处理

| 场景 | 处理 |
|---|---|
| listFullGrants 的 session 标题查询失败 | 该行 title 回落 `"会话 #id"`，不整表失败 |
| revokeRemembered id 不存在 | no-op 成功（幂等），不审计 |
| revokeAllFull 无 full 会话 | no-op，不审计（UI 按钮本就禁用） |
| listRemembered join workspace 失败/行删除 | workspaceName 回落 `"#workspaceId"` |
| disabledTools 落库含未知名（历史脏数据） | pickDisabledTools 白名单过滤，读取时静默剔除（SP1 normalize 族惯例） |
| errorMessageWithCause 输入非 Error/无 cause | 返回 String(err) / 仅顶层 message |

## 9. 测试策略

- **纯函数**：pickDisabledTools（白名单/去重/次序/非法回落）；filterDisabledTools（含 read_skill/mcp__ 不受滤语义边界——mcp__ 名不在白名单天然不受影响）；errorMessageWithCause（cause 链/非 Error/无 cause）；PermissionStore.listFull
- **配置**：config-store defaults 演进（disabledTools 含 [] + builtinTools 下发）；security-service setConfig disabledTools 归一化落库
- **注入集成**：collectToolDefinitions 过滤（照 dataSafety 注入先例 mock 构造注入）——禁用 run_command 后 getDefinitions 结果不含之；automation-runner 注入同断言
- **IPC**：listFullGrants（store 置 full + session 标题 join mock）/ revokeAllFull（store 清空 + 审计断言）/ listRemembered + revoke 单条与全部（mock prisma toolPermission）
- **cause 解包**：network-gate.test 复用真实 fetch 基建——install gate + deny 域 fetch → errorMessageWithCause(err) 含"网络安全策略已拒绝"与 host；mcp-manager 回喂文案断言
- **proxy 加固**：local-proxy.test FIN 断流 → 客户端终结；stop 清 idle 连接
- **守卫**：audit-event-message known +3
- **手工验收清单**：Task 末产出（四卡结构/工具开关端到端（禁 run_command → 对话内模型无此工具/自动化同样）/full 收回端到端/工具记忆撤销后回到审批/拒绝域 MCP 调用回喂含策略文案（SP5 发现项闭环验证）/技能市场 deny 错误展示/回归）

## 10. 与 Claude Code / WorkBuddy 的对照

| 维度 | Claude Code | WorkBuddy | 天枢 SP6 |
|---|---|---|---|
| 工具禁用 | `--disallowedTools`/settings permissions（工具集移除） | — | disabledTools 注入层过滤（同构：对模型=不存在） |
| 权限总览 | `/permissions` 查看规则 | — | 系统授权卡（full 会话 + 工具记忆） |
| 记忆审批管理 | settings.json permissions 手编 | — | toolPermission UI 撤销（一键/逐条） |
| 拒绝回喂 | `<sandbox_violations>` 点名 | — | MCP/技能市场 cause 解包（SP5 裁定 5 收口） |
| OS 沙箱 | Seatbelt/bubblewrap | NetworkExtension+CLI 沙箱 | 不做（路线图候选，边界 §1） |
