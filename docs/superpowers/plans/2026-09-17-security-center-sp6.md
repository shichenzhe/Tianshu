# 安全中心 SP6 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内置运行时工具开关（注入层过滤）+ 系统授权卡片（full 会话/工具记忆管理）+ SP5 移交（fetch cause 解包、本地代理加固）+ 安全中心收官验收清单。

**Architecture:** disabledTools 配置走 SP1 既有 option 表 read-time fallback 链路；过滤在两个工具注入单点（chat `collectToolDefinitions` / automation `collectTools`）应用纯函数 `filterDisabledTools`；系统授权 IPC 就近注册在 ChatService（PermissionStore 属主）；cause 解包共享函数落 electron/commons。

**Tech Stack:** Electron 44 主进程、Prisma、React 19 + shadcn/ui、react-i18next（zh-CN/en-US）、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-17-security-center-sp6-design.md`（下称 spec；本计划从 spec 立论，执行者两份都读）

## Global Constraints

- **行为兼容硬约束**：`ChatService` 新参数与 `AutomationRunner` 注入新参全部可选、缺席时行为与现状逐字节一致；`disabledTools` 默认 `[]` 全启用；`permission:*` 既有 IPC（get/set/rememberTool）签名零改动
- 生产代码零 `console`（winston `Log` 允许）；i18n zh-CN/en-US 同步逐 key；主题色只用 primary 变量族；JSX 零硬编码文案
- Prettier v3（双引号、tabWidth 2、printWidth 80、尾逗号 all）；文件名 kebab-case；函数 ≤20 行软约束；重复 2 次以上抽函数
- eventType→i18n key 全点换下划线（`permission.full-revoked`→`permission_full_revoked`）
- 完成标准统一为三绿：`npm run test` 全过、`npm run typecheck` 零错误、`npm run lint` 零问题

---

### Task 1: disabledTools 配置基座 + filterDisabledTools

**Files:**
- Modify: `src-react/domains/security/model/types.ts`
- Modify: `electron/domains/security/defaults.ts`
- Modify: `electron/domains/security/config-store.ts`
- Modify: `electron/domains/security/security.service.ts:81-89`
- Modify: `electron/domains/ai/agent/tool-registry.ts`
- Test: `tests/security/disabled-tools.test.ts`（新建）
- Test: `tests/security/config-store.test.ts`、`tests/security/security-service.test.ts`（追加）

**Interfaces:**
- Produces（后续任务依赖）：`SecurityConfig.disabledTools: string[]`；`BUILTIN_TOOLS`（13 项注册表）；`pickDisabledTools(v: unknown): string[]`；`filterDisabledTools(defs, disabled)`；`SecurityConfigState.defaults.builtinTools`

- [ ] **Step 1: 写失败测试** `tests/security/disabled-tools.test.ts`：

```ts
/** SP6 内置运行时开关：配置白名单清洗 + 注入过滤纯函数（spec §3） */
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, SECURITY_DEFAULTS } from "@/../electron/domains/security/defaults";
import { pickDisabledTools } from "@/../electron/domains/security/config-store";
import { filterDisabledTools } from "@/../electron/domains/ai/agent/tool-registry";
import type { SecurityConfig } from "@/../src-react/domains/security/model/types";

const BUILTIN_NAMES = BUILTIN_TOOLS.map((t) => t.name);

describe("BUILTIN_TOOLS 注册表（spec §3.1）", () => {
  it("13 个内置工具、四组齐全、名字唯一", () => {
    expect(BUILTIN_NAMES).toHaveLength(13);
    expect(new Set(BUILTIN_NAMES).size).toBe(13);
    for (const group of ["file", "command", "skill", "plan"] as const) {
      expect(BUILTIN_TOOLS.some((t) => t.group === group)).toBe(true);
    }
  });
});

