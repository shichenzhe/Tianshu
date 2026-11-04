# 桌面端迁入 apps/tianshu-desktop（根目录纯壳化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面端（electron/、src-react/、prisma/ 等 16 个顶层条目）`git mv` 进 `apps/tianshu-desktop/`，package.json 分家，根目录变纯 workspace 壳，全部断点改写后三 OS CI 绿。

**Architecture:** 一次到位的机械迁移 + 已定位断点改写。桌面端自持 dependencies（vite external 互锁六包）与全部 app devDependencies；根壳只留 workspaces/overrides/allowScripts/postinstall/委托脚本 + 工具链四件（typescript/prettier/eslint 栈/vitest）。drift manifest 镜像路径批量加前缀；测试相对路径按"下沉两级 = +2 个 `../`"修正并以 `tests/lib/paths.ts` 收敛仓根手算。

**Tech Stack:** npm workspaces、Vite 8 + vite-plugin-electron、electron-builder 26、Vitest 4、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-11-04-desktop-apps-migration-design.md`（断点清单在其附录 A，本计划含精确改写代码）

## Global Constraints

- 依赖互锁集合 verbatim：desktop `dependencies` ≡ `@modelcontextprotocol/sdk ^1.30.0`、`better-sqlite3 ^12.6.2`、`mermaid ^12.2.0`、`moment ^2.30.1`、`node-pty ^1.1.0`、`pg ^8.23.1`（只许多不少、一个版本号不改）。
- `apps/tianshu-server`、`apps/tianshu-mobile` **零改动**（subtree；CI android job 依赖 mobile 原样）。
- `packages/` 源码零改动；唯一例外：`packages/tianshu-core/scripts/drift-manifest.json` 的 mirrorPath 前缀。
- 命名：目录 `apps/tianshu-desktop`，包名 `tianshu-desktop`。
- 新写文件遵守 prettier：双引号、分号、printWidth 80、无尾随逗号。
- 路径改写一律相对写法，不引入平台分隔符（Windows 开发机存在）。
- 全程在 worktree `/Users/hjx/workspace/mirror/.claude/worktrees/desktop-apps-migration`（分支 `worktree-desktop-apps-migration`）内执行，主树零写。
- `README.md` 与 `README.en.md` 同批同步。
- 提交信息中文、按仓库 conventional 风格（`feat:`/`fix:`/`docs:`/`refactor:`/`chore:`）。

---

### Task 1: 搬迁与分家（git mv + 双 package.json + install + 别名最小修复）

**Files:**
- Modify: 仓库根 16 条目位置（git mv 到 `apps/tianshu-desktop/`）
- Create: `apps/tianshu-desktop/package.json`
- Rewrite: `package.json`（根，整文件重写）
- Create: `vitest.packages.config.ts`、`vitest.packages.setup.ts`（根）
- Modify: `apps/tianshu-desktop/vite.config.ts`（别名×2 处 + docs 路径）、`apps/tianshu-desktop/tsconfig.json`（paths + 摘 extends）、`apps/tianshu-desktop/vitest.config.ts`（别名 + include 删 packages）

**Interfaces:**
- Produces: 根委托脚本全集（`npm run dev|build|typecheck|lint|test|test:packages|test:e2e:*|init|check:drift`）；desktop script `rebuild:native`（postinstall 与 Task 8 用）；根 vitest packages 配置（`test:packages`）。

- [ ] **Step 1: A4 前置闸——遗留库 mtime 比对**

```bash
stat -f '%m %N' database/local.db "$HOME/.tianshu/dev/database/local.db"
```

判定：`~/.tianshu/dev` 库的 mtime **大于等于**根 `database/local.db` 的 mtime → 放行（根库为已迁移残留）。若 dev 库不存在、或根库反而更新 → **停止，问询用户**处置（不得擅动用户数据）。

- [ ] **Step 2: git mv 搬迁（保 rename 追踪）**

```bash
mkdir -p apps/tianshu-desktop
git mv electron src-react prisma public tests scripts index.html vite.config.ts \
  electron-builder.json5 tsconfig.json tsconfig.node.json tsconfig.witness.json \
  vitest.config.ts vitest.e2e.config.ts vitest.relay-e2e.config.ts eslint.config.js \
  apps/tianshu-desktop/
