# 项目模块二期设计（Project Module Phase 2 · 资产）

- 日期：2026-09-13
- 状态：待用户审阅
- 上游：`docs/superpowers/specs/2026-09-12-project-module-phase1-design.md`（§10 二期 roadmap）
- 范围：资产（项目专属文件管理）+ `@` 引用接入 + 工具硬隔离补齐；三期（计划/任务）另立 spec

## 1. 目标

把「资产」Tab 从占位空态变成完整的项目文件中心：多级文件夹、上传、列表（名称/类型/大小/更新时间）、排序、容量统计；动态流输入框 `@` 可引用项目资产；项目会话的工具调用硬隔离到已挂载能力集。

## 2. 关键决策

| 决策点 | 结论 | 理由与代价 |
| --- | --- | --- |
| 资产元数据存储 | **无 DB 表，磁盘直读**（fs.readdir/stat 实时呈现） | 本地单用户应用最简架构：无 DB/磁盘双源同步问题、无重命名同步；PRD 的「更新人」字段单用户恒为"我"（C 方案），大小/时间来自 fs.stat。代价：超大目录列表性能依赖 fs（本地量级无虞）；不引入 `projectAsset` 表，v3 迁移仅一列 |
| 资产目录挂载方式 | **每个项目一个专属 workspace**（`workspace.projectId` 列关联，`directoryPath` 指向资产目录） | `@` 文件联想（`file:listWorkspaceFiles`）、沙箱读取（`resolveSafePath`）、产物面板全链路**零改动复用**；替代方案（ChatInput 加资产数据源分支）会在共享组件深处注入项目感知，破坏一期边界 |
| 物理布局 | `userData/projects/<projectId>/assets/`，目录树即磁盘目录树 | 一期既定；文件物理名即用户名（本地单用户无并发冲突；非法字符按平台规则清洗，重名自动追加序号） |
| 新建项目的 session 挂载 | 项目 session 的 `workspaceId` 从「默认空间」改为「项目资产空间」 | `@` 引用与写入天然落在项目资产目录；**模型继承改为「全局最近一次选择」**（不限空间）——资产空间是新建的空空间，按空间查永远取不到值 |
| 容量配额 | 真实统计（递归 du）+ 5GB 软上限：超限仅 toast 警告，**不做「升级」假入口** | 一期 C 方案精神；「升级」按钮显示为"本地版"静态说明 |
| 工具硬隔离 | 项目会话的实际工具集（MCP tools + 技能清单）按挂载集过滤，未挂载不注册 | 一期 §5.2 降级条款的补齐；实施计划首任务做 spike 确认 chat.service 工具注册链路的过滤点 |

## 3. 架构

### 3.1 数据模型（script/v3 迁移）

- `workspace` 表加 `projectId INTEGER NULL` 列 + 索引；
- 不新增任何表。资产 = workspace（projectId 非空）+ 其 `directoryPath` 下的真实文件树。

### 3.2 后端结构

```
electron/domains/project/
  project.repo.ts          # 扩展：create/remove/list/getDetail 适配资产空间生命周期
  asset.repo.ts            # 新：资产文件操作 IPC 仓储（见 §3.3）
```

**生命周期（project.repo）**：

- `create`：创建 project 后，在 `userData/projects/<id>/assets/` 建目录 → 创建资产 workspace（`{ name: "资产 · <项目名>", directoryPath, projectId }`）→ 项目 session 挂**该 workspace**（模型继承改为全局最近一次选择，见 §2）；
- `remove`：级联删除扩展——先删资产 workspace 行与目录树（`fs.rm recursive`），再删 session/message/member/binding/project（沿用一期顺序）；
- **旧项目自愈迁移**：一期创建的项目没有资产空间——`getDetail` 检测到项目缺资产 workspace 时自动补建（目录 + workspace 行 + session 重绑该空间），幂等；升级 v3 后首个打开旧项目的动作即完成迁移，无需 SQL 数据脚本；
- `workspace:list`（session.repo）：AI 侧边栏空间分组树过滤 `projectId: null`，资产空间不进 AI 界面；`searchMessages` 的可见会话预查询不受影响（项目 session 本就被排除）。

### 3.3 资产文件操作 IPC（asset.repo，均按资产 workspace 的沙箱目录校验路径）

| 通道 | 参数 | 行为 |
| --- | --- | --- |
| `projectAsset:list` | (projectId, folderPath?) | readdir+stat 递归一层：名称/类型(文件夹/扩展名)/大小/更新时间；文件夹附带累计大小（懒统计，仅当前层） |
| `projectAsset:createFolder` | (projectId, parentPath, name) | mkdir（非法字符清洗、重名追加序号） |
| `projectAsset:upload` | (projectId, folderPath, absPaths[]) | 多文件 copy（来源由渲染层 dialog 多选或拖拽解析得到绝对路径） |
| `projectAsset:rename` | (projectId, oldPath, newName) | fs.rename（重名追加序号） |
| `projectAsset:delete` | (projectId, path) | 文件 unlink / 文件夹 rm recursive（前端二次确认） |
| `projectAsset:storage` | (projectId) | `{ usedBytes, quotaBytes: 5GB }` 递归统计 |
| `projectAsset:openFile` | (projectId, path) | `shell.openPath`（系统默认程序预览） |
| `projectAsset:revealFile` | (projectId, path) | Finder/资源管理器定位 |