describe("pickDisabledTools（白名单清洗）", () => {
  it("只收已知名，去重保注册表序", () => {
    expect(
      pickDisabledTools(["run_command", "nope", "delete_file", "run_command"]),
    ).toEqual(["run_command", "delete_file"]);
  });
  it("非数组/含 mcp__ 前缀一律回落空或剔除", () => {
    expect(pickDisabledTools(undefined)).toEqual([]);
    expect(pickDisabledTools("run_command")).toEqual([]);
    expect(pickDisabledTools(["mcp__x__y"])).toEqual([]);
  });
});

describe("filterDisabledTools（注入过滤）", () => {
  const defs = [
    { name: "read_file" },
    { name: "read_skill" },
    { name: "mcp__srv__tool" },
  ];
  it("禁用名剔除；mcp__ 不在白名单天然不受影响", () => {
    expect(filterDisabledTools(defs, ["read_file"])).toEqual([
      { name: "read_skill" },
      { name: "mcp__srv__tool" },
    ]);
  });
  it("空禁用集原样返回", () => {
    expect(filterDisabledTools(defs, [])).toEqual(defs);
  });
});

describe("defaults 演进（SP6）", () => {
  it("SECURITY_DEFAULTS.disabledTools 为空数组（全启用零行为变化）", () => {
    const config = SECURITY_DEFAULTS as SecurityConfig;
    expect(config.disabledTools).toEqual([]);
  });
});
```

（import 路径照 `tests/security/config-store.test.ts` 现有相对/别名写法对齐——先看该文件头部两行再定，语义断言不变。）

- [ ] **Step 2: 跑测试确认失败**（BUILTIN_TOOLS/pickDisabledTools/filterDisabledTools 未定义）

- [ ] **Step 3: 实现**

`types.ts`——`SecurityConfig` 末尾（`bulkDeleteThreshold` 之后）加：

```ts
  disabledTools: string[];
```

`defaults.ts`——`SECURITY_DEFAULTS` 加 `disabledTools: []`；文件追加：

```ts
/** 内置工具注册表（SP6 spec §3.1）：运行时开关的展示与白名单双源 */
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

/** disabledTools 白名单（BUILTIN_TOOLS 名单序） */
export const BUILTIN_TOOL_NAMES: readonly string[] = BUILTIN_TOOLS.map(
  (t) => t.name,
);
```

`config-store.ts`——`pickDomainArray` 后追加，并接线两处：

```ts
/** 禁用工具清洗（SP6）：只收内置已知名，去重保注册表序；防配置漂移 */
export function pickDisabledTools(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const name of pickStringArray(v)) {
    if (BUILTIN_TOOL_NAMES.includes(name)) seen.add(name);
  }
  return [...seen];
}
```

`FIELD_PARSERS` 加一行：`disabledTools: (raw) => pickDisabledTools(parseJsonArray(raw ?? "[]")),`；`copySecurityConfig` 返回对象加 `disabledTools: [...config.disabledTools],`。

`security.service.ts` `getConfig()`——`defaults` 加 `builtinTools: BUILTIN_TOOLS,`（import 自 defaults）；`SecurityConfigState.defaults` 类型（types.ts）加 `builtinTools: typeof BUILTIN_TOOLS`——用结构类型字面量避免 types.ts 反向 import electron：

```ts
export type BuiltinToolMeta = {
  name: string;
  group: "file" | "command" | "skill" | "plan";
  kind: "read" | "write";
};
export type SecurityConfigState = {
  defaults: {
    fileBlocklist: string[];
    maliciousDomains: string[];
    builtinTools: BuiltinToolMeta[];
  };
  config: SecurityConfig;
};
```

`tool-registry.ts` 追加导出：

```ts
/** 注入层过滤（SP6 裁定 1）：禁用=对模型不存在；只作用于内置工具名 */
export function filterDisabledTools<T extends { name: string }>(
  defs: T[],
  disabled: Iterable<string>,
): T[] {
  const disabledSet = new Set(disabled);
  return defs.filter((def) => !disabledSet.has(def.name));
}
```

- [ ] **Step 4: 追加配置测试**——`config-store.test.ts` 补 `parseSecurityConfig` 含 `disabledTools` 缺行回落 `[]`、脏名剔除两条；`security-service.test.ts` 补「getConfig defaults 含 builtinTools 13 项」与「setConfig disabledTools 归一化落库（未知名剔除）」两条（照该文件 SP5 追加先例的 stub db 模式）。

- [ ] **Step 5: 三绿 + commit**：`feat(安全中心): 内置运行时开关配置基座——disabledTools 白名单清洗 + BUILTIN_TOOLS 注册表 + filterDisabledTools`

### Task 2: 注入接入（chat 流 + automation）

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`（构造 + `collectToolDefinitions`:1530-1553）
- Modify: `electron/domains/ai/automation/automation-runner.ts`（`collectTools`:58-69 与调用点 :270）
- Modify: `electron/Application.ts`（ChatService 第 7 参装配）
- Test: `tests/ai/automation-runner.test.ts`、`tests/security/disabled-tools.test.ts`（追加）