git status --short | head -5
```

Expected: 全部为 `R`（rename）条目，无 untracked 新文件。

- [ ] **Step 3: 创建 apps/tianshu-desktop/package.json**

```json
{
  "name": "tianshu-desktop",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build && electron-builder",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.witness.json --noEmit",
    "typecheck:witness": "tsc -p tsconfig.witness.json --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:e2e:server": "node tests/ai/server/e2e-smoke.ts",
    "test:e2e:graph": "node tests/ai/server/e2e-graph-smoke.ts",
    "test:e2e:graphPg": "node tests/ai/server/e2e-graph-search-pg.ts",
    "test:e2e:mainPg": "node tests/ai/server/e2e-main-pg.ts",
    "test:e2e:bridge": "node tests/ai/server/e2e-bridge-smoke.ts",
    "test:e2e:ui": "vitest run --config vitest.e2e.config.ts",
    "test:e2e:relayE2E": "vitest run --config vitest.relay-e2e.config.ts",
    "init": "node scripts/init.mjs",
    "rebuild:native": "electron-builder install-app-deps"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "better-sqlite3": "^12.6.2",
    "mermaid": "^12.2.0",
    "moment": "^2.30.1",
    "node-pty": "^1.1.0",
    "pg": "^8.23.1"
  },
  "devDependencies": {
    "@codemirror/commands": "^6.11.1",
    "@codemirror/lang-css": "^6.3.0",
    "@codemirror/lang-html": "^6.4.12",
    "@codemirror/lang-javascript": "^6.2.0",
    "@codemirror/lang-json": "^6.0.2",
    "@codemirror/lang-markdown": "^6.5.2",
    "@codemirror/lang-python": "^6.2.1",
    "@codemirror/language": "^6.13.0",
    "@codemirror/state": "^6.7.6",
    "@codemirror/view": "^6.43.14",
    "@dnd-kit/core": "^6.3.1",
    "@dnd-kit/sortable": "^10.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "@langchain/anthropic": "^1.5.12",
    "@langchain/core": "^1.3.2",
    "@langchain/google-genai": "^2.3.2",
    "@langchain/langgraph": "^1.6.0",
    "@langchain/ollama": "^1.3.0",
    "@langchain/openai": "^1.6.2",
    "@lezer/highlight": "^1.2.1",
    "@prisma/adapter-better-sqlite3": "^7.10.0",
    "@prisma/client": "^7.10.0",
    "@radix-ui/react-alert-dialog": "^1.1.15",
    "@radix-ui/react-checkbox": "^1.3.3",
    "@radix-ui/react-dialog": "^1.1.15",
    "@radix-ui/react-dropdown-menu": "^2.1.16",
    "@radix-ui/react-label": "^2.1.8",
    "@radix-ui/react-popover": "^1.1.15",
    "@radix-ui/react-select": "^2.2.6",
    "@radix-ui/react-slot": "^1.2.4",
    "@radix-ui/react-switch": "^1.2.6",
    "@radix-ui/react-tooltip": "^1.2.8",
    "@tailwindcss/vite": "^4.3.3",
    "@tanstack/react-query": "^5.102.8",
    "@testing-library/dom": "^10.4.1",
    "@testing-library/react": "^16.3.3",
    "@types/better-sqlite3": "^9.6.0",
    "@types/jsonwebtoken": "^9.0.9",
    "@types/mssql": "^12.3.0",
    "@types/nodemailer": "^8.0.2",
    "@types/oracledb": "^7.0.3",
    "@types/pg": "^8.23.1",
    "@types/react": "^19.2.10",
    "@types/react-dom": "^19.2.3",
    "@types/ws": "^8.18.2",
    "@vitejs/plugin-react": "^6.1.1",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/xterm": "^6.0.0",
    "@xyflow/react": "^12.12.0",
    "adm-zip": "^0.6.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "date-fns": "^4.4.0",
    "electron": "^44.1.1",
    "electron-builder": "^26.15.3",
    "electron-updater": "^6.8.9",
    "exceljs": "^4.4.0",
    "fs-extra": "^11.4.0",
    "i18next": "^26.4.1",
    "i18next-browser-languagedetector": "^8.2.1",
    "jsdom": "^30.1.0",
    "jsonwebtoken": "^9.0.3",
    "lucide-react": "^1.39.0",
    "lunar-typescript": "^1.8.6",
    "mammoth": "^1.13.0",
    "mssql": "^12.7.3",
    "mysql2": "^3.24.3",
    "nodemailer": "^7.0.13",
    "oracledb": "^7.0.1",
    "pdf-parse": "^2.4.5",
    "prisma": "^7.10.0",
    "react": "^19.2.8",
    "react-day-picker": "^10.0.1",
    "react-dom": "^19.2.8",
    "react-i18next": "^17.0.13",
    "react-markdown": "^10.1.0",
    "react-router-dom": "^7.18.3",
    "remark-gfm": "^4.0.1",
    "shiki": "^4.4.3",
    "sonner": "^2.0.8",
    "tailwind-merge": "^3.6.0",
    "tailwindcss": "^4.3.3",
    "undici": "^8.10.2",
    "vite": "^8.2.2",
    "vite-plugin-electron": "^1.1.2",
    "vite-plugin-electron-renderer": "^1.0.0",
    "vite-plugin-eslint": "^1.8.1",
    "vitest": "^4.1.11",
    "winston": "^3.19.0",
    "winston-daily-rotate-file": "^5.0.0",
    "ws": "^8.22.0",
    "zod": "^4.5.4",
    "zustand": "^5.0.15"
  }
}
```

（相对原根 devDependencies 的差异：摘除 `expo-router`（expo extends 残留）、工具链九件（@eslint/js、eslint、eslint-config-prettier、eslint-plugin-prettier、globals、prettier、typescript、typescript-eslint 留根；vitest 双侧声明）。）

- [ ] **Step 4: 重写根 package.json**

```json
{
  "name": "tianshu",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "overrides": {
    "rxjs": "^7.8.2"
  },
  "scripts": {
    "dev": "npm run dev -w apps/tianshu-desktop",
    "build": "npm run build -w apps/tianshu-desktop",
    "typecheck": "npm run typecheck -w apps/tianshu-desktop",
    "typecheck:witness": "npm run typecheck:witness -w apps/tianshu-desktop",
    "lint": "eslint . && npm run lint -w apps/tianshu-desktop",
    "test": "npm run test -w apps/tianshu-desktop && npm run test:packages",
    "test:packages": "vitest run --config vitest.packages.config.ts",
    "test:e2e:server": "npm run test:e2e:server -w apps/tianshu-desktop",
    "test:e2e:graph": "npm run test:e2e:graph -w apps/tianshu-desktop",
    "test:e2e:graphPg": "npm run test:e2e:graphPg -w apps/tianshu-desktop",
    "test:e2e:mainPg": "npm run test:e2e:mainPg -w apps/tianshu-desktop",
    "test:e2e:bridge": "npm run test:e2e:bridge -w apps/tianshu-desktop",
    "test:e2e:ui": "npm run test:e2e:ui -w apps/tianshu-desktop",
    "test:e2e:relayE2E": "npm run test:e2e:relayE2E -w apps/tianshu-desktop",
    "check:drift": "node packages/tianshu-core/scripts/check-drift.mjs",
    "init": "npm run init -w apps/tianshu-desktop",
    "postinstall": "npm run rebuild:native -w apps/tianshu-desktop && (bash apps/tianshu-mobile/scripts/restore-local-nativewind.sh || echo '[warn] nativewind 本地树恢复失败——下次移动端真机若卡 99.9%,手动重跑该脚本')"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "eslint": "^10.9.1",
    "eslint-config-prettier": "^10.1.0",
    "eslint-plugin-prettier": "^5.2.6",
    "globals": "^16.0.0",
    "prettier": "^3.9.6",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.69.1",
    "vitest": "^4.1.11"
  },
  "allowScripts": {
    "bcrypt@6.0.0": true,
    "better-sqlite3@12.11.1": true,
    "electron-winstaller@5.4.0": true,
    "node-pty@1.1.0": true,
    "oracledb@7.0.1": true,
    "prisma@7.10.0": true,
    "prisma@6.19.3": true,
    "@prisma/engines@7.10.0": true,
    "@prisma/engines@6.19.3": true,
    "@scarf/scarf@1.4.0": true,
    "@swc/core@1.16.18": true,
    "@prisma/client@7.10.0": true,
    "@prisma/client@6.19.3": true,
    "fsevents@2.3.3": true
  }
}
```

- [ ] **Step 5: 新建根 vitest.packages.config.ts + vitest.packages.setup.ts**

`vitest.packages.config.ts`：

```ts
// packages 单测归宿（桌面端迁入 apps/tianshu-desktop 后自 desktop
// vitest include 移出）：packages/*/src 内与源码同目录的单测在根源码
// 消费（alias 口径与其余三处登记一致）；include 不写越界 ../.. glob。
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tianshu/protocol": path.resolve(
        import.meta.dirname,
        "packages/tianshu-protocol/src",
      ),
      "@tianshu/core": path.resolve(
        import.meta.dirname,
        "packages/tianshu-core/src",
      ),
    },
  },
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    setupFiles: ["vitest.packages.setup.ts"],
  },
});
```

`vitest.packages.setup.ts`：

```ts
// packages 单测全局 setup：数据根重定向临时目录（对齐桌面端
// tests/setup.ts 的隔离意图——jwt-secret 等落盘副作用不污染真实 ~/.tianshu）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-pkgs-"));
process.env.TIANSHU_DATA_ROOT = testRoot;

