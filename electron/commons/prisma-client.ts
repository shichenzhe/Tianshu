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
      createdAt DATETIME NOT NULL
    )
  `);
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

/**
 * 存量图运行会话清理（去会话化 2026-10-28 一次性迁移）：图 run 产生的
 * 会话+消息删除、run.sessionId 置 null（prompt 型 run graphId 恒 null
 * 不受影响）。幂等：清后判据不再命中。须在 initDatabase 之后调用。
 */
export async function cleanupGraphRunSessions(): Promise<void> {
  const runs = await prisma.automationRun.findMany({
    where: { graphId: { not: null }, sessionId: { not: null } },
    select: { sessionId: true },
    distinct: ["sessionId"],
  });
  const sessionIds = runs
    .map((r) => r.sessionId)
    .filter((id): id is number => id !== null);
  if (sessionIds.length > 0) {
    await prisma.message.deleteMany({
      where: { sessionId: { in: sessionIds } },
    });
    await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
    await prisma.automationRun.updateMany({
      where: { graphId: { not: null }, sessionId: { not: null } },
      data: { sessionId: null },
    });
  }
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