**Interfaces:**
- Consumes: `filterDisabledTools`、`SecurityConfig.disabledTools`
- Produces: `ChatService` 构造可选参数 `runtimeFilter?: () => string[]`（缺席 → `() => []` 行为不变）；automation `collectTools` 第三参 `disabled?: () => string[]`

- [ ] **Step 1: 写失败测试**——`tests/security/disabled-tools.test.ts` 追加 automation 集成块（`collectTools` 是模块级导出，直测）：

```ts
describe("automation collectTools 注入过滤（SP6 裁定 2）", () => {
  it("禁用 run_command 后工具集不含之；缺省参数行为不变", async () => {
    const tools = await collectTools("/tmp/ws", [], () => ["run_command"]);
    expect(tools.some((t) => t.name === "run_command")).toBe(false);
    const untouched = await collectTools("/tmp/ws", []);
    expect(untouched.some((t) => t.name === "run_command")).toBe(true);
  });
});
```

（若 `collectTools` 当前未导出：导出之——纯函数导出非行为变更。chat 侧 private 方法不直测，其过滤逻辑与 automation 同构一行，由 Task 6 验收清单端到端覆盖，测试注释写明此裁定。）

- [ ] **Step 2: 确认失败**（collectTools 未导出/无第三参）

- [ ] **Step 3: 实现**

`automation-runner.ts`：

```ts
export async function collectTools(
  workspacePath: string | undefined,
  skills: SkillInfo[],
  disabled: () => string[] = () => [],
) {
  // ……现有两层过滤不动……
  return filterDisabledTools(
    [makeReadSkillTool(skills), ...injected],
    disabled(),
  );
}
```

调用点 `:270` 所在函数把 `disabled` 透传（该函数的入参链上加可选 `disabled?: () => string[]`，缺省 `() => []`；找到该函数的装配调用点——若在 automation.service / Application，注入 `() => securityService.getConfigValue().disabledTools`）。

`chat.service.ts`——构造第 7 参（`dataSafety` 之后）：

```ts
    // 运行时工具过滤（SP6）：注入层禁用=对模型不存在；缺席（测试）不滤
    private runtimeFilter?: () => string[],
```

`collectToolDefinitions` 尾部 return 改：

```ts
    return filterDisabledTools(
      [makeReadSkillTool(skills), ...injected],
      this.runtimeFilter?.() ?? [],
    );
```

（import `filterDisabledTools` from `"../agent/tool-registry"`——文件已 import `registry`，同一模块。）

`Application.ts`——`new ChatService(...)` 调用末尾加第 7 参：

```ts
      () => securityService.getConfigValue().disabledTools,
```

- [ ] **Step 4: 三绿 + 全量回归确认零破坏 + commit**：`feat(安全中心): 工具禁用注入接入——chat/automation 双注入点过滤，闭包实时读配置`

