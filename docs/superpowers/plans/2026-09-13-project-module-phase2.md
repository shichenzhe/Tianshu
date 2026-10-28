# 项目模块二期实施计划（资产）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 资产 Tab 完整落地——项目专属文件中心（文件夹/上传/列表/排序/容量）+ `@` 引用接入 + 项目会话工具硬隔离。

**Architecture:** 资产 = 专属 workspace（`workspace.projectId` 列关联）+ `userData/projects/<id>/assets/` 真实目录树，磁盘直读无 DB 表；`@` 引用经 session 挂资产空间零改动复用现有链路；工具硬隔离在 chat.service 组装层按挂载集过滤。

**Tech Stack:** 同一期（Electron 44 + React 19 + TS + Prisma 7 + React Query + shadcn/ui + Vitest）。

**Spec:** `docs/superpowers/specs/2026-09-13-project-module-phase2-design.md`（执行者必读）

## Global Constraints

- 与一期相同：i18n 双语言同步、主题语义色、弹出层 `border-border/50 rounded-lg shadow-lg`、Prettier 规范、IPC 通道进 `IPCChannel` 联合类型、函数 ≤20 行、异常必须处理且提示有用
- **路径安全铁律**：所有资产路径操作必须经沙箱校验（resolve 后必须仍在资产根目录内），禁止拼接未校验的相对路径
- 文件/目录名清洗规则：移除 `\ / : * ? " < > |` 与控制字符、首尾空格和点；清洗后为空 → 抛错
- 重名自动追加 ` (2)`、` (3)`…
- 测试基线：当前 master 全量 925/925、typecheck/eslint 全绿——每个任务完成后必须保持
- 工作目录：以执行时 controller 指定的 worktree 为准

## 文件结构总览

```
prisma/schema.prisma                                    [改] workspace.projectId
electron/infrastructure/script/v3/upgrade-table.sql     [新]
electron/Constants.ts                                   [改] DATABASE_VERSION 2→3
electron/domains/project/asset.entity.ts                [新] 资产类型
electron/domains/project/asset.repo.ts                  [新] 资产文件 IPC 仓储
electron/domains/project/project.repo.ts                [改] 资产空间生命周期
electron/domains/ai/chat/session.repo.ts                [改] listWorkspaces 过滤
electron/domains/ai/chat/chat.service.ts                [改] 工具硬隔离
electron/preload.ts                                     [改] webUtils 拖拽桥
src-react/lib/ipc.ts                                    [改] 8 个资产通道
src-react/vite-env.d.ts                                 [改] window.getPathForFile 类型
src-react/domains/project/api/asset.api.ts              [新]
src-react/domains/project/components/AssetsPane.tsx     [新]
src-react/domains/project/components/AssetFileTable.tsx [新]
src-react/domains/project/components/AssetUploadDropZone.tsx [新]
src-react/domains/project/views/ProjectWorkspaceView.tsx [改] assets Tab 接入
src-react/i18n/locales/{zh-CN,en-US}/project.json       [改] assets.* keys
tests/project/asset-repo.test.ts 等                     [新]
```

---

### Task 1: 数据库 v3 迁移

**Files:**
- Modify: `prisma/schema.prisma`（model workspace 加 `projectId Int?` + `@@index([projectId], map: "workspace_projectId_index")`）
- Create: `electron/infrastructure/script/v3/upgrade-table.sql`
- Modify: `electron/Constants.ts`（DATABASE_VERSION = 3）

**Interfaces:**
- Produces: `workspace.projectId Int?`（后续任务依赖；资产空间 = projectId 非空的 workspace 行）

- [ ] schema.prisma 的 `model workspace` 末尾（字段区）加 `projectId Int?`，索引区加 `@@index([projectId], map: "workspace_projectId_index")`
- [ ] v3 SQL（v2 同款注释惯例；ALTER 包 `--/ignore` 保证重跑安全）：

```sql
--/p 资产空间关联（项目模块二期：项目专属 workspace 的 projectId；NULL = 普通空间）
ALTER TABLE workspace ADD COLUMN projectId INTEGER NULL;
--/ignore
CREATE INDEX IF NOT EXISTS workspace_projectId_index ON workspace (projectId);
```

- [ ] `npx prisma generate` + `npm run typecheck` + 提交 `feat(project): 数据库 v3——workspace.projectId 资产空间关联`

---

### Task 2: project.repo 资产空间生命周期 + workspace 过滤（TDD）

**Files:**
- Modify: `electron/domains/project/project.repo.ts`
- Modify: `electron/domains/ai/chat/session.repo.ts`（`listWorkspaces` 加 `where: { projectId: null }`）
- Test: `tests/project/project-repo.test.ts`（更新 + 新增用例）

