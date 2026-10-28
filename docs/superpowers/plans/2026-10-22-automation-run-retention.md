# automationRun 执行历史保留策略（方案 A）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定时任务与工作流的执行历史（`automationRun`，含图试运行）不再无限增长——双限分级保留 + `graphTrace` 先行降级，桌面端（mirror）与无头服务端（apps/tianshu-server）双端落地。

**Architecture:** 核心逻辑收在一个双份同构文件 `automation-retention.ts`（照 `automation-stat.ts` 的 PrismaLike 结构类型注入形态，双端仅引号风格/Logger/头注释差异，drift-manifest 守护）。裁剪由双端 automation-scheduler 驱动：启动即裁一次 + tick 内 6h 节流。配置存 option 表（`type="app", name="automation.runRetention"`），桌面端设置面板「存储」分组暴露最小 UI，server 端默认值兜底。

**Tech Stack:** Prisma 7 + better-sqlite3（窗口函数 ROW_NUMBER，SQLite ≥3.25）、Vitest（mirror）/ Jest（server）、react-i18next。

**Spec:**（inline）本文件「设计决策」节即 spec——方案 A 为 2026-10-22 对话裁定（业界基线：Jenkins 双限取先到者 + Argo 成功/失败分级 + GitHub Actions 大字段独立过期）。

## 设计决策（Spec）

1. **双限分级**（任一超限即清理，先到先删）：
   - 成功态（`status NOT IN ('failed','running')`，即 success/expired/skipped 等）：保 **7 天** & 每任务最近 **200** 条
   - 失败态（`status = 'failed'`）：保 **30 天** & 每任务最近 **500** 条（失败排障价值高，业界共识保留更久）
   - `running` 态永不裁剪（僵尸 running 由 scheduler 既有的僵尸恢复标记转终态后再入裁剪范围）
2. **graphTrace 先行降级**：`startedAt` 超 **3 天** 的 run 先置空 `graphTrace`（节点级轨迹 JSON 是单行最大字段），元数据行（状态/时长/token）多保留一档。前端 `parseTrace` 对空 trace 已天然容错（`GraphRunTraceView.tsx:51` 注释明示）。
3. **条数窗按 `PARTITION BY taskId`**：SQLite 中 NULL 同组——`taskId IS NULL` 的图试运行自成一组限 200/500，语义合适，无需特判。
4. **触发时机**：scheduler 启动时裁一次 + tick 内 6h 节流（tick 缺省 30s，节流命中时开销仅一次时间比较）。不碰 runner 热路径。
5. **配置**：option 表 `type="app", name="automation.runRetention", value=JSON`。字段 `{"enabled":true,"traceDays":3,"successDays":7,"successKeep":200,"failureDays":30,"failureKeep":500}`。每次 trim 前读最新值（改配置无需重启）。非法/越界值逐字段 clamp 回退默认。UI 只暴露开关+两个天数；条数与 traceDays 经 option 直改（不暴露 UI，YAGNI）。
6. **server 端附带补齐**：server 现在完全没有 `automationStat` 裁剪（桌面端在 `electron/commons/prisma-client.ts:115` `ensureEventStatMaintenance` 90 天启动裁剪），scheduler 启动钩子补一行对齐 90 天语义。server 端不写 llmCallEvent/toolCallEvent（2026-10-22 node 全量复核 NO-HIT，监控事件表桌面端专属），无需处理。
7. **零 schema 变更**：现有索引 `taskId`/`graphId`/`startedAt` 已覆盖裁剪查询；表经治理后规模有限，窗口函数全扫可接受。

## Global Constraints

- **代码风格**：mirror 仓双引号、无尾随逗号；server 仓单引号、trailingComma=all——双份文件各自遵循本仓 Prettier（drift 比对已归一化引号，`automation-stat` 对基线仅 3 行可为证）。
- **双份守护**：新文件对必须登记 `packages/tianshu-core/scripts/drift-manifest.json`，逻辑逐行同构，唯一授权差异 = 引号 + `Log`→Nest `Logger` + 头注释（照 `automation-stat` 对形态）。
- **i18n**：所有新增 UI 文案必须走 `t()`，zh-CN 与 en-US 两个 locale 文件同 key 同步添加（settings namespace）。
- **主题色**：UI 禁止硬编码 `bg-blue-*` 等类名，用 `primary` 系变量。
- **测试**：mirror 用 Vitest（先例 `tests/ai/automation-*.test.ts`），server 用 Jest（先例 `test/modules/automation-scheduler.spec.ts`）。纯函数优先（`automation-stats.test.ts` 即纯函数无 DB 先例）；SQL 行为用真库集成验证。
- **commit**：conventional commits 中文风格（先例 `feat(settings): 设置面板新增「对外服务」页——…`），每 Task 至少一个 commit。
- **状态值域**（已核实）：`running`（落库初值，`automation-runner.ts:133`）、`success`/`failed`（终态，`:427`）、`expired`（错过后过期补记，`:511`）。