### Task 3: 系统授权 IPC 层 + PermissionStore.listFull + 审计

**Files:**
- Modify: `electron/domains/ai/agent/permission-mode.ts`
- Modify: `electron/domains/ai/chat/chat.service.ts`（`permission:rememberTool` handler :1047 之后追加 5 个 handler）
- Test: `tests/security/disabled-tools.test.ts`（PermissionStore 部分独立 describe，或新文件 `tests/security/permission-store.test.ts`——按文件主题独立原则用后者）、`tests/ai/chat.service.test.ts`（追加 IPC 块，照既有 mock prisma/ipcMain 模式）

**Interfaces:**
- Produces（Task 4 前端消费）：
  - `permission:listFullGrants` → `{ sessionId: number; title: string }[]`
  - `permission:revokeAllFull` → `void`
  - `permission:listRemembered` → `{ id: number; workspaceName: string; toolName: string; createdAt: string }[]`
  - `permission:revokeRemembered(id: number)` → `void`
  - `permission:revokeAllRemembered()` → `void`

- [ ] **Step 1: 写失败测试** `tests/security/permission-store.test.ts`：

```ts
/** PermissionStore.listFull（SP6 系统授权卡数据源，spec §4.1） */
import { describe, expect, it } from "vitest";
import { PermissionStore } from "@/../electron/domains/ai/agent/permission-mode";

describe("PermissionStore.listFull", () => {
  it("只列 full 会话；set 回 default 后不再列出", () => {
    const store = new PermissionStore();
    store.set(1, "full");
    store.set(2, "default");
    store.set(3, "full");
    expect(store.listFull()).toEqual([1, 3]);
    store.set(1, "default");
    expect(store.listFull()).toEqual([3]);
  });
});
```

`tests/ai/chat.service.test.ts` 追加（照该文件既有 ipcMain/prisma mock 手法）：
- `listFullGrants`：store 置 full 的会话 join session 标题；标题查询失败行回落 `会话 #id`
- `revokeAllFull`：full 清空 + auditSink 收到 `permission.full-revoked`（detail.count）；无 full 时 auditSink 不被调
- `listRemembered`：toolPermission findMany + workspace 名 join，join 失败回落 `#<id>`
- `revokeRemembered`：delete 单行 + auditSink `permission.remembered-revoked`（detail.tool/workspace）
- `revokeAllRemembered`：deleteMany + auditSink `permission.remembered-revoked-all`（detail.count）

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**

`permission-mode.ts` 加方法：

```ts
  /** 当前 full 的会话 id 列表（SP6 系统授权卡；插入序） */
  listFull(): number[] {
    return [...this.modes.entries()]
      .filter(([, mode]) => mode === "full")
      .map(([sessionId]) => sessionId);
  }
```

`chat.service.ts`——`permission:rememberTool` handler 后追加（分段小函数 ≤20 行，auditSink 缺席静默）：

