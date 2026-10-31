/**
 * automationRun 执行历史保留策略（自 mirror electron/domains/ai/automation/
 * automation-retention.ts 摘取，2026-10 方案 A）：双限分级（成功态 7 天/200 条，
 * 失败态 30 天/500 条）+ graphTrace 先行降级（超 3 天置空轨迹）。
 * run 行删除前级联删其 graphRunNode 节点行（去会话化 2026-10-28，
 * spec §3.1——按天档两段取 id 集合，条数窗用同窗子查询 SQL 先行）。
 * 改造点（登记）：commons/Log → Nest Logger（授权面 prisma/环境适配同款，
 * 照 automation-stat 先例）。其余逐行保持。
 */
import { Logger } from '@nestjs/common';
import {
  engineOf,
  overriddenDbUrl,
  type DbEngine,
} from '../../commons/database/db-url';

const logger = new Logger('automation-retention');

export interface RunRetentionConfig {
  enabled: boolean;
  traceDays: number;
  successDays: number;
  successKeep: number;
  failureDays: number;
  failureKeep: number;
}

export const DEFAULT_RUN_RETENTION: RunRetentionConfig = {
  enabled: true,
  traceDays: 3,
  successDays: 7,
  successKeep: 200,
  failureDays: 30,
  failureKeep: 500,
};

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : min;

function clampNumber(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof raw === 'number' ? clamp(raw, min, max) : fallback;
}

/** option 表 value → 配置；逐字段 clamp 回退，非法整体回默认 */
export function parseRunRetention(
  raw: string | null | undefined,
): RunRetentionConfig {
  if (!raw) {
    return { ...DEFAULT_RUN_RETENTION };
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null) {
      return { ...DEFAULT_RUN_RETENTION };
    }
    return {
      enabled:
        typeof obj.enabled === 'boolean'
          ? obj.enabled
          : DEFAULT_RUN_RETENTION.enabled,
      traceDays: clampNumber(
        obj.traceDays,
        1,
        3650,
        DEFAULT_RUN_RETENTION.traceDays,
      ),
      successDays: clampNumber(
        obj.successDays,
        1,
        3650,
        DEFAULT_RUN_RETENTION.successDays,
      ),
      successKeep: clampNumber(
        obj.successKeep,
        1,
        10000,
        DEFAULT_RUN_RETENTION.successKeep,
      ),
      failureDays: clampNumber(
        obj.failureDays,
        1,
        3650,
        DEFAULT_RUN_RETENTION.failureDays,
      ),
      failureKeep: clampNumber(
        obj.failureKeep,
        1,
        10000,
        DEFAULT_RUN_RETENTION.failureKeep,
      ),
    };
  } catch {
    return { ...DEFAULT_RUN_RETENTION };
  }
}

/** 窄面结构类型：真 prisma 单例结构兼容可直传（automation-stat 同款手法） */
export interface RetentionDb {
  automationRun: {
    updateMany(args: {
      where: {
        startedAt?: { lt: Date };
        graphTrace?: { not: null };
      };
      data: { graphTrace: null };
    }): Promise<{ count: number }>;
    findMany(args: {
      where: {
        status?: string | { notIn: string[] };
        startedAt?: { lt: Date };
      };
      select: { id: true };
    }): Promise<Array<{ id: number }>>;
    deleteMany(args: {
      where: {
        status?: string | { notIn: string[] };
        startedAt?: { lt: Date };
      };
    }): Promise<{ count: number }>;
  };
  graphRunNode: {
    deleteMany(args: {
      where: { runId: { in: number[] } };
    }): Promise<{ count: number }>;
  };
  option: {
    findFirst(args: {
      where: { type: string; name: string };
    }): Promise<{ value: string } | null>;
  };
  $executeRawUnsafe(sql: string, ...values: number[]): Promise<number>;
}

export interface RetentionTrimResult {
  tracedRuns: number;
  successDaysDeleted: number;
  failureDaysDeleted: number;
  successKeepDeleted: number;
  failureKeepDeleted: number;
}

const daysAgo = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

/** 每任务条数窗删除（SQLite ≥3.25 / PG 同款窗口函数；taskId NULL 同组=
 * 图试运行自成一组）。双引擎方言（主库双引擎批）：PG 变体须引号 camelCase
 * 标识符（派生 migrations 建表为引号 camelCase，裸写被 PG 折叠小写
 * 即表/列不存在）+ $1 占位符（PG 引擎不认 ?）；SQLite 变体与原串逐字节
 * 不变。引擎取 env（retention 跑在 boot 后，env 稳定——ensureGraphRunNodeTable
 * 同款默认参手法；maybeTrim 吞错下 SQL 方言错=裁剪静默永败，单测钉形状）。 */
const trimKeepSql = (
  keep: number,
  statusWhere: string,
  engine: DbEngine = engineOf(overriddenDbUrl()),
): string =>
  engine === 'postgres'
    ? `
  DELETE FROM "automationRun" WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY "taskId" ORDER BY id DESC) AS rn
      FROM "automationRun" WHERE ${statusWhere}
    ) WHERE rn > $1
  )
`
    : `
  DELETE FROM automationRun WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY taskId ORDER BY id DESC) AS rn
      FROM automationRun WHERE ${statusWhere}
    ) WHERE rn > ?
  )
`;