---

### Task 1: mirror 端 retention 模块（类型 + 解析 + 裁剪执行）

**Files:**
- Create: `electron/domains/ai/automation/automation-retention.ts`
- Test: `tests/ai/automation-retention.test.ts`

**Interfaces:**
- Consumes: `prisma` 单例（`electron/commons/prisma-client.ts`）、`ensureTianshuData`（`electron/commons/tianshu-data.ts`）、`Log`（`electron/commons/Log.ts`）。
- Produces（Task 2/3/4 依赖，签名精确如下）:
  - `interface RunRetentionConfig { enabled: boolean; traceDays: number; successDays: number; successKeep: number; failureDays: number; failureKeep: number; }`
  - `const DEFAULT_RUN_RETENTION: RunRetentionConfig`
  - `function parseRunRetention(raw: string | null | undefined): RunRetentionConfig`
  - `interface RetentionDb`（结构类型，见实现）
  - `interface RetentionTrimResult { tracedRuns: number; successDaysDeleted: number; failureDaysDeleted: number; successKeepDeleted: number; failureKeepDeleted: number; }`
  - `function trimAutomationRuns(prisma: RetentionDb, config: RunRetentionConfig, now?: Date): Promise<RetentionTrimResult>`
  - `const TRIM_INTERVAL_MS: number`（6 小时）
  - `function maybeTrimAutomationRuns(prisma: RetentionDb, nowMs?: number): Promise<void>`

- [ ] **Step 1: 写失败测试（纯函数段）**

创建 `tests/ai/automation-retention.test.ts`，先写 `parseRunRetention` 的全边界用例：

```ts
// tests/ai/automation-retention.test.ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_RETENTION,
  parseRunRetention,
} from "../../electron/domains/ai/automation/automation-retention";

describe("parseRunRetention", () => {
  it("null/undefined/空串 → 全默认", () => {
    expect(parseRunRetention(null)).toEqual(DEFAULT_RUN_RETENTION);
    expect(parseRunRetention(undefined)).toEqual(DEFAULT_RUN_RETENTION);
    expect(parseRunRetention("")).toEqual(DEFAULT_RUN_RETENTION);
  });

  it("非法 JSON → 全默认", () => {
    expect(parseRunRetention("{oops")).toEqual(DEFAULT_RUN_RETENTION);
    expect(parseRunRetention("42")).toEqual(DEFAULT_RUN_RETENTION);
  });

  it("部分字段缺省 → 缺的字段用默认值补齐", () => {
    const parsed = parseRunRetention(JSON.stringify({ successDays: 14 }));
    expect(parsed).toEqual({ ...DEFAULT_RUN_RETENTION, successDays: 14 });
  });

  it("越界 clamp：天数 <1 → 1，>3650 → 3650；条数 <1 → 1，>10000 → 10000", () => {
    const parsed = parseRunRetention(
      JSON.stringify({
        traceDays: 0,
        successDays: -5,
        failureDays: 99999,
        successKeep: 0,
        failureKeep: 99999,
      }),
    );
    expect(parsed).toEqual({
      enabled: true,
      traceDays: 1,
      successDays: 1,
      failureDays: 3650,
      successKeep: 1,
      failureKeep: 10000,
    });
  });

  it("enabled:false 显式保留", () => {
    expect(parseRunRetention(JSON.stringify({ enabled: false })).enabled).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/automation-retention.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现（完整文件）**

创建 `electron/domains/ai/automation/automation-retention.ts`：

```ts
/**
 * automationRun 执行历史保留策略（方案 A，2026-10-22 裁定）：
 * 双限分级（成功态 7 天/200 条，失败态 30 天/500 条，先到先删）
 * + graphTrace 先行降级（超 3 天置空轨迹，元数据行多保留一档）。
 * 照 automation-stat 先例：PrismaLike 结构类型注入、吞错不阻塞调度。
 * 双份同构文件：apps/tianshu-server/src/modules/automation/automation-retention.ts
 * （唯一授权差异：引号风格 + Log→Nest Logger + 头注释，drift-manifest 守护）。
 * 前端 parseTrace 对空 graphTrace 已容错（GraphRunTraceView「老 run 无 trace」注释）。
 */
import Log from "../../../commons/Log";

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
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;