```ts
    // SP6 系统授权卡：full 会话总览与收回（spec §4.1）
    ipcMain.handle("permission:listFullGrants", async () => {
      const ids = this.permissions.listFull();
      return Promise.all(
        ids.map(async (sessionId) => ({
          sessionId,
          title: await this.sessionTitleOf(sessionId),
        })),
      );
    });
    ipcMain.handle("permission:revokeAllFull", () => {
      const ids = this.permissions.listFull();
      for (const id of ids) this.permissions.set(id, "default");
      if (ids.length > 0) {
        this.auditSink?.({
          eventType: "permission.full-revoked",
          decision: "info",
          detail: { count: ids.length },
        });
      }
    });
    // SP6 工具记忆管理（spec §4.2）：撤销后该工具回到逐次审批流
    ipcMain.handle("permission:listRemembered", async () => {
      const rows = await prisma.toolPermission.findMany({
        orderBy: { createdAt: "desc" },
      });
      return Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          workspaceName: (await this.workspaceNameOf(row.workspaceId)) ?? `#${row.workspaceId}`,
          toolName: row.toolName,
          createdAt: row.createdAt.toISOString(),
        })),
      );
    });
    ipcMain.handle("permission:revokeRemembered", async (_, id: number) => {
      const row = await prisma.toolPermission.findUnique({ where: { id } });
      if (!row) return; // 幂等 no-op（spec §8）
      await prisma.toolPermission.delete({ where: { id } });
      const workspaceName =
        (await this.workspaceNameOf(row.workspaceId)) ?? `#${row.workspaceId}`;
      this.auditSink?.({
        eventType: "permission.remembered-revoked",
        decision: "info",
        detail: { tool: row.toolName, workspace: workspaceName },
      });
    });
    ipcMain.handle("permission:revokeAllRemembered", async () => {
      const result = await prisma.toolPermission.deleteMany({});
      if (result.count > 0) {
        this.auditSink?.({
          eventType: "permission.remembered-revoked-all",
          decision: "info",
          detail: { count: result.count },
        });
      }
    });
```

辅助方法（标题查 sessionRepo、workspace 名查既有 repo——先看 chat.service 现有 session/workspace 取数 helper（`sessions.getWorkspace` :1471 附近有先例），有则复用没有则加两个 ≤10 行私有方法，查询失败返回 null 走回落文案）。

- [ ] **Step 4: 三绿 + commit**：`feat(安全中心): 系统授权 IPC——full 会话列表/一键收回 + 工具记忆查看/撤销（permission.* 审计三事件）`

### Task 4: 前端——SystemGrantCard + RuntimeDetailView + 入口 + i18n

**Files:**
- Create: `src-react/domains/security/components/SystemGrantCard.tsx`
- Create: `src-react/domains/security/components/RuntimeDetailView.tsx`
- Modify: `src-react/domains/security/components/SandboxCard.tsx`、`SecurityCenter.tsx`
- Modify: `src-react/domains/security/api/security.api.ts`
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/security.json`
- Test: `tests/security/security-components.test.tsx`、`tests/security/audit-event-message.test.ts`

**Interfaces:**
- Consumes: Task 3 五个 IPC、Task 1 `defaults.builtinTools`、`config.disabledTools`、既有 `setConfig` 链路

- [ ] **Step 1: 写失败测试**——`security-components.test.tsx` 追加（照 SP5 该文件 NetworkDetailView 测试模式：mock `@/lib/ipc` 的 invoke）：
  - SystemGrantCard：两区块渲染、full 列表行 + 空态、收回按钮触发 `permission:revokeAllFull` invoke + toast、工具记忆行撤销触发 `permission:revokeRemembered`
  - RuntimeDetailView：四组渲染 13 开关、组名/工具说明来自 i18n、toggle 触发 setConfig invoke（`disabledTools` 数组增删工具名）
  - SandboxCard 第四入口行「运行时工具」存在且可点（onOpenRuntime 回调）

`audit-event-message.test.ts` known 列表 +3：`"permission.full-revoked"`、`"permission.remembered-revoked"`、`"permission.remembered-revoked-all"`。

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**

`security.api.ts` 加（静态类方法，照既有命名）：

```ts
  static listFullGrants(): Promise<
    Array<{ sessionId: number; title: string }>
  > {
    return invoke("permission:listFullGrants");
  }
  static revokeAllFull(): Promise<void> {
    return invoke("permission:revokeAllFull");
  }
  static listRemembered(): Promise<
    Array<{
      id: number;
      workspaceName: string;
      toolName: string;
      createdAt: string;
    }>
  > {
    return invoke("permission:listRemembered");
  }
  static revokeRemembered(id: number): Promise<void> {
    return invoke("permission:revokeRemembered", id);
  }
  static revokeAllRemembered(): Promise<void> {
    return invoke("permission:revokeAllRemembered");
  }
```

