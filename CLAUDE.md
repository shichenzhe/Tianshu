# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

天枢（Tianshu）——Electron + Prisma + TypeScript + React 跨平台桌面应用（北斗第一星，意为"核心枢纽"；基于 shu-electron-starter 脚手架模板）。

**monorepo（三仓合一）**：本仓为根，`apps/tianshu-server`（NestJS 无头服务端）与 `apps/tianshu-mobile`（Expo/RN 移动控制端）经 git subtree 并入（完整历史保留，`git log --graph` 可溯）；npm workspaces 管理（根 package.json `workspaces: ["apps/*", "packages/*"]`），三端共享 `packages/*` 协议与核心逻辑包。

## 开发命令

```bash
# 开发调试
npm run dev

# 构建（TypeScript 编译 + Vite 构建 + Electron 打包）
npm run build

# 单元测试（Vitest）
npm run test

# Lint / 类型检查
npm run lint
npm run typecheck

# E2E（server / graph / bridge 通道冒烟、UI、relay 四链路抓帧）
npm run test:e2e:server
npm run test:e2e:graph
npm run test:e2e:bridge
npm run test:e2e:ui
npm run test:e2e:relayE2E

# 双份文件漂移巡检（mirror ↔ apps/tianshu-server 仍双份文件基线守护）
npm run check:drift
```

**workspace 跑法**（在仓库根执行，`-w` 作用于对应 app）：

```bash
# —— 无头服务端 apps/tianshu-server ——
npm run start:dev -w apps/tianshu-server   # NestJS watch 开发启动
npm run start:relay -w apps/tianshu-server # relay 独立进程（跑 dist，需先 build）
npm run test -w apps/tianshu-server        # Jest（或 cd apps/tianshu-server && npx jest）

# —— 移动控制端 apps/tianshu-mobile ——
npm run start -w apps/tianshu-mobile       # Expo（android / ios 同名子命令挂模拟器）
npm run test -w apps/tianshu-mobile        # Vitest
npm run typecheck -w apps/tianshu-mobile   # tsc
```

**首次安装**：需要全局安装 `node-gyp`：`npm i -g node-gyp`

## 代码架构

### 主进程/渲染进程分离

