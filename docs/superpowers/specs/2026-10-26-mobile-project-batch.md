# 移动端项目模块批（A7）设计 spec

日期：2026-10-26
状态：调研完成（Explore 全量摸底 32 通道级清单），待实现
关联：差集 spec `2026-10-25-mobile-desktop-gap.md`（A7 条目）；A5 资料库批三段式先例

## 1. 背景与裁定

### 1.1 现状盘点（调研结论，file:line 证据见调研报告）

- **桌面项目域 32 个本地 IPC 通道**：project:* 7、planItem:* 11、planView:* 5、projectAsset:* 9；六表齐全（project/projectMember/projectBinding/planItem/planView/planItemAttachment），无独立 service 层，业务在四个 Repository（构造时注册 IPC，**A7 装配须由 Application 持实例注入，严禁二次 new**）。
- **权限口径不统一**：project/planItem 走 handleUser 有归属校验；**planView/projectAsset 裸 ipcMain.handle、Repository 无 userId 参数**——face 适配层必须补项目可见性守卫（owner 或 member，反查 project）。
- **被控面/协议/无头端三零**：face 无项目端点；协议无 project 契约；无头端只有 Project/PlanItem 两表（AI 计划工具用），缺 member/binding/view/attachment 四表与 Nest module——**无头端另批**。
- **可复用资产**：`plan-view-engine.ts`（筛选/排序/分组/配置解析纯函数）与 `plan-date.ts`（日期网格）是最值得共享的纯逻辑；`files/list`、`files/read` 可在拿到 `assetWorkspaceId` 后直接复用做资产/附件文本预览。

### 1.2 本批裁定

- **Ruling：本批只做桌面被控面**，`project` 进 `DESKTOP_CAPABILITIES`、不进无头端 `CAPABILITIES`。
- **Ruling：planView/projectAsset 两域 face 适配层补权限守卫**——新增 ProjectRepository 公共方法（不注册 IPC）`assertProjectVisible(projectId, userId)`（owner 或 member，否则 PROJECT_NOT_FOUND 同桌面「不可见与不存在统一」口径）；planView 按 view.projectId、asset 按 projectId 反查。
- **Ruling：远程 DTO 收编进协议包新 `project-contract.ts`**；远程创建载荷剔除桌面遗留 `ownerId`/`createdById`——身份唯一来源 `withUserId`。
- **Ruling：移动端 v1 功能面**（采纳调研 §4.4 建议）：
  - **项目 hub**：列表/搜索/新建/重命名/编辑指令/删除（Alert 强确认+级联提示：资产/会话/计划/视图/自动化同删）/详情（bindings 与成员只读展示）
  - **我的任务**：listMine + 范围（all/assigned/created）/来源（local/project）/标题过滤
  - **计划**：事项列表（应用激活视图的 filter/sort，groupBy 取 status）/新建/编辑（标题/描述/状态/优先级/处理人/标签/起止日期/自定义字段值——字段定义只读 listFields）/删除/状态流转（move）/附件（列表/从既有资产挑选挂关联/删关联，删关联不删文件）
  - **视图**：只读消费（planView:list 含懒播种语义），移动端只渲染「列表（按状态分组）」一种布局；视图的建/改/删/排序另批
  - **资产**：目录浏览/面包屑/新建文件夹/重命名/删除（safeJoin 服务端守卫）/用量展示/文本·Markdown 预览（files/read）/图片预览（新增 projectAsset/readImage，服务端解析根+mime 白名单+10MB）
  - **甘特/日历/宽表不做**（日期在事项详情可编辑，数据面无损）；桌面宿主 GUI 三件套（openFile/revealFile/pickFiles）不做；资产上传/移动上传协议另批
- **Ruling：`planItem:fields:save` 与 `project:setBindings` 写面本批不做**——前者批量清理全项目事项 JSON 值、后者全量替换+binding 候选契约缺数值 id，均另批专门处理。
- **Ruling：纯逻辑下沉 packages/tianshu-core**——`plan-view-engine.ts`（filterItems/sortItems/groupItems/parseViewConfig 及 FilterCondition/SortRule 类型）与 `plan-date.ts` 的 dateKeyToIso/monthGrid/groupByDueDate（**不含农历标签**，lunar-typescript 不进 core 包）迁移为 core 纯函数；桌面 src-react 改为 re-export 兼容（既有测试零改动），移动端消费 dist。check:drift 基线需 --rebase（双份文件新增）。

### 1.3 非目标

无头端项目模块；项目聊天深链（task-session 推进，可与移动聊天页后续集成）；planView 管理写面；fields:save；资产上传；成员邀请/角色（桌面本就没有）；自动化配置。

## 2. 三层设计

### 2.1 协议包：project-contract.ts

