/**
 * 主库 PG e2e（可选，门控 MAIN_PG_E2E_URL；未设则 SKIP）：真 server 子进程以
 * TIANSHU_DB_URL=postgres://… 启动（PG 主库模式，SEARCH_DB_URL 显式置空钉死
 * 「检索跟随主库」路径）→ 首启自动 db push（派生 schema）建 23 张业务表 →
 * graph save/run 走 PG 主库（API 行为 + 直查 graphDefinition 行双证，另证
 * 无 SQLite 落库文件）→ hybridSearch keyword 同库检索命中「容错设计手册｜
 * 相关度」+「旅行日记」剔除（跟随规则 §4 实证）→ 重启两跳（two-boot，终审
 * F1）：停服复启（每次启动都跑 db push）健康仍 ok 且检索行保全——检索表
 * 限定 tianshu_search 独立 schema，db push 对其视而不见；限 public 旧形态
 * 下非空 vector_chunk 必被判 drift（退出 1）永久起不来 → 清理（子进程 +
 * 检索 schema DROP；业务表留给 PG 卷/由外部清理——检索单真源原则延续）。
 * SQLite 路径由既有 e2e/Jest 覆盖。
 *
 * spawn/env 注入/直插/断言手法对齐 e2e-graph-search-pg.ts；一处刻意偏差：
 * 分词模块解析改经 createRequire(SERVER_DIR) 的 require.resolve
 * ("@tianshu/core")——本仓 worktree 布局下共享包 dist 不在仓内且
 * node_modules 软链指主树，server 进程实际装载的就是该解析位（同树同源
 * 不变式更直接的实现）。
 *
 * PG 起法（compose main-pg 端口未发布，e2e 用一次性容器）：
 *   docker run -d --rm --name mainpg-e2e -e POSTGRES_USER=t \
 *     -e POSTGRES_PASSWORD=t -e POSTGRES_DB=m -p 55432:5432 \
 *     pgvector/pgvector:pg17
 *   MAIN_PG_E2E_URL=postgres://t:t@127.0.0.1:55432/m npm run test:e2e:mainPg
 *
 * 运行：npm run test:e2e:mainPg（node 原生 strip-types，需 Node ≥ 23.6；
 * 文件名无 .test. 段不进 vitest 常规集；TIANSHU_E2E_SKIP_BUILD=1 可跳过
 * server 构建）
 *
 * 基建单源：spawnScan / DirectControl / parseSseBlock / 握手解析 /
 * getFreePort / 停进程 / 包装体 call / 断言锚 / hybridSearchGraphJson /
 * PG 访问层与 seed（createPgSeeder）自 e2e-helpers.ts 导入（2026-10-31
 * 五副本归一，血统见其头注释）；本脚本保留 waitForHealth / scalar、
 * tokenize 的 createRequire(SERVER_DIR) 解析策略与 two-boot 断言编排。
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  DROP_SEARCH_SQL,
  E2E_CONFIG,
  PG_DDL,
  type PgPoolLike,
  SERVER_DIR,
  SERVER_ENTRY,
  DirectControl,
  type RequestResult,
  createE2eReporter,
  createPgSeeder,
  getFreePort,
  hybridSearchGraphJson,
  nextEventIn,
  parseHandshake,
  spawnScan,
  stopChild,
} from "./e2e-helpers.ts";
/** PG 生成物（prisma:generate:pg 产出，git-ignored）双落点：src 原位 +
 * dist 拷贝位（facade 编译产物 require('../../generated/prisma-pg') 解析处） */
const PG_CLIENT_SRC = path.join(SERVER_DIR, "src", "generated");
const PG_CLIENT_DIST = path.join(SERVER_DIR, "dist", "src", "generated");

const PG_URL = process.env.MAIN_PG_E2E_URL;
if (!PG_URL) {
  console.log(
    "SKIP: MAIN_PG_E2E_URL 未配置（docker compose --profile main-pg 起库后设置）",
  );
  process.exit(0);
}