- **electron/** - 主进程（后端）

  - `Application.ts` - 应用启动入口
  - `main.ts` - Electron 主进程入口
  - `preload.ts` - 预加载脚本（IPC 桥接）
  - `commons/` - 公共工具（Winston 日志、Prisma 客户端、SQL 脚本执行器）
  - `infrastructure/` - 基础设施（外部客户端、Prisma、升级脚本、版本管理）
  - `domains/` - 业务模块后端（entity + repo 仓储模式）

- **src-react/** - 渲染进程（前端 React）
  - `routes/` - React Router（Hash 模式，含 JWT 认证守卫）
  - `components/` - 公共组件（基于 shadcn/ui）
  - `domains/` - 业务模块前端（api/、components/、views/、store/；AI 域另含 data-source/ 主机路由层、lib/ 等）
  - `lib/` - 工具函数
  - `styles/` - 全局样式

### 共享包（packages/，三端复用）

- **packages/tianshu-protocol** - 三端共享协议包（纯类型 + 常量：chunk/blocks/send 契约、中继帧、事件与能力常量，零运行时依赖）
- **packages/tianshu-core** - 三端共享核心逻辑包（chat 纯函数实现：blocks 序列化、历史截断/工具输出瘦身、参数合并、错误分类、时间/场景上下文、chunk 归一、runChatStream 工具循环；peer 依赖 @langchain/*）
- 消费方式：mirror 桌面端经 alias 直引 `packages/*/src` 源码（vite 顶层 + 主进程、vitest、tsconfig paths 各自登记）；apps/tianshu-server 与 apps/tianshu-mobile 经 workspace 依赖（package.json 里 `"@tianshu/*": "*"`，npm 不支持 yarn/pnpm 的 `workspace:` 协议字面量，名称命中 workspace 即自动链接）消费 `dist` 产物——链接由根 `npm install` 维护；改包源码后须重建 dist（server 侧 `npm run sync:core`，即依次 build 两共享包；或根 `npm --prefix packages/tianshu-core run build`），链接直读、重启即生效
- 仍双份未收编文件（有意分叉/暂保留）由 `npm run check:drift` 守护：基线 manifest 在 `packages/tianshu-core/scripts/drift-manifest.json`（serverRoot 指向 `apps/tianshu-server`，monorepo 内相对路径），差异行数增长超容差 exit 1，基线变化用 `npm run check:drift -- --rebase` 重置并人工复核

### IPC 通信

前端通过 `window.ipcRenderer` 与后端通信：

- `on()` - 监听事件
- `send()` - 发送消息
- `invoke()` - 调用方法并返回结果

### 路由结构

所有 `/module/*` 路由都需要认证。主要路由：

- `/login` - 登录页（无需认证）
- `/file-window` - 文件独立窗口（与 `/login` 平级无侧边栏；`windowId` 经 hash query 携带，独立 BrowserWindow 加载）
- `/module/ai` - AI 模块（标准侧边栏布局，索引渲染对话视图）
  - `/module/ai/new` - 新任务（`/module` 根重定向至此）
  - `/module/ai/providers` - AI 服务商/模型配置
  - `/module/ai/experts` - 专家·技能·连接器管理
  - `/module/ai/library` - 资料库
  - `/module/ai/browser` - 内置浏览器（多标签 webview + 设备模拟）
  - `/module/ai/graphs`、`/module/ai/graphs/:id` - 流程编排列表/编辑器（`automation/graphs/:id` 为旧路径兼容重定向）
  - `/module/ai/automation` - 自动化（`automation/task/:id` 任务详情）
  - `/module/ai/server` - 主机页（无头端连接管理 + 编排区遥控；会话/聊天与模型配置遥控已由单 UI 主机路由取代；伴生 apps/tianshu-server）
  - `/module/ai/monitor` - 用量监控（LLM/工具调用事件聚合）
- `/module/project`、`/module/project/:projectId` - 项目 hub / 项目工作台

### 数据库

- Prisma ORM + SQLite
- **数据根**：所有用户数据统一收敛 `~/.tianshu`（生产 `app/`、开发 `dev/` 分组隔离；Windows 为 `C:\Users\<user>\.tianshu`）。目录解析集中在 `electron/commons/paths.ts`（具名函数 `databaseDir`/`skillsDir`/`libraryDir` 等）；优先级 `TIANSHU_DATA_ROOT` 环境变量（测试经 `tests/setup.ts` 全局隔离）> `userData/data-root.json` 用户自定义（设置面板「数据目录」，`data-root-config.ts`，重启生效）> 默认 `~/.tianshu`。启动迁移在 `electron/commons/tianshu-data.ts`（`ensureTianshuData`，幂等；因 rolldown 打包后模块顺序不可依赖，由 prisma-client/Log 等顺序敏感消费者在使用前自行调用，详见其头注释）；自定义根冷拷贝默认根数据（SQLite 运行中不可搬，迁移必须先于打开连接）；Electron 自身运行时数据（Cache/Local Storage 等）留在 userData 不迁移
- 数据库文件：`~/.tianshu/<分组>/database/local.db`（迁移语义同上）
- Schema 定义：`prisma/schema.prisma`
- Prisma Client 输出：`electron/generated/prisma`
- 当前数据库版本：1（`electron/Constants.ts`；v1 为发布前全量建表脚本，已并入原 v2–v14 的全部变更；发布后 schema 变更再逐版新增 `script/vN`；业务表带 userId 隔离，IPC 层经 token 解出 userId，前端不传用户 id）
- 快照指纹守卫（`electron/infrastructure/version/snapshot-guard.ts`）：发布前直接改 v1 快照不加版——旧库 `CREATE TABLE IF NOT EXISTS` 不补列，靠快照 sha256 指纹（存 option 表 `db.v1SnapshotHash`）识别「同版本但快照已变」及版本倒挂，自动 drop 全部业务表重放 v1 重建（开发期数据可弃）

主要数据表（schema 共 31 张）：`user`、`db_version`、`option`、`provider`、`model`、`assistant`、`workspace`、`session`、`message`、`artifact`、`artifactFavorite`、`mcpServer`、`toolPermission`、`skillRecord`、`skillStat`、`automationTask`、`automationRun`、`automationStat`、`graphDefinition`、`graphRunNode`（图运行节点级执行详情，`ensureGraphRunNodeTable` 启动幂等补建）、`project`、`projectMember`、`projectBinding`、`planItem`、`planView`、`planItemAttachment`、`libraryItem`、`vectorChunk`、`llmCallEvent`、`toolCallEvent`、`securityAuditLog`

## 开发规范

### 命名规范

- 变量/函数：`camelCase`，语义化命名（如 `userList` 而非 `data`）
- 类名：`PascalCase`
- CSS 类名：`kebab-case`
- React 组件名：`PascalCase`
- 所有文件名：`kebab-case`

### 代码质量

- 遵循 SOLID 原则和 DRY 原则（重复 2 次及以上需抽取函数）
- 函数只做一件事，函数名体现功能，不超过 20 行
- 所有异常必须处理，出错提示要有用
- 复杂函数必须有单测
- 变量作用域最小化，避免全局变量

### 国际化（i18n）规范

项目使用 `react-i18next` 实现国际化，支持中文（zh-CN）和英文（en-US）两种语言。

**基础设施：**

- 配置入口：`src-react/i18n/index.ts`
- 翻译文件目录：`src-react/i18n/locales/{zh-CN,en-US}/`
- 命名空间：`common`、`layout`、`user`、`ai`、`chat`、`newTask`、`project`、`security`、`settings`
- 语言持久化：localStorage key `tianshu-locale`（由 `npm run init` 一并替换）
- 语言切换入口：用户菜单（`src-react/components/layout/UserMenu.tsx`，全局侧边栏底部）的「语言」子菜单

**编码规范：**

- **禁止在 JSX 和 JS 逻辑中硬编码用户可见的中文或英文文本**，必须使用 `t()` 函数
- 翻译 key 格式：`namespace:key`（如 `chat:newWorkspace`）、嵌套用 `.` 分隔
- 带变量的翻译使用插值：`t("key", { variable })`
- 组件中通过 `useTranslation` hook 获取 `t` 函数：`const { t } = useTranslation(["namespace1", "namespace2"])`
- `useCallback`/`useMemo` 中使用 `t()` 时，必须将 `t` 加入依赖数组
- 翻译 key 命名采用 `camelCase`，按功能模块分层嵌套（如 `ai:modelConfig.configName`）
- **禁止顶层 key 与嵌套对象 key 重名**（如同一命名空间 JSON 中同时存在 `"pageTitle": "string"` 和 `"pageTitle": { ... }`），否则 JSON 后者会覆盖前者

**新增文本的流程：**

1. 在 `zh-CN` 和 `en-US` 对应的 namespace JSON 文件中同时添加翻译 key
2. 在组件中使用 `t("namespace:key")` 引用
3. 公共文本（如"确定"、"取消"、"删除"）放在 `common` 命名空间，通过 `t("common:confirm")` 引用

### 主题颜色规范

项目支持4种主题切换（蓝色/红色/绿色/橙色），通过 `data-theme` 属性 + CSS 变量实现（见 `src-react/styles/globals.css`）。

**编写样式时，禁止硬编码具体颜色，必须使用主题变量：**

- 背景色：`bg-primary`、`bg-primary-hover`、`bg-primary-active`、`bg-primary-subtle`
- 文字色：`text-primary`、`text-primary-foreground`
- 边框色：`border-primary`、`border-primary/20`（透明度写法）
- 渐变色：`bg-gradient-to-r from-primary to-primary-active`
- 焦点环：`ring-primary`

**禁止使用** `bg-blue-*`、`text-blue-*`、`border-blue-*`、`from-blue-*`、`to-indigo-*` 等硬编码蓝色类名作为主题色，否则切换主题时颜色不会跟随变化。

### 边框样式规范

**弹出层边框**（Popover、Dropdown、Dialog 等）：

- 使用 `border-border/50` 代替 `border-border`，50% 透明度更柔和
- 圆角使用 `rounded-lg`（与项目风格一致）
- 阴影使用 `shadow-lg` 增加层次感

示例：

```tsx
<PopoverContent className="border border-border/50 rounded-lg shadow-lg">
  {/* 内容 */}
