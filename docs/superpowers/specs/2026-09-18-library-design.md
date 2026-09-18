# 资料库（我的资料）— 设计文档

## 1. 背景与范围

资料库（`/module/ai/library`）现状为纯占位页：`LibraryView.tsx`（搜索框 + 「最近」「本地产物」chip + 「我的资料」「团队空间」分组，全部 comingSoon toast），前后端零数据层。

参照 WorkBuddy v5.5.4 资料库（`/tmp/wb-asar` 解包源码，`knowledge-base-panel` / `my-files`）实现单机版。WorkBuddy 资料库 = 本地产物 Tab（本地索引）+ 云端网盘（腾讯 Drive，COS 直传、配额、付费升级、分享）。天枢单机无云端，**本次只做「我的资料」——个人知识库最小完整闭环**（用户裁定方案 B）：入库、文件夹管理、浏览、搜索、预览、AI 引用。

**不做**（边界，均已与需求方确认）：

- 聚合视图——「团队空间」（项目资产已有 `projectAsset:*`）、「本地产物」（`chat/lib/artifacts.ts` 派生）、「最近」chip 留后续迭代合并；占位分组与 chip 本次移除
- 云端连接器线——腾讯文档 / ima / 乐享 / 云端网盘 / `/space` iframe，单机版天然不适用
- 收藏、版本历史、分享（公开链接/微信）、容量配额与付费升级——云端商业件
- 路径引用式入库（对标 WorkBuddy 连接器概念）——后续演进
- 全文检索——首版文件名 LIKE

## 2. 关键裁定

| # | 裁定 | 依据 |
|---|---|---|
| 1 | 首版只做「我的资料」，页面其余分组移除留白 | 用户裁定 B：一域一实体，聚合视图后续迭代 |
| 2 | **拷贝入库**：添加文件时复制到 `{userData}/library/{itemId}/{原文件名}`，DB 记元数据 | 用户裁定 A：资料库 = 长期沉淀，原文件移动/删除/修改不影响库内版本；WorkBuddy 同构（上传即入网盘）；与新建任务附件的「临时路径引用」语义并存不冲突 |
| 3 | **DB 为真相源 + ID 寻址**：`libraryItem` 表（DB v11）为唯一事实，磁盘按 itemId 寻址；移动/重命名纯 DB 操作不动磁盘 | 用户裁定 X：重元数据场景（搜索/筛选/排序/移动）SQL 天然擅长；文件夹移动 = 一条 UPDATE；`skillRecord` DB 先例 + guide.md 七步流程 |
| 4 | AI 引用**复用注入管线**：`@` 联想 + PlusMenu/AttachMenu 加「资料库」项 → 现有 `PendingFile` `localFile` kind → 现有 `@token` 内联注入（`READ_LIMIT = 512KB` 沿用），**不新增注入通道** | 用户裁定 A：与新建任务附件行为完全一致，注入侧零新代码；storagePath 即本地路径，`file:readExternalFile` 直接可读 |
| 5 | 文件夹树参照 WorkBuddy：懒加载（单层 list + 面包屑）、新建/重命名/移动/删除 | 用户裁定「参照 workbuddy 做」 |
| 6 | 预览三级：md/text/code/image 内联组件；**html/pdf/audio/video 走 `<webview src="file://…">`**（Electron 内置 Chromium 原生渲染，零新增依赖）；other 在 Finder 打开 | 用户提议 webview 方案；WorkBuddy 预览同构（`<webview partition="netdrive-file-preview">`） |
| 7 | 同层重名：repo 层统一校验（SQLite UNIQUE 对 NULL parentId 不生效），冲突自动追加 ` (1)` 序号 + toast 告知 | 简化 WorkBuddy 覆盖/保留/跳过弹窗（首版无版本概念，覆盖无意义） |
| 8 | 删除顺序：先事务删记录 → 再逐项 `fs.rm` 磁盘目录；磁盘失败仅日志 | 中断残留孤儿目录（无害）优于残留指向空路径的活记录（有害） |

## 3. 总体架构与流程

```
添加：文件选择器/拖拽 → library:addFiles(paths, folderId?)
      → 校验源存在 → INSERT 得 id → mkdir {libraryRoot}/{id} → copyFile
      →（失败回滚该条，不阻断批次）→ toast 汇总
浏览：library:list(parentId) → { items, breadcrumbs }（folder 置前）
      React Query ["libraryItems", folderId]；排序/类型筛选前端本地做（skill 页先例）
搜索：library:search(keyword) → 跨层文件名 LIKE
引用：@联想/菜单 → PendingFile(localFile, storagePath) → 发送时 @token 注入（512KB 上限）
预览：fileType 分级 → 内联组件 或 <webview file://> 或 Finder
```

- 后端：`electron/domains/ai/library/library.repo.ts`，`LibraryRepository(prisma)` 构造注册 handler，`Application.ts` `registerServices()` 接线（skill.repo 同模式）
- 前端：`src-react/domains/ai/library/` 补全 `api/` + `components/`；路由与侧边栏入口已就绪（`routes/index.tsx` library 子路由、GlobalSidebar `chat:sidebar.library`）
- 主进程窗口：`main.ts:82` `webPreferences` 增 `webviewTag: true`（webview 预览前提）