- 枚举：PlanStatus(not_started|in_progress|paused|done)、PlanPriority(P0..P3)、PlanSource(manual|ai|template)、PlanViewType(table|kanban|list|gantt|calendar)、PlanGroupBy(status|priority|assignee)、ProjectBindingType(assistant|skill|mcpServer)。
- 记录 DTO：ProjectRecord/ProjectBindingItem/ProjectMemberItem/PlanItemRecord/PlanItemAttachmentRecord/PlanViewRecord/AssetEntry/AssetStorage/PlanFieldDef——逐字镜像桌面 entity（日期一律 string ISO）。
- 载荷：ProjectCreatePayload(name/systemPrompt?/templateKey?/welcomeMessage?——无 ownerId/bindings 远程不做)、ProjectUpdatePayload(id/name?/systemPrompt?)、PlanItemCreatePayload（无 createdById，余同桌面）、PlanItemUpdatePayload、PlanItemMovePayload、PlanViewListPayload{projectId}、ProjectAssetFolderPayload{projectId,path?}/CreateFolder{projectId,parentPath,name}/Rename{projectId,path,newName}/Delete{projectId,path}/ReadImage{projectId,path}、PlanAttachmentPayload{planItemId}/{id}。
- ProjectDetailResult：{ project, assetWorkspaceId, bindings, sessionId }——**只带 sessionId 不带完整 SessionRecord**（避免聊天形状耦合）。
- 错误码常量：PROJECT_NOT_FOUND/PROJECT_NAME_EXISTS/PLAN_ITEM_NOT_FOUND/PLAN_VIEW_LAST_ONE/ASSET_PATH_ESCAPE/ASSET_NOT_FOUND/ASSET_NAME_INVALID。
- ENDPOINTS：project 6 段（query/getDetail/create/update/delete/listMembers）、planItem 10 段（list/listMine/create/update/delete/move/fieldsList/attachmentList/attachmentCreate/attachmentDelete）、planView 1 段（list）、projectAsset 6 段（list/createFolder/rename/delete/storage/readImage），共 23 段；DESKTOP_CAPABILITIES 增 "project"。

### 2.2 桌面被控面：project-tap（可按子域拆 project/plan-item/plan-view/asset 四文件）+ 路由

- Application 持四实例（现 246-255 行局部变量改字段）注入 attachServerFace；deps.ts 增 `project?: ServerFaceProject` 接口族。
- tap 层职责：DTO 转换（ISO 日期串行化）、planView/asset 的 assertProjectVisible 守卫、错误 → FaceProjectError(code) 透传、projectAsset readImage 新增实现（resolveAssetRoot + safeJoin + mime 白名单 + 10MB，仿 library-tap readImage）。
- project:create/getDetail/delete 保留 Repository 级聚合（资产 workspace/会话/member 生命周期不拆给移动端编排）；getDetail 自痊愈副作用对远程同样生效（首次进项目建资产目录，属既有语义）。
- routes.ts：23 handler 形状校验（数字 id、name trim、日期 ISO 解析、路径段校验）→ withUserId → tap → ok/bizError；REPO_ERROR_MESSAGES 补新错误码映射。

### 2.3 移动端：project store + 三页面

- `src/store/project.store.ts`（providers.store 范式：三重防迟到 + enqueueWrite 串行）：hub（list/search）、detail（getDetail+成员+bindings 只读）、tasks（listMine+前端过滤）、plan（list/fieldsList/planView list/写操作族）、assets（list/storage/写操作族/readImage）；写后局部刷新（hub 重拉/计划重拉当前项目/资产重拉当前目录）。
- 页面：
  - `/projects`（hub）：PageHeader + 搜索框 + 项目卡列表（名称/指令摘要/更新时间）+「+」新建 Dialog（名称/指令/模板选择可后置——v1 名称+指令）+长按重命名/删除；第二 Tab「我的任务」（范围/来源过滤 chips + 行列表，点击进编辑 Dialog）。
  - `/projects/[id]`（工作台）：PageHeader（项目名）+ 分段 [计划|资产|关于]；关于页 = 指令只读+成员列表+bindings 只读清单。
  - 计划：状态分组 SectionList（组头 not_started/in_progress/paused/done + 组内行：标题/优先级色点/处理人/截止日期），行点击编辑 Dialog（全字段+自定义字段值+附件区），组内「+」快速新建；激活视图配置应用 filter/sort（plan-view-engine 复用 core 版）。
  - 资产：面包屑+行列表+用量条；行长按重命名/删除；图片点击 readImage 预览，文本/md 走 FilePreviewModal（files/read + assetWorkspaceId）；其他提示桌面端。
- settings 我的页入口：`capabilities?.includes("project")` 门禁（FolderGit2/Boxes 图标）。
- i18n 新命名空间 `project`（zh/en 同步）。

## 3. 测试与验收

- 协议：protocol-package.test.ts 同步（capabilities + ENDPOINTS toEqual，23 段）；dist build 后双消费端 typecheck。
- core 纯函数迁移：plan-view-engine/plan-date 既有桌面测试全绿（路径改 re-export 后零改动）；core 包新增导出聚合。
- face：project-tap 系新测试——权限守卫（planView/asset 非成员拒）、DTO 转换、错误码透传、readImage 守卫；routes.test.ts 补 23 端点映射用例（fake deps）。
- 移动端三件套：typecheck + vitest（store 端点映射/迟到/串行/错误）+ prettier。
- 根 typecheck + server-face vitest + 移动端全量 vitest 绿。
- check:drift --rebase（core 双份文件基线变化人工复核）。
- 真机验收（移交用户）：建项目→建事项→改状态/优先级→挂附件→资产建目录/预览→删除回环；非 owner 成员账号验证只读可见性（如有）。

## 4. 风险

- **planView/asset 权限补课**：Repository 历史上裸暴露；face 守卫是远程化前提，漏一面即越权。缓解：守卫集中在 tap 层单测全覆盖。
- **project:delete 级联面大**（磁盘+六表+自动化）：Alert 强确认文案明示级联；与桌面同权限（仅 owner）。
- **getDetail 自痊愈副作用**：远程触发建目录/建会话与桌面一致，属既有语义，spec 明示不另批。
- **core 包迁移牵 drift**：双份文件基线变化须 --rebase 并人工复核；lunar 不进 core 的边界写死（桌面日历继续本机引用 lunar）。