function clampNumber(raw: unknown, min: number, max: number, fallback: number): number {
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
        obj.traceDays, 1, 3650, DEFAULT_RUN_RETENTION.traceDays),
      successDays: clampNumber(
        obj.successDays, 1, 3650, DEFAULT_RUN_RETENTION.successDays),
      successKeep: clampNumber(
        obj.successKeep, 1, 10000, DEFAULT_RUN_RETENTION.successKeep),
      failureDays: clampNumber(
        obj.failureDays, 1, 3650, DEFAULT_RUN_RETENTION.failureDays),
      failureKeep: clampNumber(
        obj.failureKeep, 1, 10000, DEFAULT_RUN_RETENTION.failureKeep),
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
    deleteMany(args: {
      where: {
        status?: { notIn: string[] };
        startedAt?: { lt: Date };
      };
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

/** 每任务条数窗删除（SQLite ≥3.25 窗口函数；taskId NULL 同组=图试运行自成一组） */
const trimKeepSql = (keep: number, statusWhere: string): string => `
  DELETE FROM automationRun WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY taskId ORDER BY id DESC) AS rn
      FROM automationRun WHERE ${statusWhere}
    ) WHERE rn > ?
  )
`;

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
      where: { startedAt: { lt: daysAgo(now, config.traceDays) }, graphTrace: { not: null } },
      data: { graphTrace: null },
    })
  ).count;
  // 2. 成功态按天（running 永不裁剪；expired/skipped 归成功档）
  const successDaysDeleted = (
    await prisma.automationRun.deleteMany({
      where: {
        status: { notIn: ["failed", "running"] },
        startedAt: { lt: daysAgo(now, config.successDays) },
      },
    })
  ).count;
  // 3. 失败态按天（保留更久）
  const failureDaysDeleted = (
    await prisma.automationRun.deleteMany({
      where: {
        status: { notIn: ["running", "success"] },
        startedAt: { lt: daysAgo(now, config.failureDays) },
      },
    })
  ).count;
  // 4/5. 每任务条数窗（参数化防注入；keep 已 clamp 为有限整数）
  const successKeepDeleted = await prisma.$executeRawUnsafe(
    trimKeepSql(config.successKeep, "status NOT IN ('failed', 'running')"),
    config.successKeep,
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
    }
  } catch (e) {
    Log.warn("自动化执行历史裁剪失败", e);
  }
}
```

注意：失败态按天的 `status: { notIn: ["running", "success"] }` 是刻意写法——失败档语义 = 「failed 之外还包含未来可能新增的非 running 终态」太宽，此处精确等价于 `status = 'failed'` 与步骤 5 SQL 对齐，**不要**写成 `notIn: ["running", "success"]` 之外的猜测值域；如实现时倾向 `equals`，统一改为 `status: "failed"` 并保持与 SQL `status = 'failed'` 一致（当前 notIn 写法即为此意图的 Prisma 表达，两者等价，择一即可）。

- [ ] **Step 4: 跑纯函数测试确认通过**

Run: `npx vitest run tests/ai/automation-retention.test.ts`
Expected: PASS（parse 用例全绿）

- [ ] **Step 5: 追加真库集成测试（SQL 行为验证）**

在 `tests/ai/automation-retention.test.ts` 追加（测试库经 `tests/setup.ts` 的 `TIANSHU_DATA_ROOT` 全局隔离，无污染）：

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../electron/commons/prisma-client";
import { ensureTianshuData } from "../../electron/commons/tianshu-data";
import {
  DEFAULT_RUN_RETENTION,
  parseRunRetention,
  trimAutomationRuns,
} from "../../electron/domains/ai/automation/automation-retention";

const NOW = new Date(2026, 10, 22, 12, 0, 0);
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const seedRun = async (over: {
  taskId?: number | null;
  status: string;
  startedAt: Date;
  graphTrace?: string | null;
}) =>
  prisma.automationRun.create({
    data: {
      taskId: over.taskId ?? null,
      triggerType: "test",
      status: over.status,
      startedAt: over.startedAt,
      graphTrace: over.graphTrace ?? null,
    },
  });

beforeAll(async () => {
  await ensureTianshuData();
  await prisma.automationRun.deleteMany({});
});

afterAll(async () => {
  await prisma.automationRun.deleteMany({});
});

describe("trimAutomationRuns（真库）", () => {
  it("graphTrace 降级：3 天前置空但行保留", async () => {
    const row = await seedRun({
      status: "success",
      startedAt: daysAgo(10),
      graphTrace: JSON.stringify({ nodes: [] }),
    });
    const result = await trimAutomationRuns(
      prisma,
      DEFAULT_RUN_RETENTION,
      NOW,
    );
    expect(result.tracedRuns).toBeGreaterThanOrEqual(1);
    const kept = await prisma.automationRun.findUnique({
      where: { id: row.id },
    });
    expect(kept).not.toBeNull();
    expect(kept?.graphTrace).toBeNull();
  });

  it("成功态超 7 天删行、失败态 30 天内保留、running 永不裁剪", async () => {
    const oldSuccess = await seedRun({
      status: "success",
      startedAt: daysAgo(10),
    });
    const recentSuccess = await seedRun({
      status: "success",
      startedAt: daysAgo(1),
    });
    const failed = await seedRun({
      status: "failed",
      startedAt: daysAgo(10),
    });
    const running = await seedRun({
      status: "running",
      startedAt: daysAgo(40),
    });
    await trimAutomationRuns(prisma, DEFAULT_RUN_RETENTION, NOW);
    expect(
      await prisma.automationRun.findUnique({ where: { id: oldSuccess.id } }),
    ).toBeNull();
    expect(
      await prisma.automationRun.findUnique({ where: { id: recentSuccess.id } }),
    ).not.toBeNull();
    expect(
      await prisma.automationRun.findUnique({ where: { id: failed.id } }),
    ).not.toBeNull();
    expect(
      await prisma.automationRun.findUnique({ where: { id: running.id } }),
    ).not.toBeNull();
    // 收尾清场，勿影响后续用例
    await prisma.automationRun.deleteMany({});
  });

  it("失败态超 30 天删行", async () => {
    const oldFailed = await seedRun({
      status: "failed",
      startedAt: daysAgo(40),
    });
    await trimAutomationRuns(prisma, DEFAULT_RUN_RETENTION, NOW);
    expect(
      await prisma.automationRun.findUnique({ where: { id: oldFailed.id } }),
    ).toBeNull();
  });

  it("成功态条数窗：同任务 250 条只留最新 200；taskId NULL（图试运行）自成一组", async () => {
    for (let i = 0; i < 250; i++) {
      await seedRun({
        taskId: 9901,
        status: "success",
        startedAt: daysAgo(0.01),
      });
    }
    for (let i = 0; i < 250; i++) {
      await seedRun({
        taskId: null,
        status: "success",
        startedAt: daysAgo(0.01),
      });
    }
    const result = await trimAutomationRuns(
      prisma,
      DEFAULT_RUN_RETENTION,
      NOW,
    );
    expect(result.successKeepDeleted).toBe(100);
    const taskRows = await prisma.automationRun.count({
      where: { taskId: 9901 },
    });
    const graphRows = await prisma.automationRun.count({
      where: { taskId: null },
    });
    expect(taskRows).toBe(200);
    expect(graphRows).toBe(200);
    // 条数窗按 id DESC 保留最新
    const minKept = await prisma.automationRun.findFirst({
      where: { taskId: 9901 },
      orderBy: { id: "asc" },
    });
    expect(minKept?.id).toBeGreaterThan(0);
    await prisma.automationRun.deleteMany({});
  });

  it("enabled:false 零动作", async () => {
    await seedRun({ status: "success", startedAt: daysAgo(40) });
    const result = await trimAutomationRuns(
      prisma,
      { ...DEFAULT_RUN_RETENTION, enabled: false },
      NOW,
    );
    expect(result).toEqual({
      tracedRuns: 0,
      successDaysDeleted: 0,
      failureDaysDeleted: 0,
      successKeepDeleted: 0,
      failureKeepDeleted: 0,
    });
    expect(await prisma.automationRun.count()).toBe(1);
    await prisma.automationRun.deleteMany({});
  });
});
```

