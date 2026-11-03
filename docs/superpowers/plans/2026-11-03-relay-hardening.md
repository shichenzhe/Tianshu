# relay 加固小批实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收掉终审三项 Minor 加固（无 tid fail-closed / createPublicKey 限定 Ed25519 / access 缓存键补 adminUrl），消除"已知未修"台账项。

**Architecture:** 三处独立小改：两处在 apps/tianshu-server relay 鉴权面，一处横跨 mirror 桌面控制端与 mobile 的 access 缓存。无协议/接口变更。

**Spec:** `docs/superpowers/specs/2026-11-03-relay-multitenant-design.md`（§4.2/§10 为依据；本批为终审 follow-up，见主批 ledger 终审节——worktree relay-multitenant-design 已清理，结论在 git 历史与记忆中）

## Global Constraints

- static 模式行为零漂移（现有全量测试全绿为基线）
- server 仓格式单引号/trailingComma=all/2 空格；mirror 根仓跟随 prettier 工具链；mobile 跟随其仓内惯例
- relay 本体零新 npm 依赖（node:crypto 内置能力）
- worktree 环境已就绪：node_modules 软链、mobile 拷贝、prisma:generate:ra 已跑

---

### Task A: relay 鉴权面两项加固（server 侧，同域合并）

**Files:**
- Modify: `apps/tianshu-server/src/relay/auth.ts`（jwt admit 补 tid 校验）
- Modify: `apps/tianshu-server/src/relay/relay-main.ts`（createAuthenticator 启动校验补密钥类型）
- Test: `apps/tianshu-server/test/relay/auth.spec.ts`（扩展）

**Interfaces:**
- Consumes: 既有 `createJwtAuthenticator`/`createAuthenticator`/AuthDecision
- Produces: 行为收紧（无接口变更）——
  1. **A1（终审 Minor #3，更新 T4 ruling）**：jwt 模式下首帧验签通过但 `claims.tid` 缺失或非非空字符串 → `admit` 返回 `{ok:false, closeCode:4001, reason:'invalid-token'}`。落点在 `auth.ts` 的 jwt 分支（验签成功后的 claims 检查，与既有 isRevoked 检查同段）。依据：正常签发（token.service）恒有 tid，缺失即畸形——fail-closed 与 quota 防御门同款逻辑。static 模式不受影响（不走 jwt 分支）。
  2. **A2（终审 Minor #8）**：`createAuthenticator` jwt 分支的 `createPublicKey` 启动校验后追加类型检查——`key.asymmetricKeyType !== 'ed25519'` → throw `relay 拒绝启动：--auth-pubkey 不是 Ed25519 公钥（当前解析为 <type>）`。覆盖 RSA 公钥 PEM 与误传私钥 PEM 两类误配（Node createPublicKey 对私钥 PEM 会提取出对应公钥，类型为原算法）。

- [ ] **Step 1: 失败测试**——A1：签发一个无 `tid` 字段的合法签名 token → 首帧 → 期望 close 4001（RED：现状放行并进入配对）。A2：RSA 公钥 PEM 文件 → startRelay 拒绝且消息含 "Ed25519"；Ed25519 私钥 PEM 误传 → 同样拒绝；合法 Ed25519 公钥 → 启动正常（回归）
- [ ] **Step 2: 确认 RED**
- [ ] **Step 3: 实现两处**
- [ ] **Step 4: `cd apps/tianshu-server && npx jest test/relay/` 全绿（static 回归）+ `npx jest test/relay-admin/` 全绿**
- [ ] **Step 5: commit** `fix(relay): 鉴权加固——无 tid token fail-closed + pubkey 限定 Ed25519（终审 Minor 3/8）`

### Task B: access 缓存键补 adminUrl（mirror + mobile 两端）

**Files:**
- Modify: `electron/domains/server/relay-ak.ts`（StoredRelayAccess 补 adminUrl + usable 检查匹配）
- Modify: `apps/tianshu-mobile/src/transport/relay-ak.ts`（同款）
- Test: `tests/ai/server/relay-ak.test.ts`（扩展）+ `apps/tianshu-mobile/src/transport/relay-transport-renew.test.ts`（扩展）

**Interfaces:**
- Consumes: 既有 StoredRelayAccess/accessStore 结构与 usable 检查（akId 同款先例）
- Produces: 行为收紧——存储的 access 记录增加 `adminUrl` 字段；`usable` 判定在 akId 匹配之外加 adminUrl 全等——同 connId 同 akId 换 adminUrl 后不复用旧 access（视为需要重新换发），旧记录被覆盖。两端实现同构（mobile 仓内惯例照旧）。

- [ ] **Step 1: 失败测试**——desktop：存 access 后改 config 的 adminUrl（akId 不变）再连接 → 期望向新 admin 发起换发请求（RED：现状复用旧 access 零请求）；mobile 同款
- [ ] **Step 2: 确认 RED**
- [ ] **Step 3: 两端实现**
- [ ] **Step 4: `npx vitest run tests/ai/server/relay-ak.test.ts` + `cd apps/tianshu-mobile && npx vitest run src/transport/` 全绿；根 `npm run typecheck` 过**
- [ ] **Step 5: commit** `fix(relay-ak): access 缓存键补 adminUrl——换控制平面不复用旧 access（终审 Minor 9，桌面+移动）`

---

## Self-Review

- 覆盖：终审 Minor #3→A1、#8→A2、#9→B。Minor #7（401 reason 分支）挂起等首报障、#5（主 Dockerfile）独立、#6（TOFU）v2——不在本批，无缺口
- 类型一致：A/B 各自独立无跨任务接口；测试矩阵含回归面
