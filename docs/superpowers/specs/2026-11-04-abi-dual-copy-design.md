# 双 ABI 根治——node-ABI better-sqlite3 副本 + vitest alias（spec+plan 合一，单任务批）

- 日期：2026-11-04；批次：native-abi-dual-copy（worktree `worktree-native-abi-dual-copy`，基线 ae8c8296）
- 状态：方案①已获用户批准（桌面端迁移批收尾对话中的四方案对比表选项 1）
- 关联：`2026-11-04-desktop-apps-migration-design.md`（迁移后暴露的 ABI 摇摆问题的根治）

## 1. 问题与原理

Electron 44 内嵌 Node（ABI 149）与系统 Node（ABI 147）是两个运行时，`better_sqlite3.node` 一份二进制只能面向一个。现状靠手动/CI 倒腾（dev/打包 ↔ Electron ABI；vitest 真库用例 ↔ node ABI）。本批根治：**树里常备两份 better-sqlite3**——主 `node_modules` 副本常驻 Electron ABI（dev/打包消费，`vite external` 走原生 require 不经任何 alias）；`apps/tianshu-desktop/.native-node/` 副本常驻 node ABI，desktop vitest 经 alias 全依赖图消费（含 `@prisma/adapter-better-sqlite3` 内部的 `require("better-sqlite3")`；e2e/relay 配置经 spread 继承）。两端互不干扰，永不 rebuild 切换。

better-sqlite3 的 bindings 按包自身路径定位 `.node` 文件——独立 prefix 安装的副本天然成立，这是本方案的可行性根基。

## 2. 设计决定（批内自主裁定）

| # | 决定 | 依据 |
|---|---|---|
| D1 | 副本目录 `apps/tianshu-desktop/.native-node/`，gitignore 未锚定条目 `.native-node` | 靠近唯一消费者（desktop vitest） |
| D2 | 版本自同步：装配脚本读主树 `node_modules/better-sqlite3/package.json` 实装版本做 exact 安装 | 永不与 lock 漂移 |
| D3 | 副本目录**预置** package.json 携带 `allowScripts: {"better-sqlite3@<ver>": true}` | npm 11 install-scripts 白名单按安装根判定——`npm install --prefix` 到无白名单目录会被拦掉 prebuild-install（假设 A1 的直接对策，使 A1 不可失败） |
| D4 | postinstall 追加装配段，warn-through（对齐 nativewind 段风格）；修复命令 `npm run setup:native-node` | 装配失败不该把整个 install 染红（dev 不受影响，测试会以清晰报错暴露） |
| D5 | CI 删除 "Rebuild better-sqlite3 (node ABI)" 步（含其注释块） | vitest 改读副本后该步成死步；postinstall 在 CI 同样装副本 |
| D6 | alias 只加 desktop `vitest.config.ts` | packages 测试纯函数不触原生；Electron 侧不经 vitest 不受影响 |

## 3. 假设单

| # | 假设 | 验证 |
|---|---|---|
| A1 | `npm install --prefix` 受安装根 allowScripts 管辖 | D3 预置白名单使假设无需成立即可过；实测装配自检（脚本内 require 冒烟）为准 |
| A2 | 无 vitest 用例以 alias 捕获不到的形态引用 better-sqlite3 | 门禁：postinstall 后**零 rebuild 前置**直跑 desktop 全量测试绿 |
| A3 | CI 三平台 postinstall 装副本成功（prebuild-install node 资产全平台） | push 后矩阵绿 |
| A4 | `@prisma/adapter-better-sqlite3` 的 require 被 vitest alias 捕获（vite alias 作用于依赖图全域） | 同 A2 门禁（真库用例即走 adapter） |

### Task 1: 双 ABI 根治落地（副本装配 + alias + CI）

**Files:**
- Create: `apps/tianshu-desktop/scripts/setup-native-node.mjs`
- Modify: `apps/tianshu-desktop/vitest.config.ts`（alias 增项）、根 `package.json`（scripts 增 `setup:native-node` + postinstall 追加段）、`.gitignore`（增 `.native-node`）、`.github/workflows/ci.yml`（删 Rebuild 步+注释）

**Steps:**

1. 写 `apps/tianshu-desktop/scripts/setup-native-node.mjs`（全文见 §5）
2. `.gitignore` 追加一行 `.native-node`
3. desktop `vitest.config.ts` 的 resolve.alias 增（放在 `@tianshu/*` 之后）：

```ts
      // 双 ABI 根治（2026-11-04-abi-dual-copy）：vitest 全依赖图（含
      // @prisma/adapter-better-sqlite3 的 require）改吃 .native-node 的
      // node-ABI 副本；主 node_modules 常驻 Electron ABI 供 dev/打包
      "better-sqlite3": path.resolve(
        __dirname,
        ".native-node/node_modules/better-sqlite3",
      ),
```