/** 检索面按 userId 过滤——server 图运行恒为伴生用户（COMPANION_USER_ID=1） */
const USER_ID = 1;
const COLLECTION = "e2e-main-pg-hybrid";
const TARGET_SOURCE = "容错设计手册";
const OFF_TOPIC_SOURCE = "旅行日记";
const SEED_MODEL = "e2e-main-pg-seed";
/** 派生 schema 的业务表数（23 model，db push 建表单源钉死；探针库实测） */
const EXPECTED_TABLES = 23;
const HEALTH_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 120_000;

const reporter = createE2eReporter("e2e-main-pg");
const { outcomes, log, pass, call, printSummary } = reporter;

/** 断言失败即抛——函数声明形态保 never 控制流分析（reporter 解构件不保） */
function fail(label: string, detail: string): never {
  return reporter.fail(label, detail);
}

/** PG seed 器（e2e-helpers 单源；集合名/seed 标记为本脚本隔离值） */
const { upsertSeed } = createPgSeeder({
  userId: USER_ID,
  collection: COLLECTION,
  seedModel: SEED_MODEL,
});

/** 单值查询（COUNT 等） */
async function scalar(
  pool: PgPoolLike,
  sql: string,
  values?: unknown[],
): Promise<number> {
  const result = await pool.query(sql, values);
  return Number((result.rows[0] as { n: number }).n);
}

/** 健康探测（带重试）：握手行后仍容忍 db push 尾延/网络抖动，30s 内
 * status=ok 才放行（T5 停留竞态的 e2e 侧兜底）。/actuator/health 在
 * ResponseInterceptor 排除表——terminus 原生 {status:"ok"}；StaticTokenGuard
 * 不豁免 @Public，须带 Bearer。 */
async function waitForHealth(
  request: (
    method: "GET" | "POST",
    reqPath: string,
    body?: unknown,
  ) => Promise<RequestResult>,
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "（未探测）";
  for (;;) {
    try {
      const result = await request("GET", "/actuator/health");
      const parsed =
        typeof result.body === "object" && result.body !== null
          ? (result.body as { status?: unknown; data?: { status?: unknown } })
          : null;
      last = `HTTP ${result.status} body=${JSON.stringify(result.body).slice(0, 200)}`;
      if (
        result.status === 200 &&
        (parsed?.status === "ok" || parsed?.data?.status === "ok")
      ) {
        return;
      }
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() >= deadline) {
      fail("健康探测", `${HEALTH_TIMEOUT_MS}ms 内未就绪：${last}`);
    }
    await delay(1000);
  }
}

// —— 主流程 ——

