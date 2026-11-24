import fs from "node:fs";
import path from "node:path";
import { app } from "electron"; // 用于 Electron 应用的全局功能
import { PrismaClient } from "../generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { databaseDir } from "./paths";
import { ensureTianshuData } from "./tianshu-data";
// 副作用导入：statement 缓存补丁须在 adapter 创建 Database 实例前生效
// （Node 24 代运行时 Statement GC finalizer 竞态崩溃，详见补丁文件头注释）
import "./sqlite-stmt-cache";
import { backfillRunSessionOwners } from "../domains/ai/automation/run-session-owner";

// 判断当前环境是否是开发环境
const isDevelopment = !app.isPackaged;
// 建库前先完成数据根装配与历史迁移（含自定义根冷迁移——SQLite 运行中
// 不可搬，必须赶在打开连接之前；打包器模块顺序不可依赖，消费者自查，
// 见 tianshu-data.ts 头注释）
ensureTianshuData();
const databasePath = databaseDir();

if (!fs.existsSync(databasePath)) {
  fs.mkdirSync(databasePath, { recursive: true });
}

const dbFilePath = path.join(databasePath, "local.db").replace(/\\/g, "/");
process.env.DATABASE_URL = `file:${dbFilePath}`;
console.info("db version:", process.env.DATABASE_URL);

const adapter = new PrismaBetterSqlite3({ url: dbFilePath });
const prisma = new PrismaClient({
  adapter,
  // info 级会启用 query 事件（每条 SQL 一条日志）：后台定时器与聊天热路径
  // 常年产生数万条/天，生产环境纯开销——仅开发环境保留方便调试
  log: isDevelopment ? ["info", "warn", "error"] : ["warn", "error"],
});

// SQLite 调优（WAL + NORMAL 同步）：应用有多个后台写源（chat 落库、
// automation 定时 tick、audit 批量 flush），默认 DELETE 日志模式下读写
// 互斥会周期性互卡；WAL 持久化到库文件头（幂等），失败仅记日志不阻塞启动
void prisma
  .$queryRawUnsafe("PRAGMA journal_mode=WAL")
  .then(() => prisma.$queryRawUnsafe("PRAGMA synchronous=NORMAL"))
  .catch((e) => console.error("SQLite PRAGMA 调优失败:", e));

/**
 * 产物表建表（H7a）：启动幂等补建（与事件表索引同理，不走 v1 快照避免
 * 指纹变化触发旧库 drop 重建）。须在 initDatabase 建表之后调用。
 */
export async function ensureArtifactTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS artifact (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      userId INTEGER NOT NULL,
      workspaceId INTEGER NOT NULL,
      sessionId INTEGER NOT NULL,
      relPath TEXT NOT NULL,
      createdAt DATETIME NOT NULL,
      CONSTRAINT artifact_userId_workspaceId_relPath_key UNIQUE (userId, workspaceId, relPath)
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS artifact_userId_idx ON artifact (userId)",
  );
}

/**
 * provider 表加列（provider 窗口批 2026-11-01）：服务商级默认上下文窗口
 * contextWindow。启动幂等补建（artifact/监控表先例，不走 v1 快照避免
 * 指纹变化触发旧库 drop 重建）——SQLite ALTER ADD COLUMN 无 IF NOT
 * EXISTS 形态，先查 pragma_table_info 判列存在再补。
 */
export async function ensureProviderColumns(): Promise<void> {
  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM pragma_table_info('provider')",
  );
  if (columns.some((col) => col.name === "contextWindow")) return;
  await prisma.$executeRawUnsafe(
    "ALTER TABLE provider ADD COLUMN contextWindow INTEGER",
  );
}

/**
 * 监控事件表建表（token/工具监控 spec §3.2）：启动幂等补建，不走 v1
 * 快照（指纹变化会触发旧库 drop 重建）。须在 initDatabase 之后调用。
 */
