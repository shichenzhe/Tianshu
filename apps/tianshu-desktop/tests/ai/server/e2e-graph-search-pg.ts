/**
 * PG 检索层 e2e（可选，门控 SEARCH_E2E_PG_URL；未设则 SKIP）：
 * 真 server 子进程（注入 SEARCH_DB_URL）→ vectorChunk 直插中文样本
 * （带假向量，绕过 vectorize 的真 embedding 依赖——对齐 e2e-graph-smoke 的
 * seedHybridChunks 手法但写向 PG）→ hybridSearch keyword 模式命中/剔除断言
 * → 重跑同款 upsert（DELETE+INSERT 事务，语句形状同运行时 upsertChunksPg）
 * 幂等（collection 计数不翻倍）。semantic/hybrid 的向量 SQL 语义由单测钉板
 * （e2e 免真模型外呼），spec 已显式此取舍。
 *
 * 直插 SQL 内联自 search-pg.ts 同款（DDL/INSERT 占位序/计数语句），不
 * import server 内部模块——e2e 走进程边界；分词与 server 同源
 * （@tianshu/core 的 tokenize，经 worktree 包 dist 绝对路径装载——裸模块名
 * 会命中主树 node_modules 的陈旧 dist，见脚本内注释）。PG 由 docker compose
 * 起 search-pg（起法见 apps/tianshu-server/README.md PG 检索模式段；宿主
 * 5432 被占时用 compose override 映射空闲宿主端口，URL 随之指向该端口）。
 *
 * 运行：npm run test:e2e:graphPg（node 原生 strip-types，需 Node ≥ 23.6；
 * 文件名无 .test. 段不进 vitest 常规集；TIANSHU_E2E_SKIP_BUILD=1 可跳过
 * server 构建）
 *
 * 基建单源：spawnScan / DirectControl / parseSseBlock / 握手解析 /
 * getFreePort / 停进程 / 包装体 call / 断言锚 / hybridSearchGraphJson /
 * PG 访问层与 seed（createPgSeeder）自 e2e-helpers.ts 导入（2026-10-31
 * 五副本归一，血统见其头注释）；本脚本保留 tokenize 装载位策略
 * （CORE_RETRIEVAL 绝对路径）与断言编排。
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DROP_SEARCH_SQL,
  E2E_CONFIG,
  MIRROR_ROOT,
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
/** core 包 dist 的检索模块（tokenize 单源）：绕过 node_modules 解析——
 * worktree node_modules 软链指主树，主树 dist 未必含 retrieval（未重建），

 * 绝对路径恒指向脚本所在树的包产物，与 server 侧 overlay 同树同源 */
const CORE_RETRIEVAL = path.join(
  MIRROR_ROOT,
  "packages",
  "tianshu-core",
  "dist",
  "retrieval.js",
);

const PG_URL = process.env.SEARCH_E2E_PG_URL;
if (!PG_URL) {
  console.log("SKIP: SEARCH_E2E_PG_URL 未配置（docker compose up search-pg 后设置）");
  process.exit(0);
}

/** 检索面按 userId 过滤——server 图运行恒为伴生用户（COMPANION_USER_ID=1） */
const USER_ID = 1;
const COLLECTION = "e2e-pg-hybrid";
const TARGET_SOURCE = "容错设计手册";
const OFF_TOPIC_SOURCE = "旅行日记";
const SEED_MODEL = "e2e-pg-seed";
const RUN_TIMEOUT_MS = 120_000;

const reporter = createE2eReporter("e2e-graph-pg");
const { outcomes, log, pass, call, printSummary } = reporter;

/** 断言失败即抛——函数声明形态保 never 控制流分析（reporter 解构件不保） */
function fail(label: string, detail: string): never {
  return reporter.fail(label, detail);
}

/** PG seed 器（e2e-helpers 单源；集合名/seed 标记为本脚本隔离值） */
const { upsertSeed, countCollection } = createPgSeeder({
  userId: USER_ID,
  collection: COLLECTION,
  seedModel: SEED_MODEL,
});

// —— 主流程 ——

