# 桌面端迁入 apps/tianshu-desktop——monorepo 根目录纯壳化设计

- 日期：2026-11-04
- 状态：已获批（方案 A：完整形态一次到位），待实施
- 批次：desktop-apps-migration（worktree `worktree-desktop-apps-migration`）
- 关联：`docs/superpowers/specs/2026-10-17-shared-core-refactor-design.md`（packages/* 由来）、`2026-10-18-packaging-design.md`（vite external 互锁铁律出处）

## 1. 背景与动机

桌面端源自 shu-electron-starter 脚手架（根即应用形态）；server/mobile 后经 git subtree 并入，形成 `apps/*` + `packages/*` 主流惯例布局，但桌面端本体（electron/、src-react/、prisma/ 等）仍留在仓库根，导致三处不标准：

1. **根即应用**：根目录同时承担 workspace 壳与桌面应用本体两种角色；
2. **依赖混装**：根 package.json 挂着全部桌面端依赖（react/tailwind/radix 全家桶…），边界不清；
3. **三端不对称**：server/mobile 住 `apps/`，桌面端住根。

本设计将桌面端整体迁入 `apps/tianshu-desktop/`，根目录纯壳化，依赖同步分家。

## 2. 目标与非目标

**目标**：桌面端 `git mv` 进 `apps/tianshu-desktop/`；package.json 分家（桌面带走自己的 dependencies + devDependencies，根只留工具链与壳配置）；全部断点改写后三 OS CI 矩阵绿、本地构建/测试/e2e 全绿。

**非目标**：

- 不动 `apps/tianshu-server`、`apps/tianshu-mobile`（subtree 前缀与内容零改动）；
- 不动 `packages/` 源码与 drift 巡检脚本本体（manifest 路径前缀除外）；
- 不引入 turborepo/nx 等编排工具，不升级任何依赖版本（依赖只改声明位置）；
- 不做依赖清理/瘦身（除摘除 expo extends 残留，见 §5）。

## 3. 目标布局

```
mirror/                              # 纯壳：只留仓级事物
├── package.json                     # workspaces + 委托脚本 + overrides/allowScripts/postinstall
├── package-lock.json                # 分家后全量重排
├── .github/ .gitignore .gitattributes .dockerignore
├── CLAUDE.md  README.md  README.en.md  LICENSE
├── docs/                            # 仓级文档留守（update-log.md 由 desktop 跨界引用，同 packages 模式）
├── packages/                        # 不动（check-drift 的 mirrorRoot 锚点在本层）
│   ├── tianshu-protocol/
│   └── tianshu-core/
└── apps/
    ├── tianshu-desktop/             # ★ 桌面端新家
    │   ├── package.json             # 新建：name tianshu-desktop，依赖分家
    │   ├── electron/  src-react/  prisma/  public/  tests/  scripts/
    │   ├── index.html  vite.config.ts  electron-builder.json5
    │   ├── tsconfig.json  tsconfig.node.json  tsconfig.witness.json
    │   ├── vitest.config.ts  vitest.e2e.config.ts  vitest.relay-e2e.config.ts
    │   └── eslint.config.js
    ├── tianshu-server/              # subtree，不动
    └── tianshu-mobile/              # subtree，不动
```

命名随先例（tianshu-server / tianshu-mobile）：目录 `apps/tianshu-desktop`，包名 `tianshu-desktop`。

## 4. package.json 分家

### 4.1 根（壳）

- `name: tianshu`、`private: true`、`type: module`（根级 eslint.config.js 为 ESM）、`workspaces` 原样；
- `overrides`（rxjs）原样；`allowScripts` 原样留守（install-scripts 白名单只在安装根生效，依赖声明迁入 workspace 不改变其判定域）；
- **scripts**：
  - 委托脚本（肌肉记忆不变）：`dev` / `build` / `typecheck` / `typecheck:witness` / `lint` / `init` / 全部 7 条 `test:e2e:*` → `-w apps/tianshu-desktop` 透传；
  - `test` = `npm run test -w apps/tianshu-desktop && npm run test:packages`；
  - `lint` = `eslint . && npm run lint -w apps/tianshu-desktop`（根 config 只管 packages/*，见 §6.4）；
  - `test:packages` = `vitest run --config vitest.packages.config.ts`（新增配置，见 §6.3）；
  - `check:drift` 原样（脚本路径 `packages/...` 自根解析不变）；
- **postinstall**：`electron-builder install-app-deps --project-dir apps/tianshu-desktop && (bash apps/tianshu-mobile/scripts/restore-local-nativewind.sh || echo '[warn] nativewind 本地树恢复失败——下次移动端真机若卡 99.9%,手动重跑该脚本')`；
- **devDependencies 只留工具链**：`typescript`、`prettier`、`eslint` 栈（@eslint/js、eslint-config-prettier、eslint-plugin-prettier、typescript-eslint、globals）、`vitest`。根不再有 `dependencies`、不再有 `main`。

### 4.2 桌面（apps/tianshu-desktop/package.json）

- `name: tianshu-desktop`、`version: 0.1.0`、`private: true`、`type: module`、`main: dist-electron/main.js`；
- **`dependencies` 六包集合原样照搬**：`@modelcontextprotocol/sdk`、`better-sqlite3`、`mermaid`、`moment`、`node-pty`、`pg`——
  **互锁铁律立此存照**：desktop `dependencies` ≡ vite 主进程 external 白名单互锁集合（electron-builder 装 prod 依赖，打包态 require 才可解析；vite.config.ts external 列表与该集合互锁，golden 契约口径不变，只是读包从根换成 desktop；终审注记：严格为 ⊇ 关系——mermaid 在 dependencies 而 external 列表未列，渲染层打包内联，系基线既有不对称，本批原样保留）；
- 其余全部现根 devDependencies 跟随迁入（electron、electron-builder、langchain 栈、react 栈、vite 栈、vitest 等）；**摘除 `expo-router`**（根 tsconfig extends expo 时代的残留，桌面代码无 import，实证见附录 A-10）；
- scripts：`dev`/`build`/`typecheck`/`typecheck:witness`/`lint`/`test`/7 条 `test:e2e:*`/`init` 原文随迁（命令体不变，cwd 变为 desktop 自身）；另加 `rebuild:native: electron-builder install-app-deps`（postinstall 回退方案用，见假设 A1）。

## 5. 构建链改写

| 文件 | 改写 | 依据 |
|---|---|---|
| `apps/tianshu-desktop/vite.config.ts` | `@tianshu/protocol|core` 别名**两处**（顶层 + main.vite）→ `path.resolve(__dirname, "../../packages/tianshu-*/src")`；`./docs/update-log.md` → `../../docs/update-log.md` | 附录 A-vite |
| 同上 | 其余零改动：dist-electron 清空/资产拷贝（script、builtin-skills）、`readJsonSync(__dirname/package.json)` 版本号、external 列表全部相对自洽 | 附录 A-1 |
| `apps/tianshu-desktop/tsconfig.json` | `@tianshu/*` paths → `../../packages/...`；**摘除 `"extends": "expo/tsconfig.base"`** | 假设 A2（showConfig 验证） |
| `tsconfig.node.json` / `tsconfig.witness.json` | 零改动（include 相对自身，extends 链同目录） | 附录 A-ts |

