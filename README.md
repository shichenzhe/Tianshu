# 枢 · shu-electron-starter

> 枢者，门轴也——门之开合，皆系于枢。一切桌面应用，由此开启。

开箱即用的 **Electron + React + Prisma** 桌面应用脚手架：登录认证、SQLite 版本化迁移、
多主题、双语、自动更新、可选 AI 模块，一个模板全都有。

## 特性

- **登录认证**：本地用户 + 注册 + JWT 守卫（单机应用的基础安全）
- **版本化数据库迁移**：Prisma + SQLite，`script/vN` 逐版本升级脚本，启动时自动执行
- **多主题**：蓝/红/绿/橙四主题，CSS 变量驱动，一行切换
- **双语 i18n**：react-i18next（zh-CN / en-US），key 规范见 CLAUDE.md
- **自动更新**：electron-updater + generic 更新源，未配置时自动禁用（[自建更新服务器指南](docs/update-server.md)）
- **AI 模块（可选）**：OpenAI 兼容模型配置管理 + `ai:chat` 调用封装，不需要可整体移除（[如何移除](docs/guide.md#移除-ai-模块)）
- **多平台**：macOS / Windows / Linux 打包目标齐备
- **日志**：Winston 按日轮转，渲染进程 console 自动代理到主进程

## 技术栈

Electron 44 · React 19 · TypeScript · Vite · Prisma + SQLite · Tailwind CSS 4 ·
shadcn/ui · Zustand · React Query · react-i18next · electron-updater · Vitest

## 快速开始

```bash
# 0. 前置：全局安装 node-gyp（native 依赖编译需要）
npm i -g node-gyp

# 1. 用本模板创建仓库（GitHub "Use this template" 或）
npx degit <your-fork>/shu-electron-starter my-app
cd my-app

# 2. 安装依赖
npm install

# 3. 初始化（应用名 / appId / 更新源 / 作者 / 仓库地址，可重复运行）
npm run init

# 4. 启动开发
npm run dev

# 5. 打包
npm run build
```

> ⚠️ `npm run init` 是 `npm run build` 的硬性前置——electron-builder 会校验
> package.json 的 `name`，未 init 前的 `{{APP_NAME}}` 占位符会导致打包直接失败；
> `npm run dev` 不受影响。另外若在 init 之前执行 `npm install`，会看到 name 无效的警告，无害。

首次启动会自动创建本地 SQLite 并执行 v1 建表脚本；在登录页**注册第一个账号**即可使用。

## 目录结构

```
├── electron/          # 主进程（commons / infrastructure / domains）
│   └── domains/       # 业务域：entity + repo，IPC handler 构造时自注册
├── src-react/         # 渲染进程（components / domains / lib / i18n / routes）
│   └── domains/       # 业务域前端：api / components / views / store
├── prisma/schema.prisma
└── scripts/init.mjs   # 交互式初始化
```

**添加你的第一个业务模块** → [docs/guide.md](docs/guide.md)

## 文档

- [如何添加业务域（以 user 域为例）](docs/guide.md)
- [自建更新服务器](docs/update-server.md)

## License

[MIT](LICENSE)
