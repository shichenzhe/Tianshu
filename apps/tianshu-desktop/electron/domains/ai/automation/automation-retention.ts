/**
 * automationRun 执行历史保留策略（方案 A，2026-10-22 裁定）：
 * 双限分级（成功态 7 天/200 条，失败态 30 天/500 条，先到先删）
 * + graphTrace 先行降级（超 3 天置空轨迹，元数据行多保留一档）。
 * run 行删除前级联删其 graphRunNode 节点行（去会话化 2026-10-28，
 * spec §3.1——按天档两段取 id 集合，条数窗用同窗子查询 SQL 先行）。
 * 照 automation-stat 先例：PrismaLike 结构类型注入、吞错不阻塞调度。
 * 双份同构文件：apps/tianshu-server/src/modules/automation/automation-retention.ts
 * （唯一授权差异：引号风格 + Log→Nest Logger + 头注释，drift-manifest 守护）。
 * 前端 parseTrace 对空 graphTrace 已容错（GraphRunTraceView「老 run 无 trace」注释）。
 */
import Log from "../../../commons/Log";
import { emitAutomationChanged } from "./automation-change-bus";
import {
  clearRunSessionOwners,
  type RunSessionOwnerDb,
} from "./run-session-owner";

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
  return typeof raw === "number" ? clamp(raw, min, max) : fallback;
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
    if (typeof obj !== "object" || obj === null) {
      return { ...DEFAULT_RUN_RETENTION };
    }
    return {
      enabled:
        typeof obj.enabled === "boolean"
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
export interface RetentionDb extends RunSessionOwnerDb {
  automationRun: RunSessionOwnerDb["automationRun"] & {
    updateMany(args: {
      where: {
        startedAt?: { lt: Date };
        graphTrace?: { not: null };
      };
      data: { graphTrace: null };
    }): Promise<{ count: number }>;
    deleteMany(args: {
      where: { id: { in: number[] } };
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
  $transaction<T>(callback: (tx: RetentionDb) => Promise<T>): Promise<T>;
  $queryRawUnsafe(sql: string, ...values: number[]): Promise<unknown>;
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

/** 每任务条数窗待删 run id（SQLite ≥3.25 窗口函数；taskId NULL 同组=图试运行自成一组） */
const trimKeepIdsSql = (statusWhere: string): string => `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY taskId ORDER BY id DESC) AS rn
    FROM automationRun WHERE ${statusWhere}
  ) WHERE rn > ?
`;

const RUN_DELETE_BATCH_SIZE = 500;

/** 所有 run 删除共用：单事务内按 500 个稳定 id 分批清理与删除。 */
async function deleteRunRows(
  prisma: RetentionDb,
  runIds: number[],
): Promise<number> {
  if (runIds.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    let deleted = 0;
    for (let start = 0; start < runIds.length; start += RUN_DELETE_BATCH_SIZE) {
      const batch = runIds.slice(start, start + RUN_DELETE_BATCH_SIZE);
      await clearRunSessionOwners(tx, batch);
      await tx.graphRunNode.deleteMany({ where: { runId: { in: batch } } });
      deleted += (
        await tx.automationRun.deleteMany({ where: { id: { in: batch } } })
      ).count;
    }
    return deleted;
  });
}

/** 按天档先取现存 run id，再统一事务删除；空集合免触库。 */
async function deleteRunsWhere(
  prisma: RetentionDb,
  where: { status: string | { notIn: string[] }; startedAt: { lt: Date } },
): Promise<number> {
  const rows = await prisma.automationRun.findMany({
    where,
    select: { id: true, sessionId: true, taskId: true, graphId: true },
  });
  return deleteRunRows(
    prisma,
    rows.map((row) => row.id),
  );
}

async function trimRunsByKeep(
  prisma: RetentionDb,
  keep: number,
  statusWhere: string,
): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    trimKeepIdsSql(statusWhere),
    keep,
  )) as Array<{ id: number }>;
  return deleteRunRows(
    prisma,
    rows.map((row) => row.id),
  );
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
  // 2. 成功态按天（running 永不裁剪；expired/skipped 归成功档）
  const successDaysDeleted = await deleteRunsWhere(prisma, {
    status: { notIn: ["failed", "running"] },
    startedAt: { lt: daysAgo(now, config.successDays) },
  });
  // 3. 失败态按天（保留更久；精确匹配 failed，与条数窗状态条件对齐）
  const failureDaysDeleted = await deleteRunsWhere(prisma, {
    status: "failed",
    startedAt: { lt: daysAgo(now, config.failureDays) },
  });
  // 4/5. 每任务条数窗（参数化防注入；keep 已 clamp 为有限整数）
  const successKeepDeleted = await trimRunsByKeep(
    prisma,
    config.successKeep,
    "status NOT IN ('failed', 'running')",
  );
  const failureKeepDeleted = await trimRunsByKeep(
    prisma,
    config.failureKeep,
    "status = 'failed'",
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
      where: { type: "app", name: "automation.runRetention" },
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
      Log.info("自动化执行历史裁剪完成", result);
      emitAutomationChanged();
    }
  } catch (e) {
    Log.warn("自动化执行历史裁剪失败", e);
  }
}
