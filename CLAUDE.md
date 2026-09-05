# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

shu-electron-starter——Electron + Prisma + TypeScript + React 跨平台桌面应用脚手架模板（从生产业务项目抽取）。

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
  - `domains/` - 业务模块前端（api/、components/、model/、views/、store/）
  - `lib/` - 工具函数
  - `styles/` - 全局样式

### IPC 通信

前端通过 `window.ipcRenderer` 与后端通信：

- `on()` - 监听事件
- `send()` - 发送消息
- `invoke()` - 调用方法并返回结果

### 路由结构

所有 `/module/*` 路由都需要认证。主要路由：

- `/login` - 登录页（无需认证）
- `/module/ai` - AI 模块（标准侧边栏布局，默认进入对话视图）
  - `/module/ai/providers` - AI 服务商/模型配置
  - `/module/ai/experts` - 专家·技能·连接器管理
  - `/module/ai/library` - 资料库
  - `/module/ai/automation` - 自动化

### 数据库

- Prisma ORM + SQLite
- Schema 定义：`prisma/schema.prisma`
- Prisma Client 输出：`electron/generated/prisma`
- 当前数据库版本：6（`electron/Constants.ts`）

主要数据表：`user`、`option`、`modelConfig`、`db_version`

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
- 命名空间：`common`、`layout`、`user`、`ai`、`chat`
- 语言持久化：localStorage key `mirror-locale`（由 `npm run init` 一并替换）
- 语言切换组件：`src-react/components/common/LanguageSelector.tsx`

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
- ai - 可选 AI 模块（OpenAI 兼容模型配置管理 + chat 调用封装）

## 技术栈

- Electron 44、React 19、TypeScript 5.9、Vite 8
- Zustand（状态管理）
- React Query（服务端状态管理）
- React Router 7（路由）
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
- 更新服务器地址由 `npm run init` 写入，未配置时自动更新禁用（见 docs/update-server.md）

## 脚手架专有

本仓库是脚手架模板，源码中内置 5 个占位符，由 `npm run init` 交互式替换（幂等，可重复运行，写入记录在 `shu-init.json`）：

- `mirror` - 应用名（package.json `name`、窗口标题、i18n localStorage key 前缀等）
- `com.xmf.mirror` - 应用 ID（electron-builder `appId`）
- `` - 更新服务器地址（`electron/Constants.ts` 的 `UPGRADE_URL` 与 `electron-builder.json5` 的 `publish.url`）
- `hjx` - 作者（打包元信息）
- `` - 仓库地址

注意：`npm run init` 是 `npm run build` 的硬性前置（占位符 name 会导致 electron-builder 校验失败）；替换逻辑见 `scripts/lib/replace.mjs`，配套单测用 `npm run test` 运行。

**移除 AI 模块**：AI 为可选模块，移除步骤见 [docs/guide.md](docs/guide.md#移除-ai-模块)。