process.on("exit", () => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});
```

- [ ] **Step 6: vite.config.ts 三处别名 + docs 路径**

`apps/tianshu-desktop/vite.config.ts` 顶层 alias（约 52-61 行）：

```ts
      alias: {
        "@": path.resolve(__dirname, "src-react"),
        // 共享包（RC-T1 protocol / RC-T3 core）：渲染层构建内联包源码；
        // 主进程构建是 vite-plugin-electron 独立实例，须在下方
        // main.vite.resolve.alias 再登记一份（顶层 alias 不传递）
        "@tianshu/protocol": path.resolve(
          __dirname,
          "../../packages/tianshu-protocol/src",
        ),
        "@tianshu/core": path.resolve(
          __dirname,
          "../../packages/tianshu-core/src",
        ),
      },
```

main.vite 内第二处（约 86-97 行）同款改为 `../../packages/tianshu-protocol/src` 与 `../../packages/tianshu-core/src`（多行缩进保持原样）。docs 拷贝（约 26 行）：

```ts
  tryCopySync(
    path.resolve(__dirname, "../../docs/update-log.md"),
    path.resolve(distElectronDir, "./docs/update-log.md"),
  );
```

- [ ] **Step 7: npm install（全新 node_modules + postinstall 双段跑通）**

```bash
npm install
```

Expected: 安装成功；postinstall 两段输出（install-app-deps 原生模块 Electron ABI 重编 + nativewind 恢复或 warn）。若 postinstall 失败，先修 postinstall 链路再继续（不允许跳过）。

- [ ] **Step 8: 摘 expo extends 前的 showConfig 快照（A2）**

```bash
npx tsc -p apps/tianshu-desktop --showConfig > /tmp/tsc-with-expo.json
```

- [ ] **Step 9: tsconfig.json 改写**

`apps/tianshu-desktop/tsconfig.json`：compilerOptions 增加一行 `"allowSyntheticDefaultImports": true,`（原由 expo base 供给，显式化零语义变化）；paths 三条改前缀：

```json
    "paths": {
      "@/*": [
        "./src-react/*"
      ],
      "@tianshu/protocol": [
        "../../packages/tianshu-protocol/src"
      ],
      "@tianshu/core": [
        "../../packages/tianshu-core/src"
      ],
      "@tianshu/core/*": [
        "../../packages/tianshu-core/src/*"
      ]
    }