async function main(): Promise<number> {
  log("PG 检索层 e2e 启动", `SEARCH_E2E_PG_URL=${PG_URL.replace(/:[^:@/]+@/, ":***@")}`);

  if (!fs.existsSync(CORE_RETRIEVAL)) {
    fail(
      "core 包分词模块",
      `${CORE_RETRIEVAL} 不存在——先重建共享包 dist（根 npm --prefix packages/tianshu-core run build）`,
    );
  }
  const { tokenize } = (await import(
    pathToFileURL(CORE_RETRIEVAL).href
  )) as { tokenize: (text: string) => string[] };
  if (typeof tokenize !== "function") {
    fail("core 包分词模块", "dist 导出缺 tokenize（陈旧产物？重建共享包 dist）");
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
        `[e2e-graph-pg] FAIL：构建失败\n${(build.stderr ?? "").slice(-2000)}`,
      );
      return 1;
    }
  }
  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error(
      `[e2e-graph-pg] FAIL：无头端产物不存在 ${SERVER_ENTRY}（先在 tianshu-server 执行 npm run build）`,
    );
    return 1;
  }

  const { Pool } = (await import("pg")) as unknown as {
    Pool: new (opts: { connectionString: string }) => PgPoolLike;
  };
  const pool: PgPoolLike = new Pool({ connectionString: PG_URL });

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-e2e-pg-"));
  let child: ChildProcess | null = null;
  let control: DirectControl | null = null;
  try {
    // 1. 直连 PG：清场 + 幂等建库（与运行时 PG_DDL 同款）
    await pool.query(DROP_SEARCH_SQL);
    for (const ddl of PG_DDL) {
      await pool.query(ddl);
    }
    pass(
      "PG 建库",
      "DROP CASCADE 清场 + schema/扩展/表/GIN·复合索引五语句 DDL 就绪",
    );

    // 2. 中文样本直插（目标条目两块均含「容错/设计」词元；无关条目零词元
    //    交集——FTS 真匹配而非全量透传的反证）
    const targetTexts = [
      "高可用架构在设计阶段须引入容错机制，故障隔离与优雅降级是容错设计的第一道防线。",
      "容错设计要求重试、熔断与幂等配合，避免局部故障在设计不当的链路上被放大为全局雪崩。",
    ];
    const offTopicTexts = ["今天的行程是京都的寺庙巡礼与宇治抹茶甜品，傍晚沿鸭川散步。"];
    await upsertSeed(pool, tokenize, TARGET_SOURCE, targetTexts);
    await upsertSeed(pool, tokenize, OFF_TOPIC_SOURCE, offTopicTexts);
    const seeded = await countCollection(pool);
    if (seeded !== 3) {
      fail("中文样本直插", `首播计数期望 3 实为 ${seeded}`);
    }
    pass("中文样本直插", `「${TARGET_SOURCE}」×2 +「${OFF_TOPIC_SOURCE}」×1，collection 计数 ${seeded}`);

    // 3. spawn server 子进程：主库指临时 SQLite（e2e-graph-smoke 的 SERVER_DB
    //    模式），检索库注入 SEARCH_DB_URL 指向真 PG
    const port = await getFreePort();
    fs.writeFileSync(
      E2E_CONFIG,
      `# e2e-graph-search-pg 生成（运行完自动删除）\napp:\n  port: ${port}\n`,
    );
    const spawned = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-graph-pg-token-0123456789abcdef0123456789",
        TIANSHU_HANDSHAKE_TOKEN: "1",
        TIANSHU_DATA_ROOT: dataRoot,
        TIANSHU_DB_URL: path.join(dataRoot, "database", "local.db"),
        SEARCH_DB_URL: PG_URL,
      },
    );
    child = spawned.child;
    const info = parseHandshake(spawned.matched);
    if (info.token !== "e2e-graph-pg-token-0123456789abcdef0123456789" || info.port !== port) {
      fail(
        "server spawn+握手",
        `token/port 未按 env 回显（token=${info.token} port=${info.port} ≠ 配置 ${port}）`,
      );
    }
    pass(
      "server spawn+握手（SEARCH_DB_URL 注入）",
      `port=${info.port} instanceId=${info.instanceId}`,
    );

    control = new DirectControl(info.port, info.token);
    const request = (
      method: "GET" | "POST",
      reqPath: string,
      body?: unknown,
    ): Promise<RequestResult> =>
      (control as DirectControl).request(method, reqPath, body);

    // 4. hybridSearch keyword 图 → run → 事件至终态 → 命中/剔除断言
    const graph = (await call(request, "graph/save", "graph/save", {
      name: "e2e-graph-search-pg 混合检索图",
      graphJson: hybridSearchGraphJson(COLLECTION),
    })) as { id: number; nodeCount: number };
    if (graph.nodeCount !== 1) {
      fail("graph/save", `nodeCount 期望 1 实为 ${graph.nodeCount}`);
    }
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
        "hybridSearch keyword 中文命中",
        `输出未含「${TARGET_SOURCE}｜相关度」：${output.slice(0, 200)}`,
      );
    }
    if (output.includes(OFF_TOPIC_SOURCE)) {
      fail(
        "hybridSearch keyword 中文命中",
        `零词元交集条目「${OFF_TOPIC_SOURCE}」未被剔除（疑似全量透传）：${output.slice(0, 200)}`,
      );
    }
    pass(
      "hybridSearch keyword 中文命中",
      `run#${accepted.runId} succeeded；output「${output.slice(0, 60)}」`,
    );

    // 5. 幂等探针：重跑同款 upsert（同 user/collection/source_name）→ 计数不翻倍
    await upsertSeed(pool, tokenize, TARGET_SOURCE, targetTexts);
    await upsertSeed(pool, tokenize, OFF_TOPIC_SOURCE, offTopicTexts);
    const reseeded = await countCollection(pool);
    if (reseeded !== 3) {
      fail(
        "upsert 幂等",
        `重播后 collection 计数期望 3（不翻倍）实为 ${reseeded}`,
      );
    }
    pass("upsert 幂等", `同键重播后计数 ${seeded} → ${reseeded}（DELETE+INSERT 事务不翻倍）`);

    // 收敛：图删除（临时主库随之弃置）
    await call(request, "graph/delete 收敛", "graph/delete", { id: graph.id });

    // 6. PG 清理
    await pool.query(DROP_SEARCH_SQL);
    pass("PG 清理", "tianshu_search schema 已 DROP");
  } finally {
    control?.close();
    await stopChild(child);
    await pool.end().catch(() => {});
    fs.rmSync(E2E_CONFIG, { force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  return printSummary() > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[e2e-graph-pg] 阶段失败：${e instanceof Error ? e.message : e}`);
    const failed = outcomes.filter((o) => !o.ok);
    for (const o of failed) {
      console.log(`  FAIL  ${o.label} — ${o.detail}`);
    }
    process.exit(1);
  });
