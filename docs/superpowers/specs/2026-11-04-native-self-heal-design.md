# 原生自愈 setup:native——postinstall 一次跑齐三件事（spec+plan 合一，单任务批）

- 日期：2026-11-04；批次：native-self-heal（worktree `worktree-native-self-heal`，基线 e7fc5258）
- 状态：设计已获用户批准（双 ABI 事故 + nativewind 雷同日踩响后的根治提议）
- 关联：`2026-11-04-abi-dual-copy-design.md`（双 ABI 机制与事故勘误）

## 1. 问题与目标

根目录任何一次 npm reify 都可能静默破坏三处原生/本地状态，且破坏不报错、到用时才炸：

1. **主树 better-sqlite3 被 flip/清掉**（reify 重装拉 node 预编译 → dev 报 ABI 错；`rebuild:native` 因 prebuild-install"已存在即跳过"是静默空转，且 Electron 44（v149）根本无预编译产物，下载路线死路——详见 abi-dual-copy spec 勘误）
2. **vitest 的 node-ABI 副本缺失**（`.native-node/`，已有 setup-native-node.mjs 但只此一件）
3. **mobile 本地 nativewind 被 npm 当多余包清掉**（99.9% 卡死哨兵拦在 expo 启动；今日实证）

目标：一个编排脚本 `apps/tianshu-desktop/scripts/setup-native-all.mjs` + 根 script `npm run setup:native`，postinstall 末段替换现有散链——**每次 install 自动把三处验齐/修好**，分级大声报告，任何一处失败即非零退出（让 postinstall warn 段可见触发）。

## 2. 设计

### 2.1 编排脚本三段（顺序执行，各自 OK/WARN/FAIL 报告；任一 FAIL → exit 1）

**段 1：electron 主树二进制自愈（better-sqlite3）**
- **验**：`node -e 'new (require(<主树包>))(":memory:")'`——抛错且报文含 `NODE_MODULE_VERSION 149`（electronVersion 由 `node_modules/electron/package.json` 实装版读取，不硬编码）→ 健康；能跑通（node-ABI）/ bindings 缺失 → 需修
- **修三级瀑布**（逐级验后通过才收手，成功后写冷缓存）：
  - a. 冷缓存 `~/Library/Caches/tianshu/native/better_sqlite3-<electronVer>-<pkgVer>-<platform>-<arch>.node` 命中即回写
  - b. 本机已装 app 的 asar：glob `/Applications/天枢.app` 与 `~/Applications/天枢.app`，经 `require("@electron/asar")` 读 asar 内 `node_modules/better-sqlite3/package.json` 版本比对主树一致才抽二进制
  - c. 源码编译：清主树包 `build/` 后从 desktop 目录跑 `npx @electron/rebuild -f -v <electronVer>`（无 `-w` 过滤），验后再清再试一次 `-w better-sqlite3`；**本批实施须实测出能真正编到 better-sqlite3 的调用形态**（今日它只编 node-pty 的发现机制问题待查明并记录）；两级都拿不到 → FAIL 并打印 asar/手动修指引
  - 每级修完立即重跑"验"，通过才进入下一处
- 跨平台注意：段 b 仅 darwin 有效（glob 不到即跳级）；Windows 依赖 a/c；`npx`/路径全部 node spawn（复用 abi-dual-copy 批的 `process.execPath` + npm-cli 三落点探测法，可抽公共小函数或复制）

**段 2：vitest 副本（委托既有 setup-native-node.mjs）**
- spawn `node apps/tianshu-desktop/scripts/setup-native-node.mjs`，其内置 construct 自检即验；退出码透传为段状态

**段 3：mobile 本地 nativewind**
- 先**验**：`require.resolve("nativewind/package.json", {paths:[mobileDir]})` 落在 `apps/tianshu-mobile/node_modules/` 内 → 已健康直接 OK（幂等快路径，避免每次 install 都白跑恢复脚本）
- 不健康 → spawn `bash apps/tianshu-mobile/scripts/restore-local-nativewind.sh`（win32 无 bash 则直接 WARN 跳过）→ 再验 → 仍不健康 FAIL

### 2.2 接线

- 根 package.json：scripts 增 `"setup:native": "node apps/tianshu-desktop/scripts/setup-native-all.mjs"`；postinstall 改为 `npm run rebuild:native -w apps/tianshu-desktop && node apps/tianshu-desktop/scripts/setup-native-all.mjs || echo '[warn] 原生自愈未全成——跑 npm run setup:native 看分级报告'`（原 nativewind 段与 copy 段并入编排脚本，不再单列）
- 旧入口 `setup:native-node`、`rebuild:native` 保留不动（单项修复入口）
- CLAUDE.md「构建注意事项」双 ABI 三行后补一行自愈口径
- 记忆更新：desktop-apps-migration-batch 的"根治方向挂账"改为已落地

### 2.3 假设/风险单

| # | 项 | 处置 |
|---|---|---|
| A1 | @electron/rebuild 对 hoisted better-sqlite3 的发现机制不明（今日只见 node-pty） | 实施首步专项探明；查不出则段 c 降级为 FAIL+指引（a/b 冷缓存与 asar 已覆盖常见场景，首次成功后 a 永久秒修） |
| A2 | asar 抽取依赖本机装过同版本 app | glob 不到跳级；冷缓存先行降低依赖 |
| A3 | 段 b 版本不一致（app 旧版） | 版本比对不过即跳级，绝不动主树 |
| A4 | postinstall 整链 `|| echo` 吞掉 rebuild:native 的真实失败 | 维持现状语义（rebuild:native 历史上就是 warn 域；编排脚本的段级报告才是权威） |

### Task 1: setup:native 编排脚本落地

**Files:**
- Create: `apps/tianshu-desktop/scripts/setup-native-all.mjs`
- Modify: 根 `package.json`（setup:native + postinstall）、`CLAUDE.md`（一行）
- 记忆文件（收尾时 controller 自理，非任务内）

**Steps:**
1. 实测探明 A1：`npx @electron/rebuild -f -v 44.1.1`（无过滤，desktop 目录）在"主树 build/ 已清"态能否编到 better-sqlite3；两种形态都试，结果与结论写入报告（无论成败，脚本段 c 按实证形态写）
2. 写编排脚本（§2.1 三段 + 分级报告 + 汇总表 + 任一 FAIL exit 1；新代码 prettier 双引号分号）
3. 根 package.json 接线（§2.2）；CLAUDE.md 补行
4. **破坏性三连自测（门禁）**——每件先破坏再 `npm run setup:native`，期望全 OK 且汇总表绿：
   - a. 主树二进制替换为副本的 node-ABI 产物（cp .native-node 的 .node 过去）→ 段 1 应经缓存/asar 瀑布修回（首次走 b，修回后缓存文件应存在；再破坏一次应走 a 秒修）
   - b. 删 `.native-node` 整目录 → 段 2 重装自检过
   - c. `mv apps/tianshu-mobile/node_modules/nativewind /tmp/nw-bak` → 段 3 恢复并验解析路径
5. 完整回归：`rtk proxy npm run test -w apps/tianshu-desktop` 全绿（自愈未伤任何东西）；主树探针仍 Electron-ABI
6. Commit `feat(desktop): 原生自愈 setup:native——postinstall 三件套（electron 二进制瀑布/副本/nativewind），reify 后自动归位` + push
7. 报告（含 A1 探明结论 + 三连自测证据 + 汇总表样例）

## 4. 验证门

三连破坏自测全绿 + desktop 全量 vitest 绿 + 主树探针 Electron-ABI + push 确认。dev/expo 启动冒烟归用户。