```

删除末行 `"extends": "expo/tsconfig.base"`（连同其行）。

- [ ] **Step 10: showConfig diff 验证（A2 收口）**

```bash
npx tsc -p apps/tianshu-desktop --showConfig > /tmp/tsc-without-expo.json
diff /tmp/tsc-with-expo.json /tmp/tsc-without-expo.json
```

Expected: 空 diff（allowSyntheticDefaultImports 已显式补齐）。若 diff 显示 expo base 还贡献了其他编译选项，把该选项原值内联进 compilerOptions 后重跑本步。

- [ ] **Step 11: desktop vitest.config.ts 改写**

别名两处同 Step 6 改 `../../packages/...`；include 删 packages 行：

```ts
    include: [
      "scripts/**/*.test.mjs",
      "tests/**/*.test.{mjs,ts,tsx}",
      // 共享包单测（packages/*/src）归根源跑：vitest.packages.config.ts
      //（根 test:packages——include 不写越界 ../.. glob）
    ],
```

- [ ] **Step 12: 门禁验证**

```bash
npm run typecheck        # tsc + witness 全绿
npm run test:packages    # packages 单测绿（首次在根 config 下跑）
cd apps/tianshu-desktop && npx vite build && cd ../..   # 渲染 + 主进程构建绿
```

- [ ] **Step 13: Commit（spec §12 承诺的 ② 号提交）**

```bash
git add -A
git commit -m "refactor(monorepo): 桌面端整体迁入 apps/tianshu-desktop——git mv 保 rename + package.json 分家（根纯壳化第一步，依赖互锁六包原样随迁）"
```

---

### Task 2: tests 层级修正 + MIRROR_ROOT 单源（commit ③-1）

**Files:**
- Create: `apps/tianshu-desktop/tests/lib/paths.ts`
- Modify: `apps/tianshu-desktop/tests/ai/server/e2e-helpers.ts:42`、`e2e-relay-e2e.ts:128`、`relay-transport.test.ts:25-27`、`apps/tianshu-desktop/tests/ai/drift-manifest.test.ts:14-18`
- Modify（批量）: 附录 A-2 所列 ~12 文件的 `../../packages`、`../../../packages`、`../../docs` 相对导入

**Interfaces:**
- Produces: `MIRROR_ROOT`（`tests/lib/paths.ts` 导出，绝对路径仓根）——后续 e2e/巡检测试的仓根定位单源。

- [ ] **Step 1: node ABI 重建（CI 同款，vitest 真库用例依赖）**

```bash
npm rebuild better-sqlite3
```

- [ ] **Step 2: 新建 tests/lib/paths.ts**

```ts
// tests 下沉 apps/tianshu-desktop 后的仓根定位单源：e2e 基建（server
// dist/relay dist 定位）与 drift-manifest.test 此前各自手算上溯层数，
// 迁移后层数 3→5，重复且易错——收敛一处（tests/lib → 上溯四级 = 仓根）。
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIRROR_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
```

- [ ] **Step 3: 五处 MIRROR_ROOT 手算收敛**

`tests/ai/server/e2e-helpers.ts`（行 42，原 `export const MIRROR_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");`）改为再导出：