`SystemGrantCard.tsx`——骨架照 `DataSafetyCard`/`SandboxCard` 惯例（SettingsGroup 容器 + useEffect 加载 + 本地 useState + sonner toast + AlertDialog 确认 destructive 按钮；两区块各一个列表 + 空态 `text-muted-foreground` + 操作行）。关键语义：
- full 区块行：`{title}` + Badge「完全访问」（`security:systemGrant.fullBadge`）+ 撤销全部按钮（列表空时 disabled）
- 记忆区块行：`{workspaceName}` + 等宽 `{toolName}` + 相对时间（照 AuditCenter 时间格式惯例）+ 行内撤销（ghost 按钮）
- 撤销后本地列表即时更新 + toast `security:systemGrant.revoked`

`RuntimeDetailView.tsx`——骨架照 `NetworkDetailView`（标题 + 返回 + 说明行 + 分组）。数据：`defaults.builtinTools` 按 group 分四组；每组 SettingSwitchRow 样式行：工具名（`font-mono text-xs`）+ kind Badge（读/写）+ 工具说明 + Switch。Switch 状态 = `!config.disabledTools.includes(name)`，toggle 调 `onToggle("disabledTools", nextArray)`（增删工具名，保持 BUILTIN_TOOLS 序——`BUILTIN_TOOL_NAMES` 语义在前端用 `defaults.builtinTools.map(t=>t.name)` 即可）。

`SandboxCard.tsx`——ENTRIES 加第四项（icon `Wrench`，labelKey `security:sandbox.runtime`，descKey `security:sandbox.runtimeDesc`，view 联合类型加 `"runtime"`）+ props `onOpenRuntime` + openers 映射。`SecurityCenter.tsx`——`SecurityView` 联合加 `"runtime"`、渲染分支照 network 块、`onOpenRuntime` 传入；首页卡片流在 DataSafetyCard 后挂 `<SystemGrantCard />`（自取数组件）。

i18n——`security.json` 双语同步追加（嵌套块，注意与既有顶层 key 无重名）：

- `sandbox.runtime`：「运行时工具」/ "Runtime tools"；`sandbox.runtimeDesc`：「控制 AI 可用的内置工具」/ "Control built-in tools available to AI"
- `runtimeDetail` 块：`title`（运行时工具/Runtime tools）、`note`（关闭的工具对本机所有 AI 会话与自动化隐藏，即刻生效/Closed tools are hidden from all AI sessions and automations on this machine, effective immediately）、`groupFile`（文件/File）、`groupCommand`（命令/Command）、`groupSkill`（技能/Skill）、`groupPlan`（计划/Plan）、`kindRead`（读/Read）、`kindWrite`（写/Write）、`tools.{read_file,list_dir,search_files,write_file,delete_file,run_command,read_skill,create_skill,plan_create_item,plan_update_status,plan_append_summary,plan_list_items,plan_get_item}` 13 条一句话说明（如 `read_file`：「读取工作区内文件」/ "Read files in the workspace"；`run_command`：「执行 shell 命令」/ "Execute shell commands"；`delete_file`：「删除文件或目录（受数据安全保护）」/ "Delete files or directories (protected by data safety)"——其余按工具语义逐条写全，双语成对）
- `systemGrant` 块：`title`（系统授权/System grants）、`desc`（管理 AI 当前被授予的权限/Manage permissions currently granted to AI）、`fullTitle`（活跃完全访问/Active full access）、`fullDesc`（以下会话已跳过文件写入与命令审批/The following sessions skip file-write and command approvals）、`fullBadge`（完全访问/Full access）、`revokeAllFull`（一键收回全部/Revoke all）、`revokeAllFullConfirm`（收回后这些会话回到逐次审批。继续？/These sessions will return to per-action approval. Continue?）、`rememberedTitle`（工作空间工具记忆/Workspace tool memories）、`rememberedDesc`（「允许并记住」产生的免审记录，撤销后回到逐次审批/Memory entries created by "Allow and remember"; revoking returns to per-action approval）、`emptyFull`（当前没有完全访问会话/No full-access sessions）、`emptyRemembered`（暂无工具记忆/No tool memories）、`revoke`（撤销/Revoke）、`revokeAll`（全部撤销/Revoke all）、`revokeAllConfirm`（将撤销全部工具记忆，继续？/This revokes all tool memories. Continue?）、`revoked`（已撤销/Revoked）
- `audit.events.permission_full_revoked`（「收回全部完全访问（{{count}} 个会话）」/ "Revoked all full access ({{count}} sessions)"）、`permission_remembered_revoked`（「撤销工具记忆：{{tool}}（{{workspace}}）」/ "Revoked tool memory: {{tool}} ({{workspace}})"）、`permission_remembered_revoked_all`（「撤销全部工具记忆（{{count}} 条）」/ "Revoked all tool memories ({{count}})"）