（import 与 Step 1 合并去重，`describe("parseRunRetention")` 段保留在前。）

- [ ] **Step 6: 跑全量测试确认通过**

Run: `npx vitest run tests/ai/automation-retention.test.ts`
Expected: PASS 全绿。若 `ensureTianshuData` 在测试态报错，先读 `electron/commons/tianshu-data.ts` 头注释与 `tests/setup.ts` 确认测试态调用姿势，修正 import/调用后再跑。

- [ ] **Step 7: Commit**

```bash
git add electron/domains/ai/automation/automation-retention.ts tests/ai/automation-retention.test.ts
git commit -m "feat(automation): 执行历史保留裁剪核心——双限分级+graphTrace 先行降级"
```

---

### Task 2: mirror 端挂线（scheduler 启动 + tick 节流）

**Files:**
- Modify: `electron/domains/ai/automation/automation-scheduler.ts`（`start()` 约 :226、`tick()` 约 :134——以实际文件为准）
- Test: `tests/ai/automation-retention.test.ts`（追加节流用例）

**Interfaces:**
- Consumes: Task 1 的 `maybeTrimAutomationRuns(prisma)`。
- Produces: scheduler 生命周期内自动裁剪（Task 3 在 server 端对称实现）。

- [ ] **Step 1: 追加节流失败测试**

在 `tests/ai/automation-retention.test.ts` 追加：