electron-builder.json5 零改动：`files`、`directories.output`、`afterPack: electron/after-pack.cjs`、icon `public/pc_logo.*` 全部相对 app 目录自洽。

## 6. 测试链改写

### 6.1 desktop vitest.config.ts

- 别名同款 `../../packages`；include 改为 `tests/**` + `scripts/**/*.test.mjs`（均已在 desktop 内），**删去 `packages/*/src/**/*.test.ts`**（归属根，见 6.3）；setupFiles `tests/setup.ts` 不变。

### 6.2 tests 层级修正（tests 下沉两级 → 指向根级的相对路径全部 +2 层）

- 新增 `apps/tianshu-desktop/tests/lib/paths.ts`：`export const MIRROR_ROOT`（fileURLToPath 上溯仓根）——替换 5 处重复的 MIRROR_ROOT 手算（e2e-helpers.ts:42、e2e-relay-e2e.ts:128、relay-transport.test.ts:25、e2e-graph-search-pg.ts:55、drift-manifest.test.ts:14；上溯层数 3→5，手算易错且重复，符合仓库"重复≥2 抽函数"规约）；
- ~12 个文件的 `../../packages/...`（+2 层）/`../../../packages/...`（+2 层）/`../../docs/demo-app`（+2 层）机械改层数，清单见附录 A-2；
- `tests/ai/drift-manifest.test.ts` 改用 MIRROR_ROOT helper；其对**根** package.json `check:drift` 的断言保持有效（脚本留根）。