- [ ] **Step 4: 三绿 + 程序化 i18n 比对**（zh/en 键集一致、插值变量一致——照 SP5 Task 6 的比对手法自查一次）+ commit：`feat(安全中心): 系统授权卡片 + 运行时工具二级页——full 会话/工具记忆管理 UI 与双语词条`

### Task 5: SP5 移交——cause 解包回喂 + 本地代理加固

**Files:**
- Create: `electron/commons/error-message-with-cause.ts`
- Modify: `electron/domains/ai/agent/mcp-manager.ts:352-354`
- Modify: `electron/domains/ai/skill/skillhub-client.ts:143-152`（catch 尾段）
- Modify: `electron/domains/security/local-proxy.ts`（`stop()` 与 `handlePlainRequest`）
- Test: `tests/security/error-message-with-cause.test.ts`（新建）、`tests/security/network-gate.test.ts`（追加真实 fetch 断言）、`tests/ai/mcp-manager.test.ts`（追加回喂断言）、`tests/security/local-proxy.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

`tests/security/error-message-with-cause.test.ts`：

```ts
/** SP5 移交：undici 策略拒绝文案在 error.cause（spec §6.1） */
import { describe, expect, it } from "vitest";
import { errorMessageWithCause } from "@/../electron/commons/error-message-with-cause";

describe("errorMessageWithCause", () => {
  it("cause 链逐层拼接（策略文案可见）", () => {
    const err = new Error("fetch failed", {
      cause: new Error("网络安全策略已拒绝 evil.com（规则：deny）"),
    });
    expect(errorMessageWithCause(err)).toContain("fetch failed");
    expect(errorMessageWithCause(err)).toContain("网络安全策略已拒绝 evil.com");
  });
  it("无 cause 仅顶层；非 Error 输入 String 化", () => {
    expect(errorMessageWithCause(new Error("boom"))).toBe("boom");
    expect(errorMessageWithCause("plain")).toBe("plain");
  });
});
```

`network-gate.test.ts` 追加（复用既有 install + 真实 fetch 基建）：deny 域 `fetch("https://blocked-by-policy.test/")` → catch 的 err 经 `errorMessageWithCause` 断言含 host 与规则（SP5 终审 ① 的闭环探针，任务移交强制项）。

`mcp-manager.test.ts` 追加：callTool 网络异常（mock client 抛 `new Error("fetch failed", {cause: new Error("网络安全策略已拒绝 x（规则：deny）")})`）→ 返回文案含「MCP 服务不可用」与「网络安全策略已拒绝」两段。

`local-proxy.test.ts` 追加两条：
- FIN 断流：目标 server 回包后 `socket.end()` 平滑关闭（非 destroy）→ 经代理的明文请求客户端连接被终结（res close/destroyed 断言，不悬挂——带超时保护）
- stop 清 idle：建一条 CONNECT 隧道保持 idle → `stop()` 在默认 close 超时内完成（closeAllConnections 生效）

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**

`electron/commons/error-message-with-cause.ts`：

```ts
/**
 * 顶层 message + cause 链拼接（SP5 移交，spec §6.1）：undici 策略拒绝的
 * 文案在 error.cause.message（顶层只见 "fetch failed"），解包后调用方
 * 回喂/上抛才能让策略文案对模型与用户可见（SP5 裁定 5 闭环）
 */