### IPC 通道清单（同步加 `src-react/lib/ipc.ts` 白名单）

| 通道 | 签名 | 说明 |
|---|---|---|
| `library:list` | `(parentId?) → { items: LibraryItem[], breadcrumbs: LibraryItem[] }` | 单层列表 + 祖先链一次返回 |
| `library:search` | `(keyword) → LibraryItem[]` | 文件名 LIKE，仅 file kind |
| `library:addFiles` | `(paths: string[], folderId?) → { added: LibraryItem[]; failed: { path; reason }[] }` | 批量拷贝入库 |
| `library:createFolder` | `(parentId?, name) → LibraryItem` | 重名自动序号 |
| `library:rename` | `(id, name) → LibraryItem` | 纯 DB |
| `library:move` | `(ids: number[], targetParentId?) → void` | 纯 DB；循环防护 |
| `library:delete` | `(ids: number[]) → void` | 级联删记录 → 逐项清盘 |
| `library:revealItem` | `(id) → void` | `shell.showItemInFolder` |

`LibraryItem` 类型定义在 `api/library.api.ts`（skill 先例，后端反向 import）：

```ts
interface LibraryItem {
  id: number;
  parentId: number | null;
  name: string;
  kind: "folder" | "file";
  fileType: string | null; // document|image|pdf|audio|video|code|text|archive|html|other
  mimeType: string | null;
  size: number | null;
  originalPath: string | null;
  storagePath: string | null; // file 专用，绝对路径（注入用）
  createdAt: string;
  updatedAt: string;
}
```

## 4. 数据模型与后端变更

### Prisma schema + DB v11

```prisma
model libraryItem {
  id           Int      @id @default(autoincrement())
  parentId     Int?     // null = 根层
  name         String
  kind         String   // "folder" | "file"
  fileType     String?
  mimeType     String?
  size         Int?     // bytes
  originalPath String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([parentId])
}
```

- `electron/infrastructure/script/v11/upgrade-table.sql`：建表 + 索引（`--/ignore` 幂等头，v9 securityAuditLog 同款）
- `electron/Constants.ts` `DATABASE_VERSION` 10 → 11
- `npx prisma generate` 后 `electron/generated/prisma` 出客户端

### repo 关键逻辑（均抽纯函数单测）

- **重名序号**：同 `parentId` + `name` 存在时生成 `name (n)`（n 从 1 递增至不冲突，保留扩展名）
- **子树收集**：递归收集文件夹全部后代 id（delete/move 循环防护共用）
- **循环防护**：`move` 目标不得为自身或自身后代
- **面包屑**：沿 parentId 上溯至根
- **fileType 分类**：扩展名 → `document|image|pdf|audio|video|code|text|archive|html|other` 映射表
- **入库事务**：INSERT → mkdir → copyFile 任一步失败即回滚该条（DELETE 记录 + rm 目录），`failed` 数组记录原因

### 预览安全（webview）

- `<webview>` 标签属性：`partition="library-preview"`（独立 session）、`nodeIntegration` 默认 false（webview 不继承主 preload）、`allowpopups=false`
- `will-navigate` / `setWindowOpenHandler` 复用 `electron/domains/security/renderer-guard.ts` 的 `shouldAllowNavigation`（file:// + dev server 白名单语义一致），外链跳系统浏览器或直接拒
- 仅加载 `{libraryRoot}` 下 `storagePath`；`did-fail-load` 降级「在 Finder 中打开」

## 5. 前端视图与组件

`LibraryView.tsx` 改造为真实页面：

- **工具栏**：面包屑（根「我的资料」可点）· 搜索框（跨层 `library:search`）· 类型筛选下拉 · 「新建文件夹」·「上传」（`file:pickLocalFiles` 现有通道）
- **列表**（`components/LibraryFileList.tsx`）：图标+名称 / 类型 / 大小 / 添加时间 / `...` 行菜单（预览·重命名·移动·Finder 中显示·删除）；排序（名称/时间，folder 置前）与类型筛选前端本地；多选暂不做（WorkBuddy 的批量操作留后续）
- **拖拽入库**：拖到页面释放（`filePath.getPathForFile` 取路径，new-task 先例）
- **弹窗**：`LibraryItemDialogs.tsx`（新建文件夹/重命名，输入校验）；`LibraryMoveDialog.tsx`（文件夹树浏览器，复用 `library:list`）；删除 AlertDialog（文件夹提示含内容数）
- **预览**（`LibraryPreviewDialog.tsx`）：大尺寸 Dialog；md 复用会话 markdown 渲染、text/code `<pre>`、image `<img>`；html/pdf/audio/video `<webview>`；other 主按钮「在 Finder 中打开」
- 占位清理：移除「最近」「本地产物」chip 与「团队空间」分组及 `comingSoon` 引用
- 数据：React Query；错误 `mapIpcError` + sonner toast；空态引导首次上传

