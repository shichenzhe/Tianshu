# 冒烟共享库（scripts/smoke）

收编历次 GUI 冒烟驱动（/tmp/tsdriver* 各 ~200 行中 ~150 行重复）的公共部分：
dev 检活保活复用、Electron 拉起、固定冒烟用户登录、冒烟空间/会话准备、
IPC 直调（token 自动注入）、截图、sqlite3 只读查询、主进程改动后重启。
目标：单次冒烟不再重写驱动脚本、不再重复冷启动。

## 快速开始

```bash
# 0) 前置（一次性）：仓库 node_modules 装 playwright-core，不进 package.json
npm i --no-save playwright-core

# 1) 库自测 = 最小示例（登录 → 展开右栏 → 截图 → 断言产物 tab 存在）
node scripts/smoke/example.mjs           # 首跑冷启动 dev 并保活；二跑复用（应 <30s）
node scripts/smoke/example.mjs --kill    # 跑完顺带终止保活 dev

# 2) 自写冒烟：照抄 example.mjs 的骨架，from "./lib.mjs" 取用 API
```

## API（lib.mjs）

| API                                      | 说明                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `withApp(opts, fn)`                      | 主入口。检活 `TIANSHU_SMOKE_PORT`（默认 **5199**）上的 dev：活着直接复用；没有则 detached 起 `npm run dev -- --host 127.0.0.1 --port <p> --strictPort` 并等就绪。fn(app) 结束后**默认不杀**（保活）；`opts.kill: true` 显式终止。opts：`{ port, kill, timeoutMs }` |
| `api(app, channel, ...args)`             | IPC invoke 直调，token 自动从页面 localStorage 读取并**末位追加**（handleUser 通道解 userId；login/create 等匿名通道忽略）                                                                                                                                         |
| `ensureLogin(app)`                       | 固定冒烟用户 `smoke`（不存在则 `user:create` 创建）：IPC `user:login` 直调 + 登录态写 localStorage 后 reload（zustand persist 不热读）。**数据保留不清理**                                                                                                         |
| `ensureWorkspace(app, token, dirPath?)`  | 冒烟空间 `smoke-ws`（默认绑 `~/.tianshu/smoke-ws`，缺目录自动建），复用优先，返回 id                                                                                                                                                                               |
| `ensureSession(app, token, workspaceId)` | 复用最新一条，否则新建，返回 id                                                                                                                                                                                                                                    |
| `shot(app, name)`                        | 截图到 `/tmp/ts-smoke/shots/<name>.png`                                                                                                                                                                                                                            |
| `sql(query)`                             | sqlite3 只读查询（`-json`，dev 库 `~/.tianshu/dev/database/local.db`，随 `TIANSHU_DATA_ROOT` 覆盖），返回数组；只放行 select/with/pragma。写库造数用 `sqlWrite`（历次冒烟插 assistant 消息块的既有模式）                                                           |
| `restartApp()`                           | 主进程改动后重启驱动实例：等 `dist-electron/main.js` 重建稳定 → 拉新 Electron → 自动恢复登录。**返回新 app**，旧句柄作废                                                                                                                                           |
| 其他                                     | `firstWindow(app)`（缓存主窗口）、`resize(app, w, h)`（默认 1440x900）、`probeVite(port)`、`killDev(port)`、`SMOKE_USER`/`DB_PATH`/`REPO` 常量                                                                                                                     |

## 设计要点

- **保活即复用**：`npm run dev` 进程树（vite + vite-plugin-electron 自己的
  Electron 实例 A）detached 存活于驱动脚本之外；每次冒烟只 `playwright-core`
  另拉一个驱动实例 B（dev 无单实例锁，SQLite WAL 双进程并存，历次冒烟同款），
  跑完关 B、dev 树留作下次复用——省掉每次 15-60s 冷启动。
- **固定用户、数据不清理**：用户 `smoke`、空间 `smoke-ws`、会话跨次复用；
  断言别依赖「全新空库」，需要干净状态时自查自建（如按标题查重）。
- **并发换端口**：多人/多任务并行冒烟时 `TIANSHU_SMOKE_PORT=5200 node xxx.mjs`
  各自起独立 dev 树，互不抢实例；默认 5199 与自用 dev（5173/5174）错开。
- **主进程改动先 `restartApp()`**：vite watch 会重建 `dist-electron/main.js`
  （等 mtime 稳定后拉新实例），渲染层改动无需重启。
- **驱动请串行跑**：restartApp/killDev 是模块级单实例状态；并发多驱动会互踩。
- **保活载体的脆弱点（自愈）**：vite 插件的 Electron A 若退出（用户手关、
  崩溃）会连带整个 `npm run dev` 退出——下次冒烟自动冷启动自愈，只是多花几秒。

## 已知边界与坑（实测）

- **与自用 dev 共存**：两个 vite 实例共享同一 `dist-electron` 构建产物，
  另一边在改主进程代码时两侧都会热重建；极端同时写入可能瞬时写坏
  main.js（下次启动失败重试即好）。端口隔离但不隔离构建目录。
- **`--remote-debugging-port` 未启用**：vite CLI 不认该参数（会启动失败），
  且 playwright `_electron.launch` 自带调试管道，无需 CDP 口。
- **会话经 IPC 直建后 UI 缓存没有**：React Query 首屏 listAll 在 app 启动时
  已取好，`ensureSession` 建完要先 `win.reload()` 再导航 `#/module/ai?session=<id>`
  （example.mjs 第 4 步）。
- **选择器走 zh-CN 文案**：如「产物面板」按钮；切 en-US 会被兜底选择器接住，
  但自定义断言建议优先 `[data-detail-panel]`/`[role=tablist]` 等结构选择器。
- **DB_PATH 不解析 data-root.json 自定义数据根**：只认 `TIANSHU_DATA_ROOT`
  环境变量与默认 `~/.tianshu`；用过设置面板「数据目录」改数据根的开发者，
  sql()/sqlWrite() 查的仍是默认 dev 库，需自行注意（应用本体行为不受影响）。
- **产物**：截图在 `/tmp/ts-smoke/shots/`；dev 日志在 `/tmp/ts-smoke/dev-<port>.log`
  （排障第一入口）；进程信息在 `dev-<port>.json`。
- **Node ≥ 20.11**（`import.meta.dirname`）；macOS 优先走
  `node_modules/electron/dist/Electron.app`，其余平台走 `node_modules/.bin/electron`。