export function errorMessageWithCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cause: unknown = err.cause;
  const seen = new Set<unknown>([err]);
  while (cause instanceof Error && !seen.has(cause)) {
    parts.push(cause.message);
    seen.add(cause);
    cause = cause.cause;
  }
  return parts.join("：");
}
```

`mcp-manager.ts:353` 改：

```ts
    } catch (e) {
      return `错误: MCP 服务不可用（${row.name}）：${errorMessageWithCause(e)}`;
    }
```

`skillhub-client.ts` catch 尾段（`lastError = e instanceof Error ? e : new Error(String(e));`）改：

```ts
        lastError =
          e instanceof Error
            ? new Error(errorMessageWithCause(e))
            : new Error(String(e));
```

（IPC handler 直接透传 promise，前端 `mapIpcError` 零改动——spec §6.1 裁定。）

`local-proxy.ts`——`stop()` 的 `await new Promise` 前加 `server.closeAllConnections();`；`handlePlainRequest` 的 `upRes.pipe(res)` 前加：

```ts
        // FIN 断流（对端平滑关闭）不触发 upstream error——主动终结客户端
        upRes.on("aborted", () => res.destroy());
```

- [ ] **Step 4: 三绿 + commit**：`fix(安全中心): SP5 移交收口——MCP/技能市场错误解包 cause 回喂策略文案 + 本地代理 stop 清隧道与 FIN 断流防护`

### Task 6: 手工验收清单 + 全量三绿

**Files:**
- Create: `docs/superpowers/acceptance/2026-09-17-security-center-sp6.md`

- [ ] **Step 1: 跑全量三绿取证**（数字以实际为准：`npm run test`/`typecheck`/`lint`）
- [ ] **Step 2: 产出验收清单**——样式照 `docs/superpowers/acceptance/2026-09-17-security-center-sp5.md`（头注块：适用分支/commit 链/三绿数字与归因账/对照文档/前置）。8 组走查：
  1. 首页四卡结构与系统授权卡空态
  2. 运行时工具二级页：四组 13 开关 + 分组与说明文案
  3. 工具禁用端到端：禁 `run_command` → 对话内模型工具列表无此工具（让其列工具或执行命令观察）→ 自动化任务同样不可用 → 重启开关恢复
  4. full 会话管理：对话切完全访问 → 卡片列表出现 → 一键收回 → 胶囊回默认 + 审计 `permission.full-revoked`
  5. 工具记忆管理：「允许并记住」产生记忆 → 卡片列表出现 → 撤销后同工具再次执行回到审批弹窗 + 审计
  6. SP5 发现项闭环：拒绝名单加 MCP http 域 → 对话调用该 MCP 工具 → 回喂文案含「网络安全策略已拒绝 host（规则：deny）」（强制走查项）
  7. 技能市场 deny：拒绝名单加 `api.skillhub.cn` → 技能市场页错误提示含策略文案
  8. 回归：SP2–SP5 四清单关键项抽查（命令 ask、文件黑名单、删除保护、断网 403）+ 全部开关旁路（sandboxEnabled=false）
  - 附录：已知边界（OS 沙箱不做、MCP 动态工具不在开关面、full 收回不中断进行中审批、permission.* 审计落 config category）
- [ ] **Step 3: commit**：`docs(安全中心): SP6 手工验收清单`
- [ ] **Step 4: 返回四行**（状态/commit/三绿数字/concerns）
