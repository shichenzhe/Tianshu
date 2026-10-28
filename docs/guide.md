# 如何添加业务域

以模板自带的 **user 域**为参照，新增一个业务域共七步。假设新域叫 `note`（一张表、一个列表页）。

## 第 1 步：建表（Prisma + 版本化迁移）

1. `prisma/schema.prisma` 追加 model：

```prisma
model note {
  id      Int      @id @default(autoincrement())
  content String
  createdAt DateTime @default(now())
}
```

2. 当前 `DATABASE_VERSION` 为 1，新建 `electron/infrastructure/script/v2/`：

```sql
-- upgrade-table.sql
--/p 新建笔记表
CREATE TABLE IF NOT EXISTS note (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

3. `electron/Constants.ts` 的 `DATABASE_VERSION` 改为 `2`。
4. 执行 `npx prisma generate`（重新生成含 note 的客户端）。

启动时 Application 会自动逐版本执行未跑过的 `script/vN`。脚本语法：`--/p 描述`、
`--/ignore`（失败忽略）、以 `;` 结尾逐句执行。

## 第 2 步：后端 entity

`electron/domains/note/note.entity.ts`——纯类型定义（前后端共享的接口都放这）。

## 第 3 步：后端 repo（IPC 自注册）

`electron/domains/note/note.repo.ts`：

```ts
import { ipcMain } from "electron";
import prisma from "../../commons/prisma-client";

export default class NoteRepository {
  constructor() {
    this.registerHandlers();
  }

  private registerHandlers() {
    ipcMain.handle("note:list", () => this.list());
    ipcMain.handle("note:create", async (_, content: string) => {
      return prisma.note.create({ data: { content } });
    });
  }