async function main(): Promise<number> {
  log(
    "主库 PG e2e 启动",
    `MAIN_PG_E2E_URL=${PG_URL.replace(/:[^:@/]+@/, ":***@")}`,
  );

  // 分词单源：从 SERVER_DIR 解析 @tianshu/core 实际装载位（spawn 的 server
  // 进程同一棵解析树——同树同源不变式；worktree packages dist 不存在时解析
  // 落 node_modules 软链的主树 dist，与 server 运行时一致）
  const requireFromServer = createRequire(SERVER_DIR);
  let coreDir: string;
  try {
    coreDir = path.dirname(requireFromServer.resolve("@tianshu/core"));
  } catch {
    fail(
      "core 包分词模块",
      "无法从 apps/tianshu-server 解析 @tianshu/core（先跑 server 侧 npm run sync:core 重建共享包 dist）",
    );
  }
  const CORE_RETRIEVAL = path.join(coreDir, "retrieval.js");
  if (!fs.existsSync(CORE_RETRIEVAL)) {
    fail(
      "core 包分词模块",
      `${CORE_RETRIEVAL} 不存在——先重建共享包 dist（server 侧 npm run sync:core）`,
    );
  }
  const { tokenize } = (await import(pathToFileURL(CORE_RETRIEVAL))) as {
    tokenize: (text: string) => string[];
  };
  if (typeof tokenize !== "function") {
    fail(
      "core 包分词模块",
      "dist 导出缺 tokenize（陈旧产物？重建共享包 dist）",
    );
  }
  log(`分词单源：${CORE_RETRIEVAL}`);

  if (!fs.existsSync(path.join(PG_CLIENT_SRC, "prisma-pg"))) {
    fail(
      "PG 生成物",
      `${PG_CLIENT_SRC}/prisma-pg 不存在——先在 apps/tianshu-server 执行 npm run prisma:generate:pg`,
    );
  }

  if (!process.env.TIANSHU_E2E_SKIP_BUILD) {
    log("构建 tianshu-server（TIANSHU_E2E_SKIP_BUILD=1 可跳过）…");
    const build = spawnSync("npm", ["run", "build"], {
      cwd: SERVER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (build.status !== 0) {
      console.error(
        `[e2e-main-pg] FAIL：构建失败\n${(build.stderr ?? "").slice(-2000)}`,
      );
      return 1;
    }
  }
  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error(
      `[e2e-main-pg] FAIL：无头端产物不存在 ${SERVER_ENTRY}（先在 tianshu-server 执行 npm run build）`,
    );
    return 1;
  }
  // PG 生成物随行：nest build 经 nest-cli assets 自动拷 src/generated →
  // dist/src/generated（终审 F3；dist/src/generated 是 facade require 的解析
  // 位）。自拷兜底保留——TIANSHU_E2E_SKIP_BUILD 配旧 dist 时 assets 可能缺席
  if (!fs.existsSync(PG_CLIENT_DIST)) {
    fs.cpSync(PG_CLIENT_SRC, PG_CLIENT_DIST, { recursive: true });
    log(
      `PG 生成物拷贝：src/generated → dist/src/generated（${PG_CLIENT_DIST}）`,
    );
  }

  const { Pool } = (await import("pg")) as unknown as {
    Pool: new (opts: { connectionString: string }) => PgPoolLike;
  };
  const pool: PgPoolLike = new Pool({ connectionString: PG_URL });

  const dataRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tianshu-e2e-mainpg-"),
  );
  let child: ChildProcess | null = null;
  let control: DirectControl | null = null;
  try {
    // 1. PG 可达性预检（容器 initdb 竞态兜底：SELECT 1 重试至多 30s）+
    //    检索 schema 清场（幂等 DROP CASCADE；主库业务表不清——首启建库由
    //    server 自证）
    const pgDeadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (e) {
        if (Date.now() >= pgDeadline) {
          fail(
            "PG 可达性",
            `${HEALTH_TIMEOUT_MS}ms 内连接失败：${e instanceof Error ? e.message : String(e)}`,
          );
        }
        await delay(1000);
      }
    }
    await pool.query(DROP_SEARCH_SQL);
    pass(
      "PG 预检",
      "连接可达 + 检索 schema tianshu_search 清场（DROP CASCADE）",
    );

    // 2. spawn server 子进程：主库指真 PG（TIANSHU_DB_URL=postgres://…），
    //    SEARCH_DB_URL 显式置空——钉死「检索跟随主库」分支（§4）
    const port = await getFreePort();
    fs.writeFileSync(
      E2E_CONFIG,
      `# e2e-main-pg 生成（运行完自动删除）\napp:\n  port: ${port}\n`,
    );
    const spawned = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-main-pg-token",
        TIANSHU_DATA_ROOT: dataRoot,
        TIANSHU_DB_URL: PG_URL,
        SEARCH_DB_URL: "",
      },
    );
    child = spawned.child;
    const info = parseHandshake(spawned.matched);
    if (info.token !== "e2e-main-pg-token" || info.port !== port) {
      fail(
        "server spawn+握手",
        `token/port 未按 env 回显（token=${info.token} port=${info.port} ≠ 配置 ${port}）`,
      );
    }
    pass(
      "server spawn+握手（PG 主库模式）",
      `port=${info.port} instanceId=${info.instanceId}`,
    );

    control = new DirectControl(info.port, info.token);
    const request = (
      method: "GET" | "POST",
      reqPath: string,
      body?: unknown,
    ): Promise<RequestResult> =>
      (control as DirectControl).request(method, reqPath, body);

    // 3. 健康（带重试）+ 首启建库实证：boot 自动 db push（派生 schema）
    //    → 23 张业务表 + graphDefinition 在位（直查 information_schema）
    await waitForHealth(request);
    const tables = await scalar(
      pool,
      "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    if (tables !== EXPECTED_TABLES) {
      const names = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
      );
      fail(
        "首启建库（boot db push）",
        `业务表数期望 ${EXPECTED_TABLES} 实为 ${tables}：${names.rows.map((r) => (r as { table_name: string }).table_name).join(",")}`,
      );
    }
    const graphTable = await scalar(
      pool,
      `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'graphDefinition'`,
    );
    if (graphTable !== 1) {
      fail("首启建库（boot db push）", "graphDefinition 表不在 PG 中");
    }
    pass(
      "首启建库（boot db push）+ 健康",
      `/actuator/health ok；public 业务表 ${tables} 张，graphDefinition 在位`,
    );

    // 4. graph save 走 PG 主库：API 受理 + 直查 "graphDefinition" 行双证
    //    （camelCase 物理名须引号），另证引擎确未落 SQLite 文件
    const graph = (await call(request, "graph/save", "graph/save", {
      name: "e2e-main-pg 同库检索图",
      graphJson: hybridSearchGraphJson(COLLECTION),
    })) as { id: number; nodeCount: number };
    if (graph.nodeCount !== 1) {
      fail("graph/save", `nodeCount 期望 1 实为 ${graph.nodeCount}`);
    }
    const graphRows = await scalar(
      pool,
      `SELECT COUNT(*)::int AS n FROM "graphDefinition" WHERE id = $1`,
      [graph.id],
    );
    if (graphRows !== 1) {
      fail(
        "graph/save 落 PG",
        `API 受理 id=${graph.id} 但 PG "graphDefinition" 行数 ${graphRows} ≠ 1`,
      );
    }
    const sqlitePath = path.join(dataRoot, "database", "local.db");
    if (fs.existsSync(sqlitePath)) {
      fail("graph/save 落 PG", `引擎误落 SQLite：${sqlitePath} 存在`);
    }
    pass(
      "graph/save 走 PG 主库",
      `id=${graph.id} nodeCount=1；PG 行在位；无 SQLite 落库文件`,
    );

    // 5. 检索跟随：tianshu_search.vector_chunk 直插同库（search-pg 同款
    //    seed）→ hybridSearch keyword run → 命中/剔除断言
    const targetTexts = [
      "高可用架构在设计阶段须引入容错机制，故障隔离与优雅降级是容错设计的第一道防线。",
      "容错设计要求重试、熔断与幂等配合，避免局部故障在设计不当的链路上被放大为全局雪崩。",
    ];
    const offTopicTexts = [
      "今天的行程是京都的寺庙巡礼与宇治抹茶甜品，傍晚沿鸭川散步。",
    ];
    for (const ddl of PG_DDL) {
      await pool.query(ddl);
    }
    await upsertSeed(pool, tokenize, TARGET_SOURCE, targetTexts);
    await upsertSeed(pool, tokenize, OFF_TOPIC_SOURCE, offTopicTexts);
    const seeded = await scalar(
      pool,
      "SELECT COUNT(*)::int AS n FROM tianshu_search.vector_chunk WHERE user_id = $1 AND collection = $2",
      [USER_ID, COLLECTION],
    );
    if (seeded !== 3) {
      fail("检索表同库 seed", `首播计数期望 3 实为 ${seeded}`);
    }
    pass(
      "检索表同库 seed",
      `tianshu_search.vector_chunk（主库同库）「${TARGET_SOURCE}」×2 +「${OFF_TOPIC_SOURCE}」×1`,
    );

    const accepted = (await call(request, "graph/run", "graph/run", {
      graphId: graph.id,
      inputs: {},
    })) as { runId: number };
    log(`graph#${graph.id} run#${accepted.runId} 已受理（keyword）`);

    let state = "";
    let output = "";
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (state !== "succeeded" && state !== "failed") {
      const event = await nextEventIn(
        control,
        Math.max(1, deadline - Date.now()),
        "graph.run.updated 事件",
      );
      if (event.type !== "graph.run.updated") continue;
      const payload = event.payload as {
        runId?: number;
        graphId?: number;
        state?: string;
        output?: string;
        error?: string;
      };
      if (payload.runId !== accepted.runId || payload.graphId !== graph.id) {
        continue;
      }
      if (
        payload.state &&
        payload.state !== "running" &&
        payload.state !== "progress"
      ) {
        state = payload.state;
        output = payload.output ?? payload.error ?? "";
      }
    }
    if (state !== "succeeded") {
      fail("hybridSearch 执行", `终态 ${state}（${output.slice(0, 200)}）`);
    }
    if (!output.includes(TARGET_SOURCE) || !output.includes("相关度")) {
      fail(
        "hybridSearch keyword 中文命中（跟随主库）",
        `输出未含「${TARGET_SOURCE}｜相关度」：${output.slice(0, 200)}`,
      );
    }
    if (output.includes(OFF_TOPIC_SOURCE)) {
      fail(
        "hybridSearch keyword 中文命中（跟随主库）",
        `零词元交集条目「${OFF_TOPIC_SOURCE}」未被剔除（疑似全量透传）：${output.slice(0, 200)}`,
      );
    }
    pass(
      "hybridSearch keyword 中文命中（跟随主库）",
      `SEARCH_DB_URL 空 → 主库同库检索；run#${accepted.runId} succeeded；output「${output.slice(0, 60)}」`,
    );

    // 6. 重启两跳（two-boot，终审 F1 断言组）：检索表已有数据 → 停服 →
    //    复启（ensureDatabasePg 每次启动都跑 db push）→ 健康仍 ok 且检索
    //    行保全。检索表限 tianshu_search 独立 schema，db push（只管 public
    //    业务面）对其视而不见；若仍落 public，非空 vector_chunk 会被判
    //    drift（db push 拒绝 drop 非空表、退出 1）→ 第二次 boot 必炸。
    control?.close();
    control = null;
    await stopChild(child);
    child = null;
    const respawned = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-main-pg-token",
        TIANSHU_DATA_ROOT: dataRoot,
        TIANSHU_DB_URL: PG_URL,
        SEARCH_DB_URL: "",
      },
    );
    child = respawned.child;
    const info2 = parseHandshake(respawned.matched);
    if (info2.token !== "e2e-main-pg-token" || info2.port !== port) {
      fail(
        "重启握手（two-boot）",
        `token/port 未按 env 回显（token=${info2.token} port=${info2.port} ≠ 配置 ${port}）`,
      );
    }
    control = new DirectControl(info2.port, info2.token);
    await waitForHealth(request);
    const survived = await scalar(
      pool,
      "SELECT COUNT(*)::int AS n FROM tianshu_search.vector_chunk WHERE user_id = $1 AND collection = $2",
      [USER_ID, COLLECTION],
    );
    if (survived !== 3) {
      fail(
        "重启两跳：检索行保全",
        `第二次 boot 后计数期望 3 实为 ${survived}（检索表疑似被 db push 判 drift 清除）`,
      );
    }
    const tablesAfterReboot = await scalar(
      pool,
      "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    if (tablesAfterReboot !== EXPECTED_TABLES) {
      fail(
        "重启两跳：业务表幂等",
        `第二次 boot 后 public 业务表期望 ${EXPECTED_TABLES} 实为 ${tablesAfterReboot}`,
      );
    }
    pass(
      "重启两跳（two-boot）",
      `第二次 boot 健康 ok；tianshu_search.vector_chunk 检索行 ${survived} 保全；public 业务表 ${tablesAfterReboot} 张（db push 复跑幂等）`,
    );

    // 7. 清理：检索 schema DROP CASCADE（主库业务表留给 PG 卷/外部清理——
    //    一次性容器随销毁；收敛段在 finally 保失败路径同样回收）
    await pool.query(DROP_SEARCH_SQL);
    pass("PG 清理", "tianshu_search schema 已 DROP（业务表留存，随容器/卷销毁）");
  } finally {
    control?.close();
    await stopChild(child);
    await pool.query(DROP_SEARCH_SQL).catch(() => {});
    await pool.end().catch(() => {});
    fs.rmSync(E2E_CONFIG, { force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  return printSummary() > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(
      `[e2e-main-pg] 阶段失败：${e instanceof Error ? e.message : e}`,
    );
    const failed = outcomes.filter((o) => !o.ok);
    for (const o of failed) {
      console.log(`  FAIL  ${o.label} — ${o.detail}`);
    }
    process.exit(1);
  });