**Interfaces:**
- Consumes: Task 1 的 `workspace.projectId`
- Produces:
  - `ProjectRepository.create`：建目录 `path.join(app.getPath("userData"), "projects", String(id), "assets")` → `prisma.workspace.create({ data: { name: "资产 · " + name, directoryPath, projectId: id } })` → 项目 session 挂**该 workspace**，模型继承改**全局最近**（`session.findFirst({ where: { currentModelId: { not: null } }, orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }] })`，不限空间）
  - `ProjectRepository.remove`：查资产 workspace（`findFirst({ where: { projectId: id } })`）→ 有则 `fs.rm(assetsDir, { recursive: true, force: true })` + `workspace.delete` → 原一期删除顺序不变
  - `ensureAssetWorkspace(project)`（私有，幂等）：无资产 workspace 的项目（一期旧数据）自动补建目录 + workspace + `session.update({ where: { projectId }, data: { workspaceId } })`；`getDetail` 入口调用
  - `ProjectDetail` 增加字段 `assetWorkspaceId: number`（getDetail 返回，前端资产操作用）
- [ ] 失败测试（更新既有 create 断言 + 新增）：
  - create → `workspace.create` 调用含 `{ name: "资产 · test", directoryPath: <含 projects/11/assets>, projectId: 11 }`；`session.create` 的 `workspaceId` 为**资产空间 id**（stub workspace.create 返回 `{ id: 30 }` 断言 30）；模型继承查询 `findFirst` 不含 workspaceId 条件
  - remove → workspace.findFirst({projectId}) 命中时 `fs.rm` 与 `workspace.delete` 被调（fs mock）
  - getDetail（旧项目自愈）→ 项目有 session 但无资产 workspace 时：建目录 + workspace.create + session.update 重绑；已有则零副作用
  - session.repo `listWorkspaces` → `findMany` where 含 `projectId: null`（该断言放 `tests/project/session-isolation.test.ts` 或 session-repo 测试）
- [ ] 实现（fs/path/app import；fs 操作 try/catch 转中文错误）
- [ ] 全量回归（一期 create 测试断言需同步更新）+ typecheck + eslint + 提交 `feat(project): 项目生命周期挂接资产空间——创建/删除/旧项目自愈 + workspace 列表过滤`

---

### Task 3: asset.repo 核心——列表/文件夹/重命名/删除（TDD）

**Files:**
- Create: `electron/domains/project/asset.entity.ts`、`electron/domains/project/asset.repo.ts`
- Modify: `electron/Application.ts`（接线 `new AssetRepository(projectRepo)`，在 ProjectRepository 之后）
- Modify: `src-react/lib/ipc.ts`（IPCChannel 加 8 个 `projectAsset:*` 通道）
- Test: `tests/project/asset-repo.test.ts`

**Interfaces（前后端契约，Task 5/6 消费）:**

```ts
// asset.entity.ts
export interface AssetEntry {
  name: string;
  type: "file" | "folder";
  size: number;        // 文件字节；文件夹 = 目录项懒统计累计（readdir+stat 一层）
  updatedAt: string;   // ISO
  ext: string | null;  // 小写无点，仅文件
}
export interface AssetUploadResult { uploaded: string[]; failed: string[]; }
export interface AssetStorage { usedBytes: number; quotaBytes: number; } // quota 恒 5*1024^3
// IPC：
// projectAsset:list (projectId, folderPath?) => AssetEntry[]（不存在则自愈重建空目录）
// projectAsset:createFolder (projectId, parentPath, name) => string（最终目录名）
// projectAsset:rename (projectId, oldPath, newName) => string（最终名）
// projectAsset:delete (projectId, targetPath) => void（文件夹 rm recursive）
```

内部纯函数（单测重点，fs 全 mock 或注入）：

```ts
sanitizeName(name: string): string;              // 清洗非法字符；空结果抛"名称无效"
uniqueName(dir: string, name: string): string;   // fs.existsSync 探测追加序号
resolveAssetRoot(projectId): Promise<{ root, workspaceId }>;  // project → ensureAssetWorkspace → directoryPath
safeJoin(root: string, relPath: string): string; // resolve 后必须 startsWith(root + sep) 否则抛"非法路径"
```

- [ ] 失败测试：sanitizeName 用例表（非法字符/空/正常）、safeJoin 穿越攻击（`../`、绝对路径、符号拼接）拒绝、list 一层 mock fs 返回条目映射（类型/大小/时间/ext）、createFolder/rename 的重名序号与清洗、delete 分支（文件 unlink vs 文件夹 rm recursive）
- [ ] 实现（自注册 IPC 模式照 project.repo；方法 ≤20 行抽私有）
- [ ] typecheck + eslint + 全量 + 提交 `feat(project): 资产仓储——列表/文件夹/重命名/删除（沙箱校验+名称清洗+重名序号）`

