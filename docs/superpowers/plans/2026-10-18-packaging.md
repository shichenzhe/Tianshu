# 打包内嵌分发实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tianshu-server standalone 产物打进桌面端安装包（extraResources），Supervisor 打包态 ELECTRON_RUN_AS_NODE spawn，mac 实测闭环。

**Architecture:** server 侧 dist:standalone（build+prune+双包实体化）→ mirror extraResources filter 白名单 → connections.ts 双态命令解析 → dmg 实测。

**Spec:** `docs/superpowers/specs/2026-10-18-packaging-design.md`

## Global Constraints

- 铁律不触碰（mirror 根 dependencies 不动——build:server/build 链只动 scripts 与 builder 配置）；哨兵规程；两仓风格。
- 双包实体化用直接拷贝法（packages/*/dist+package.json → node_modules/@tianshu/*，覆盖 symlink）。
- 基线：mirror 3734 过/1 外来预存红零新增；server 352 绿。

---

### Task 1: server standalone 产物

**Files:**
- Create: server `scripts/standalone.mjs`（build→prune --omit=dev→双包实体化→prisma generate→产物清单校验+短启动冒烟）
- Modify: server `package.json` scripts + `dist:standalone`
- Test: `test/standalone.spec.ts`（产物校验函数单测——清单/实体化判定逻辑若可抽；否则脚本级验证并入 T3 实测，报告说明）

- [ ] 哨兵+基线 → 脚本实现 → `npm run dist:standalone` 全链跑通（产物清单实查：dist/src/main.js、relay-main.js、node_modules/@tianshu/* 为**实体目录非 symlink**、prisma client）→ `npm test` 全绿（prune 后 devDeps 缺失注意：跑测试前需 npm install 恢复——脚本尾部提示或顺序安排，报告记录）→ Commit（server `feat(packaging): standalone 产物管线（PK-1）`）

### Task 2: extraResources + Supervisor 双态

**Files:**
- Modify: mirror `electron-builder.json5`（extraResources filter 白名单）
- Modify: mirror `package.json` scripts + `build:server`；CLAUDE.md 打包节一句
- Modify: mirror `electron/domains/server/connections.ts`（命令注入处双态解析：`app.isPackaged` → execPath+ELECTRON_RUN_AS_NODE+resourcesPath 路径；dev 维持）+ `supervisor.ts`（若 env 注入需扩——ELECTRON_RUN_AS_NODE 透传）
- Test: `tests/ai/server/supervisor-packed.test.ts`（mock app.isPackaged 两态命令构造断言）

- [ ] 哨兵+基线 → TDD → 全量绿+typecheck → Commit（mirror `feat(packaging): extraResources 内嵌+Supervisor 打包态 spawn（PK-2）`）

### Task 3: mac 实测+终审

- [ ] `build:server` → `npm run build`（dmg 产出）→ 运行 release .app → 控制台本地无头端 start → **握手+health+一次会话往返**（真模型回退机制）→ Prisma 兼容性结论记录（不兼容即 BLOCKED 上报 fallback 裁定）→ spec §2.4 全项 → final review（fable）→ 修复轮 → 收官

---

## Self-Review

Spec §2.1（T1）/§2.2/§2.3（T2）/§2.4（T3）/§3 假设承载；无占位。