  private async list() {
    return prisma.note.findMany({ orderBy: { createdAt: "desc" } });
  }
}
```

## 第 4 步：主进程接线

`electron/Application.ts` 的 `registerServices()` 中追加 `new NoteRepository();`。

## 第 5 步：前端 api + view

- `src-react/domains/note/api/note.api.ts`：封装 `invoke("note:list")` 等
- `src-react/domains/note/views/NoteListView.tsx`：页面组件
- `src-react/lib/ipc.ts` 的 `IPCChannel` 联合类型追加 `"note:list" | "note:create"`

## 第 6 步：路由 + 侧边栏

- `src-react/routes/index.tsx`：lazy import + `/module` children 加 `{ path: "note", element: ... }`
- `src-react/components/layout/Sidebar.tsx`：navItems 加一项（icon + label + path）

## 第 7 步：i18n（zh-CN 与 en-US 同步加）

- 新建 `src-react/i18n/locales/{zh-CN,en-US}/note.json`
- `src-react/i18n/index.ts` 注册 namespace
- 组件中 `const { t } = useTranslation(["note"])` 使用

完成。前后端各目录一一对应，删域 = 反向删除这七步产物。

## AI 模块 P1 能力（Agent 模式）

P1 在对话之上叠加了受限的文件工具能力（`electron/domains/ai/agent/` 子域），要点：

- **进入条件**：会话绑定工作空间目录后，AI 自动获得 4 个文件工具——`read_file`/`write_file`/
  `list_dir`/`search_files`，路径全部限定在该目录内；未绑定即为纯对话，行为与 P0 一致。
- **审批机制**：读类工具免审直接执行；写类默认每次审批，消息流内出现内联按钮（允许 / 拒绝；
  P1 时期的跨会话「允许并记住」授权已被 P3 的两级权限取代，见下文 P3 段）。拒绝不终止循环，
  会作为结果回喂给模型自行调整。
- **数据库 v2**：`DATABASE_VERSION` 升为 2，`electron/infrastructure/script/v2/upgrade-table.sql`
  给 `workspace` 表补 `writeApprovedAt` 列（写入授权的时间戳）；旧库首次启动自动升级，脚本带
  `--/ignore` 幂等，无感。

## AI 模块 P2 能力（MCP 与技能）

P2 在 Agent 模式之上叠加外部工具生态：MCP 服务接入（`agent/mcp-manager.ts` + `mcp/mcp.repo.ts`）
与 SKILL.md 技能加载（`agent/` 下 skill-loader / read-skill / skill-prompt），要点：

- **MCP 服务**：设置页 `/module/ai/mcp` 管理（入口在服务商设置页顶部导航）。传输支持 stdio
  （command/args/env）与 streamable HTTP（url + headers，可配 Bearer 认证）；应用启动时自动
  连接全部启用项（失败标记 error 状态，不阻塞启动），页面提供连接状态徽标与启停/重连。
  服务的工具以 `mcp__服务名__工具名` 进入模型可用集；标注 readOnlyHint 的只读工具免审直接
  执行，其余每次审批——**完全访问不豁免 MCP 审批**（权限放开仅限文件与终端工具）。
- **技能（skills）**：用户级放 `<userData>/skills/<名称>/SKILL.md`（frontmatter 需 name 与
  description 两字段），始终加载；工作空间级放 `<工作空间目录>/.tianshu/skills/`，会话绑定
  目录后加载，同名时用户级优先。全部技能的清单（name+description）注入 system prompt，
  模型按需调用内置工具 `read_skill` 读取正文（超过 256KB 截断）。无管理界面——文件系统即
  配置，放目录即生效（每次发消息时扫描，免重启增删）。
- **依赖**：新增运行时依赖 `@modelcontextprotocol/sdk`（官方 MCP SDK），移除 AI 模块时随
  package.json 的 dependencies 一并删除。

## AI 模块 P3 能力（输入框与权限）

P3 重构输入区交互并引入两级权限、终端工具与会话模式（`agent/permission-mode.ts` +
`agent/command-tool.ts`，渲染层新增 PlusMenu / PermissionCapsule / FullAccessModal 组件；
原输入行的 AssistantPicker 已移除，并入「＋→专家」子菜单），要点：

- **输入框卡片化**：输入区整体为一张圆角卡片——左上「＋」按钮唤起扩展菜单（添加文件 / 模式 /
  专家 / 技能 / 连接器五项），旁边是权限胶囊，右下为模型选择器与发送按钮。**@ 文件引用**：
  「＋→添加文件」经系统对话框多选文本文件（≤512KB）后以 chips 暂存在卡片上，发送时文件内容
  以 `[引用文件 <路径>]` 文本块注入消息；二进制/超限文件 toast 提示并丢弃，不阻塞发送。
- **两级权限**：胶囊默认为「默认权限」——文件写与终端命令在沙箱约束内执行、超出范围逐次审批；
  切换「完全访问」须经过全屏 Modal 风险确认（权限清单 + 免责勾选必选）——之后文件操作与终端
  命令直接执行，文件路径与命令工作目录不再限定于工作空间内（MCP 审批不豁免）。完全访问是
  **会话级内存态、不持久**：重启应用或新开会话自动回默认，会话中随时可关、立即生效。该模型
  取代 P1 的工作空间写授权：`workspace:approveWrite`/`revokeWrite` 通道与「允许并记住」按钮
  已移除（`workspace.writeApprovedAt` 列保留不读，历史兼容）。相关 IPC：`permission:get`/
  `permission:set`（会话权限读写）、`file:pickAndRead`（选文件读内容）。
- **终端工具 `run_command`**：默认权限下执行前逐次审批、工作目录强制为工作空间根；完全访问下
  直接执行、可用任意 cwd。**高危命令硬拦截常开**（与权限级别无关）：`rm -rf` 根目录、`mkfs`、
  `dd of=/dev/*`、fork 炸弹、`chmod -R 777 /` 等破坏性命令直接拒绝不执行。命令 60s 超时，
  stdout+stderr 合并截断 8KB 后回喂。
- **会话模式**：「＋→模式」三选一，会话级持久（`session.mode` 列，重启保留）——默认 Agent
  （全能力）/ 仅问答 ASK（纯对话：不注入任何工具与技能清单）/ 计划 PLAN（system 注入计划
  指令，模型先输出完整计划、经确认前不调用工具）。IPC：`session:setMode`。
- **数据库 v3**：`DATABASE_VERSION` 升为 3，`electron/infrastructure/script/v3/upgrade-table.sql`
  给 `session` 表补 `mode` 列（幂等）；旧库首次启动自动升级，无感。

## 移除 AI 模块

AI 是可选模块，分四个子域：`provider/`（服务商与模型管理）、`chat/`（对话、会话、助手预设）、
`agent/`（P1 工具调用循环与文件工具，P2 又加入 MCP 连接管理与技能加载，仅被 chat 消费）和
`mcp/`（P2 MCP 服务 CRUD 与状态 IPC，联动 `agent/mcp-manager`）。
支持两种裁剪粒度：整体移除，或只保留 provider 层。每步做完建议跑 `npm run typecheck`
和 `npm run test` 验证无残留引用。
注意：本分支把 AI 建表并入 v1 脚本（只对全新库执行），已有开发数据库不会自动补建，
升级后请删除旧库文件（开发环境为仓库下 `database/local.db`）重启应用重新生成。

### 完整移除

1. 删除 `electron/domains/ai/` 与 `src-react/domains/ai/` 两个目录。
2. `electron/Application.ts`：删除 `registerServices()` 中的 AI 接线块（`ProviderRepository`/
   `ModelRepository`/`AssistantRepository`/`SessionRepository`/`ChatService` 五行，及 P2 的
   `McpManager`/`McpRepository` 接线块与 `startupConnectAll()` 调用，均含注释）与对应 import。
3. `src-react/routes/index.tsx`：删除 `ai`、`ai/providers`、`ai/assistants`、`ai/mcp` 四条路由
   及对应的 lazy import。
4. `src-react/components/layout/Sidebar.tsx`：删除 `AI 模型配置` 项（`layout:sidebar.ai`）。
5. i18n：删除 `src-react/i18n/locales/{zh-CN,en-US}/ai.json` 与 `chat.json`，并移除
   `src-react/i18n/index.ts` 中的注册（import、`resources`、`ns` 数组）。
6. `src-react/lib/ipc.ts`：删除 `IPCChannel` 联合类型中的 `// AI 模块（可选）` 段。
7. `prisma/schema.prisma`：删除 7 个 model——`provider`、`model`、`assistant`、`workspace`、
   `session`、`message`、`mcpServer`，然后执行 `npx prisma generate` 重新生成客户端。
8. `electron/infrastructure/script/v1/upgrade-table.sql`：删除从「新建服务商表（AI 模块）」到
   文件末尾的建表段。只影响新数据库；老库里多出的表不读写、不影响运行。同时删除
   `electron/infrastructure/script/v2/`（P1 工作空间授权列）与 `v3/`（P3 会话模式列）两个
   目录，并把 `electron/Constants.ts` 的 `DATABASE_VERSION` 回到 `1`。
9. 删除 `tests/ai/`（22 个测试文件全部属于 AI 模块，`scripts/` 下的脚手架测试不受影响）。
10. `package.json`：删除 dependencies 中的 `@modelcontextprotocol/sdk`（P2 MCP SDK，唯一新增
    运行时依赖），重新 `npm install`。

### 裁剪到仅 provider 层

保留服务商/模型管理与连通性测试，去掉对话能力：

1. 删除 `electron/domains/ai/chat/`、`electron/domains/ai/agent/`、`electron/domains/ai/mcp/`、
   `src-react/domains/ai/chat/`、`src-react/domains/ai/assistant/`、`src-react/domains/ai/mcp/`
   六个目录，以及 `src-react/domains/ai/api/` 下的 `chat.api.ts`、`session.api.ts`、
   `workspace.api.ts`、`assistant.api.ts`、`mcp.api.ts`（保留 `provider.api.ts`、`model.api.ts`）。
   `@modelcontextprotocol/sdk` 仅被 `agent/mcp-manager.ts` 引用，此处删除后即无使用方，可顺手
   从 package.json dependencies 移除。
2. `provider/connectivity.ts` 引用了 `chat/error-classify.ts` 的 `classifyError`：把该文件移到
   `provider/` 下并同步修改 import（其单测 `tests/ai/error-classify.test.ts` 的路径一并改），
   或暂时保留原位置。
3. `electron/Application.ts`：AI 接线块只保留 `ProviderRepository`/`ModelRepository` 两行
   （P2 的 `McpManager`/`McpRepository` 块与 `startupConnectAll()` 调用一并删除）。
4. `src-react/routes/index.tsx`：删除 `ai`（ChatView）、`ai/assistants`、`ai/mcp` 三条路由；
   `src-react/components/layout/Sidebar.tsx` 的 AI 项改指 `/module/ai/providers`。
5. i18n：移除 `chat` namespace（`chat.json` 与 `index.ts` 注册）；`ai.json` 的 `assistant.*`
   与 `mcp.*` 键随之不再使用，可一并删除。
6. 同步删除 `tests/ai/` 下的 `chat.service`、`blocks`、`param-merge`、`history-truncate`、
   `stream-buffer`、`error-classify`（未按第 2 步移动时）、`agent-loop`、`approval`、
   `file-tools`、`workspace-path-chip`、`command-tool`、`permission-mode`、
   `permissions-integration`、`mcp-manager`、`mcp-integration`、`skill-loader`、
   `read-skill`、`skill-prompt` 测试，保留 `connectivity`、`provider-factory`、
   `v2-migration` 与 `v3-migration`。
7. 数据库（可选）：`assistant`、`workspace`、`session`、`message` 与 `mcpServer` 表不再被
   读写，可连同 schema model 与 v1 脚本对应段一并删除（记得 `npx prisma generate`）；保留不影响运行。