4. 根 package.json：scripts 增 `"setup:native-node": "node apps/tianshu-desktop/scripts/setup-native-node.mjs"`；postinstall 末尾追加 `&& (node apps/tianshu-desktop/scripts/setup-native-node.mjs || echo '[warn] node-ABI 副本装配失败——真库测试前先跑 npm run setup:native-node')`
5. **装配实测（双态并存证明）**：`npm install`（postinstall 走通双段+装配）→ `node -e "require('<worktree>/apps/tianshu-desktop/.native-node/node_modules/better-sqlite3')"` 成功（副本 node-ABI）→ `node -e "require('<worktree>/node_modules/better-sqlite3')"` **失败**（主树 Electron ABI——失败即证明互不覆盖）
6. **门禁（零 rebuild 前置）**：`npm run test -w apps/tianshu-desktop` 全绿；`cd apps/tianshu-desktop && npx vite build` 绿（主树 Electron ABI 未被触碰，dev/打包路径无恙）
7. ci.yml 删 Rebuild 步与注释块（§5 给 old/new）
8. Commit `feat(desktop): 双 ABI 根治——node-ABI better-sqlite3 副本 + vitest alias + CI 去 Rebuild 步` + push

## 5. 代码全文

**setup-native-node.mjs：**

```js
#!/usr/bin/env node
/**
 * node-ABI better-sqlite3 副本装配（双 ABI 根治，2026-11-04-abi-dual-copy）：
 * 主 node_modules 的 better-sqlite3 常驻 Electron ABI（dev/打包消费，vite
 * external 原生 require 不经 alias）；本脚本在 .native-node/ 装一份与主树
 * 同版本的 node-ABI 副本供 vitest 经 alias 消费——两端互不干扰，无需来回
 * rebuild。版本读主树实装值，永不漂移。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(desktopDir, "..", "..");
const targetDir = path.join(desktopDir, ".native-node");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const mainVersion = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "node_modules", "better-sqlite3", "package.json"),
    "utf8",
  ),
).version;

// 副本目录预置 package.json：npm 11 install-scripts 白名单按安装根判定，
// 预置同名条目防止 --prefix 安装把 prebuild-install 拦在门外（拿不到
// node-ABI 预编译产物）
fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(
  path.join(targetDir, "package.json"),
  JSON.stringify(
    {
      name: "tianshu-native-node",
      private: true,
      allowScripts: { [`better-sqlite3@${mainVersion}`]: true },
    },
    null,
    2,
  ) + "\n",
);

console.log(`[setup-native-node] better-sqlite3@${mainVersion} → ${targetDir}`);
execFileSync(
  npmCmd,
  [
    "install",
    "--prefix",
    targetDir,
    `better-sqlite3@${mainVersion}`,
    "--no-save",
    "--no-audit",
    "--no-fund",
  ],
  { stdio: "inherit", cwd: repoRoot },
);

// 装配自检：副本必须在系统 node 下**构造实例**成功（v12 addon 在 Database
// 构造时懒加载，裸 require 对缺 .node/错 ABI 均假绿——终审 R1 教训）；
// 失败即非零退出，让 postinstall 的 warn 段与 setup:native-node 修复入口接手
execFileSync("node", [
  "-e",
  `require(${JSON.stringify(path.join(targetDir, "node_modules", "better-sqlite3"))})(":memory:"); console.log("[setup-native-node] 副本 node-ABI 自检通过")`,
]);
```

**执行期勘误（入册）**：①自检原文字面为裸 require，因 v12 懒加载防不住坏副本态，713ef9c0 已改构造实例（上文已同步）；②Step 5 配对证明同样须构造实例（bare require 主树也 OK）；③终审 C1：vitest 模块域 `require()` 不经 vite alias——测试内裸 require better-sqlite3 的探测会静默 skip，d205663f 已把两处探测改 `await import`；④I1 落地为三落点探测（win 同层/POSIX shim realpath/lib），单公式版在 homebrew 布局 ENOENT。

**ci.yml 删除块（old，整块删）：**

```yaml
      # postinstall 的 install-app-deps 会把 better-sqlite3 编成 Electron ABI(149)，
      # vitest 跑在 node 22(ABI 127) 下加载即炸——Test 前按 node ABI 重装
      # （prebuild-install 有 node-v127 全平台资产，秒级；routes 等真库用例依赖）
      - name: Rebuild better-sqlite3 (node ABI)
        if: matrix.os != 'windows-latest'
        run: npm rebuild better-sqlite3
```

（其后的 Test 步注释里如有 ABI 相关表述一并核对；Test 步本体不动。）

## 6. 验证门

1. `npm install` 后双态并存证明（§4 Step 5 两连 require：副本成、主败）
2. 零前置 rebuild：desktop 全量 vitest 绿 + `npx vite build` 绿
3. push 后 CI 三 OS 矩阵绿（A3）
4. dev 冒烟归用户（主树 Electron ABI 未动，理论零影响）