```ts
export { MIRROR_ROOT } from "../../lib/paths.ts";
```

（e2e 约定 node strip-types 直跑，相对导入带 `.ts` 扩展名。）

`tests/ai/server/e2e-relay-e2e.ts`（行 128 的 const 行）替换为：

```ts
import { MIRROR_ROOT } from "../../lib/paths.ts";
```

`tests/ai/server/relay-transport.test.ts`（行 25-27）：

```ts
const TS_ROOT = process.env.TIANSHU_SERVER_DIST
  ? path.resolve(process.env.TIANSHU_SERVER_DIST)
  : path.resolve(MIRROR_ROOT, "apps/tianshu-server");
```

并在文件 import 区（`import { RelayTransport }` 附近）加 `import { MIRROR_ROOT } from "../../lib/paths.ts";`。

`tests/ai/drift-manifest.test.ts`（行 14-18 的 mirrorRoot 手算）替换为 import 别名（保持文件内 `mirrorRoot` 用名不变）：

```ts
import { MIRROR_ROOT as mirrorRoot } from "../lib/paths";
```

（原 `import { fileURLToPath } from "node:url";` 若再无他用则删除；`path` 仍有他用保留。）

`tests/ai/server/e2e-graph-search-pg.ts` 无需改（`MIRROR_ROOT` 经 `./e2e-helpers.ts` import；改完 grep 确认：`grep -n "MIRROR_ROOT" tests/ai/server/e2e-graph-search-pg.ts` 应显示来自 e2e-helpers 的 import）。

- [ ] **Step 4: 批量修相对导入层数（在 apps/tianshu-desktop 下执行；引号锚定）**

引号锚定（`"` 前缀确保只命中「恰好 N 层」的导入——≥N 层的已修路径不含该锚定形态，故顺序无关、可重入）：

```bash
cd apps/tianshu-desktop
perl -pi -e 's{"\.\./\.\./\.\./packages/}{"../../../../../packages/}g' $(grep -rl '"\.\./\.\./\.\./packages/' tests/)
perl -pi -e 's{"\.\./\.\./packages/}{"../../../../packages/}g' $(grep -rl '"\.\./\.\./packages/' tests/)
perl -pi -e 's{"\.\./\.\./docs/}{"../../../../docs/}g' $(grep -rl '"\.\./\.\./docs/' tests/)
cd ../..
```

- [ ] **Step 5: 残留核验（rtk 环境下结论以原生命令复核为准）**

```bash
grep -rnE '(^|[^./])\.\./\.\./(packages|docs)/' apps/tianshu-desktop/tests/ || echo "无残留"
```

Expected: `无残留`（`[^./]` 前置排除四/五层已修路径的尾段命中——裸 `\.\./\.\./packages/` 会匹配一切 ≥2 层路径，属自败门禁）。

- [ ] **Step 6: 门禁验证**

```bash
npm run test -w apps/tianshu-desktop
```