export async function ensureMonitorTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS llmCallEvent (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      userId INTEGER,
      scene TEXT NOT NULL,
      modelId INTEGER,
      sessionId INTEGER,
      graphId INTEGER,
      inputTokens INTEGER NOT NULL,
      outputTokens INTEGER NOT NULL,
      durationMs INTEGER,
      meta TEXT,
      createdAt DATETIME NOT NULL
    )
  `);
  // meta 列补建（专家团可观测性批 2026-11-05，ensureProviderColumns 先例）：
  // CREATE TABLE IF NOT EXISTS 不补列，旧库经 pragma 判缺席后 ALTER
  const llmColumns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM pragma_table_info('llmCallEvent')",
  );
  if (!llmColumns.some((col) => col.name === "meta")) {
    await prisma.$executeRawUnsafe(
      "ALTER TABLE llmCallEvent ADD COLUMN meta TEXT",
    );
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS toolCallEvent (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      userId INTEGER,
      scene TEXT NOT NULL,
      toolName TEXT NOT NULL,
      state TEXT NOT NULL,
      durationMs INTEGER,
      sessionId INTEGER,
      createdAt DATETIME NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS llmCallEvent_userId_createdAt_idx ON llmCallEvent (userId, createdAt)",
  );
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS toolCallEvent_userId_createdAt_idx ON toolCallEvent (userId, createdAt)",
  );
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS toolCallEvent_userId_toolName_idx ON toolCallEvent (userId, toolName)",
  );
}

/**
 * 图运行节点详情表建表（图执行留痕去会话化 2026-10-28）：启动幂等补建，
 * 不走 v1 快照（指纹变化会触发旧库 drop 重建）。须在 initDatabase 之后调用。
 */
export async function ensureGraphRunNodeTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS graphRunNode (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      runId INTEGER NOT NULL,
      nodeId TEXT NOT NULL,
      nodeName TEXT,
      status TEXT NOT NULL,
      input TEXT,
      output TEXT,
      errorJson TEXT,
      toolCallsJson TEXT,
      promptTokens INTEGER,
      completionTokens INTEGER,
      durationMs INTEGER NOT NULL,
      startedAt TEXT NOT NULL,
      outputImage TEXT,
      errorOutput TEXT,
      fallbackJson TEXT,
      CONSTRAINT graphRunNode_runId_nodeId_key UNIQUE (runId, nodeId)
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS graphRunNode_runId_idx ON graphRunNode (runId)",
  );
}

const LEGACY_RUN_LINK_BATCH_SIZE = 500;

/**
 * v0.1.1 缺列事故修复（2026-11-24）：0.1.1 的 dd059b5c/4c85a37c 两提交
 * 误走 v1 快照加列（应走本 ensure 惯例），打包态旧库 CREATE TABLE IF NOT
 * EXISTS 不补列 + 快照守卫永不重置 → Prisma 按新 schema SELECT 显式列清
 * 单报 no such column，会话/工作流列表全空。此处对 v0.1.0 旧库幂等补齐：
 * session.automationTaskId/runGraphId、graphDefinition.aiSessionId、
 * automationRun.workspaceId 四列，两条 session 索引，及
 * automationRun.sessionId 唯一索引（建前查重——旧模型多 run 可共享同一
 * 会话，保留每组 startedAt 最新 run 的链接、其余置 null）。
 * 须在 cleanupGraphRunSessions 与业务查询之前执行。
 */
export async function ensureRunSessionColumns(): Promise<void> {
  const tableColumns = async (
    table: string,
  ): Promise<Array<{ name: string }>> =>
    prisma.$queryRawUnsafe(`SELECT name FROM pragma_table_info('${table}')`);
  const ensureColumn = async (
    table: string,
    column: string,
    ddl: string,
  ): Promise<void> => {
    const columns = await tableColumns(table);
    if (!columns.some((col) => col.name === column)) {
      await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };

  await ensureColumn("session", "automationTaskId", "automationTaskId INTEGER");
  await ensureColumn("session", "runGraphId", "runGraphId INTEGER");
  await ensureColumn("graphDefinition", "aiSessionId", "aiSessionId INTEGER");
  await ensureColumn("automationRun", "workspaceId", "workspaceId INTEGER");
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS session_automationTaskId_idx ON session (automationTaskId)",
  );
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS session_runGraphId_idx ON session (runGraphId)",
  );

  // 唯一索引（缺建时）：先清多 run 共享会话的重复链接再上约束
  const runIndexes = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM pragma_index_list('automationRun')",
  );
  if (!runIndexes.some((idx) => idx.name === "automationRun_sessionId_key")) {
    await prisma.$executeRawUnsafe(`
      UPDATE automationRun
      SET sessionId = NULL
      WHERE sessionId IS NOT NULL
        AND id NOT IN (
          SELECT r.id FROM automationRun r
          WHERE r.sessionId IS NOT NULL
            AND r.id = (
              SELECT r2.id FROM automationRun r2
              WHERE r2.sessionId = r.sessionId
              ORDER BY r2.startedAt DESC, r2.id DESC
              LIMIT 1
            )
        )
    `);
    await prisma.$executeRawUnsafe(
      "CREATE UNIQUE INDEX IF NOT EXISTS automationRun_sessionId_key ON automationRun(sessionId)",
    );
  }
}

/**
 * 存量图运行会话清理（去会话化 2026-10-28 一次性迁移）：图 run 产生的
 * 会话+消息删除、run.sessionId 置 null（prompt 型 run graphId 恒 null
 * 不受影响）。幂等：清后判据不再命中。须在 initDatabase 之后调用。
 */
export async function cleanupGraphRunSessions(): Promise<void> {
  const runs = await prisma.automationRun.findMany({
    where: { graphId: { not: null }, sessionId: { not: null } },
    select: { id: true, sessionId: true },
  });
  const sessionIds = [
    ...new Set(
      runs.map((r) => r.sessionId).filter((id): id is number => id !== null),
    ),
  ];
  if (sessionIds.length > 0) {
    // 新模型下带分组列的是用户伴随会话，不属于 2026-10-28 旧图会话清理。
    const legacySessions = await prisma.session.findMany({
      where: {
        id: { in: sessionIds },
        automationTaskId: null,
        runGraphId: null,
      },
      select: { id: true },
    });
    const legacyIds = legacySessions.map((session) => session.id);
    if (legacyIds.length > 0) {
      const legacyRunIds = runs
        .filter(
          (run) => run.sessionId !== null && legacyIds.includes(run.sessionId),
        )
        .map((run) => run.id);
      await prisma.message.deleteMany({
        where: { sessionId: { in: legacyIds } },
      });
      await prisma.session.deleteMany({ where: { id: { in: legacyIds } } });
      for (
        let start = 0;
        start < legacyRunIds.length;
        start += LEGACY_RUN_LINK_BATCH_SIZE
      ) {
        const batch = legacyRunIds.slice(
          start,
          start + LEGACY_RUN_LINK_BATCH_SIZE,
        );
        await prisma.automationRun.updateMany({
          where: { id: { in: batch } },
          data: { sessionId: null },
        });
      }
    }
  }
  // 同在 initDatabase 后执行的存量数据迁移：只回填仍可反查任务的 prompt 会话。
  await backfillRunSessionOwners(prisma);
}

/**
 * 埋点事件表维护（M12）：索引幂等补建 + 90 天保留期裁剪。
 * 索引不走 v1 建表脚本——v1 快照 sha256 变化会触发旧库 drop 重建
 * （开发期数据可弃的约定只对该语义兜底，不应因加索引而清库），
 * 幂等 CREATE INDEX IF NOT EXISTS 让新老库统一补齐且零数据影响；
 * 事件表 append-only 无人清理，裁剪防其无界增长。
 * 须在 initDatabase 建表之后调用（表不存在时索引语句会失败）。
 */
export async function ensureEventStatMaintenance(): Promise<void> {
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS skillStat_name_createdAt_idx ON skillStat (name, createdAt)",
  );
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS automationStat_createdAt_idx ON automationStat (createdAt)",
  );
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await prisma.skillStat.deleteMany({ where: { createdAt: { lt: cutoff } } });
  await prisma.automationStat.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  // 监控事件表（token/工具监控）同享 90 天保留期：与埋点表同为
  // append-only 高频写入，不裁剪会无界增长
  await prisma.llmCallEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  await prisma.toolCallEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
}

export default prisma;