### 6.3 新增根 vitest.packages.config.ts

- include `packages/*/src/**/*.test.ts`；`@tianshu/*` alias → `packages/*/src`；mini setup（tmpdir 隔离 TIANSHU_DATA_ROOT，语义对齐原 tests/setup.ts 的隔离意图）；
- 归根跑的理由：规避 vitest include 越界 glob（`../..`）的不确定性（假设 A5）；packages 无自己的 devDeps，为两个包配独立 runner 属过度工程。

### 6.4 eslint 拆分

- `eslint.config.js` 随迁 desktop：ignores 删去 `"apps"` 条目（其余 `electron/infrastructure/prisma`、`electron/generated`、`public` 相对生效不变）；
- 根新留精简 `eslint.config.js` 只管 `packages/*`（ignores 保持 `apps` 整体排除；死条目清理）；
- 至此三端各自 lint（server/mobile 本就自带 config），根管 packages——与 CI 分工一致。

### 6.5 scripts/ 内部

- `scripts/init.mjs`：`rootDir = __dirname/..` 随迁后自然指向 desktop，**零改动**（IGNORE_DIRS 按目录名匹配，不受层级影响；`shu-init.json` 落 desktop）；
- `scripts/smoke/lib.mjs`：REPO=上两级随迁后自然等于 desktop app 目录，唯 **electron 定位需改**——`REPO/node_modules/electron` 直拼在 workspace 化后失效（依赖 hoist 至根 node_modules），改为 `createRequire(REPO/package.json).resolve("electron")` 沿 node_modules 上溯解析；playwright-core 的 createRequire 解析同理自动上溯，无需改；
- `scripts/smoke/README.md` 用法表述同步。

## 7. drift 守护（mirror ↔ server 双份基线）

- `packages/tianshu-core/scripts/check-drift.mjs` **零改动**（mirrorRoot 锚定 packages/tianshu-core/scripts 上溯三级 = 仓根，packages 留根故不变）；
- `packages/tianshu-core/scripts/drift-manifest.json`：54 条 `mirrorPath` 批量加 `apps/tianshu-desktop/` 前缀（49 条 `electron/`、4 条 `src-react/`、1 条 `prisma/schema.prisma`）；基线行数不动（归一化 diff 与文件路径无关）；`serverRoot` 不变；
- 前缀批处理用脚本化 sed 完成（54 条手改必漏），跑一遍 `npm run check:drift` 全 OK 验收。

## 8. CI 与 Docker

### 8.1 ci.yml

- ci job（桌面）：install 留根；`npm run lint` / `typecheck` / `test` 走根委托（天然覆盖 desktop + packages）；`npx vite build` 步加 `working-directory: apps/tianshu-desktop`；`npm rebuild better-sqlite3` 留根（hoist 布局下包仍在根 node_modules，假设 A7）；
- server / mobile 两个 job：零改动。

### 8.2 release.yml

- release job：typecheck / vite build / electron-builder 三步加 `working-directory: apps/tianshu-desktop`；产物 glob `release/**` → `apps/tianshu-desktop/release/**`（Upload + Attach 两处）；
- android job：零改动。

### 8.3 .dockerignore（server 镜像根 context）

- 补 `apps/tianshu-desktop`（`apps/tianshu-mobile` 已有同款先例；server 镜像 `npm ci` 对缺席 workspace 的容忍已被 Relay 镜像构建实证，假设 A3）；
- 清死条目：根级 `dist-electron`、`src-react`、`tests`、`release`（迁移后根不再有这些目录）；`docs` 条目保留（docs 留守仍需排除）；
- `apps/tianshu-server/docker-compose.yml` 的 `context: ../..` 与 Dockerfile COPY 集合不变（根 package.json + lock + packages + apps/tianshu-server 仍齐备）。

## 9. 运行时行为变化与数据处置