Expected: desktop 全单测集绿（relay-transport 等依赖 server dist 的用例在 dist 缺席时按 `hasRelay` 跳过属正常）。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(desktop-tests): 仓根定位单源 tests/lib/paths + 相对导入层级修正（tests 下沉两级 +2 层）"
```

---

### Task 3: drift manifest 镜像路径前缀（commit ③-2）

**Files:**
- Modify: `packages/tianshu-core/scripts/drift-manifest.json`（54 条 mirrorPath 加前缀）

**Interfaces:**
- Consumes: Task 1 的搬迁结果（mirrorPath 指向的新位置）。
- Produces: `npm run check:drift` 恢复全绿（54 对 + peer 双查）。

- [ ] **Step 1: 批量前缀**

```bash
perl -pi -e 's{("mirrorPath": ")(electron/|src-react/|prisma/)}{$1apps/tianshu-desktop/$2}g' packages/tianshu-core/scripts/drift-manifest.json
```

- [ ] **Step 2: 门禁验证**

```bash
npm run check:drift
```

Expected: 54 对全 `[OK]`（基线行数与容差不变——归一化 diff 与路径无关）；peer @langchain 双 OK；exit 0。

```bash
npx vitest run --root apps/tianshu-desktop tests/ai/drift-manifest.test.ts
```

（若 vitest CLI 文件参数形态不符，用 `cd apps/tianshu-desktop && npx vitest run tests/ai/drift-manifest.test.ts`。）Expected: PASS（manifest 结构 + 路径存在性断言绿）。

- [ ] **Step 3: Commit**

```bash
git add packages/tianshu-core/scripts/drift-manifest.json
git commit -m "chore(drift): manifest 镜像路径批量加 apps/tianshu-desktop/ 前缀（54 对，基线不动）"
```

---

### Task 4: eslint 拆分 + smoke electron 解析（commit ③-3）

**Files:**
- Create: `eslint.config.js`（根，新写精简版）
- Modify: `apps/tianshu-desktop/eslint.config.js`（删 apps ignore）
- Modify: `apps/tianshu-desktop/scripts/smoke/lib.mjs:159-175`（electron 定位）、`apps/tianshu-desktop/scripts/smoke/README.md`（措辞）

**Interfaces:**
- Produces: 根 `npm run lint` 两段式（root packages + desktop 递归）绿。

- [ ] **Step 1: 新写根 eslint.config.js**

```js
// 根 lint 只管 packages/* 与根级脚本：桌面端迁 apps/tianshu-desktop 后
// 自带同规则 config；server/mobile 子项目各有独立 lint 体系（server 单引号
// 风格 / mobile RN 规则），误扫必红（CI lint 步骤三平台连坐）。
// 规则层与 apps/tianshu-desktop/eslint.config.js 保持同步（两份同改）。
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";