---

### Task 4: asset.repo 上传/统计/预览 + 拖拽桥（TDD）

**Files:**
- Modify: `electron/domains/project/asset.repo.ts`（upload/storage/openFile/revealFile 四方法）
- Modify: `electron/preload.ts`（暴露 `getPathForFile: (file: File) => string`——`webUtils.getPathForFile(file)`，注明 Electron 44 无 File.path）
- Modify: `src-react/vite-env.d.ts`（window 类型补 `getPathForFile`）
- Test: `tests/project/asset-repo.test.ts`（扩展）

**Interfaces:**
- `projectAsset:upload (projectId, folderPath, absPaths: string[]) => AssetUploadResult`——逐文件 `fs.copyFile`，源不存在/不可读收集进 failed；单文件大小与总量不做上限（软配额仅提示）
- `projectAsset:storage (projectId) => AssetStorage`——递归 du（复用思路参照 `settings.service.ts` 的 storageInfo 实现）；目录缺失返回 0
- `projectAsset:openFile (projectId, path) => void`——`shell.openPath`（仅文件）
- `projectAsset:revealFile (projectId, path) => void`——`shell.showItemInFolder`
- preload：`getPathForFile` 经 contextBridge 暴露（渲染层拖拽 file 对象换绝对路径）

- [ ] 失败测试：upload 成功/部分失败分支、storage 递归统计（mock fs 目录树）、openFile/revealFile shell 调用
- [ ] 实现 + preload 桥（preload 是全局桥，改动最小化：仅加一个方法）
- [ ] typecheck + eslint + 全量 + 提交 `feat(project): 资产上传/容量统计/系统预览 + webUtils 拖拽桥`

---

### Task 5: 前端 asset.api + i18n + AssetsPane 骨架（TDD 轻量）

**Files:**
- Create: `src-react/domains/project/api/asset.api.ts`（静态类，8 方法 invoke 封装）
- Create: `src-react/domains/project/components/AssetsPane.tsx`（props: `{ projectId: number }`）
- Create: `src-react/domains/project/components/AssetFileTable.tsx`
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/project.json`（`assets.*` 约 22 key：title/upload/newFolder/name/type/size/updatedAt/empty/uploadSuccess/uploadPartial/uploadFailed/deleteTitle/deleteDescN/renamed/folder/file/sortName/sortTime/filterAll/filterType/storageUsed/quotaExceeded/open/reveal/rename/delete/dropHere/nameInvalid）
- Modify: `src-react/i18n/index.ts`（如需注册——project ns 已注册，仅加 key 则不用动）
- Test: `tests/project/assets-pane.test.tsx`

**Interfaces:**
- `AssetApi.list(projectId, folderPath?) / createFolder / upload / rename / remove(projectId, path) / storage / openFile / revealFile`
- AssetsPane 状态：`folderPath: string[]`（面包屑栈）、`sortKey: "name" | "updatedAt"`、`typeFilter: string | null`（扩展名）；数据 `useQuery(["projectAssets", projectId, folderPath.join("/")], ...)`；容量 `useQuery(["projectAssetStorage", projectId])`
- AssetFileTable props：`entries`、`sortKey`、`onOpen`(文件夹进入/文件 openFile)、`onRename`、`onDelete`、`onReveal`

- [ ] 失败测试：渲染列表行（图标/名称/大小格式化 KB/MB/相对时间）、面包屑导航进出文件夹、排序切换、类型筛选、空态文案
- [ ] 实现（大小格式化与相对时间用 date-fns + 现有 locale 惯例；图标按扩展名映射一组 lucide）
- [ ] typecheck + eslint + 全量 + 提交 `feat(project): 资产面板——列表/面包屑/排序筛选/容量条骨架 + asset i18n`

---

### Task 6: 资产操作交互完整化（TDD）

**Files:**
- Modify: `AssetsPane.tsx`（上传按钮 dialog、新建文件夹、重命名弹窗、删除确认、容量条、超配额 toast）
- Create: `AssetUploadDropZone.tsx`（拖拽覆盖层：onDragOver 显示 / onDrop 经 `window.getPathForFile(file)` 取路径 → `AssetApi.upload`）
- Test: `tests/project/assets-pane.test.tsx`（扩展）

- [ ] 失败测试：新建文件夹（重名由后端返回最终名 toast）、重命名弹窗保存、删除二次确认（文件夹文案含条目数）、上传结果 toast（成功/部分失败/配额超限提示）、拖拽 drop 调用 upload（mock window.getPathForFile）
- [ ] 实现（上传来源按钮用 `dialog` 等价 IPC——检查现有 `file:pickAndRead` 的选择器实现，若为单读内容则新加 `projectAsset:pickFiles` 通道走 `dialog.showOpenDialog` 多选返回绝对路径，加进 Task 4 的通道集） 
- [ ] typecheck + eslint + 全量 + 提交 `feat(project): 资产操作——上传/拖拽/重命名/删除确认/容量条交互`

---

### Task 7: ProjectWorkspaceView 接入 assets Tab

**Files:**
- Modify: `src-react/domains/project/views/ProjectWorkspaceView.tsx`（`tab === "assets"` 渲染 `<AssetsPane projectId={detail.project.id} />`，替换占位空态；其余三个 Tab 占位不变）

- [ ] 手动接线 + typecheck + 全量（无新测试面——AssetsPane 已测）
- [ ] 提交 `feat(project): 详情页资产 Tab 接入`

---

### Task 8: 工具硬隔离（spike + TDD）

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`（组装工具集处按项目挂载集过滤）
- Test: `tests/ai/chat.service.test.ts`（扩展）