/** 条数窗的节点行级联（去会话化 2026-10-28，spec §3.1）：与 trimKeepSql
 * 同窗子查询选 id，先于 run 窗删除执行——run 删除后子查询即失效；
 * 双引擎方言同 trimKeepSql（PG 引号标识符 + $1） */
const trimKeepNodesSql = (
  statusWhere: string,
  engine: DbEngine = engineOf(overriddenDbUrl()),
): string =>
  engine === 'postgres'
    ? `
  DELETE FROM "graphRunNode" WHERE "runId" IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY "taskId" ORDER BY id DESC) AS rn
      FROM "automationRun" WHERE ${statusWhere}
    ) WHERE rn > $1
  )
`
    : `
  DELETE FROM graphRunNode WHERE runId IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY taskId ORDER BY id DESC) AS rn
      FROM automationRun WHERE ${statusWhere}
    ) WHERE rn > ?
  )
`;

/** 按天档删 run 前级联删其节点行（graphRunNode 无 status/startedAt 列，
 * 以同 where 先取 run id 集合再删；空集合免触库） */
async function cascadeDeleteRunNodes(
  prisma: RetentionDb,
  where: { status: string | { notIn: string[] }; startedAt: { lt: Date } },
): Promise<void> {
  const rows = await prisma.automationRun.findMany({
    where,
    select: { id: true },
  });
  if (rows.length === 0) {
    return;
  }
  await prisma.graphRunNode.deleteMany({
    where: { runId: { in: rows.map((row) => row.id) } },
  });
}

export async function trimAutomationRuns(
  prisma: RetentionDb,
  config: RunRetentionConfig,
  now = new Date(),
): Promise<RetentionTrimResult> {
  if (!config.enabled) {
    return {
      tracedRuns: 0,
      successDaysDeleted: 0,
      failureDaysDeleted: 0,
      successKeepDeleted: 0,
      failureKeepDeleted: 0,
    };
  }
  // 1. graphTrace 先行降级（保行清大字段）
  const tracedRuns = (
    await prisma.automationRun.updateMany({
      where: {
        startedAt: { lt: daysAgo(now, config.traceDays) },
        graphTrace: { not: null },
      },
      data: { graphTrace: null },
    })
  ).count;
  // 2. 成功态按天（running 永不裁剪；expired/skipped 归成功档）；run 行
  // 删除前先级联删节点行
  await cascadeDeleteRunNodes(prisma, {
    status: { notIn: ['failed', 'running'] },
    startedAt: { lt: daysAgo(now, config.successDays) },
  });
  const successDaysDeleted = (
    await prisma.automationRun.deleteMany({
      where: {
        status: { notIn: ['failed', 'running'] },
        startedAt: { lt: daysAgo(now, config.successDays) },
      },
    })
  ).count;
  // 3. 失败态按天（保留更久；精确匹配 failed，与下方 SQL status = 'failed' 对齐）
  await cascadeDeleteRunNodes(prisma, {
    status: 'failed',
    startedAt: { lt: daysAgo(now, config.failureDays) },
  });
  const failureDaysDeleted = (
    await prisma.automationRun.deleteMany({
      where: {
        status: 'failed',
        startedAt: { lt: daysAgo(now, config.failureDays) },
      },
    })
  ).count;
  // 4/5. 每任务条数窗（参数化防注入；keep 已 clamp 为有限整数）；节点行
  // 级联先于 run 窗删除执行
  await prisma.$executeRawUnsafe(
    trimKeepNodesSql("status NOT IN ('failed', 'running')"),
    config.successKeep,
  );
  const successKeepDeleted = await prisma.$executeRawUnsafe(
    trimKeepSql(config.successKeep, "status NOT IN ('failed', 'running')"),
    config.successKeep,
  );
  await prisma.$executeRawUnsafe(
    trimKeepNodesSql("status = 'failed'"),
    config.failureKeep,
  );
  const failureKeepDeleted = await prisma.$executeRawUnsafe(
    trimKeepSql(config.failureKeep, "status = 'failed'"),
    config.failureKeep,
  );
  return {
    tracedRuns,
    successDaysDeleted,
    failureDaysDeleted,
    successKeepDeleted,
    failureKeepDeleted,
  };
}

export const TRIM_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastTrimAtMs = 0;

/** 读最新配置并裁剪（6h 节流）；吞错——清理失败不阻塞调度 */
export async function maybeTrimAutomationRuns(
  prisma: RetentionDb,
  nowMs = Date.now(),
): Promise<void> {
  if (nowMs - lastTrimAtMs < TRIM_INTERVAL_MS) {
    return;
  }
  lastTrimAtMs = nowMs;
  try {
    const option = await prisma.option.findFirst({
      where: { type: 'app', name: 'automation.runRetention' },
    });
    const config = parseRunRetention(option?.value);
    const result = await trimAutomationRuns(prisma, config);
    if (
      result.tracedRuns ||
      result.successDaysDeleted ||
      result.failureDaysDeleted ||
      result.successKeepDeleted ||
      result.failureKeepDeleted
    ) {
      logger.log('自动化执行历史裁剪完成', result);
    }
  } catch (e) {
    logger.warn('自动化执行历史裁剪失败', e);
  }
}