export default defineConfig([
  {
    ignores: ["node_modules", "dist", "**/dist", "apps"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  prettierConfig,
  {
    plugins: { prettier: prettierPlugin },
    rules: {
      "prettier/prettier": "error",
      semi: ["error", "always"],
      quotes: ["error", "double", { avoidEscape: true }],
      // `_` 前缀是本仓「占位不用」惯例（接口形状对齐/mock 签名/解构剔除）
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": process.env.NODE_ENV === "production" ? "warn" : "off",
      "no-debugger": process.env.NODE_ENV === "production" ? "warn" : "off",
    },
  },
]);
```

- [ ] **Step 2: desktop eslint.config.js 删 apps ignore**

删除 ignores 数组中的三行（注释两行 + 条目一行）：

```js
      // apps/* 子项目各有独立 lint 体系（server 单引号风格 / mobile RN 规则），
      // 根规则只管桌面端与 packages/*，误扫必红（CI lint 步骤三平台连坐）
      "apps",
```

并在文件头加一行注释：`// 规则层与根 eslint.config.js（packages/* 用）保持同步（两份同改）。`（其余 ignores 条目相对 desktop 生效不变。）

- [ ] **Step 3: smoke electron 定位改 node 解析**

`apps/tianshu-desktop/scripts/smoke/lib.mjs` launchApp 内（原 159-175 行）：

```js
async function launchApp(port) {
  const { _electron } = loadPlaywright();
  // workspace 化后 electron hoist 至根 node_modules——REPO/node_modules/electron
  // 直拼不再成立，经 node 解析规则定位包根；.bin 回退由包根同层推导
  const electronDir = path.dirname(
    createRequire(path.join(REPO, "package.json")).resolve(
      "electron/package.json",
    ),
  );
  const darwinBin = path.join(
    electronDir,
    "dist",
    "Electron.app",
    "Contents",
    "MacOS",
    "Electron",
  );
  const app = await _electron.launch({
    executablePath: fs.existsSync(darwinBin)
      ? darwinBin
      : path.join(path.dirname(electronDir), ".bin", "electron"),
    args: [REPO],
```

（`createRequire` 已在文件头 import；后续 `env`/`NODE_ENV` 等行不变。）`scripts/smoke/README.md` 中"仓库根"措辞如指 desktop app 目录则改为"桌面端目录（apps/tianshu-desktop）"。

- [ ] **Step 4: 门禁验证**

```bash
npm run lint
node -e "const{createRequire}=require('node:module');const path=require('node:path');const r=createRequire(path.resolve('apps/tianshu-desktop/package.json'));const fs=require('node:fs');const dir=path.dirname(r.resolve('electron/package.json'));const bin=path.join(dir,'dist','Electron.app','Contents','MacOS','Electron');console.log('darwinBin exists:',fs.existsSync(bin));"
```

Expected: lint 全绿；`darwinBin exists: true`。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(lint,smoke): eslint 根/桌面分治（根管 packages）+ smoke electron 定位改 node 解析（hoist 适配）"
```

---

### Task 5: CI 双 workflow + .dockerignore（commit ③-4）

**Files:**
- Modify: `.github/workflows/ci.yml`（ci job Build 步）、`.github/workflows/release.yml`（release job 三步 + 产物 glob×2 处）、`.dockerignore`

**Interfaces:**
- Consumes: Task 1-4 后的命令面（根委托 + desktop cwd 构建）。

- [ ] **Step 1: ci.yml ci job 构建步加 working-directory**

```yaml
      - name: Build (renderer + main)
        run: npx vite build
        working-directory: apps/tianshu-desktop
```

（lint/typecheck/test 三步走根委托脚本，不改。）

- [ ] **Step 2: release.yml release job**

```yaml
      - name: Build (renderer + main)
        run: npx vite build
        working-directory: apps/tianshu-desktop
      # postinstall 的 install-app-deps 已按 Electron ABI 编好原生模块（各平台
      # runner 工具链已实证可编），此处直接打包；--publish never = 只打不传，
      # generic publish url 为空由我们统一走 upload/Release
      - name: Package (electron-builder)
        run: npx electron-builder --publish never
        working-directory: apps/tianshu-desktop
```

Upload artifacts 与 Attach to GitHub Release 两步的四个 glob 前缀 `release/` → `apps/tianshu-desktop/release/`（`*.dmg`、`*.exe`、`*.AppImage`、`latest*.yml`）。

- [ ] **Step 3: .dockerignore 定稿**

```
node_modules
**/node_modules
docs
.superpowers
.claude
.git
*.md
apps/tianshu-mobile
apps/tianshu-desktop
coverage
**/local.db*
**/.env
# tianshu-server PG client 生成物（gitignored 构建期产物，含宿主平台 engine
# 二进制）——builder 内派生重生成，宿主副本入 context 会污染镜像
apps/tianshu-server/src/generated
```

（删根级死条目 `dist-electron`、`src-react`、`tests`、`release`；补 `apps/tianshu-desktop`——mobile 已有同款先例，server 镜像对缺席 workspace 的容忍已被 Relay 镜像实证。）

- [ ] **Step 4: 核验 + Commit**

目检两 workflow 缩进与 step 名；`git diff --check`。真验证在 Task 8 push 后的 CI 矩阵。

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml .dockerignore
git commit -m "ci(docker): 双 workflow 桌面 job 指向 apps/tianshu-desktop + dockerignore 排除桌面树（mobile 先例同款）"
```

---

### Task 6: 根目录垃圾清理（commit ③-5）

**Files:**
- Delete: `.probe-*.mjs`（8 个）、`.reset-probe.txt`、`.face-cors-proxy.mjs`、`.fix-workflow-refresh.patch`、`.fix-backup/`、（若 tracked）`.expo/`、`.vitest/`

- [ ] **Step 1: 核实 tracked 集并删除**

```bash
git ls-files .expo .vitest '.probe-*' .reset-probe.txt .face-cors-proxy.mjs .fix-backup .fix-workflow-refresh.patch
git rm -r --ignore-unmatch .expo .vitest '.probe-*' .reset-probe.txt .face-cors-proxy.mjs .fix-backup .fix-workflow-refresh.patch
```

（`--ignore-unmatch`：`.expo/`、`.vitest/` 若实测未 tracked 则自动跳过，其余按显式清单删。）

- [ ] **Step 2: 核验 + Commit**

```bash
git status --short   # 仅 D 条目
npm run typecheck    # 抽检不受影响
git commit -m "chore: 清根目录一次性调试遗留（probe×8/cors-proxy/fix-backup 等，实证无仓相对引用）"
```

---

### Task 7: 文档批（commit ④）

**Files:**
- Modify: `CLAUDE.md`、`README.md`、`README.en.md`；核对 `apps/tianshu-server/README-relay.md`（预计零改动）

- [ ] **Step 1: CLAUDE.md 改写要点**

1. 项目概述段：monorepo 描述改为"三端 apps/* 对称：`apps/tianshu-desktop`（桌面端）/ `apps/tianshu-server` / `apps/tianshu-mobile`；根目录为纯 workspace 壳（workspaces + 委托脚本 + 工具链）"。
2. 开发命令段：注明 `npm run dev` / `build` / `test` / `lint` / `typecheck` / `test:e2e:*` 为根委托（等价 `-w apps/tianshu-desktop`）；新增 `npm run test:packages`（packages 单测根源码跑）。
3. 代码架构段：段首注明"以下桌面端路径均相对 `apps/tianshu-desktop/`"（electron/、src-react/ 小节标题不改路径写法，加前缀说明即可）。
4. 共享包消费方式段："mirror 桌面端经 alias 直引" → "desktop（apps/tianshu-desktop）经 alias 直引"；"worktree 各自构建不回写主树"等老规矩保留。
5. drift 段、数据库段、构建注意事项段：路径均不变，核对无遗留"根即桌面端"表述（`grep -n "仓库根\|根目录" CLAUDE.md` 逐条核对语境）。

- [ ] **Step 2: README 双语同步**

`grep -n "src-react\|electron/\|apps/\|packages/" README.md README.en.md`——改两处：目录树段（桌面块从根级缩进挪入 `apps/tianshu-desktop/` 下）、monorepo 描述句（同 CLAUDE.md 口径）。命令表因根委托保持有效不动。中英同构镜像，两份同批改。

- [ ] **Step 3: README-relay.md 核对**

`grep -n "monorepo 根\|dockerignore" apps/tianshu-server/README-relay.md`——预计零改动（"monorepo 根 context"表述仍成立）；若提及根级桌面文件则同步。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md README.en.md
git commit -m "docs: CLAUDE.md/README 双语随迁——三端 apps/* 对称布局与根委托命令口径"
```

---

### Task 8: 终验批（全套验证门，spec §13）

**Files:** 无新增改动（本任务只验证 + 推送 + 交接；发现问题回对应任务修后重跑本任务）

- [ ] **Step 1: server dist 构建（e2e 前置）**

```bash
npm run build -w apps/tianshu-server
ls apps/tianshu-server/dist/src/main.js apps/tianshu-server/dist/src/relay/relay-main.js
```

- [ ] **Step 2: e2e 双链（MIRROR_ROOT 改写的直接验收）**

```bash
npm run test:e2e:relayE2E   # 真 relay 子进程 + 双端真实握手栈
npm run test:e2e:server     # spawn server dist 直连链路
```

（`test:e2e:graphPg`/`mainPg` 需 SEARCH_E2E_PG_URL，未配置则跳过不计门禁。）

- [ ] **Step 3: 零扰动确认**

```bash
npm run test -w apps/tianshu-server
npm run typecheck -w apps/tianshu-mobile
```

- [ ] **Step 4: showConfig 终复核**

```bash
diff /tmp/tsc-with-expo.json /tmp/tsc-without-expo.json && echo "A2 恒成立"
```

- [ ] **Step 5: 打包冒烟（先回 Electron ABI）**

```bash
npm run rebuild:native -w apps/tianshu-desktop
npm run build -w apps/tianshu-desktop
ls apps/tianshu-desktop/release/0.1.0/
```

Expected: `Tianshu-Mac-0.1.0-Installer.dmg` 产出（compression maximum，耗时数分钟属正常）。

- [ ] **Step 6: 推送 + PR + CI 矩阵观察**

```bash
git push -u origin worktree-desktop-apps-migration
gh pr create --title "refactor(monorepo): 桌面端迁入 apps/tianshu-desktop——根目录纯壳化" --body "spec: docs/superpowers/specs/2026-11-04-desktop-apps-migration-design.md" || true
```

观察 CI 三 OS（macos/ubuntu/windows）矩阵 + server/mobile job 全绿。合并由用户裁定。

- [ ] **Step 7: 用户交接**

1. dev 冒烟由用户亲自起：`npm run dev`（根委托）；日志落点变为 `apps/tianshu-desktop/logs/`。
2. 合并回 main 后：**主树须 `npm install`**（lock 全量重排），并跑 `npm --prefix packages/tianshu-core run build` 刷新共享包 dist（老规矩）。
3. 更新持久记忆中涉及根路径的条目（drift manifest 路径、worktree server jest、bash cwd 漂移等表述里的"根=桌面端"语境）。

---

## Self-Review 记录

- **Spec 覆盖**：spec §3 布局→Task 1-2；§4 分家→Task 1 Steps 3-4；§5 构建链→Task 1 Steps 6/9/11；§6 测试链→Task 1 Step 5 + Task 2 + Task 4；§7 drift→Task 3；§8 CI/Docker→Task 5；§9 数据处置→Task 1 Step 1 + Task 8 Step 7；§10 垃圾→Task 6；§11 文档→Task 7；§12 手法→全程；§13 验证门→各任务门禁 + Task 8；§14 假设 A1（已用 `-w` 形态消解）、A2（Task 1 Steps 8-10）、A3（Task 5 + CI 复验）、A4（Task 1 Step 1）、A5（Task 1 Step 5 规避）、A6（Global Constraints）、A7（CI 实证，回退 `-w` 形态已备）。
- **占位符**：无 TBD/TODO；全部代码步骤含精确内容。
- **一致性**：`MIRROR_ROOT`/`mirrorRoot` 命名、`rebuild:native`、`test:packages`、perl 层数（3→5、2→4）全文核对一致。
