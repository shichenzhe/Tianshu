/**
 * 自动化每日统计 rollup 纯函数（批3A，spec §6-6）：automationStat 只记
 * create 埋点、健康度即时聚合无历史快照——run 又被保留策略裁剪，「上周
 * 成功率」不可回溯。本模块提供按日 × 按用户聚合桶 + 单调合并（重算缩
 * 水保底）：落库形状 automationStat 行 event=dailyRollup（新 bucket
 * 类型，免 schema 迁移）、detail=JSON(DailyRollupDetail)。
 * 双端调度器 tick 节流写（消费方 automation-stat.ts）。
 */

/** automationStat 新事件桶名（detail = DailyRollupDetail JSON） */
export const AUTOMATION_STAT_ROLLUP_EVENT = "dailyRollup";

/** 回溯窗口：与 computeStats trend 同为 7 天（窗口外行冻结为历史快照） */
export const ROLLUP_WINDOW_DAYS = 7;

/** 单用户日桶（口径对齐 computeStats today：skipped 入桶、running 只计 total） */
export interface RollupUserBucket {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

/** 一日 rollup（byUser 键 = 任务/图归属 userId 字符串，"0" = 无归属） */
export interface DailyRollupDetail {
  date: string;
  byUser: Record<string, RollupUserBucket>;
}

/** 聚合输入行（写方完成 userId 归属映射后的最小面） */
export interface RollupRunRow {
  startedAt: Date | string;
  status: string;
  userKey: string;
}

/** 本地日键 yyyy-MM-dd（设备时区「今日」与 computeStats/用户直觉一致） */
export function rollupDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 含今日往回 days 个自然日键，旧 → 新 */
export function rollupWindowKeys(now: Date, days: number): string[] {
  return Array.from({ length: days }, (_, i) =>
    rollupDateKey(
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - (days - 1 - i),
      ),
    ),
  );
}

/** 窗口内 run → 按日 × 按用户聚合；零运行日不出行（读者以 run 现算兜底） */
export function buildDailyRollups(
  runs: RollupRunRow[],
  dayKeys: string[],
): DailyRollupDetail[] {
  const wanted = new Set(dayKeys);
  const byDay = new Map<string, DailyRollupDetail>();
  for (const run of runs) {
    const key = rollupDateKey(new Date(run.startedAt));
    if (!wanted.has(key)) {
      continue;
    }
    let day = byDay.get(key);
    if (!day) {
      day = { date: key, byUser: {} };
      byDay.set(key, day);
    }
    let bucket = day.byUser[run.userKey];
    if (!bucket) {
      bucket = { total: 0, success: 0, failed: 0, skipped: 0 };
      day.byUser[run.userKey] = bucket;
    }
    bucket.total += 1;
    if (run.status === "success") {
      bucket.success += 1;
    } else if (run.status === "failed") {
      bucket.failed += 1;
    } else if (run.status === "skipped") {
      bucket.skipped += 1;
    }
  }
  return dayKeys
    .filter((key) => byDay.has(key))
    .map((key) => byDay.get(key) as DailyRollupDetail);
}

/** detail JSON → rollup（坏 JSON/缺字段 → null，读者与写方共用） */
export function parseRollupDetail(detail: string): DailyRollupDetail | null {
  try {
    const raw = JSON.parse(detail) as Partial<DailyRollupDetail>;
    if (
      typeof raw.date !== "string" ||
      typeof raw.byUser !== "object" ||
      raw.byUser === null
    ) {
      return null;
    }
    return { date: raw.date, byUser: raw.byUser };
  } catch {
    return null;
  }
}

/**
 * 单调合并（upsert 依据）：逐用户「计算值 total ≥ 旧值才覆盖，否则旧桶
 * 保底」。动机：窗口内每日重算，但保留策略（成功 7d/失败 30d、条数窗）
 * 可能先于出窗裁掉 run——重算缩水不得回退已冻结的历史计数；计算侧缺席
 * 的用户桶保留。合并结果与旧值全等时写方跳过落库。
 */
export function mergeRollupDetail(
  existing: DailyRollupDetail,
  computed: DailyRollupDetail,
): DailyRollupDetail {
  const byUser: Record<string, RollupUserBucket> = { ...existing.byUser };
  for (const [user, bucket] of Object.entries(computed.byUser)) {
    const old = byUser[user];
    if (!old || bucket.total >= old.total) {
      byUser[user] = bucket;
    }
  }
  return { date: existing.date, byUser };
}