```ts
import { maybeTrimAutomationRuns, TRIM_INTERVAL_MS } from "../../electron/domains/ai/automation/automation-retention";

describe("maybeTrimAutomationRuns 节流", () => {
  it("6h 内第二次调用不再触达 DB", async () => {
    let touches = 0;
    const countingDb = {
      option: {
        // 返回 enabled:false 使 trim 零动作，countingDb 无需提供 automationRun 面
        findFirst: async () => {
          touches++;
          return JSON.stringify({ enabled: false });
        },
      },
    } as unknown as Parameters<typeof maybeTrimAutomationRuns>[0];
    const t0 = 1_000_000_000_000;
    await maybeTrimAutomationRuns(countingDb, t0);
    await maybeTrimAutomationRuns(countingDb, t0 + 1000);
    expect(touches).toBe(1); // 第二次被节流挡下
    await maybeTrimAutomationRuns(countingDb, t0 + TRIM_INTERVAL_MS + 1);
    expect(touches).toBe(2);
  });
});
```

（`findFirst` 返回 `{ enabled: false }` → trim 零动作，桩无需提供 `automationRun`/`$executeRawUnsafe` 面。）

- [ ] **Step 2: 跑测试确认通过（Task 1 已含实现，节流逻辑应直接绿；若红，修 maybeTrim）**

Run: `npx vitest run tests/ai/automation-retention.test.ts`
Expected: PASS

- [ ] **Step 3: scheduler 挂线**

打开 `electron/domains/ai/automation/automation-scheduler.ts`，找到 `start(disabledTools?: () => string[]): void`（约 :226）与 `private async tick(): Promise<void>`（约 :134）。该文件已 import prisma 单例（`:200` 附近 `prisma.automationRun.create` 可证）。

顶部加 import：

```ts
import { maybeTrimAutomationRuns } from "./automation-retention";
```

`start()` 方法体内（起 setInterval 之前）加：

```ts
    // 执行历史保留裁剪：启动即裁一次（option 配置实时读，改配置无需重启）
    void maybeTrimAutomationRuns(prisma);
```

`tick()` 方法体末尾加：

```ts
    // 6h 节流，命中时开销仅一次时间比较
    void maybeTrimAutomationRuns(prisma);
```

- [ ] **Step 4: 跑 automation 域测试回归**

Run: `npx vitest run tests/ai/`
Expected: PASS（scheduler 相关既有测试不回归；`automation-schedule.test.ts` 等先例全绿）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/automation/automation-scheduler.ts tests/ai/automation-retention.test.ts
git commit -m "feat(automation): scheduler 挂接执行历史裁剪——启动即裁+tick 6h 节流"
```

---

### Task 3: server 端移植 + automationStat 90 天补齐 + 挂线

**Files:**
- Create: `apps/tianshu-server/src/modules/automation/automation-retention.ts`
- Modify: `apps/tianshu-server/src/modules/automation/automation-scheduler.ts`（NestJS 生命周期钩子，约 :217 `this.start(...)` 处）
- Test: `apps/tianshu-server/test/modules/automation-retention.spec.ts`

**Interfaces:**
- Consumes: Task 1 定稿的全部导出（逐行移植）；server 的 `PrismaService`（`this.prisma`）。
- Produces: 与 mirror 完全同构的 retention 面（Task 5 登记双份守护）。

- [ ] **Step 1: 移植 retention 文件（完整内容，单引号 + Nest Logger 版）**

创建 `apps/tianshu-server/src/modules/automation/automation-retention.ts`——将 Task 1 的 mirror 版**逐行转换**：双引号→单引号、`import Log from "../../../commons/Log"` → `import { Logger } from '@nestjs/common'; const logger = new Logger('automation-retention');`、`Log.info/Log.warn` → `logger.log/logger.warn`，头注释改为：

```ts
/**
 * automationRun 执行历史保留策略（自 mirror electron/domains/ai/automation/
 * automation-retention.ts 摘取，2026-10 方案 A）：双限分级（成功态 7 天/200 条，
 * 失败态 30 天/500 条）+ graphTrace 先行降级（超 3 天置空轨迹）。
 * 改造点（登记）：commons/Log → Nest Logger（授权面 prisma/环境适配同款，
 * 照 automation-stat 先例）。其余逐行保持。
 */
```

其余函数体（parseRunRetention / trimAutomationRuns / maybeTrimAutomationRuns / TRIM_INTERVAL_MS / 类型与常量）逐行保持不变。Prettier 单引号风格跑 `npx prettier --write src/modules/automation/automation-retention.ts`（server 仓 trailingComma=all 会补尾逗号，属风格差异不进 drift 基线）。

- [ ] **Step 2: 写 jest spec（真库，先例 automation-scheduler.spec.ts 的库准备方式）**

创建 `apps/tianshu-server/test/modules/automation-retention.spec.ts`。先读 `test/modules/automation-scheduler.spec.ts` 开头 60 行确认该仓测试的 PrismaService/临时库构建先例并沿用；spec 用例与 mirror Task 1 Step 5 五个场景一一对应（降级/成功天/失败天+running/条数窗+NULL 组/enabled false）+ Step 1 纯函数 parse 用例。造数与断言代码直接从 mirror 测试翻译（describe 名不变，`daysAgo`/`seedRun` 同款）。示例骨架（库构建以先例为准）：

```ts
import {
  DEFAULT_RUN_RETENTION,
  parseRunRetention,
  trimAutomationRuns,
} from '../../src/modules/automation/automation-retention';
// ↑ 按先例补 PrismaClient/PrismaService import 与临时库初始化