**Spike（首步，结论写报告）:** 定位 MCP 工具与技能清单进入会话的注册/合并点（`grep -n "mcpManager\|collectEnabledSkills\|tools" chat.service.ts`）；评估在组装层过滤（项目会话：工具名前缀 `mcp__<server>` 匹配挂载 server 名集合；技能 = collectEnabledSkills 结果 ∩ 挂载技能名集合）。**若过滤实现成本超预期（>2 处深改），降级为仅 MCP 硬隔离 + 技能维持软约束，结论记入报告与 ledger。**
- [ ] spike 结论（改动点清单）
- [ ] 失败测试：项目会话（mock projectRepo.getPromptContext 返回挂载集）→ 工具数组仅含挂载 server 的工具与挂载技能；非项目会话全量（回归锚点）
- [ ] 实现（软约束声明段与新实际一致）
- [ ] typecheck + eslint + 全量 + 提交 `feat(project): 项目会话工具硬隔离——MCP/技能按挂载集过滤`

---

### Task 9: workspace 遍历面全面核查

**Files:**
- 核查不改（发现问题才改）：所有消费 `workspace:list` / `WorkspaceApi.list` / `prisma.workspace.findMany` 的位置

- [ ] `grep -rn "WorkspaceApi.list\|workspace:list\|workspace.findMany" src-react/ electron/` 列出全部消费点，逐一确认资产空间不泄漏进 AI 界面：
  - [ ] AI 侧边栏空间树（Task 2 已过滤 `projectId: null`——验证）
  - [ ] 自动化任务的空间选择下拉（automation 域）
  - [ ] 全局搜索/其他消费点
  - [ ] MainLayout/TopBar 相关
- [ ] 泄漏点修复 + 对应断言；无泄漏则记录核查清单进报告
- [ ] 提交（有修复时）`fix(project): workspace 遍历面隔离资产空间`

---

### Task 10: 收尾——全量验证 + 手动验收清单

- [ ] `npm run typecheck && npm run lint && npm run test` 全绿
- [ ] 写 `docs/superpowers/manual-acceptance-2026-09-13-project-module-phase2.md`（照一期清单格式）：
  - 新建项目 → 资产 Tab 空态引导 → 上传（按钮/拖拽）→ 多级文件夹进出/面包屑 → 重命名（重名序号）→ 删除（二次确认+级联）→ 预览/ Finder 定位 → 排序筛选 → 容量条
  - 动态流 `@` 引用资产文件（联想列表=资产树、发送注入内容）
  - 旧项目自愈（一期建的项目打开详情后资产空间自动补齐）
  - 删除项目 → `userData/projects/<id>/` 磁盘清理
  - 硬隔离：挂载单个连接器后项目会话仅可调它
  - AI 模块回归：空间树无资产空间、自动化选空间无资产空间
- [ ] 提交 `docs(project): 项目模块二期手动验收清单`

---

## 自审记录

1. **Spec 覆盖**：§2 决策表→T1/T2（workspace 挂载/无 DB/全局继承/自愈）；§3.3 IPC→T3/T4（8 通道+pickFiles 备注在 T6）；§3.5 UI→T5/T6/T7；§3.6 @ 引用→T2（零改动，验收清单覆盖）；§3.7 硬隔离→T8（含降级条款）；§7 风险 1→T9、风险 2→T4、风险 3→懒统计已入 T3。无缺口。
2. **占位符**：T8 spike 是计划显式设计的验证步骤（含降级出口）非 TBD；Task 6 的 `projectAsset:pickFiles` 为条件新增（标注了判定条件）。
3. **类型一致性**：`AssetEntry/AssetUploadResult/AssetStorage` 定义（T3）与消费（T5/T6）一致；`assetWorkspaceId`（T2 ProjectDetail 扩展）与 AssetsPane 的 projectId 入参来源（detail.project.id）解耦无依赖冲突。
