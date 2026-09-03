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

## 移除 AI 模块

AI 是可选模块，分两个子域：`provider/`（服务商与模型管理）和 `chat/`（对话、会话、助手预设）。
支持两种裁剪粒度：整体移除，或只保留 provider 层。每步做完建议跑 `npm run typecheck`
和 `npm run test` 验证无残留引用。

### 完整移除

1. 删除 `electron/domains/ai/` 与 `src-react/domains/ai/` 两个目录。
2. `electron/Application.ts`：删除 `registerServices()` 中的 AI 接线块（`ProviderRepository`/
   `ModelRepository`/`AssistantRepository`/`SessionRepository`/`ChatService` 五行及注释）与对应 import。
3. `src-react/routes/index.tsx`：删除 `ai`、`ai/providers`、`ai/assistants` 三条路由及对应的
   lazy import。
4. `src-react/components/layout/Sidebar.tsx`：删除 `AI 模型配置` 项（`layout:sidebar.ai`）。
5. i18n：删除 `src-react/i18n/locales/{zh-CN,en-US}/ai.json` 与 `chat.json`，并移除
   `src-react/i18n/index.ts` 中的注册（import、`resources`、`ns` 数组）。
6. `src-react/lib/ipc.ts`：删除 `IPCChannel` 联合类型中的 `// AI 模块（可选）` 段。
7. `prisma/schema.prisma`：删除 7 个 model——`provider`、`model`、`assistant`、`workspace`、
   `session`、`message`、`mcpServer`，然后执行 `npx prisma generate` 重新生成客户端。
8. `electron/infrastructure/script/v1/upgrade-table.sql`：删除从「新建服务商表（AI 模块）」到
   文件末尾的建表段。只影响新数据库；老库里多出的表不读写、不影响运行。
9. 删除 `tests/ai/`（8 个测试文件全部属于 AI 模块，`scripts/` 下的脚手架测试不受影响）。

### 裁剪到仅 provider 层

保留服务商/模型管理与连通性测试，去掉对话能力：

1. 删除 `electron/domains/ai/chat/`、`src-react/domains/ai/chat/`、`src-react/domains/ai/assistant/`
   三个目录，以及 `src-react/domains/ai/api/` 下的 `chat.api.ts`、`session.api.ts`、
   `workspace.api.ts`、`assistant.api.ts`（保留 `provider.api.ts`、`model.api.ts`）。
2. `provider/connectivity.ts` 引用了 `chat/error-classify.ts` 的 `classifyError`：把该文件移到
   `provider/` 下并同步修改 import（其单测 `tests/ai/error-classify.test.ts` 的路径一并改），
   或暂时保留原位置。
3. `electron/Application.ts`：AI 接线块只保留 `ProviderRepository`/`ModelRepository` 两行。
4. `src-react/routes/index.tsx`：删除 `ai`（ChatView）与 `ai/assistants` 两条路由；
   `src-react/components/layout/Sidebar.tsx` 的 AI 项改指 `/module/ai/providers`。
5. i18n：移除 `chat` namespace（`chat.json` 与 `index.ts` 注册）；`ai.json` 的 `assistant.*`
   键随之不再使用，可一并删除。
6. 同步删除 `tests/ai/` 下的 `chat.service`、`blocks`、`param-merge`、`history-truncate`、
   `stream-buffer`、`error-classify`（未按第 2 步移动时）测试，保留 `connectivity` 与
   `provider-factory`。
7. 数据库（可选）：`assistant`、`workspace`、`session`、`message` 与预留的 `mcpServer` 表不再被
   读写，可连同 schema model 与 v1 脚本对应段一并删除（记得 `npx prisma generate`）；保留不影响运行。