const NOW = new Date(2026, 10, 22, 12, 0, 0);
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('parseRunRetention', () => {
  it('非法 JSON → 全默认', () => {
    expect(parseRunRetention('{oops')).toEqual(DEFAULT_RUN_RETENTION);
  });
  // …其余 parse 用例照 mirror 版翻译
});

describe('trimAutomationRuns（真库）', () => {
  // 五个场景照 mirror tests/ai/automation-retention.test.ts 逐个翻译
  // （jest 全局 describe/it/expect，无需 import）
});
```

- [ ] **Step 3: 跑 server 测试确认通过**

Run: `npm run test -w apps/tianshu-server -- automation-retention`
Expected: PASS

- [ ] **Step 4: scheduler 挂线 + automationStat 90 天补齐**

打开 `apps/tianshu-server/src/modules/automation/automation-scheduler.ts`，找到 NestJS 生命周期钩子（约 :217 `this.start(...)` 所在的 onModuleInit/onApplicationBootstrap）。

顶部加 import：

```ts
import { maybeTrimAutomationRuns } from './automation-retention';
```

生命周期钩子内、`this.start(...)` 之前加（prisma 取值照本文件既有用法 `this.prisma`）：

```ts
    // 执行历史保留裁剪：启动即裁一次（对齐 mirror scheduler start() 挂点）
    void maybeTrimAutomationRuns(this.prisma);
    // automationStat 90 天裁剪：对齐 mirror commons ensureEventStatMaintenance
    // 语义（mirror 在启动链 prisma-client.ts:115；server 端此前完全无裁剪）。
    // server 不写 llm/toolCallEvent（2026-10-22 复核），无需处理。
    const statCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    void this.prisma.automationStat
      .deleteMany({ where: { createdAt: { lt: statCutoff } } })
      .catch((e) => logger.warn('automationStat 裁剪失败', e));
```

（`logger` 为本文件既有 Nest Logger 实例；若本文件用别的日志句柄名，照文件现状替换。）

`tick()` 方法体末尾加：

```ts
    // 6h 节流，命中时开销仅一次时间比较（mirror 同款挂点）
    void maybeTrimAutomationRuns(this.prisma);
```

- [ ] **Step 5: 跑 server automation 域测试回归**

Run: `npm run test -w apps/tianshu-server`
Expected: PASS（automation-scheduler.spec.ts 等既有测试不回归）

- [ ] **Step 6: Commit**

```bash
git add apps/tianshu-server/src/modules/automation/automation-retention.ts apps/tianshu-server/src/modules/automation/automation-scheduler.ts apps/tianshu-server/test/modules/automation-retention.spec.ts
git commit -m "feat(server): 移植执行历史保留裁剪+补 automationStat 90 天——无头端同款双限分级"
```

---

### Task 4: 设置面板配置 UI（存储分组 + IPC 通道 + i18n）

**Files:**
- Modify: `electron/domains/app-settings/settings.service.ts`（照 `settings:getWebhookPort` 既有通道形态新增两通道）
- Modify: `electron/commons/ipc-channels.ts`（照既有 settings 通道行登记）
- Modify: `src-react/domains/app-settings/api/settings.api.ts`
- Modify: `src-react/domains/app-settings/components/StorageGroup.tsx`
- Modify: `src-react/i18n/locales/zh-CN/settings.json`、`src-react/i18n/locales/en-US/settings.json`
- Test: `tests/ai/app-settings-retention.test.tsx`（渲染冒烟，先例 `tests/project/config-panel-automation.test.tsx`）

**Interfaces:**
- Consumes: Task 1 的 `parseRunRetention` / `DEFAULT_RUN_RETENTION`（后端侧）；option 行 `{ type: "app", name: "automation.runRetention" }`。
- Produces: IPC `settings:getRunRetention` → `RunRetentionConfig` 形状 JSON；`settings:setRunRetention(config)` → void。前端 `getRunRetention()` / `setRunRetention(config)`。

- [ ] **Step 1: 后端通道**

打开 `electron/domains/app-settings/settings.service.ts`，找到 `settings:getWebhookPort` / `settings:setWebhookPort` 的注册与实现形态，照同款新增：

```ts
// 通道注册（照本文件 webhookPort 通道同款挂法）
// settings:getRunRetention —— 读 option 表返回配置（缺省回默认）
// settings:setRunRetention —— upsert option 行