</PopoverContent>
```

**触发按钮悬停效果**：

- 悬停时背景：`hover:bg-primary-subtle`
- 悬停时文字：`hover:text-primary`
- 悬停时边框：`hover:border-primary/30`

示例：

```tsx
<Button
  variant="outline"
  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
>
  {/* 内容 */}
</Button>
```

### 代码风格

- Prettier：双引号、分号、tabWidth=2、printWidth=80、无尾随逗号
- ESLint：生产环境禁用 `console` 和 `debugger`
- 路径别名：`@/*` → `src-react/*`

### 模块化业务域

采用 DDD 风格组织，每个业务域前后端对应：

- user - 登录认证·示范域
- option - 系统选项
- ai - 可选 AI 模块（多厂商模型配置管理 + chat 调用封装；LLM 栈统一 LangChain）
- server - 无头服务端控制端域（`electron/domains/server`：Direct/Relay Transport、Supervisor 本地无头端启停、连接注册表；前端 `src-react/domains/ai/server` 主机页——连接管理列表为主体（HD-P3 收敛：无编排能力时居中独占），选中 capabilities 含 graph 的连接才展开右栏编排遥控 GraphPanel + AutomationPanel（capability 判定用连接运行时上报值，勿 import CAPABILITIES 常量做客户端判定）；协议类型单份在 `@tianshu/protocol`（mirror packages/tianshu-protocol））；relay 链路 E2E 端到端加密（握手/信封单份在 `packages/tianshu-core/src/e2e-crypto.ts`）四链路抓帧验证 `npm run test:e2e:relayE2E`（本机真 relay 子进程 + 双端真实握手栈）
- **单 UI 多主机架构（HD 批，spec 2026-10-19）**：桌面单 UI 经 HostSwitcher 在本地/远程主机间切换，聊天、会话、模型配置、专家、技能、审批对远程主机全功能可用。核心在 `src-react/domains/ai/data-source/` 主机数据源路由层——`host-route.ts` 在 api 模块内做双通道路由（本地走 invoke 原通道零行为变化，远程走调用方给定适配器闭包：server:* 通道 + 形状转换，UI 组件对路由完全透明）；chat/model/provider/assistant/session/message/skill 域与审批决议、模型配置写面（providerSave）均已路由化；workspace 协议化数据面——被控端工作空间透出（HD-A1）+ 侧栏远端 workspace 树（HD-A2，workspace 概念不跨主机）
- server-face - 桌面端被控面域（`electron/domains/server-face`：本机 HTTP/WS 控制面 + relay 客户端，供远程端遥控桌面端；无前端路由，option 表开关启停；HD-A1 起向远程端透出 workspace 数据面）

## 技术栈

- Electron 44、React 19、TypeScript 5.9、Vite 8
- Zustand（状态管理）
- React Query（服务端状态管理）
- React Router 7（路由）
- LangChain（LLM 抽象：@langchain/core + anthropic/openai/google-genai/ollama/langgraph）
- shadcn/ui + Radix UI（UI 组件）
- Tailwind CSS 4（样式）
- Lucide React（图标）
- Sonner（Toast 通知）
- Prisma 7 + better-sqlite3（ORM）
- Winston 3（日志）
- electron-updater 6（自动更新）
- Vitest（单元测试）

## 构建注意事项

- 单实例模式（生产环境只允许一个窗口）
- 硬件加速已禁用
- 构建时自动复制 `script` 与 `docs/update-log.md` 到 `dist-electron`（Prisma 客户端随主进程打包内联）
- tianshu-server 独立部署（`node dist/src/main.js` / Dockerfile），桌面端安装包**不内嵌**（2026-10-27 拆除内嵌裁定）；本地无头端仅 dev 态（spawn 兄弟仓产物，`startLocalServer` 通道保留经 IPC/脚本可达，打包态前置拒绝）；monorepo 内路径，无兄弟仓依赖
