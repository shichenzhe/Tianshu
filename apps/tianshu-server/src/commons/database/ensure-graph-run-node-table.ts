/**
 * 图运行节点详情表建表（图执行留痕去会话化 2026-10-28，终审 C2）：
 * 启动幂等补建——ensureDatabase 的 db push 只覆盖「缺库/空壳首启」，
 * 存量部署升级库就绪即跳过，graphRunNode 建表无路径（图执行
 * no such table 100% run failed、删图/删任务事务首句 deleteMany 抛错
 * 回滚、retention 持续报错）。DDL 与 mirror electron/commons/
 * prisma-client.ts 的 ensureGraphRunNodeTable 逐字同源；schema.prisma
 * 模型保留（新库 db push 用）。须在 ensureDatabase 之后调用。
 */
/** 结构最小面：仅需执行原生 DDL（PrismaService / 测试桩同构满足） */
interface RawExecutor {
  $executeRawUnsafe(sql: string): Promise<number>;
}

export async function ensureGraphRunNodeTable(
  db: RawExecutor,
): Promise<void> {
  await db.$executeRawUnsafe(`
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
  await db.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS graphRunNode_runId_idx ON graphRunNode (runId)',
  );
}
