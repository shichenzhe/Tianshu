# relay 挂起项收尾批实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收掉两项挂起项——主 Dockerfile 构建链修复（g++12/langchain 断链）+ 四端 401 按 reason 分支粘滞。完成后 relay 挂起清单仅剩 v2 项（TOFU/拆仓/收费）。

**Architecture:** 两独立任务：Dockerfile 修法照 Dockerfile.relay 已验证模式（--ignore-scripts + 产物存在性闸）；401 分支为四端各自的 requestAccess 401 路径加 body.data.reason 判定。无协议/接口变更。

**Spec:** `docs/superpowers/specs/2026-11-03-relay-multitenant-design.md`（§5.2/§5.4）；T12 的 401 响应契约 `{code,message,data:{reason}}`（RelayProtocolFilter 直出，reason ∈ not-found/disabled/expired/bad-secret）

## Global Constraints

- 各端现有行为回归全绿（server relay/relay-admin jest、mirror/desktop vitest、mobile vitest、根 typecheck）
- server 仓格式单引号/trailingComma=all/2 空格；mirror 根仓/mobile 跟随各自工具链
- relay 本体与 relay-admin 零新 npm 依赖
- worktree 环境已就绪（软链/mobile 拷贝/prisma:generate:ra）

---

### Task 1: 主 Dockerfile 构建链修复

**Files:**
- Modify: `apps/tianshu-server/Dockerfile`（两处断点，修法照 `Dockerfile.relay` 已验证模式——先读它 15-44 行注释）

**Interfaces:**
- Produces: `docker build -f apps/tianshu-server/Dockerfile -t tianshu-server .`（monorepo 根 context）成功产镜像；修法两处——
  1. `npm ci` → `npm ci --ignore-scripts`：根 postinstall 的 `electron-builder install-app-deps` 会把 better-sqlite3 对 Electron 44 头文件源码重编（g++12 编不过 v8config.h）；server 镜像运行时用 Prisma engine（无 better-sqlite3——server 仓无此依赖），builder 只需 tsc + 声明文件 + prisma generate（显式 RUN，非 lifecycle）。工具链行（`apk add python3 make g++`）若实证不再需要一并移除，若 prisma/其他步骤仍需则保留——以 build 成功为准
  2. `tianshu-core` 构建的 `&&` 链断点：core tsc 因 @langchain peer 有 6 项既有类型报错 exit 2（host 侧同判：**exit code 不作判据，产物存在性闸住**——构建允许 exit≠0 但必须产出 `dist/index.js`，真失败由 `test -f` 闸住）。照 Dockerfile.relay 40-44 行同款写法
- 验证（brief Step 2）：docker 可用时 `docker build` 主镜像成功 + 容器冒烟（`node dist/src/main.js` 起 `/actuator/health` 200 后停——参照 T19 的 Dockerfile.relay 冒烟法与 2026-10-31 server-docker-deploy-design spec 的六坑处置）；docker 不可用则逐行比对 Dockerfile.relay 已验证模式 + hadolint，并在报告注明未实证

- [ ] **Step 1: 读 Dockerfile 全文 + Dockerfile.relay 13-44 注释 + 2026-10-31 docker-deploy spec，确认两处断点与既有六坑处置不冲突**
- [ ] **Step 2: 改两处（含注释说明原委，风格照 Dockerfile.relay）**
- [ ] **Step 3: docker build + 容器冒烟（或降级验证并注明）**
- [ ] **Step 4: commit** `fix(docker): 主 Dockerfile 修复 langchain/postinstall 断链——ignore-scripts + core 产物存在性闸（照 Dockerfile.relay 已验证模式）`

### Task 2: 四端 401 按 reason 分支粘滞

**Files:**
- Modify: `apps/tianshu-server/src/relay/relay-client.ts`（requestAccess 401 路径）
- Modify: `electron/domains/server-face/renewable-credential.ts`（requestAccess 401 路径）
- Modify: `apps/tianshu-mobile/src/transport/relay-ak.ts`（401 分类）
- Modify: `electron/domains/server/relay-ak.ts`（401 分类）
- Test: 各端既有测试文件扩展（relay-client-renew.spec / server-face relay-ak.test / mobile relay-transport-renew.test / tests/ai/server/relay-ak.test）

**Interfaces:**
- Consumes: T12 的 401 响应体 `{code, message, data: {reason}}`；既有瞬态/粘滞分类结构
- Produces: 统一判定——**401 响应体解析出 `data.reason ∈ {disabled, expired, bad-secret}` → 粘滞（AK 凭证失效语义，现状行为）；`not-found`、body 缺失/不可解析（中间盒质询、代理 401）→ 瞬态退避（新行为）**。理由：not-found 可能是库重建窗口（运营纪律之外的自愈场景）或 akId 配置漂移中的中间态，瞬态让恢复后自愈；无 JSON body 的 401 是代理质询特征，粘滞会造成误报"凭证失效"。四端语义同构、实现随各端惯例（server 侧 requestAccess 内分类、mirror/mobile 侧在 401 分支读 body）。

- [ ] **Step 1: 失败测试（四端各一）**——stub admin 返回**无 body 的 401** → 期望瞬态退避重试（RED：现状一律粘滞断开）；带 `data.reason:'disabled'` 的 401 → 粘滞（回归）
- [ ] **Step 2: 确认 RED**
- [ ] **Step 3: 四端实现**
- [ ] **Step 4: 四端既有套件全绿 + 根 typecheck + mobile typecheck**
- [ ] **Step 5: commit** `fix(relay-clients): 401 按 reason 分支——凭证失效粘滞/代理质询与 not-found 瞬态（四端同构）`

---

## Self-Review

- 覆盖：挂起清单的 401 粘滞项与主 Dockerfile 项全收；TOFU/拆仓/收费留 v2（需 brainstorm，不属"继续"范围）
- Task 1 修法来源是已验证模式（Dockerfile.relay build 成功的同款处置），风险低
- Task 2 语义裁定：not-found 归瞬态——计划内注明理由，若运营侧希望 not-found 也粘滞可后续一行翻转
