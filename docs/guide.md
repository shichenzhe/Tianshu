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

AI 是可选模块，不需要时删除以下三处即可：

1. `electron/domains/ai/`（ai.service + model-config.repo）
2. `electron/Application.ts` 中 `registerServices()` 的 AI 接线块（modelConfigRepo/AIService 两行）
3. `src-react/domains/ai/`、路由 `ai` 项、Sidebar `AI 模型配置` 项、`i18n/index.ts` 的 ai namespace、`prisma/schema.prisma` 的 modelConfig model 与 v1 SQL 中对应建表段