import { DEFAULT_RUN_RETENTION, parseRunRetention } from "../ai/automation/automation-retention";

const RETENTION_OPTION_NAME = "automation.runRetention";

async getRunRetention(): Promise<RunRetentionConfig> {
  const row = await prisma.option.findFirst({
    where: { type: "app", name: RETENTION_OPTION_NAME },
  });
  return parseRunRetention(row?.value);
}

async setRunRetention(patch: Partial<RunRetentionConfig>): Promise<void> {
  const current = await this.getRunRetention();
  const next = { ...current, ...patch, enabled: patch.enabled ?? current.enabled };
  const existing = await prisma.option.findFirst({
    where: { type: "app", name: RETENTION_OPTION_NAME },
  });
  if (existing) {
    await prisma.option.update({
      where: { id: existing.id },
      data: { value: JSON.stringify(next) },
    });
  } else {
    await prisma.option.create({
      data: {
        type: "app",
        name: RETENTION_OPTION_NAME,
        value: JSON.stringify(next),
      },
    });
  }
}
```

（`RunRetentionConfig` 从 retention 文件 re-export 或直接 import；prisma 句柄取法照本文件既有代码。`electron/commons/ipc-channels.ts` 照既有 settings 通道行补两行登记。）

- [ ] **Step 2: 前端 api 封装**

`src-react/domains/app-settings/api/settings.api.ts` 追加（类型内联，GA-T3 契约内联先例）：

```ts
export interface RunRetentionSetting {
  enabled: boolean;
  traceDays: number;
  successDays: number;
  successKeep: number;
  failureDays: number;
  failureKeep: number;
}

export function getRunRetention(): Promise<RunRetentionSetting> {
  return invoke<RunRetentionSetting>("settings:getRunRetention");
}

export function setRunRetention(
  config: Partial<RunRetentionSetting>,
): Promise<void> {
  return invoke<void>("settings:setRunRetention", config);
}
```

- [ ] **Step 3: StorageGroup 新增「执行历史保留」分节**

打开 `src-react/domains/app-settings/components/StorageGroup.tsx`，照本文件既有分节（SettingsGroup 标题 + 内容行）形态，在数据目录分节之后追加新分节。控件用 shadcn `Switch` + `Input`（type="number"）。核心逻辑：

```tsx
const { t } = useTranslation(["settings"]);
const [retention, setRetention] = useState<RunRetentionSetting | null>(null);
const { toast } = useToast(); // 或项目现行 toast 先例（Sonner——照本文件其他保存动作）

useEffect(() => {
  getRunRetention().then(setRetention).catch(() => setRetention(null));
}, []);

const saveRetention = async (patch: Partial<RunRetentionSetting>) => {
  if (!retention) return;
  const next = { ...retention, ...patch };
  setRetention(next);
  await setRunRetention(patch);
  toast({ description: t("settings:executionHistory.saved") });
};
```

分节 UI（挂载结构与分组标题组件照本文件既有分节同款）：

```tsx
<SettingsGroup title={t("settings:executionHistory.title")}>
  <div className="flex items-center justify-between">
    <div>
      <p>{t("settings:executionHistory.enabledLabel")}</p>
      <p className="text-sm text-muted-foreground">
        {t("settings:executionHistory.desc")}
      </p>
    </div>
    <Switch
      checked={retention?.enabled ?? true}
      onCheckedChange={(enabled) => saveRetention({ enabled })}
      disabled={!retention}
    />
  </div>
  <div className="flex items-center gap-4">
    <label className="flex items-center gap-2">
      {t("settings:executionHistory.successDaysLabel")}
      <Input
        type="number"
        min={1}
        max={3650}
        className="w-20"
        value={retention?.successDays ?? 7}
        onChange={(e) => {
          const successDays = Number(e.target.value);
          if (successDays >= 1) saveRetention({ successDays });
        }}
        disabled={!retention}
      />
    </label>
    <label className="flex items-center gap-2">
      {t("settings:executionHistory.failureDaysLabel")}
      <Input
        type="number"
        min={1}
        max={3650}
        className="w-20"
        value={retention?.failureDays ?? 30}
        onChange={(e) => {
          const failureDays = Number(e.target.value);
          if (failureDays >= 1) saveRetention({ failureDays });
        }}
        disabled={!retention}
      />
    </label>
  </div>