## 6. AI 引用链路

- **`@` 联想**：会话输入框与新建任务输入框的 `@` 数据源加「资料库」段（`library:search`，选中挂 pill）——挂共享 `detectMention` 三件套
- **PlusMenu**（会话 `chat/components/PlusMenu.tsx`）与 **AttachMenu**（新建任务）各加「资料库」项 → 资料库选择器 Dialog（列表 + 搜索 + 文件夹浏览，仅 file 可选）
- **引用形态**：现有 `PendingFile` 的 `localFile` kind（`storagePath` 即路径），不新增 kind；pill 标识资料库来源
- **发送注入**：`@token` 内联管线（`chat/lib/build-injected-content.ts` / `new-task/lib/attach.ts`）经 `file:readExternalFile` 读 storagePath；文本 ≤512KB（`READ_LIMIT` 沿用），超限行为与文案照旧；图片走现有附件管线。注入侧零新代码

## 7. 异常处理

| 场景 | 行为 |
|---|---|
| 入库：源不存在/不可读/磁盘满 | 单条失败回滚不阻断批次，toast「成功 N / 失败 M」并列失败项 |
| 同层重名 | 自动 ` (n)` 序号 + toast 告知 |
| 移动到自身子树 | 拒绝 + 明确文案 |
| 删除：磁盘清理失败 | 日志记录后放行（孤儿目录无害） |
| webview 预览加载失败 | `did-fail-load` 降级 Finder 打开 |
| 注入超 512KB | 沿用 new-task 既有提示 |
| IPC 异常 | `mapIpcError` → sonner toast |

## 8. i18n

chat namespace `library` 段重写扩充（zh-CN / en-US 同步）：

- 保留：`library.title`、`library.searchPlaceholder`
- 新增：面包屑根名、列头（类型/大小/添加时间）、操作菜单 8 项、弹窗标题与按钮、空态文案、上传结果 toast、移动/重名/循环防护错误文案、PlusMenu/AttachMenu「资料库」项、`@` 联想分组标题
- 移除：`recent` / `localOutputs` / `team` 等占位 key（确认无他处引用后删除）
- 禁止硬编码中文/英文（项目规范）；顶层 key 与嵌套对象不重名

## 9. 测试

- **后端纯函数单测**（Vitest，`skill-filter` 先例）：重名序号生成、子树收集、循环检测、面包屑上溯、fileType 分类映射、存储路径拼装
- **前端纯函数单测**：列表排序（folder 置前）/类型筛选、预览方式分级判定（fileType → inline|webview|finder）
- repo IPC 装配、webview 行为走手工验收；门禁 `npm run test` / `lint` / `typecheck` 全绿

## 10. 手工验收清单（概要）

1. 上传：选择器 + 拖拽（批量、重名序号、源删除后库内可预览/引用）
2. 文件夹：新建/进入/面包屑回退/移动（含移动进自身子树被拒）/删除级联
3. 搜索：跨层文件名命中；类型筛选；排序
4. 预览：md/text/image 内联；html/pdf/audio/video webview；other Finder；webview 外链被拦
5. 引用：会话与新建任务 `@` 联想 + 菜单入口 → pill → 发送注入（≤512KB 注入、超限提示）；图片附件
6. 重启应用：列表/搜索/预览/引用正常（DB + 磁盘持久）
7. 门禁：`npm run test && npm run lint && npm run typecheck`

## Deviations（执行记录）

1. **renderer-guard 内联同语义**：`renderer-guard.ts` 的 `shouldAllowNavigation` 依赖 electron 模块不能进渲染层，预览 webview 导航拦截采用同语义内联实现（`will-navigate` preventDefault 全拦外跳，仅初始 `file://` 加载放行）。
2. **重名序号从 ` (2)` 起**：§2 裁定 7 字面为 ` (1)`，实现对齐 `asset.repo`/Finder 惯例从 ` (2)` 起且序号插在扩展名前（`笔记 (2).md`）；重名 toast 告知经 `uploadRenamed` 插值实现。
3. **文本预览沿用 512KB**：md/text/code 预览的文本读取沿用 `file:readExternalFile`（512KB 上限随之沿用，超限降级 Finder 按钮）。
4. **file rename 磁盘双写**：§2 裁定 3「移动/重命名纯 DB」对 file 的 rename 不成立——storagePath 派生自当前 name，file 重命名须先 `fs.rename` 磁盘文件再 update DB（磁盘失败抛错不动 DB）；folder rename、全部 move 仍纯 DB（移动只改 parentId）。
5. **allowpopups 存在性陷阱**：§4 字面写 `allowpopups=false`，Electron 实以 `hasAttribute` 判定——属性存在即放行弹窗（无论值）。实现为**不写该属性**（默认拒绝），达成 spec 意图。
6. **i18n 插值双花括号**：spec 阶段文案以单花括号示意，实现统一 i18next `{{var}}` 约定。