| 项 | 变化 | 处置 |
|---|---|---|
| dev 日志（`electron/commons/Log.ts:16` `process.cwd()/logs`） | 落点根 `logs/` → `apps/tianshu-desktop/logs/` | 新落点被未锚定的 `logs` 规则自动忽略；旧 `logs/` 原地保留不删 |
| 遗留库迁移源（`electron/commons/tianshu-data.ts:83` `getAppPath()/database`） | getAppPath() 变为 apps/tianshu-desktop 后找不到根 `database/local.db`，迁移静默跳过（幂等设计如此） | **不动用户数据**：真实开发库早已在 `~/.tianshu`；实施时先做 mtime 比对，若根库反而更新则停下问询（假设 A4） |
| `.expo/`、`.vitest/`（根缓存） | 不再在根生成 | `git ls-files` 核实 tracked 状态后随垃圾清理步处置，未 tracked 则留垃圾不删 |
| dist / dist-electron / release / node_modules | 全部在 desktop 下重新生成 | 本地产物不迁不删，自然再生 |

electron 侧其余路径实证全部自洽：main.ts APP_ROOT（__dirname/..）、builtin-skills、script/vN 升级脚本、prisma generated（`import.meta.url` 自定位且已入库）、skill.repo getAppPath()/electron/resources、app-info getAppPath()/package.json（desktop package.json 存在后成立）。`startLocalServer` 的 projectDir 全程由渲染层传入，无仓内相对假设。

## 10. 根目录垃圾清理（随批 git rm）

`.probe-*.mjs`（8 个）、`.reset-probe.txt`、`.face-cors-proxy.mjs`、`.fix-workflow-refresh.patch`、`.fix-backup/` ——已实证全部为无仓相对引用的一次性调试遗留（绝对路径 import / /tmp token / 端口打点）。若不欲清理，剔除本节即可，其余设计不受影响。

## 11. 文档同步

- `CLAUDE.md`：monorepo 布局段重写（根=壳）、全部命令跑法（根委托 + `-w apps/tianshu-desktop`）、共享包消费方式措辞（mirror→desktop）、`check:drift` 路径不变；
- `README.md` 与 `README.en.md` **同任务内同步**（双语同构镜像铁律）；
- `apps/tianshu-server/README-relay.md` 中"monorepo 根 context"表述核对（预计不变）。

## 12. 迁移手法

- worktree `worktree-desktop-apps-migration` 内执行（本 spec 首个提交落此分支），基线已校验为本地 main b3c8ce54；
- `git mv` 逐顶层条目搬迁保 rename 追踪：electron/、src-react/、prisma/、public/、tests/、scripts/、index.html、vite.config.ts、electron-builder.json5、tsconfig.json、tsconfig.node.json、tsconfig.witness.json、vitest.config.ts、vitest.e2e.config.ts、vitest.relay-e2e.config.ts、eslint.config.js；
- 顺序：spec 提交 → 搬迁 + 双 package.json 定稿 + `npm install`（lock 重排）+ 别名等最小修复 → 改写批（tests 层级 + helper、manifest 前缀、eslint 拆分、smoke electron 解析、CI、dockerignore、垃圾清理）→ 文档批；
- commit 拆分：① `docs(specs)` 本 spec；② 搬迁+分家+可构建可测；③ 改写批；④ 文档批；
- 老规矩：worktree 各自构建不回写主树；合并后主树需 `npm install` 刷新 node_modules（lock 大变）。

## 13. 验证门（全绿才收口）

1. worktree 全新 `npm install`（postinstall 链路含 install-app-deps + nativewind 恢复）；
2. 根 `npm run typecheck` / `lint` / `test`（desktop + packages）/ `check:drift`（54 对全 OK）；
3. `npm run test:e2e:relayE2E`（真 relay 子进程，MIRROR_ROOT 改写的直接验收）+ `test:e2e:server`（spawn server dist 链路）；
4. `tsc --showConfig` 前后 diff（expo 摘除无选项漂移）；
5. `npm run test -w apps/tianshu-server` + `npm run typecheck -w apps/tianshu-mobile`（零扰动确认）；
6. `npm run build -w apps/tianshu-desktop`（tsc + vite + electron-builder mac 本地打包冒烟，产物在 apps/tianshu-desktop/release/）；
7. PR CI 三 OS 矩阵绿；
8. 桌面 dev 启动冒烟——**用户亲自起**（`npm run dev`），提供命令即可。

## 14. 假设与风险单