</SettingsGroup>
```

（`successKeep`/`failureKeep`/`traceDays` 不暴露 UI——option 直改，分节注释一行说明。）

- [ ] **Step 4: i18n 双语同步**

`src-react/i18n/locales/zh-CN/settings.json` 加：

```json
"executionHistory": {
  "title": "执行历史保留",
  "desc": "定时任务与工作流运行记录自动清理，轨迹数据先于记录清理，防止无限增长",
  "enabledLabel": "自动清理执行历史",
  "successDaysLabel": "成功记录保留天数",
  "failureDaysLabel": "失败记录保留天数",
  "saved": "执行历史保留设置已保存"
}
```

`src-react/i18n/locales/en-US/settings.json` 加同 key 英文：

```json
"executionHistory": {
  "title": "Run History Retention",
  "desc": "Automatically clean scheduled task and workflow run records; trace data is cleaned before records to prevent unbounded growth",
  "enabledLabel": "Auto-clean run history",
  "successDaysLabel": "Keep successful runs (days)",
  "failureDaysLabel": "Keep failed runs (days)",
  "saved": "Run history retention settings saved"
}
```

- [ ] **Step 5: 渲染冒烟测试**

创建 `tests/ai/app-settings-retention.test.tsx`（mock `@/lib/ipc` 的 `invoke`，先例照 `tests/project/config-panel-automation.test.tsx` 的 mock 形态）：渲染 StorageGroup → 断言出现「执行历史保留」标题与开关；mock `settings:getRunRetention` 返回 `{ enabled: false, traceDays: 3, successDays: 7, successKeep: 200, failureDays: 30, failureKeep: 500 }` → 断言开关为关。

- [ ] **Step 6: 跑测试与类型检查**

Run: `npx vitest run tests/ai/app-settings-retention.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add electron/domains/app-settings/settings.service.ts electron/commons/ipc-channels.ts src-react/domains/app-settings/api/settings.api.ts src-react/domains/app-settings/components/StorageGroup.tsx src-react/i18n/locales/zh-CN/settings.json src-react/i18n/locales/en-US/settings.json tests/ai/app-settings-retention.test.tsx
git commit -m "feat(settings): 存储分组新增执行历史保留配置——开关+成功/失败天数"
```

---

### Task 5: drift 双份登记 + 全量验证

**Files:**
- Modify: `packages/tianshu-core/scripts/drift-manifest.json`

**Interfaces:**
- Consumes: Task 1/3 产出的双份文件对。
- Produces: `npm run check:drift` 通过且新对入册。

- [ ] **Step 1: 先跑未登记检查看差异规模**

Run: `npm run check:drift`
Expected: 告警出现新文件对未登记（或直接比对差异行数）。人工核对 mirror↔server 两份 retention 文件 diff：**预期差异仅**引号风格、trailingComma、`Log`→Nest Logger、头注释——任何逻辑差异都是移植错误，回 Task 3 修。

- [ ] **Step 2: 登记 manifest**

`packages/tianshu-core/scripts/drift-manifest.json` 的 `pairs` 数组追加（`baselineLines` 填 Step 1 实测差异行数）：

```json
{
  "id": "automation-retention",
  "mirrorPath": "electron/domains/ai/automation/automation-retention.ts",
  "serverPath": "src/modules/automation/automation-retention.ts",
  "baselineDiff": true,
  "baselineLines": <实测值>,
  "note": "执行历史保留裁剪（2026 方案 A：双限分级+graphTrace 先行降级）：照 automation-stat 形态逐行同构——仅引号风格/trailingComma/Log→Nest Logger/头注释差异，期望 diff 趋零；条数窗 SQL 双端 better-sqlite3 同引擎窗口函数"
}
```

- [ ] **Step 3: 全量验证**

Run（依次，全绿才算完）：

```bash
npm run check:drift
npm run test
npm run test -w apps/tianshu-server
npm run lint
npm run typecheck
```

Expected: 全部 PASS（含既有测试零回归）。

- [ ] **Step 4: Commit**

```bash
git add packages/tianshu-core/scripts/drift-manifest.json
git commit -m "chore(drift): 登记执行历史保留裁剪双份对——automation-retention 入册"
```

---

## 风险与注记

- **窗口函数依赖 SQLite ≥3.25**：better-sqlite3（Prisma 7 驱动）内置 SQLite 3.4x，两端一致，无版本风险。
- **`$executeRawUnsafe` 表名硬编码 `automationRun`**：两端 `@@map("automationRun")` 同名（server schema :309 已核），安全。
- **server 打包态（standalone extraResources）无影响**：纯源码级改动，`npm run build:server` 正常携带。
- **移动端不涉及**：automationRun 无移动端消费面；HD 遥控经 server API 读 run 列表，`graphTrace` 置空后前端 `parseTrace` 容错已确认。
- **行为注记**：首跑（存量库）可能一次删除大量行/置空大量 trace——SQLite 事务内 deleteMany 原子执行，UI 侧无感；若首次裁剪量大导致 tick 阻塞担忧，可观察首跑日志（`自动化执行历史裁剪完成` 输出分项计数）。