拖拽上传：Electron 44 已移除 `File.path`——preload 暴露 `webUtils.getPathForFile` 桥（`window.getPathForFile(file)`），渲染层拖放事件换算绝对路径后走 `projectAsset:upload`。

### 3.4 前端结构

```
src-react/domains/project/
  api/asset.api.ts                        # IPC 封装
  components/AssetsPane.tsx               # 资产 Tab 主视图（§3.5）
  components/AssetToolbar.tsx             # 上传/新建文件夹/排序/容量条
  components/AssetFileTable.tsx           # 列表（面包屑 + 表格）
  components/AssetUploadDropZone.tsx      # 拖拽覆盖层
```

ActivityPane（动态流）不改——`@` 引用随 session.workspaceId 切到资产空间自动生效。

### 3.5 资产 Tab（AssetsPane）

- **头部**：面包屑（根 › 子文件夹…）+ 工具栏（上传按钮、新建文件夹、名称/时间排序切换、类型筛选下拉）+ 容量条（`usedBytes/quotaBytes`，超 80% 变警示色）；
- **列表**：图标（文件夹/按扩展名）、名称、类型、大小（文件夹显示累计或 "--"）、更新时间（相对时间）；行内操作：预览（openFile）、定位（revealFile）、重命名、删除（二次确认）；
- **拖拽**：整个 Tab 为放置区，拖入文件显示覆盖层，松手上传到当前文件夹；
- **空态**：引导上传/新建文件夹；
- 上传成功 → invalidate 列表 + toast；超配额 → 上传完成但 toast 警告。

### 3.6 `@` 引用

项目 session 的 workspace 即资产空间 → ChatInput 现有 `@` 联想（`file:listWorkspaceFiles`）、内容读取（发送时读文件注入）、产物面板全部自动指向资产目录。**ChatInput/ChatPane 零改动。**

### 3.7 工具硬隔离（一期 §5.2 补齐）

chat.service 组装项目会话的工具集时：MCP 工具仅保留已挂载 `mcpServer` 的工具；技能清单仅保留已挂载技能（`collectEnabledSkills` 结果 ∩ 挂载集）。软约束声明段保留（声明与实际一致化）。实施首任务 spike：定位工具注册/合并点，评估过滤实现位置（manager 层 or service 组装层），若成本超预期允许降级为"仅 MCP 硬隔离、技能保持软约束"并记录。

## 4. 错误处理

| 场景 | 处理 |
| --- | --- |
| 资产目录缺失（被外部删除） | `projectAsset:list` 自动重建空目录并返回空列表（自愈，日志记录） |
| 上传源文件不可读 | 逐文件失败收集，toast 汇总"N 个文件上传失败" |
| 名称非法/保留字符 | 按平台清洗（`\ / : * ? " < > |` 与首尾空格/点），清洗后为空则拒绝并提示 |
| 重名 | 自动追加 ` (2)`、` (3)`… |
| 删除非空文件夹 | AlertDialog 明示"将删除 N 个文件" |
| 磁盘写入失败（权限/空间） | toast 报错保留现场 |
| 所有 IPC 异常 | catch + 有用提示（项目规范） |

## 5. i18n / 测试 / 手动验收

- i18n：`project` namespace 扩展 `assets.*`（约 20 key），zh/en 同步；
- 单测（Vitest）：asset.repo（路径沙箱校验、重名序号、名称清洗、递归统计 mock fs）、project.repo（create 建 workspace+目录、remove 连带删、list 过滤 projectId）、chat.service 工具过滤（若硬隔离落地）；前端：AssetsPane 列表渲染/排序/面包屑、上传流；
- 手动验收清单随实施计划产出（含拖拽、大文件、超配额、@ 引用、删除项目连带清理磁盘）。

## 6. 三期展望（不改）

计划（表格/看板/自定义字段）+ 任务（个人清单），`planItem` 表 v4 迁移，另立 spec。

## 7. 风险

1. **workspace 语义扩展**：资产空间混入 workspace 体系，所有遍历 workspace 的代码面（侧边栏树、全局搜索、自动化任务选空间）需逐一核查过滤——实施计划含全面 grep 核查任务；
2. **webUtils 桥**：preload 暴露方式依赖 Electron 44 API 稳定性，spike 验证；
3. **大目录性能**：懒统计（仅当前层）控制 stat 范围，超大项目（万级文件）列表分页留待后续。