| # | 假设 | 验证/回退 |
|---|---|---|
| A1 | `electron-builder install-app-deps` 认 `--project-dir` | 实测 `-h`；回退：根 postinstall 改 `npm run rebuild:native -w apps/tianshu-desktop`（desktop script 已备） |
| A2 | 摘除 `expo/tsconfig.base` extends 后 resolved options 不变 | `tsc --showConfig` 前后 diff；有差异则内联等效项 |
| A3 | server 镜像 npm ci 容忍 workspace 目录缺席（dockerignore 排除 desktop） | mobile 先例实证（Relay 镜像在 mobile 缺席下构建绿）；PR CI 复验 |
| A4 | 根 `database/local.db` 为已迁移历史残留 | 实施首步 mtime 比对 `~/.tianshu` dev 库；根库更新则停下问询 |
| A5 | vitest include 不写越界 glob | packages 测试移根 config，结构上规避 |
| A6 | 命名 `apps/tianshu-desktop` / `tianshu-desktop` | 先例对齐，无验证需求 |
| A7 | 根 `npm rebuild better-sqlite3` 在依赖声明移入 workspace 后仍作用于 hoisted 副本 | CI 实证；回退：`-w apps/tianshu-desktop` 形态 |

## 附录 A：断点改写清单（2026-11-04 扫描实证，行号基于 b3c8ce54）

**A-1 electron/ 运行时（除 2 处行为项见 §9 外全部自洽跟随）**：main.ts:36 APP_ROOT、main.ts:44,163 public、Application.ts:189-194,218 script/docs 资产（断点在 vite.config 拷贝行，§5 已列）、skill.repo.ts:164、app-info.service.ts:45、generated/prisma（自定位+已入库）、prisma/schema.prisma:3 output 相对路径、connections.ts:799-886 projectDir 由渲染层传入。

**A-2 tests/ 改层数文件**（+2 层）：tests/core/workspace-files-scan.test.ts:12；tests/security/master-key.test.ts:56；tests/ai/crypto-envelope.test.ts:7、graph-typed-inputs.test.ts:47-48、graph-http-guard.test.ts:5、graph-input-schema.test.ts:15,19、tool-alias.test.ts:30、demo-app-graphs.test.ts:19,21（docs 同）；tests/ai/backup/backup-archive-crypto.test.ts:11、backup-ipc.test.ts:22（+2 层，原 3 层）。

**A-3 MIRROR_ROOT 手算五处**（§6.2 helper 收敛）：tests/ai/server/e2e-helpers.ts:42-45、e2e-relay-e2e.ts:128-131、relay-transport.test.ts:25-27、e2e-graph-search-pg.ts:55-61、tests/ai/drift-manifest.test.ts:14-18。

**A-4 scripts/**：init.mjs:11 零改动（rootDir 随迁自然正确）；smoke/lib.mjs:17,54,96,115,162-175 唯 electron 定位改 createRequire 解析（§6.5）。

**A-5 eslint.config.js**：ignores 11-20 行——desktop 侧删 `"apps"`；根侧死条目清理（§6.4）。

**A-6 CI**：ci.yml:21-44（ci job 三步改写）；release.yml:17-54（release job 三步 + 两处产物 glob）。

**A-7 .dockerignore**：补 `apps/tianshu-desktop`、清 4 死条目（§8.3）。

**A-8 drift**：drift-manifest.json 54 条 mirrorPath 前缀（§7）；check-drift.mjs:29 mirrorRoot 不变。

**A-9 server 反向引用**：sync:core `--prefix ../../packages`（相对 server，不变）、jest rootDir（不变）、Dockerfile/docker-compose COPY 集（不变，lock 重排见 §8.3）。

**A-10 src-react/**：index.html `/src-react/main.tsx`（vite root 相对，跟随）；src-react↔electron 双向相对 import ~45 处层级关系不变全部跟随；24 处 `@tianshu/*` import 断点仅在 alias 登记（§5）；无 expo-router import（摘除依据）。

**A-11 零散**：.face-cors-proxy.mjs / .probe-* / .reset-probe.txt / .fix-* 无仓相对引用（§10 清理）；.gitattributes 无路径规则；.gitignore 锚定项 `/database`、`/release-t3-orig/`、`/generated/prisma` 留根不动（其目标物留根），未锚定的 dist/dist-electron/release/logs 规则自动覆盖新落点。
