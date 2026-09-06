# AI 自动化与定时任务模块实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron 主进程实现定时任务调度引擎（结构化 JSON 频率自算 + 无人值守 agent 执行），前端实现任务列表/运行记录/批量管理/创建表单/模板市场五视图。

**Architecture:** 后端独立 `electron/domains/ai/automation/` 子域（repo/scheduler/runner/templates/stat），执行复用 `runChatStream` 纯函数（注入 `fullAccess=true` + 自动放行审批，产物落 session/message 可回看）；数据走 v10 迁移三张新表；前端重写 `AutomationView` 占位页为多视图壳，React Query + zustand，来源/状态/搜索纯前端过滤。

**Tech Stack:** Electron 44 / React 19 / TypeScript 5.9 / Prisma 7 + SQLite / zod 4 / date-fns 4 / Zustand / React Query / shadcn-ui / Vitest。

**Spec:** `docs/superpowers/specs/2026-09-06-ai-automation-module-design.md`（计划与 spec 同行，执行者两份都读）

## Global Constraints

- 所有用户可见文案必须 `t("chat:automation.*")`，zh-CN 与 en-US **同一任务内同时添加**；禁止硬编码中英文。
- 禁止硬编码主题色（`bg-blue-*` 等一律禁止），用 `bg-primary`/`text-primary`/`hover:bg-primary-subtle` 等主题变量；弹出层边框 `border-border/50 rounded-lg shadow-lg`。
- Prettier：双引号、分号、tabWidth=2、printWidth=80、无尾随逗号；文件名 kebab-case；函数 ≤20 行（视图组件按现有代码习惯放宽）。
- 星期约定：ISO 数字 **1=周一 … 7=周日**（存库与组件统一）。
- 测试放 `tests/ai/automation-*.test.ts`，运行 `npx vitest run tests/ai/automation-xxx.test.ts`；迁移测试用 `node:sqlite` `DatabaseSync(":memory:")` 模式（先例 `tests/ai/v7-migration.test.ts`）。
- 后端文件 import 前端类型是既有模式（chat.service.ts import workspace.api 的 WorkspaceRecord）；**前端不得 import electron/ 下文件**。
- 新 IPC 通道必须同步加进 `src-react/lib/ipc.ts` 的 `IPCChannel` 联合类型（preload 为通用透传无需改）。
- `SessionRepository`/`ChatService` 构造函数有 `ipcMain.handle` 注册副作用，automation 模块**不得实例化它们**，直接用 `prisma`（`electron/commons/prisma-client`）。
- 提交信息沿用 conventional commit 中文风格（如 `feat(automation): ...`）。
- 每个任务完成后运行 `npm run typecheck` 确认无类型错误。

---

### Task 1: v10 数据迁移（三张新表）

**Files:**
- Modify: `prisma/schema.prisma`（文件末尾追加三 model）
- Create: `electron/infrastructure/script/v10/upgrade-table.sql`
- Modify: `electron/Constants.ts:11`（`DATABASE_VERSION = 9` → `10`）
- Test: `tests/ai/automation-v10-migration.test.ts`

**Interfaces:**
- Produces: prisma 委托 `prisma.automationTask` / `prisma.automationRun` / `prisma.automationStat`（后续任务依赖此类型生成）。DateTime 落库为 JS Date；string 字段见下。

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/automation-v10-migration.test.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const V10_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../electron/infrastructure/script/v10/upgrade-table.sql",
  ),
  "utf8",
);

/** 去注释行后按分号拆分(模拟 sql-file-executor 最小语义,同 v7 测试) */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("v10 迁移:自动化任务三表", () => {
  it("三表建表成功且任务行可插入必填列", () => {
    const db = new DatabaseSync(":memory:");
    for (const stmt of statements(V10_SQL)) {
      db.exec(stmt);
    }
    db.exec(
      `INSERT INTO automationTask (name, prompt, workspaceId, modelId,
        temperature, scheduleJson, scheduleText, missedPolicy, enabled,
        status, createdAt, updatedAt)
       VALUES ('早报', '总结今日AI资讯', 1, 1, 0.7,
        '{"mode":"periodic","kind":"daily","time":"09:00"}',
        '每天 09:00', 'skip', 1, 'active', '2026-09-06 00:00:00',
        '2026-09-06 00:00:00')`,
    );
    db.exec(
      `INSERT INTO automationRun (taskId, sessionId, attempt, triggerType,
        status, startedAt)
       VALUES (1, 10, 1, 'schedule', 'success', '2026-09-06 09:00:05')`,
    );
    db.exec(
      `INSERT INTO automationStat (event, detail, createdAt)
       VALUES ('create', '{"mode":"periodic"}', '2026-09-06 09:00:05')`,
    );
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM automationTask").get(),
    ).toEqual({ n: 1 });
    expect(
      db.prepare("SELECT attempt FROM automationRun WHERE taskId = 1").get(),
    ).toEqual({ attempt: 1 });
  });

  it("重复执行幂等(IF NOT EXISTS)", () => {
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 2; i += 1) {
      for (const stmt of statements(V10_SQL)) {
        db.exec(stmt);
      }
    }
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('automationTask','automationRun','automationStat')",
        )
        .get(),
    ).toEqual({ n: 3 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/automation-v10-migration.test.ts`
Expected: FAIL（找不到 v10/upgrade-table.sql，readFileSync 抛 ENOENT）

- [ ] **Step 3: 写 SQL 脚本与 schema**

```sql
-- electron/infrastructure/script/v10/upgrade-table.sql
--/p 自动化模块(v10):定时任务表
CREATE TABLE IF NOT EXISTS automationTask (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  workspaceId INTEGER NOT NULL,
  modelId INTEGER NOT NULL,
  temperature REAL,
  scheduleJson TEXT NOT NULL,
  scheduleText TEXT NOT NULL,
  startAt DATETIME,
  endAt DATETIME,
  missedPolicy TEXT NOT NULL DEFAULT 'skip',
  enabled BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active',
  statusNote TEXT,
  lastRunAt DATETIME,
  nextRunAt DATETIME,
  templateSlug TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS automationTask_enabled_idx ON automationTask(enabled);

--/p 自动化模块(v10):运行记录表
CREATE TABLE IF NOT EXISTS automationRun (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  taskId INTEGER NOT NULL,
  sessionId INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  triggerType TEXT NOT NULL,
  status TEXT NOT NULL,
  durationMs INTEGER,
  promptTokens INTEGER,
  completionTokens INTEGER,
  error TEXT,
  startedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finishedAt DATETIME
);
CREATE INDEX IF NOT EXISTS automationRun_taskId_idx ON automationRun(taskId);
CREATE INDEX IF NOT EXISTS automationRun_startedAt_idx ON automationRun(startedAt);

--/p 自动化模块(v10):埋点事件表(事件流,无唯一约束,同 skillStat)
CREATE TABLE IF NOT EXISTS automationStat (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

`prisma/schema.prisma` 末尾追加（字段与 SQL 严格一一对应）：

```prisma
model automationTask {
  id           Int       @id @default(autoincrement())
  name         String
  prompt       String
  workspaceId  Int
  modelId      Int
  temperature  Float?
  scheduleJson String
  scheduleText String
  startAt      DateTime?
  endAt        DateTime?
  missedPolicy String    @default("skip")
  enabled      Boolean   @default(true)
  status       String    @default("active")
  statusNote   String?
  lastRunAt    DateTime?
  nextRunAt    DateTime?
  templateSlug String?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  @@index([enabled])
}

model automationRun {
  id               Int       @id @default(autoincrement())
  taskId           Int
  sessionId        Int?
  attempt          Int       @default(1)
  triggerType      String
  status           String
  durationMs       Int?
  promptTokens     Int?
  completionTokens Int?
  error            String?
  startedAt        DateTime  @default(now())
  finishedAt       DateTime?

  @@index([taskId])
  @@index([startedAt])
}

model automationStat {
  id        Int      @id @default(autoincrement())
  event     String
  detail    String
  createdAt DateTime @default(now())
}
```

`electron/Constants.ts` 第 11 行 `DATABASE_VERSION: number = 9;` 改为 `10`。

- [ ] **Step 4: 重新生成 Prisma 客户端并跑测试**

Run: `npx prisma generate && npx vitest run tests/ai/automation-v10-migration.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma electron/infrastructure/script/v10 electron/Constants.ts electron/generated/prisma tests/ai/automation-v10-migration.test.ts
git commit -m "feat(automation): v10 迁移新增自动化任务/运行记录/埋点三表"
```

---

### Task 2: schedule 纯函数（zod schema + computeNextRun）

**Files:**
- Create: `src-react/domains/ai/automation/api/schedule.schema.ts`（zod 与类型放前端目录，后端 import 此文件校验——后端引前端有先例；前端组件也直接用类型）
- Create: `electron/domains/ai/automation/schedule.ts`（computeNextRun，date-fns）
- Test: `tests/ai/automation-schedule.test.ts`

**Interfaces:**
- Produces:
  - `ScheduleConfig = z.infer<typeof scheduleSchema>`（discriminated union，8 个变体，见 Step 3）
  - `computeNextRun(config: ScheduleConfig, from: Date, lastRunAt?: Date): Date | null`（null = 不再有下次，仅 once 过期时出现）
  - `INTERVAL_MIN_MINUTES = 5`

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/automation-schedule.test.ts
import { describe, expect, it } from "vitest";
import { computeNextRun } from "../../electron/domains/ai/automation/schedule";

/** 基准:2026-09-06 是周日(ISO weekday 7) */
const at = (s: string) => new Date(`2026-09-06T${s}:00`);

describe("computeNextRun:periodic", () => {
  it("once:未来时刻返回原值,已过返回 null", () => {
    const cfg = {
      mode: "periodic",
      kind: "once",
      runAt: "2026-09-07T08:00:00.000Z",
    } as const;
    expect(computeNextRun(cfg, new Date("2026-09-06T00:00:00Z"))).toEqual(
      new Date("2026-09-07T08:00:00.000Z"),
    );
    expect(computeNextRun(cfg, new Date("2026-09-08T00:00:00Z"))).toBeNull();
  });

  it("daily:当天未到取今天,已过取明天", () => {
    const cfg = { mode: "periodic", kind: "daily", time: "09:00" } as const;
    expect(computeNextRun(cfg, at("08:00"))).toEqual(at("09:00"));
    expect(computeNextRun(cfg, at("10:00"))).toEqual(
      new Date("2026-09-07T09:00:00"),
    );
  });

  it("weekly:星期多选取最近的未来匹配(跨周)", () => {
    // 周日 from,候选 周一(1)/周五(5) → 明天周一 18:00
    const cfg = {
      mode: "periodic",
      kind: "weekly",
      weekdays: [1, 5],
      time: "18:00",
    } as const;
    expect(computeNextRun(cfg, at("10:00"))).toEqual(
      new Date("2026-09-07T18:00:00"),
    );
    // 周一 19:00 已过周一时刻 → 下一个候选周五
    expect(computeNextRun(cfg, new Date("2026-09-07T19:00:00"))).toEqual(
      new Date("2026-09-11T18:00:00"),
    );
  });

  it("biweekly:保持 anchor 相位,取下一个未来双周点", () => {
    // anchor 9-07(周一) 10:00;from=9-13(下周日) → 9-21 10:00
    const cfg = {
      mode: "periodic",
      kind: "biweekly",
      anchorDate: "2026-09-07",
      weekday: 1,
      time: "10:00",
    } as const;
    expect(computeNextRun(cfg, new Date("2026-09-13T12:00:00"))).toEqual(
      new Date("2026-09-21T10:00:00"),
    );
    // from 在 anchor 当天之前 → anchor 本身
    expect(computeNextRun(cfg, new Date("2026-09-01T00:00:00"))).toEqual(
      new Date("2026-09-07T10:00:00"),
    );
  });

  it("monthly:正常推进,当月无 31 号则跳过该月", () => {
    const cfg = {
      mode: "periodic",
      kind: "monthly",
      dayOfMonth: 31,
      time: "09:00",
    } as const;
    // from 2026-09-06 → 10-31(9 月只有 30 天,跳过)
    expect(computeNextRun(cfg, at("10:00"))).toEqual(
      new Date("2026-10-31T09:00:00"),
    );
    // 12-31 存在
    expect(
      computeNextRun(cfg, new Date("2026-11-15T10:00:00")),
    ).toEqual(new Date("2026-12-31T09:00:00"));
  });

  it("yearly:2/29 非闰年跳过", () => {
    const cfg = {
      mode: "periodic",
      kind: "yearly",
      month: 2,
      day: 29,
      time: "10:00",
    } as const;
    // from 2027-01-01 → 2028-02-29(2027 非闰年)
    expect(
      computeNextRun(cfg, new Date("2027-01-01T00:00:00")),
    ).toEqual(new Date("2028-02-29T10:00:00"));
  });
});

describe("computeNextRun:interval", () => {
  it("以 lastRunAt 为相位基准累加", () => {
    const cfg = {
      mode: "interval",
      value: 90,
      unit: "minute",
    } as const;
    // lastRun 08:00,from 11:30 → 相位 08:00+90min 序列:9:30/11:00/12:30 → 12:30
    expect(computeNextRun(cfg, at("11:30"), at("08:00"))).toEqual(
      at("12:30"),
    );
  });

  it("无 lastRunAt 时以 from 为基准(首次)", () => {
    const cfg = { mode: "interval", value: 30, unit: "minute" } as const;
    expect(computeNextRun(cfg, at("09:00"))).toEqual(at("09:30"));
  });

  it("落在未选星期则顺延至下一个允许日 00:00", () => {
    // 仅周一;from 周日 10:00,30 分钟 → 周日 10:30 不在集合 → 周一 00:00
    const cfg = {
      mode: "interval",
      value: 30,
      unit: "minute",
      weekdays: [1],
    } as const;
    expect(computeNextRun(cfg, at("10:00"))).toEqual(
      new Date("2026-09-07T00:00:00"),
    );
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/automation-schedule.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 schema 与 computeNextRun**

```ts
// src-react/domains/ai/automation/api/schedule.schema.ts
/**
 * 自动化调度配置(zod discriminated union,spec §3)。
 * 放前端目录供后端 repo 校验复用(后端引前端类型有先例);
 * 前端 SchedulePicker/表单直接消费类型。
 * 星期约定 ISO:1=周一 … 7=周日。
 */
import { z } from "zod";

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 间隔模式下限(分钟),防高频打爆资源(PRD《执行频率》§4) */
export const INTERVAL_MIN_MINUTES = 5;

const time = z.string().regex(TIME_RE);
const isoDate = z.string().regex(DATE_RE);
const isoDateTime = z.string().datetime({ offset: true });

export const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("once"),
    runAt: isoDateTime,
  }),
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("daily"),
    time,
  }),
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("weekly"),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1),
    time,
  }),
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("biweekly"),
    anchorDate: isoDate,
    weekday: z.number().int().min(1).max(7),
    time,
  }),
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("monthly"),
    dayOfMonth: z.number().int().min(1).max(31),
    time,
  }),
  z.object({
    mode: z.literal("periodic"),
    kind: z.literal("yearly"),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    time,
  }),
  z.object({
    mode: z.literal("interval"),
    value: z.number().int().positive(),
    unit: z.enum(["minute", "hour"]),
    weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  }),
]);

export type ScheduleConfig = z.infer<typeof scheduleSchema>;
/** 间隔分钟数换算(校验下限用) */
export function intervalMinutes(cfg: Extract<ScheduleConfig, { mode: "interval" }>): number {
  return cfg.unit === "hour" ? cfg.value * 60 : cfg.value;
}
```

```ts
// electron/domains/ai/automation/schedule.ts
/**
 * 下次触发时间计算(纯函数,date-fns,不依赖系统时钟——from 显式注入可测)。
 * 语义见 spec §3:月末无该日跳过当月;2/29 非闰年跳过;interval 以
 * lastRunAt 为相位基准,落在未选星期则顺延至下一允许日 00:00。
 */
import { addDays, addMinutes } from "date-fns";
import type { ScheduleConfig } from "../../../../src-react/domains/ai/automation/api/schedule.schema";

/** [hh, mm] 拆 "HH:mm" */
function parseTime(t: string): [number, number] {
  const [h, m] = t.split(":").map(Number);
  return [h, m];
}

/** d 的当天 hh:mm 时刻 */
function atTime(d: Date, time: string): Date {
  const [h, m] = parseTime(time);
  const next = new Date(d);
  next.setHours(h, m, 0, 0);
  return next;
}

/** ISO 星期(1=周一…7=周日) */
function isoWeekday(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

/** interval 分钟数 */
function minutes(cfg: Extract<ScheduleConfig, { mode: "interval" }>): number {
  return cfg.unit === "hour" ? cfg.value * 60 : cfg.value;
}

function nextPeriodic(
  cfg: Extract<ScheduleConfig, { mode: "periodic" }>,
  from: Date,
): Date | null {
  switch (cfg.kind) {
    case "once":
      return new Date(cfg.runAt) > from ? new Date(cfg.runAt) : null;
    case "daily": {
      const today = atTime(from, cfg.time);
      return today > from ? today : addDays(today, 1);
    }
    case "weekly": {
      for (let i = 0; i <= 7; i += 1) {
        const day = addDays(from, i);
        const candidate = atTime(day, cfg.time);
        if (candidate > from && cfg.weekdays.includes(isoWeekday(day))) {
          return candidate;
        }
      }
      return atTime(addDays(from, 7), cfg.time);
    }
    case "biweekly": {
      const [y, m, d] = cfg.anchorDate.split("-").map(Number);
      const anchor = new Date(y, m - 1, d, ...parseTime(cfg.time));
      // 相位对齐:回退 anchor 到 from 之前最近的双周点,再加 14 天
      let base = anchor;
      while (base > from) {
        base = new Date(base.getTime() - 14 * 24 * 3600 * 1000);
      }
      return new Date(base.getTime() + 14 * 24 * 3600 * 1000);
    }
    case "monthly": {
      const cursor = new Date(from);
      for (let i = 0; i <= 2; i += 1) {
        const daysInMonth = new Date(
          cursor.getFullYear(),
          cursor.getMonth() + 1,
          0,
        ).getDate();
        if (cfg.dayOfMonth <= daysInMonth) {
          const candidate = new Date(
            cursor.getFullYear(),
            cursor.getMonth(),
            cfg.dayOfMonth,
            ...parseTime(cfg.time),
          );
          if (candidate > from) {
            return candidate;
          }
        }
        cursor.setMonth(cursor.getMonth() + 1, 1);
      }
      cursor.setMonth(cursor.getMonth() + 1, 1);
      return new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        cfg.dayOfMonth,
        ...parseTime(cfg.time),
      );
    }
    case "yearly": {
      const year = from.getFullYear();
      for (let y = year; y <= year + 5; y += 1) {
        const candidate = new Date(y, cfg.month - 1, cfg.day, ...parseTime(cfg.time));
        if (candidate > from) {
          return candidate;
        }
      }
      return null;
    }
  }
}

/** interval:相位累加 + 星期顺延 */
function nextInterval(
  cfg: Extract<ScheduleConfig, { mode: "interval" }>,
  from: Date,
  lastRunAt?: Date,
): Date {
  const step = minutes(cfg);
  let next = lastRunAt ? new Date(lastRunAt) : new Date(from);
  do {
    next = addMinutes(next, step);
  } while (next <= from);
  if (!cfg.weekdays) {
    return next;
  }
  if (cfg.weekdays.includes(isoWeekday(next))) {
    return next;
  }
  // 顺延至下一个允许日 00:00(相位基准同步重置到该时刻)
  let day = next;
  do {
    day = addDays(day, 1);
  } while (!cfg.weekdays.includes(isoWeekday(day)));
  return atTime(day, "00:00");
}

export function computeNextRun(
  config: ScheduleConfig,
  from: Date,
  lastRunAt?: Date,
): Date | null {
  return config.mode === "interval"
    ? nextInterval(config, from, lastRunAt)
    : nextPeriodic(config, from);
}
```

注：monthly 循环里 `cursor.setMonth(month+1, 1)` 后再构造候选保证跳过短月；biweekly 用毫秒常量避免月末 DST 争议（本地时区应用场景可接受）。若 Step 4 有用例失败，按用例语义修实现而非改用例。

- [ ] **Step 4: 运行测试至通过**

Run: `npx vitest run tests/ai/automation-schedule.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/automation/api/schedule.schema.ts electron/domains/ai/automation/schedule.ts tests/ai/automation-schedule.test.ts
git commit -m "feat(automation): schedule zod schema 与 computeNextRun 纯函数"
```

---

### Task 3: 内置模板与埋点

**Files:**
- Create: `electron/domains/ai/automation/automation-templates.ts`
- Create: `electron/domains/ai/automation/automation-stat.ts`
- Test: `tests/ai/automation-templates.test.ts`

**Interfaces:**
- Consumes: `ScheduleConfig`（Task 2）
- Produces:
  - `AutomationTemplate = { slug: string; icon: string; titleI18nKey: string; descI18nKey: string; prompt: string; scheduleJson: ScheduleConfig; temperature: number }`（icon 用 lucide 图标名，前端映射组件；title/desc 用 i18n key 而非硬编码文案，规避 Global Constraints）
  - `listAutomationTemplates(): AutomationTemplate[]`
  - `recordAutomationEvent(prisma: { automationStat: { create(...): Promise<unknown> } } | undefined, event: "create", detail: unknown): Promise<void>`（fire-and-forget，吞错）

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/automation-templates.test.ts
import { describe, expect, it, vi } from "vitest";
import { listAutomationTemplates } from "../../electron/domains/ai/automation/automation-templates";
import { recordAutomationEvent } from "../../electron/domains/ai/automation/automation-stat";
import { scheduleSchema } from "../../src-react/domains/ai/automation/api/schedule.schema";

describe("内置模板", () => {
  it("至少 6 个,slug 唯一,schedule 全部通过 zod 校验", () => {
    const templates = listAutomationTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(6);
    expect(new Set(templates.map((t) => t.slug)).size).toBe(templates.length);
    for (const t of templates) {
      expect(scheduleSchema.safeParse(t.scheduleJson).success).toBe(true);
      expect(t.prompt).toContain("{{"); // 模板善用变量,保证示例性
      expect(t.titleI18nKey).toMatch(/^chat:automation\.template\./);
    }
  });
});

describe("埋点", () => {
  it("写 create 事件;prisma 缺席静默;失败吞错不抛", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    await recordAutomationEvent(
      { automationStat: { create } } as never,
      "create",
      { mode: "periodic" },
    );
    expect(create).toHaveBeenCalledWith({
      data: { event: "create", detail: '{"mode":"periodic"}' },
    });
    await expect(recordAutomationEvent(undefined, "create", {})).resolves.toBeUndefined();
    const boom = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      recordAutomationEvent({ automationStat: { create: boom } } as never, "create", {}),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/automation-templates.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现两个文件**

```ts
// electron/domains/ai/automation/automation-templates.ts
/**
 * 内置自动化模板(纯数据,spec §0:不走远端)。
 * title/desc 只放 i18n key(文案在 Task 11 的 chat.json 定义);
 * icon 为 lucide 图标名,前端 TemplateMarketView 映射组件。
 */
import type { ScheduleConfig } from "../../../../src-react/domains/ai/automation/api/schedule.schema";

export interface AutomationTemplate {
  slug: string;
  icon: string;
  titleI18nKey: string;
  descI18nKey: string;
  prompt: string;
  scheduleJson: ScheduleConfig;
  temperature: number;
}

const TEMPLATES: AutomationTemplate[] = [
  {
    slug: "daily-ai-news",
    icon: "Newspaper",
    titleI18nKey: "chat:automation.template.dailyAiNews.title",
    descI18nKey: "chat:automation.template.dailyAiNews.desc",
    prompt:
      "今天是 {{date}} 星期{{weekday}}。请汇总过去一天 AI 领域的重要动态,分「模型发布 / 工具产品 / 行业政策」三节,每条一句话 + 来源,最后给一段 50 字以内的趋势点评。",
    scheduleJson: { mode: "periodic", kind: "daily", time: "09:00" },
    temperature: 0.2,
  },
  {
    slug: "weekly-report",
    icon: "ClipboardList",
    titleI18nKey: "chat:automation.template.weeklyReport.title",
    descI18nKey: "chat:automation.template.weeklyReport.desc",
    prompt:
      "今天是 {{date}} 星期{{weekday}}。请基于本周工作空间内文件变动,生成一份周报:本周完成 / 数据指标 / 风险与阻塞 / 下周计划,Markdown 输出。",
    scheduleJson: {
      mode: "periodic",
      kind: "weekly",
      weekdays: [1],
      time: "18:00",
    },
    temperature: 0.2,
  },
  {
    slug: "biweekly-review",
    icon: "GitCompare",
    titleI18nKey: "chat:automation.template.biweeklyReview.title",
    descI18nKey: "chat:automation.template.biweeklyReview.desc",
    prompt:
      "今天是 {{date}}。请对工作空间内最近两周的代码/文档做一次双周回顾:亮点、待还的技术债、建议重构点。",
    scheduleJson: {
      mode: "periodic",
      kind: "biweekly",
      anchorDate: "2026-09-07",
      weekday: 1,
      time: "10:00",
    },
    temperature: 0.7,
  },
  {
    slug: "monthly-billing",
    icon: "Receipt",
    titleI18nKey: "chat:automation.template.monthlyBilling.title",
    descI18nKey: "chat:automation.template.monthlyBilling.desc",
    prompt:
      "今天是 {{date}}。请汇总本月模型调用账单数据,生成费用月报:分服务商统计、环比变化、异常项预警。",
    scheduleJson: {
      mode: "periodic",
      kind: "monthly",
      dayOfMonth: 1,
      time: "09:00",
    },
    temperature: 0.2,
  },
  {
    slug: "yearly-reminder",
    icon: "Sparkles",
    titleI18nKey: "chat:automation.template.yearlyReminder.title",
    descI18nKey: "chat:automation.template.yearlyReminder.desc",
    prompt:
      "今天是 {{date}}。跨年时刻,请生成本年度 AI 能力使用回顾与明年展望,轻松一点的语气。",
    scheduleJson: {
      mode: "periodic",
      kind: "yearly",
      month: 12,
      day: 31,
      time: "23:59",
    },
    temperature: 1.0,
  },
  {
    slug: "workdir-monitor",
    icon: "Radar",
    titleI18nKey: "chat:automation.template.workdirMonitor.title",
    descI18nKey: "chat:automation.template.workdirMonitor.desc",
    prompt:
      "现在是 {{time}}。请快速检查工作空间目录状态:磁盘占用 TOP5、最近修改的 10 个文件,发现异常路径立即指出。",
    scheduleJson: {
      mode: "interval",
      value: 60,
      unit: "minute",
      weekdays: [1, 2, 3, 4, 5],
    },
    temperature: 0.2,
  },
  {
    slug: "standup-prep",
    icon: "Coffee",
    titleI18nKey: "chat:automation.template.standupPrep.title",
    descI18nKey: "chat:automation.template.standupPrep.desc",
    prompt:
      "今天是 {{date}} 星期{{weekday}}。请根据昨天的工作空间产出,准备今日站会三条:昨天完成 / 今天计划 / 需要协助。",
    scheduleJson: {
      mode: "periodic",
      kind: "weekly",
      weekdays: [1, 2, 3, 4, 5],
      time: "09:30",
    },
    temperature: 0.7,
  },
];

export function listAutomationTemplates(): AutomationTemplate[] {
  return TEMPLATES.map((t) => ({ ...t, scheduleJson: { ...t.scheduleJson } }));
}
```

```ts
// electron/domains/ai/automation/automation-stat.ts
/**
 * 自动化埋点(spec §5):仅 create 事件,detail JSON 携带
 * { mode, kind, hasEndAt, tabSwitchCount } 覆盖 PRD 三项统计。
 * 照 skill-stats 先例:fire-and-forget、吞错、delegate 缺席静默。
 */
import Log from "../../../commons/Log";

export interface AutomationStatPrismaLike {
  automationStat: {
    create(args: {
      data: { event: string; detail: string };
    }): Promise<unknown>;
  };
}

export async function recordAutomationEvent(
  prisma: AutomationStatPrismaLike | undefined,
  event: "create",
  detail: unknown,
): Promise<void> {
  if (!prisma) {
    return;
  }
  try {
    await prisma.automationStat.create({
      data: { event, detail: JSON.stringify(detail) },
    });
  } catch (e) {
    Log.warn("自动化埋点写入失败", event, e);
  }
}
```

- [ ] **Step 4: 运行测试至通过**

Run: `npx vitest run tests/ai/automation-templates.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/automation/automation-templates.ts electron/domains/ai/automation/automation-stat.ts tests/ai/automation-templates.test.ts
git commit -m "feat(automation): 内置模板数据与埋点事件写入"
```

---

### Task 4: 前端 API 层与 IPC 通道注册

**Files:**
- Create: `src-react/domains/ai/automation/api/automation.api.ts`
- Modify: `src-react/lib/ipc.ts`（IPCChannel 联合类型追加 automation 通道）

**Interfaces:**
- Consumes: `ScheduleConfig`（Task 2）
- Produces（Task 5 后端与 Task 10-17 前端依赖以下类型与方法，签名不得改动）:
  - `TaskRecord`：`{ id; name; prompt; workspaceId; workspaceName: string; source: "local" | "project"; modelId; temperature?: number; scheduleJson: string; scheduleText: string; startAt?: string; endAt?: string; missedPolicy: "skip" | "catchUpOnce"; enabled: boolean; status: "active" | "error" | "expired"; statusNote?: string; lastRunAt?: string; nextRunAt?: string; templateSlug?: string; createdAt: string; updatedAt: string }`
  - `RunRecord`：`{ id; taskId; taskName: string; sessionId?: number; attempt; triggerType: "schedule" | "catchUp" | "retry"; status: "running" | "success" | "failed" | "skipped"; durationMs?: number; promptTokens?: number; completionTokens?: number; error?: string; startedAt: string; finishedAt?: string }`
  - `AutomationApi.list() / create(p) / update(id, p) / remove(ids: number[]) / toggle(id, enabled) / templates() / runs(page, taskId?) / stat(detail)`

- [ ] **Step 1: 写 automation.api.ts**

```ts
// src-react/domains/ai/automation/api/automation.api.ts
/**
 * 自动化任务/运行记录/模板 API(IPC 封装)。
 * 日期字段由主进程 toISOString() 归一;soruce 为后端派生
 * (workspace.directoryPath 有值 = project,无值 = local,spec §0)。
 */
import { invoke } from "@/lib/ipc";
import type { ScheduleConfig } from "./schedule.schema";

export type AutomationStatus = "active" | "error" | "expired";
export type AutomationSource = "local" | "project";
export type MissedPolicy = "skip" | "catchUpOnce";
export type RunStatus = "running" | "success" | "failed" | "skipped";
export type TriggerType = "schedule" | "catchUp" | "retry";

export interface TaskRecord {
  id: number;
  name: string;
  prompt: string;
  workspaceId: number;
  workspaceName: string;
  source: AutomationSource;
  modelId: number;
  temperature?: number;
  /** ScheduleConfig 的 JSON 序列(组件用 JSON.parse 还原) */
  scheduleJson: string;
  scheduleText: string;
  startAt?: string;
  endAt?: string;
  missedPolicy: MissedPolicy;
  enabled: boolean;
  status: AutomationStatus;
  statusNote?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  templateSlug?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCreateParams {
  name: string;
  prompt: string;
  workspaceId: number;
  modelId: number;
  temperature?: number;
  schedule: ScheduleConfig;
  scheduleText: string;
  startAt?: string;
  endAt?: string;
  missedPolicy: MissedPolicy;
  templateSlug?: string;
}

export type TaskUpdateParams = TaskCreateParams;

export interface RunRecord {
  id: number;
  taskId: number;
  taskName: string;
  sessionId?: number;
  attempt: number;
  triggerType: TriggerType;
  status: RunStatus;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface RunPage {
  total: number;
  items: RunRecord[];
}

export interface TemplateRecord {
  slug: string;
  icon: string;
  titleI18nKey: string;
  descI18nKey: string;
  prompt: string;
  scheduleJson: string;
  temperature: number;
}

/** 创建埋点载荷(PRD《执行频率》§5 三项统计合一) */
export interface CreateStatDetail {
  mode: "periodic" | "interval";
  kind: string;
  hasEndAt: boolean;
  tabSwitchCount: number;
}

export class AutomationApi {
  static async list(): Promise<TaskRecord[]> {
    return invoke<TaskRecord[]>("automation:list");
  }

  static async create(params: TaskCreateParams): Promise<TaskRecord> {
    return invoke<TaskRecord>("automation:create", params);
  }

  static async update(
    id: number,
    params: TaskUpdateParams,
  ): Promise<TaskRecord> {
    return invoke<TaskRecord>("automation:update", id, params);
  }

  static async remove(ids: number[]): Promise<void> {
    return invoke<void>("automation:delete", ids);
  }

  static async toggle(id: number, enabled: boolean): Promise<TaskRecord> {
    return invoke<TaskRecord>("automation:toggle", id, enabled);
  }

  static async templates(): Promise<TemplateRecord[]> {
    return invoke<TemplateRecord[]>("automation:templates");
  }

  static async runs(page: number, taskId?: number): Promise<RunPage> {
    return invoke<RunPage>("automation:runs:page", page, taskId);
  }

  static async stat(detail: CreateStatDetail): Promise<void> {
    return invoke<void>("automation:stat", detail);
  }
}

/** 任务变更事件通道(scheduler 执行/过期/异常后主进程推送) */
export const AUTOMATION_CHANGED_EVENT = "automation:tasks-changed";
```

- [ ] **Step 2: ipc.ts 补通道**

`src-react/lib/ipc.ts` 的 `IPCChannel` 联合中，`"mcpServer:statuses"` 之后追加：

```ts
  // 自动化模块
  | "automation:list"
  | "automation:create"
  | "automation:update"
  | "automation:delete"
  | "automation:toggle"
  | "automation:templates"
  | "automation:runs:page"
  | "automation:stat"
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 通过（invoke 的通道字面量均已在联合类型中）

- [ ] **Step 4: Commit**

```bash
git add src-react/domains/ai/automation/api/automation.api.ts src-react/lib/ipc.ts
git commit -m "feat(automation): 前端 API 层与 IPC 通道注册"
```

---

### Task 5: automation.repo.ts（CRUD + IPC）

**Files:**
- Create: `electron/domains/ai/automation/automation.repo.ts`
- Test: `tests/ai/automation-repo.test.ts`

**Interfaces:**
- Consumes: `scheduleSchema`/`computeNextRun`（Task 2）、`listAutomationTemplates`/`recordAutomationEvent`（Task 3）、`prisma`（`electron/commons/prisma-client`）
- Produces: `export default class AutomationRepository`（构造注册 IPC；`static toTaskRecord(row, workspace)` 纯派生函数导出供测试）

- [ ] **Step 1: 写失败测试**

repo 的 IPC/DB 副作用重，只对纯派生与参数组装做单测（DB 行为走 Task 18 冒烟）：

```ts
// tests/ai/automation-repo.test.ts
import { describe, expect, it } from "vitest";
import { toTaskRecord, buildTaskData } from "../../electron/domains/ai/automation/automation.repo";

const row = {
  id: 1,
  name: "早报",
  prompt: "总结 {{date}} 资讯",
  workspaceId: 2,
  modelId: 3,
  temperature: 0.7,
  scheduleJson: '{"mode":"periodic","kind":"daily","time":"09:00"}',
  scheduleText: "每天 09:00",
  startAt: null,
  endAt: null,
  missedPolicy: "skip",
  enabled: true,
  status: "active",
  statusNote: null,
  lastRunAt: null,
  nextRunAt: new Date("2026-09-07T01:00:00Z"),
  templateSlug: null,
  createdAt: new Date("2026-09-06T00:00:00Z"),
  updatedAt: new Date("2026-09-06T00:00:00Z"),
};

describe("toTaskRecord", () => {
  it("workspace 有目录 → project;无目录 → local;日期 toISOString", () => {
    const withDir = toTaskRecord(row, { id: 2, name: "项目A", directoryPath: "/tmp/x" });
    expect(withDir.source).toBe("project");
    expect(withDir.workspaceName).toBe("项目A");
    expect(withDir.nextRunAt).toBe("2026-09-07T01:00:00.000Z");
    const noDir = toTaskRecord(row, { id: 2, name: "本地空间", directoryPath: null });
    expect(noDir.source).toBe("local");
  });
});

describe("buildTaskData(创建/更新共用组装)", () => {
  const params = {
    name: "早报",
    prompt: "总结资讯",
    workspaceId: 2,
    modelId: 3,
    temperature: 0.7,
    schedule: { mode: "periodic", kind: "daily", time: "09:00" } as const,
    scheduleText: "每天 09:00",
    startAt: undefined,
    endAt: undefined,
    missedPolicy: "skip" as const,
    templateSlug: undefined,
  };

  it("scheduleJson 序列化,nextRunAt 用 computeNextRun 计算,不含 enabled/status", () => {
    const data = buildTaskData(params, new Date("2026-09-06T10:00:00"));
    expect(data.scheduleJson).toBe('{"mode":"periodic","kind":"daily","time":"09:00"}');
    expect(data.nextRunAt).toEqual(new Date("2026-09-07T09:00:00"));
    expect(data).not.toHaveProperty("enabled");
    expect(data).not.toHaveProperty("status");
  });

  it("startAt 晚于首个触发点时 nextRunAt clamp 到 startAt", () => {
    const data = buildTaskData(
      { ...params, startAt: "2026-10-01T00:00:00.000Z" },
      new Date("2026-09-06T10:00:00"),
    );
    expect(data.nextRunAt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/automation-repo.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 repo**

```ts
// electron/domains/ai/automation/automation.repo.ts
/**
 * 自动化任务仓储 + IPC(spec §6)。
 * 不实例化 SessionRepository(其构造注册 IPC 有副作用);删除走
 * prisma.$transaction 连带删 run(应用层级联,SQLite 无外键)。
 */
import { ipcMain } from "electron";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import {
  scheduleSchema,
  type ScheduleConfig,
} from "../../../../src-react/domains/ai/automation/api/schedule.schema";
import type {
  TaskCreateParams,
  TaskRecord,
  RunRecord,
  RunPage,
  TemplateRecord,
  CreateStatDetail,
} from "../../../../src-react/domains/ai/automation/api/automation.api";
import { computeNextRun } from "./schedule";
import { listAutomationTemplates } from "./automation-templates";
import { recordAutomationEvent } from "./automation-stat";

type TaskRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationTask.findFirst>>
>;
type RunRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationRun.findFirst>>
>;

/** DB 行 + workspace → 前端记录(source 派生规则 spec §0) */
export function toTaskRecord(
  row: TaskRow,
  workspace: { id: number; name: string; directoryPath: string | null } | null,
): TaskRecord {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    workspaceId: row.workspaceId,
    workspaceName: workspace?.name ?? "-",
    source: workspace?.directoryPath ? "project" : "local",
    modelId: row.modelId,
    temperature: row.temperature ?? undefined,
    scheduleJson: row.scheduleJson,
    scheduleText: row.scheduleText,
    startAt: row.startAt?.toISOString(),
    endAt: row.endAt?.toISOString(),
    missedPolicy: row.missedPolicy === "catchUpOnce" ? "catchUpOnce" : "skip",
    enabled: row.enabled,
    status: row.status as TaskRecord["status"],
    statusNote: row.statusNote ?? undefined,
    lastRunAt: row.lastRunAt?.toISOString(),
    nextRunAt: row.nextRunAt?.toISOString(),
    templateSlug: row.templateSlug ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 创建/更新共用:create params → prisma data(nextRunAt 初算,clamp startAt)。
 * 不含 enabled/status——编辑已暂停任务不得重置用户开关 */
export function buildTaskData(params: TaskCreateParams, now: Date) {
  const schedule = scheduleSchema.parse(params.schedule) as ScheduleConfig;
  const next = computeNextRun(schedule, now);
  const startAt = params.startAt ? new Date(params.startAt) : null;
  return {
    name: params.name,
    prompt: params.prompt,
    workspaceId: params.workspaceId,
    modelId: params.modelId,
    temperature: params.temperature ?? null,
    scheduleJson: JSON.stringify(schedule),
    scheduleText: params.scheduleText,
    startAt,
    endAt: params.endAt ? new Date(params.endAt) : null,
    missedPolicy: params.missedPolicy,
    templateSlug: params.templateSlug ?? null,
    nextRunAt:
      next && startAt && startAt > next ? startAt : next,
  };
}

function toRunRecord(row: RunRow, taskName: string): RunRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    taskName,
    sessionId: row.sessionId ?? undefined,
    attempt: row.attempt,
    triggerType: row.triggerType as RunRecord["triggerType"],
    status: row.status as RunRecord["status"],
    durationMs: row.durationMs ?? undefined,
    promptTokens: row.promptTokens ?? undefined,
    completionTokens: row.completionTokens ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

function toTemplateRecord(t: ReturnType<typeof listAutomationTemplates>[number]): TemplateRecord {
  return {
    slug: t.slug,
    icon: t.icon,
    titleI18nKey: t.titleI18nKey,
    descI18nKey: t.descI18nKey,
    prompt: t.prompt,
    scheduleJson: JSON.stringify(t.scheduleJson),
    temperature: t.temperature,
  };
}

export default class AutomationRepository {
  constructor() {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    ipcMain.handle("automation:list", () => this.listTasks());
    ipcMain.handle(
      "automation:create",
      (_, p: TaskCreateParams) => this.createTask(p),
    );
    ipcMain.handle(
      "automation:update",
      (_, id: number, p: TaskCreateParams) => this.updateTask(id, p),
    );
    ipcMain.handle(
      "automation:delete",
      async (_, ids: number[]): Promise<void> => {
        await prisma.$transaction([
          prisma.automationRun.deleteMany({ where: { taskId: { in: ids } } }),
          prisma.automationTask.deleteMany({ where: { id: { in: ids } } }),
        ]);
      },
    );
    ipcMain.handle(
      "automation:toggle",
      async (_, id: number, enabled: boolean): Promise<TaskRecord> => {
        // 重新启用 = 给异常任务恢复路径:清 statusNote,status 回 active
        const row = await prisma.automationTask.update({
          where: { id },
          data: {
            enabled,
            ...(enabled && { status: "active", statusNote: null }),
          },
        });
        return this.hydrate(row);
      },
    );
    ipcMain.handle(
      "automation:templates",
      (): TemplateRecord[] => listAutomationTemplates().map(toTemplateRecord),
    );
    ipcMain.handle(
      "automation:runs:page",
      (_, page: number, taskId?: number) => this.listRuns(page, taskId),
    );
    ipcMain.handle("automation:stat", (_, detail: CreateStatDetail) => {
      void recordAutomationEvent(prisma, "create", detail);
    });
  }

  /** 供 runner/scheduler 复用的查询:行 → TaskRecord(带 workspace 派生) */
  async hydrate(row: TaskRow): Promise<TaskRecord> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: row.workspaceId },
      select: { id: true, name: true, directoryPath: true },
    });
    return toTaskRecord(row, workspace);
  }

  async listTasks(): Promise<TaskRecord[]> {
    const rows = await prisma.automationTask.findMany({
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  private async createTask(p: TaskCreateParams): Promise<TaskRecord> {
    const row = await prisma.automationTask.create({
      data: { ...buildTaskData(p, new Date()), enabled: true, status: "active" },
    });
    return this.hydrate(row);
  }

  private async updateTask(id: number, p: TaskCreateParams): Promise<TaskRecord> {
    const row = await prisma.automationTask.update({
      where: { id },
      data: buildTaskData(p, new Date()),
    });
    return this.hydrate(row);
  }

  async listRuns(page: number, taskId?: number): Promise<RunPage> {
    const where = taskId ? { taskId } : {};
    const PAGE_SIZE = 20;
    const [total, rows] = await Promise.all([
      prisma.automationRun.count({ where }),
      prisma.automationRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    const names = new Map(
      (
        await prisma.automationTask.findMany({
          where: { id: { in: rows.map((r) => r.taskId) } },
          select: { id: true, name: true },
        })
      ).map((t) => [t.id, t.name]),
    );
    return {
      total,
      items: rows.map((r) =>
        toRunRecord(r, names.get(r.taskId) ?? "-"),
      ),
    };
  }
}

/** 测试导出(buildTaskData 含 zod parse,坏入参抛错由调用方 toast) */
Log; // 保持 import 引用(若 lint 报未使用则删除该行与 import)
```

注：文件末尾 `Log;` 行是为了占位说明——实现时若未用到 Log 直接删除该 import。hydration 的 N+1（每任务一次 workspace 查询）在本地单机任务量级（<百）可接受，不做 join 优化。

- [ ] **Step 4: 运行测试至通过**

Run: `npx vitest run tests/ai/automation-repo.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/automation/automation.repo.ts tests/ai/automation-repo.test.ts
git commit -m "feat(automation): 任务仓储 CRUD 与 IPC 通道"
```

---

### Task 6: automation-runner.ts（无人值守执行器）

**Files:**
- Create: `electron/domains/ai/automation/automation-runner.ts`
- Test: `tests/ai/automation-runner.test.ts`

**Interfaces:**
- Consumes: `runChatStream`（`../chat/chat.service`，纯函数导出）、`createLanguageModel`（`../provider/provider-factory`）、`registry`（`../agent/tool-registry`）、`loadSkills`/`buildSystemPrompt`/`makeReadSkillTool`（`../agent/*`）、`serializeBlocks`/`parseBlocks`（`../chat/blocks`）、`normalizeWorkspacePath`（`../chat/chat.service`）、`computeNextRun`（Task 2）
- Produces:
  - `replaceVariables(prompt: string, now: Date): string`（`{{date}}`→`yyyy-MM-dd`、`{{weekday}}`→`["一","二","三","四","五","六","日"][iso-1]`、`{{time}}`→`HH:mm`）
  - `extractUsage(blocks: MessageBlock[]): { promptTokens: number; completionTokens: number } | undefined`
  - `executeTask(task: TaskRow, opts: { triggerType: "schedule" | "catchUp" | "retry"; attempt: number; abort: AbortSignal }): Promise<void>`（终态自落库：run + task.lastRunAt/nextRunAt；异常路径自动 `status=error`）
  - `TaskRow` 类型 `export type AutomationTaskRow = NonNullable<Awaited<ReturnType<typeof prisma.automationTask.findFirst>>>`

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/automation-runner.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../electron/commons/prisma-client", () => ({
  default: {
    workspace: { findUnique: vi.fn() },
    model: { findUnique: vi.fn() },
    provider: { findUnique: vi.fn() },
    session: { create: vi.fn(), update: vi.fn() },
    message: { create: vi.fn() },
    automationRun: { create: vi.fn(), update: vi.fn() },
    automationTask: { update: vi.fn() },
  },
}));
vi.mock("../../../electron/domains/ai/chat/chat.service", () => ({
  runChatStream: vi.fn(),
  normalizeWorkspacePath: (p: string) => p,
}));
vi.mock("../../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: () => [],
}));
vi.mock("../../../electron/domains/ai/provider/provider-factory", () => ({
  createLanguageModel: () => ({}),
}));

import prisma from "../../../electron/commons/prisma-client";
import { runChatStream } from "../../../electron/domains/ai/chat/chat.service";
import {
  replaceVariables,
  extractUsage,
} from "../../../electron/domains/ai/automation/automation-runner";

describe("replaceVariables", () => {
  it("三个变量全部替换(2026-09-06 为周日)", () => {
    const out = replaceVariables(
      "今天 {{date}} 星期{{weekday}} {{time}}",
      new Date("2026-09-06T09:05:00"),
    );
    expect(out).toBe("今天 2026-09-06 星期日 09:05");
  });
  it("无变量原样返回", () => {
    expect(replaceVariables("plain", new Date())).toBe("plain");
  });
});

describe("extractUsage", () => {
  it("从 usage 块取 input/output;无块返回 undefined", () => {
    expect(
      extractUsage([
        { type: "text", text: "hi" },
        { type: "usage", input: 12, output: 34 },
      ] as never),
    ).toEqual({ promptTokens: 12, completionTokens: 34 });
    expect(extractUsage([{ type: "text", text: "hi" }] as never)).toBeUndefined();
  });
});

describe("executeTask 失败短路", () => {
  it("workspace 缺失 → run failed(workspace_missing) + task error", async () => {
    const { executeTask } = await import(
      "../../../electron/domains/ai/automation/automation-runner"
    );
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue(null);
    const task = {
      id: 1, name: "t", prompt: "p", workspaceId: 9, modelId: 1,
      temperature: 0.7, scheduleJson: '{"mode":"periodic","kind":"daily","time":"09:00"}',
      scheduleText: "每天 09:00", startAt: null, endAt: null,
      missedPolicy: "skip", enabled: true, status: "active", statusNote: null,
      lastRunAt: null, nextRunAt: null, templateSlug: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    await executeTask(task as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    expect(prisma.automationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskId: 1, status: "running" }),
      }),
    );
    expect(prisma.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          error: "workspace_missing",
          finishedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.automationTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "error",
          enabled: false,
          statusNote: "workspace_missing",
        }),
      }),
    );
    expect(runChatStream).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/automation-runner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 runner**

```ts
// electron/domains/ai/automation/automation-runner.ts
/**
 * 自动化任务执行器(spec §4):建 session → 变量替换 → 静默
 * runChatStream(完全访问 + 审批自动放行,无人值守)→ 落 message 与 run。
 * 不经渲染层(onChunk 不传),产物在聊天页可回看。
 */
import { format } from "date-fns";
import path from "node:path";
import { app } from "electron";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import {
  runChatStream,
  normalizeWorkspacePath,
} from "../chat/chat.service";
import { serializeBlocks, type MessageBlock } from "../chat/blocks";
import { createLanguageModel } from "../provider/provider-factory";
import { registry } from "../agent/tool-registry";
import { loadSkills } from "../agent/skill-loader";
import { buildSystemPrompt } from "../agent/skill-prompt";
import { makeReadSkillTool } from "../agent/read-skill";
import { classifyError } from "../chat/error-classify";
import {
  computeNextRun,
} from "./schedule";
import type { ScheduleConfig } from "../../../../src-react/domains/ai/automation/api/schedule.schema";

export type AutomationTaskRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationTask.findFirst>>
>;

const WEEKDAY_ZH = ["一", "二", "三", "四", "五", "六", "日"];

/** 运行时变量替换(中文格式,spec §4;语言不跟随 i18n,固定格式) */
export function replaceVariables(prompt: string, now: Date): string {
  return prompt
    .replaceAll("{{date}}", format(now, "yyyy-MM-dd"))
    .replaceAll(
      "{{weekday}}",
      WEEKDAY_ZH[(now.getDay() === 0 ? 7 : now.getDay()) - 1],
    )
    .replaceAll("{{time}}", format(now, "HH:mm"));
}

/** assistant blocks 的 usage 块 → run 记录 token 数 */
export function extractUsage(
  blocks: MessageBlock[],
): { promptTokens: number; completionTokens: number } | undefined {
  const usage = blocks.find((b) => b.type === "usage");
  return usage && usage.type === "usage"
    ? { promptTokens: usage.input, completionTokens: usage.output }
    : undefined;
}

/** 工具集组装(对齐 chat.service collectToolDefinitions:read_skill 常驻) */
function collectTools(workspacePath: string | undefined, skills: ReturnType<typeof loadSkills>) {
  const registered = registry.getDefinitions();
  const injected = workspacePath
    ? registered
    : registered.filter(
        (def) => def.name.startsWith("mcp__") || def.name === "create_skill",
      );
  return [makeReadSkillTool(skills), ...injected];
}

export interface ExecuteTaskOptions {
  triggerType: "schedule" | "catchUp" | "retry";
  attempt: number;
  abort: AbortSignal;
}

/**
 * 单次执行(所有异常吞掉落库,绝不向调度器抛出)。
 * 返回值仅用于测试断言:最终 run.status。
 */
export async function executeTask(
  task: AutomationTaskRow,
  opts: ExecuteTaskOptions,
): Promise<"success" | "failed"> {
  const now = new Date();
  const startedAt = Date.now();
  const run = await prisma.automationRun.create({
    data: {
      taskId: task.id,
      attempt: opts.attempt,
      triggerType: opts.triggerType,
      status: "running",
      startedAt: now,
    },
  });
  let sessionId: number | undefined;
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: task.workspaceId },
    });
    if (!workspace) {
      return await failRun(run.id, task, "workspace_missing", startedAt, sessionId);
    }
    const modelRow = await prisma.model.findUnique({
      where: { id: task.modelId },
    });
    const providerRow = modelRow
      ? await prisma.provider.findUnique({
          where: { id: modelRow.providerId },
        })
      : null;
    if (!modelRow || !providerRow) {
      return await failRun(run.id, task, "model_missing", startedAt, sessionId);
    }
    sessionId = await createSession(task);
    return await streamAndRecord(task, opts, {
      runId: run.id,
      sessionId,
      startedAt,
      providerType: providerRow.type,
      baseUrl: providerRow.baseUrl,
      apiKey: providerRow.apiKey,
      extraHeaders: providerRow.extraHeaders,
      modelSdkId: modelRow.modelId,
      workspacePath: workspace.directoryPath?.trim()
        ? normalizeWorkspacePath(workspace.directoryPath)
        : undefined,
      workspaceId: workspace.id,
    });
  } catch (e) {
    Log.error("自动化任务执行异常", task.id, e);
    return await failRun(
      run.id,
      task,
      classifyError(e),
      startedAt,
      sessionId,
    );
  }
}

async function createSession(task: AutomationTaskRow): Promise<number> {
  const session = await prisma.session.create({
    data: {
      workspaceId: task.workspaceId,
      currentModelId: task.modelId,
      title: task.name,
      mode: "agent",
    },
  });
  return session.id;
}

interface StreamContext {
  runId: number;
  sessionId: number;
  startedAt: number;
  providerType: string;
  baseUrl: string;
  apiKey: string | null;
  extraHeaders: string | null;
  modelSdkId: string;
  workspacePath?: string;
  workspaceId: number;
}

async function streamAndRecord(
  task: AutomationTaskRow,
  opts: ExecuteTaskOptions,
  ctx: StreamContext,
): Promise<"success" | "failed"> {
  const userText = replaceVariables(task.prompt, new Date());
  await prisma.message.create({
    data: {
      sessionId: ctx.sessionId,
      role: "user",
      blocks: serializeBlocks([{ type: "text", text: userText }]),
    },
  });
  const skills = loadSkills([
    {
      dir: path.join(app.getPath("userData"), "skills"),
      source: "user",
    },
    ...(ctx.workspacePath
      ? [{ dir: path.join(ctx.workspacePath, ".mirror", "skills"), source: "user" as const }]
      : []),
  ]);
  const result = await runChatStream({
    model: createLanguageModel(
      {
        type: ctx.providerType,
        baseUrl: ctx.baseUrl,
        apiKey: ctx.apiKey ?? undefined,
        extraHeaders: ctx.extraHeaders,
      },
      ctx.modelSdkId,
    ),
    system: buildSystemPrompt(undefined, skills),
    history: [
      { role: "user", blocks: serializeBlocks([{ type: "text", text: userText }]) },
    ],
    params: { temperature: task.temperature ?? undefined },
    abortSignal: opts.abort,
    toolDefinitions: collectTools(ctx.workspacePath, skills),
    agent: {
      sessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      // 完全访问 + 审批自动放行(spec §0 无人值守决策)
      fullAccess: () => true,
      isToolAllowed: async () => true,
      requestApproval: async () => true,
    },
  });
  const usage = extractUsage(result.blocks);
  await prisma.message.create({
    data: {
      sessionId: ctx.sessionId,
      role: "assistant",
      blocks: serializeBlocks(result.blocks),
      modelId: task.modelId,
      error: result.errorMessage,
      durationMs: Date.now() - ctx.startedAt,
    },
  });
  const success = !result.errorCode;
  await prisma.automationRun.update({
    where: { id: ctx.runId },
    data: {
      status: success ? "success" : "failed",
      durationMs: Date.now() - ctx.startedAt,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      error: result.errorMessage
        ? `${result.errorCode}: ${result.errorMessage}`.slice(0, 500)
        : null,
      finishedAt: new Date(),
    },
  });
  await advanceTask(task, new Date());
  return success ? "success" : "failed";
}

/** 失败收尾:run failed + 可选 task 标异常(系统错误码) */
async function failRun(
  runId: number,
  task: AutomationTaskRow,
  errorCode: string,
  startedAt: number,
  sessionId?: number,
): Promise<"failed"> {
  await prisma.automationRun.update({
    where: { id: runId },
    data: {
      status: "failed",
      error: errorCode,
      durationMs: Date.now() - startedAt,
      sessionId: sessionId ?? null,
      finishedAt: new Date(),
    },
  });
  if (errorCode === "workspace_missing" || errorCode === "model_missing") {
    await prisma.automationTask.update({
      where: { id: task.id },
      data: { status: "error", enabled: false, statusNote: errorCode },
    });
  } else {
    await advanceTask(task, new Date());
  }
  return "failed";
}

/** lastRunAt=now;nextRunAt=computeNextRun(once 到期 → expired) */
async function advanceTask(task: AutomationTaskRow, now: Date): Promise<void> {
  const schedule = JSON.parse(task.scheduleJson) as ScheduleConfig;
  const next = computeNextRun(schedule, now, now);
  await prisma.automationTask.update({
    where: { id: task.id },
    data: {
      lastRunAt: now,
      nextRunAt: next,
      ...(schedule.mode === "periodic" &&
        schedule.kind === "once" && { status: "expired" }),
    },
  });
}
```

注：`loadSkills` 的 workspace 级 source 联合类型如报错，按 skill-loader 实际签名调整（chat.service.ts:1089 的 collectSkills 是权威参照）。`failRun` 中非系统错误码也推进 lastRunAt/nextRunAt（interval 相位正确），重试由 scheduler 扫描发起（retry 的 attempt 递增），retry 的 run 不在 runner 内推进 schedule——因此 `advanceTask` 仅在非 retry 或最终成功时调用。**修正**：为保持简单，`streamAndRecord` 成功路径与 `failRun` 非系统错误路径均调用 `advanceTask`，重复调用幂等（同值覆盖），可接受。

- [ ] **Step 4: 运行测试至通过**

Run: `npx vitest run tests/ai/automation-runner.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/automation/automation-runner.ts tests/ai/automation-runner.test.ts
git commit -m "feat(automation): 无人值守执行器(复用 runChatStream 静默落库)"
```

---

### Task 7: automation-scheduler.ts（30s tick 决策树 + 重试扫描）

**Files:**
- Create: `electron/domains/ai/automation/automation-scheduler.ts`
- Test: `tests/ai/automation-scheduler.test.ts`

**Interfaces:**
- Consumes: `computeNextRun`（Task 2）、`executeTask`（Task 6）
- Produces:
  - `export type TickDecision = "execute" | "catchUp" | "skip" | "advance" | "expire" | "noop"` 与 `decideTick(task, now: Date, processStartTime: Date): TickDecision`（纯函数，spec §4 决策树）
  - `export function pickRetryTaskIds(latestRunByTask: Map<number, { status: string; attempt: number; finishedAt?: Date }>, now: Date, delayMs = 60_000): number[]`（纯函数）
  - `export default class AutomationScheduler { start(): void; stop(): void; }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/automation-scheduler.test.ts
import { describe, expect, it } from "vitest";
import { decideTick, pickRetryTaskIds } from "../../electron/domains/ai/automation/automation-scheduler";

const base = {
  id: 1, name: "t", prompt: "p", workspaceId: 1, modelId: 1,
  temperature: null, scheduleJson: '{"mode":"periodic","kind":"daily","time":"09:00"}',
  scheduleText: "每天 09:00", startAt: null, endAt: null,
  missedPolicy: "skip", enabled: true, status: "active", statusNote: null,
  templateSlug: null, createdAt: new Date(), updatedAt: new Date(),
} as const;

const now = new Date("2026-09-07T09:00:30");
const boot = new Date("2026-09-07T08:00:00");

describe("decideTick 决策树", () => {
  it("nextRunAt 未到 → noop", () => {
    expect(
      decideTick(
        { ...base, nextRunAt: new Date("2026-09-07T10:00:00") } as never,
        now,
        boot,
      ),
    ).toBe("noop");
  });
  it("正常触发:nextRunAt >= 进程启动时间 → execute", () => {
    expect(
      decideTick(
        { ...base, nextRunAt: new Date("2026-09-07T09:00:00") } as never,
        now,
        boot,
      ),
    ).toBe("execute");
  });
  it("错过且 nextRunAt < 进程启动:skip 策略 → skip;catchUpOnce → catchUp", () => {
    const missed = {
      ...base,
      nextRunAt: new Date("2026-09-07T07:00:00"),
      lastRunAt: new Date("2026-09-06T09:00:00"),
    };
    expect(decideTick(missed as never, now, boot)).toBe("skip");
    expect(
      decideTick({ ...missed, missedPolicy: "catchUpOnce" } as never, now, boot),
    ).toBe("catchUp");
  });
  it("该触发点已执行(lastRunAt >= nextRunAt) → advance", () => {
    expect(
      decideTick(
        {
          ...base,
          nextRunAt: new Date("2026-09-07T09:00:00"),
          lastRunAt: new Date("2026-09-07T09:00:05"),
        } as never,
        now,
        boot,
      ),
    ).toBe("advance");
  });
  it("endAt 已过 → expire;未到 startAt → noop", () => {
    expect(
      decideTick(
        { ...base, endAt: new Date("2026-09-06T00:00:00") } as never,
        now,
        boot,
      ),
    ).toBe("expire");
    expect(
      decideTick(
        { ...base, startAt: new Date("2026-09-08T00:00:00") } as never,
        now,
        boot,
      ),
    ).toBe("noop");
  });
  it("once 任务:runAt 过期且跑过 → expire", () => {
    expect(
      decideTick(
        {
          ...base,
          scheduleJson: '{"mode":"periodic","kind":"once","runAt":"2026-09-06T09:00:00.000Z"}',
          nextRunAt: new Date("2026-09-06T09:00:00"),
          lastRunAt: new Date("2026-09-06T09:00:01"),
        } as never,
        now,
        boot,
      ),
    ).toBe("expire");
  });
});

describe("pickRetryTaskIds", () => {
  const finishedAt = (iso: string) => ({ finishedAt: new Date(iso) });
  it("最新 run failed 且 attempt<3 且冷却 60s 已过 → 重试", () => {
    const m = new Map([
      [1, { status: "failed", attempt: 1, ...finishedAt("2026-09-07T08:59:00") }],
      [2, { status: "failed", attempt: 3, ...finishedAt("2026-09-07T08:00:00") }],
      [3, { status: "failed", attempt: 2, ...finishedAt("2026-09-07T08:59:31") }],
      [4, { status: "success", attempt: 1, ...finishedAt("2026-09-07T08:00:00") }],
    ]);
    expect(pickRetryTaskIds(m, now)).toEqual([1]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/automation-scheduler.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 scheduler**

```ts
// electron/domains/ai/automation/automation-scheduler.ts
/**
 * 调度器(spec §4):30s tick + 决策树 + 重试扫描。
 * 互斥:内存 Map<taskId, AbortController>;退出 abort 全部在途。
 * 推送:执行/过期/异常后向全部窗口发 automation:tasks-changed。
 */
import { BrowserWindow } from "electron";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { computeNextRun } from "./schedule";
import { executeTask, type AutomationTaskRow } from "./automation-runner";
import type { ScheduleConfig } from "../../../../src-react/domains/ai/automation/api/schedule.schema";

const TICK_MS = 30_000;
const RETRY_DELAY_MS = 60_000;
const MAX_ATTEMPT = 3;

export type TickDecision =
  | "execute"
  | "catchUp"
  | "skip"
  | "advance"
  | "expire"
  | "noop";

/** 决策树纯函数(spec §4;once 已跑过 = expire) */
export function decideTick(
  task: AutomationTaskRow,
  now: Date,
  processStartTime: Date,
): TickDecision {
  if (task.startAt && now < task.startAt) {
    return "noop";
  }
  if (task.endAt && now > task.endAt) {
    return "expire";
  }
  if (!task.nextRunAt) {
    // once:从未跑过且 runAt 已过也走 expire 由 runner 不再触发;此处仅到期回收
    return "expire";
  }
  if (now < task.nextRunAt) {
    return "noop";
  }
  if (task.lastRunAt && task.lastRunAt >= task.nextRunAt) {
    return "advance";
  }
  return task.nextRunAt < processStartTime
    ? task.missedPolicy === "catchUpOnce"
      ? "catchUp"
      : "skip"
    : "execute";
}

/** 重试扫描纯函数:failed && attempt<3 && finishedAt 早于 now-60s */
export function pickRetryTaskIds(
  latestRunByTask: Map<
    number,
    { status: string; attempt: number; finishedAt?: Date }
  >,
  now: Date,
  delayMs = RETRY_DELAY_MS,
): number[] {
  const ids: number[] = [];
  for (const [taskId, run] of latestRunByTask) {
    if (
      run.status === "failed" &&
      run.attempt < MAX_ATTEMPT &&
      run.finishedAt &&
      now.getTime() - run.finishedAt.getTime() >= delayMs
    ) {
      ids.push(taskId);
    }
  }
  return ids;
}

export default class AutomationScheduler {
  private timer?: NodeJS.Timeout;
  private aborts = new Map<number, AbortController>();
  private processStartTime = new Date();

  start(): void {
    // 崩溃残留:running 的 run 全部置 failed(interrupted)(spec §7)
    void this.recoverInterruptedRuns();
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    Log.info("自动化调度器已启动");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const abort of this.aborts.values()) {
      abort.abort();
    }
    this.aborts.clear();
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const result = await prisma.automationRun.updateMany({
      where: { status: "running" },
      data: { status: "failed", error: "interrupted", finishedAt: new Date() },
    });
    if (result.count > 0) {
      Log.info(`回收中断运行记录 ${result.count} 条`);
    }
  }

  private async tick(): Promise<void> {
    try {
      const tasks = await prisma.automationTask.findMany({
        where: { enabled: true },
      });
      let changed = false;
      for (const task of tasks) {
        const decision = decideTick(task, new Date(), this.processStartTime);
        if (decision === "noop") {
          continue;
        }
        changed = true;
        await this.applyDecision(task, decision);
      }
      await this.scanRetries(tasks);
      if (changed) {
        this.notifyChanged();
      }
    } catch (e) {
      Log.error("自动化调度 tick 异常", e);
    }
  }

  private async applyDecision(
    task: AutomationTaskRow,
    decision: TickDecision,
  ): Promise<void> {
    const now = new Date();
    const schedule = JSON.parse(task.scheduleJson) as ScheduleConfig;
    switch (decision) {
      case "expire":
        await prisma.automationTask.update({
          where: { id: task.id },
          data: { status: "expired" },
        });
        return;
      case "advance": {
        const next = computeNextRun(schedule, now, task.lastRunAt ?? undefined);
        await prisma.automationTask.update({
          where: { id: task.id },
          data: { nextRunAt: next },
        });
        return;
      }
      case "skip":
        await prisma.automationRun.create({
          data: {
            taskId: task.id,
            triggerType: "schedule",
            status: "skipped",
            startedAt: now,
            finishedAt: now,
          },
        });
        await prisma.automationTask.update({
          where: { id: task.id },
          data: { nextRunAt: computeNextRun(schedule, now, task.lastRunAt ?? undefined) },
        });
        return;
      case "execute":
        await this.launch(task, "schedule", 1);
        return;
      case "catchUp":
        await this.launch(task, "catchUp", 1);
        return;
    }
  }

  private async scanRetries(tasks: AutomationTaskRow[]): Promise<void> {
    const runs = await prisma.automationRun.findMany({
      orderBy: { id: "desc" },
      take: 500,
    });
    const latest = new Map<
      number,
      { status: string; attempt: number; finishedAt?: Date }
    >();
    for (const run of runs) {
      if (!latest.has(run.taskId)) {
        latest.set(run.taskId, {
          status: run.status,
          attempt: run.attempt,
          finishedAt: run.finishedAt ?? undefined,
        });
      }
    }
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const taskId of pickRetryTaskIds(latest, new Date())) {
      const task = byId.get(taskId);
      const attempt = (latest.get(taskId)?.attempt ?? 0) + 1;
      if (task && task.enabled) {
        await this.launch(task, "retry", attempt);
      }
    }
  }

  /** fire:不 await 完成,互斥已有则跳过 */
  private launch(
    task: AutomationTaskRow,
    triggerType: "schedule" | "catchUp" | "retry",
    attempt: number,
  ): void {
    if (this.aborts.has(task.id)) {
      return;
    }
    const abort = new AbortController();
    this.aborts.set(task.id, abort);
    void executeTask(task, { triggerType, attempt, abort: abort.signal })
      .catch((e) => Log.error("自动化执行失败", task.id, e))
      .finally(() => {
        this.aborts.delete(task.id);
        this.notifyChanged();
      });
  }

  private notifyChanged(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("automation:tasks-changed");
    }
  }
}
```

注：`decideTick` 测试用例「nextRunAt === null 的 once 已跑过 → expire」覆盖在 `nextRunAt === null` 分支——once 执行后 `advanceTask` 会把 nextRunAt 置 null（computeNextRun once 过期返回 null），下个 tick 回收为 expired。**实现细节**：`prisma.automationTask.update` 的 `nextRunAt: next` 当 `next` 为 `null` 时即落 NULL，与决策树自洽。

- [ ] **Step 4: 运行测试至通过**

Run: `npx vitest run tests/ai/automation-scheduler.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/automation/automation-scheduler.ts tests/ai/automation-scheduler.test.ts
git commit -m "feat(automation): 调度器决策树/重试扫描/互斥与生命周期"
```

---

### Task 8: Application 接线

**Files:**
- Modify: `electron/Application.ts`（import + registerServices 两行 + quit stop）

**Interfaces:**
- Consumes: `AutomationRepository`（Task 5）、`AutomationScheduler`（Task 7）
- Produces: 应用启动后调度器运行；退出时中断在途执行。

- [ ] **Step 1: 修改 Application.ts**

顶部 import 区追加：

```ts
import AutomationRepository from "./domains/ai/automation/automation.repo";
import AutomationScheduler from "./domains/ai/automation/automation-scheduler";
```

`Application` 类内加字段与方法：

```ts
export default class Application {
  private databaseVerson: number;
  private scheduler = new AutomationScheduler();
  // ...constructor 不变
```

`execute()` 中 `this.registerServices();` 之后追加一行：

```ts
    this.scheduler.start();
```

`initDatabase()` 里已有的 `app.on("quit", ...)` 回调内追加：

```ts
      this.scheduler.stop();
```

`registerServices()` 末尾（`new UpdateLogService(...)` 之后）追加：

```ts
    // 自动化模块:repo 注册 IPC;调度器随应用生命周期启停
    new AutomationRepository();
```

- [ ] **Step 2: 类型检查与全量后端测试**

Run: `npm run typecheck && npx vitest run tests/ai`
Expected: 全部 PASS（既有测试不回归）

- [ ] **Step 3: Commit**

```bash
git add electron/Application.ts
git commit -m "feat(automation): Application 接线(调度器随生命周期启停)"
```

---

### Task 9: schedule-text.ts（自然语言 + 校验，前端）

**Files:**
- Create: `src-react/domains/ai/automation/lib/schedule-text.ts`
- Test: `tests/ai/automation-schedule-text.test.ts`

**Interfaces:**
- Consumes: `ScheduleConfig`（Task 2）
- Produces（Task 12/13/14 依赖）:
  - `describeSchedule(cfg: ScheduleConfig, t: (key: string, opts?: Record<string, unknown>) => string): string`（全部走 `chat:automation.schedule.text*` i18n 键，星期名 `t("common:weekday.n", { n })`——若 common 无 weekday 键，在 Task 11 一并添加）
  - `describeValidity(validity: { startAt?: string; endAt?: string }, t): string`
  - `validateSchedule(cfg: ScheduleConfig | null, validity: { startAt?: string; endAt?: string }, now: Date): "ok" | "timeInPast" | "intervalTooSmall" | "incomplete"`（错误码由组件映射 i18n，SchedulePicker 摘要栏与 Dialog 确定按钮共用）

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/automation-schedule-text.test.ts
import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  describeValidity,
  validateSchedule,
} from "../../src-react/domains/ai/automation/lib/schedule-text";

/** t 直通键名,断言走键拼接 */
const t = (key: string, opts?: Record<string, unknown>) =>
  key + (opts ? `:${JSON.stringify(opts)}` : "");

describe("describeSchedule", () => {
  it("daily → 每天时间", () => {
    expect(
      describeSchedule({ mode: "periodic", kind: "daily", time: "09:00" }, t),
    ).toBe('chat:automation.schedule.textDaily:{"time":"09:00"}');
  });
  it("weekly → 星期多选", () => {
    expect(
      describeSchedule(
        { mode: "periodic", kind: "weekly", weekdays: [1, 5], time: "18:00" },
        t,
      ),
    ).toBe(
      'chat:automation.schedule.textWeekly:{"weekdays":"chat:common.weekday.1, chat:common.weekday.5","time":"18:00"}',
    );
  });
  it("interval → 间隔 + 星期筛选", () => {
    expect(
      describeSchedule(
        { mode: "interval", value: 1, unit: "hour", weekdays: [1, 2] },
        t,
      ),
    ).toContain("chat:automation.schedule.textInterval");
  });
});

describe("describeValidity", () => {
  it("长期有效 / 自定义区间", () => {
    expect(describeValidity({}, t)).toBe("chat:automation.schedule.longTerm");
    expect(describeValidity({ startAt: "2026-09-07", endAt: "2026-10-01" }, t)).toBe(
      'chat:automation.schedule.textRange:{"start":"2026-09-07","end":"2026-10-01"}',
    );
  });
});

describe("validateSchedule", () => {
  const now = new Date("2026-09-06T10:00:00");
  it("once runAt 已过 → timeInPast", () => {
    expect(
      validateSchedule(
        { mode: "periodic", kind: "once", runAt: "2026-09-05T10:00:00.000Z" },
        {},
        now,
      ),
    ).toBe("timeInPast");
  });
  it("interval < 5 分钟 → intervalTooSmall", () => {
    expect(
      validateSchedule({ mode: "interval", value: 3, unit: "minute" }, {}, now),
    ).toBe("intervalTooSmall");
  });
  it("startAt 已过 → timeInPast;null → incomplete;正常 → ok", () => {
    expect(
      validateSchedule(
        { mode: "periodic", kind: "daily", time: "09:00" },
        { startAt: "2025-01-01T00:00:00.000Z" },
        now,
      ),
    ).toBe("timeInPast");
    expect(validateSchedule(null, {}, now)).toBe("incomplete");
    expect(
      validateSchedule({ mode: "periodic", kind: "daily", time: "09:00" }, {}, now),
    ).toBe("ok");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/automation-schedule-text.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src-react/domains/ai/automation/lib/schedule-text.ts
/**
 * 调度自然语言与校验(纯函数,摘要栏与列表行同一实现,spec §5)。
 * 文案全走 i18n;t 注入可测;校验规则见 PRD《执行频率》§4。
 */
import {
  intervalMinutes,
  INTERVAL_MIN_MINUTES,
  type ScheduleConfig,
} from "../api/schedule.schema";

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export type ScheduleValidation =
  | "ok"
  | "timeInPast"
  | "intervalTooSmall"
  | "incomplete";

function weekdayNames(weekdays: number[], t: TFunc): string {
  return weekdays.map((n) => t("common:weekday." + n)).join(", ");
}

export function describeSchedule(cfg: ScheduleConfig, t: TFunc): string {
  if (cfg.mode === "interval") {
    return t("chat:automation.schedule.textInterval", {
      weekdays: cfg.weekdays ? weekdayNames(cfg.weekdays, t) : "",
      value: cfg.value,
      unit: t(`chat:automation.schedule.unit.${cfg.unit}`),
    });
  }
  switch (cfg.kind) {
    case "once":
      return t("chat:automation.schedule.textOnce", { time: cfg.runAt.slice(0, 16).replace("T", " ") });
    case "daily":
      return t("chat:automation.schedule.textDaily", { time: cfg.time });
    case "weekly":
      return t("chat:automation.schedule.textWeekly", {
        weekdays: weekdayNames(cfg.weekdays, t),
        time: cfg.time,
      });
    case "biweekly":
      return t("chat:automation.schedule.textBiweekly", {
        weekday: t("common:weekday." + cfg.weekday),
        time: cfg.time,
      });
    case "monthly":
      return t("chat:automation.schedule.textMonthly", {
        day: cfg.dayOfMonth,
        time: cfg.time,
      });
    case "yearly":
      return t("chat:automation.schedule.textYearly", {
        month: cfg.month,
        day: cfg.day,
        time: cfg.time,
      });
  }
}

export function describeValidity(
  validity: { startAt?: string; endAt?: string },
  t: TFunc,
): string {
  if (!validity.startAt && !validity.endAt) {
    return t("chat:automation.schedule.longTerm");
  }
  return t("chat:automation.schedule.textRange", {
    start: validity.startAt?.slice(0, 10) ?? "",
    end: validity.endAt?.slice(0, 10) ?? "",
  });
}

export function validateSchedule(
  cfg: ScheduleConfig | null,
  validity: { startAt?: string; endAt?: string },
  now: Date,
): ScheduleValidation {
  if (!cfg) {
    return "incomplete";
  }
  if (cfg.mode === "interval" && intervalMinutes(cfg) < INTERVAL_MIN_MINUTES) {
    return "intervalTooSmall";
  }
  if (cfg.mode === "periodic" && cfg.kind === "once") {
    if (new Date(cfg.runAt) <= now) {
      return "timeInPast";
    }
  }
  if (validity.startAt && new Date(validity.startAt) <= now) {
    return "timeInPast";
  }
  return "ok";
}
```

- [ ] **Step 4: 运行测试至通过**

Run: `npx vitest run tests/ai/automation-schedule-text.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/automation/lib/schedule-text.ts tests/ai/automation-schedule-text.test.ts
git commit -m "feat(automation): 调度自然语言描述与表单校验纯函数"
```

---

### Task 10: automation.store.ts（视图状态 + 过滤）

**Files:**
- Create: `src-react/domains/ai/automation/store/automation.store.ts`
- Test: `tests/ai/automation-filter.test.ts`

**Interfaces:**
- Consumes: `TaskRecord`（Task 4）
- Produces:
  - `export type SourceFilter = "all" | "local" | "project" | "cloud"`
  - `export type StatusFilter = "all" | "running" | "paused" | "error" | "expired"`
  - `export function filterTasks(tasks: TaskRecord[], source: SourceFilter, status: StatusFilter, search: string): TaskRecord[]`（纯函数：cloud 恒空结果；running = enabled && status==="active"；paused = !enabled；search 按名称 toLowerCase includes）
  - `export const useAutomationStore`（zustand：`{ tab: "tasks"|"runs"; view: "list"|"market"; sourceFilter; statusFilter; search; batchMode: boolean; selectedIds: number[]; tabSwitchCount: number; setters...; toggleSelected(id); clearSelection() }`，tab/view 切换记录 tabSwitchCount？——否：**tabSwitchCount 语义是 SchedulePicker 周期/间隔切换次数**，放组件本地 state，不进 store）

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/automation-filter.test.ts
import { describe, expect, it } from "vitest";
import { filterTasks } from "../../src-react/domains/ai/automation/store/automation.store";
import type { TaskRecord } from "../../src-react/domains/ai/automation/api/automation.api";

const task = (over: Partial<TaskRecord>): TaskRecord => ({
  id: 1,
  name: "早报",
  prompt: "p",
  workspaceId: 1,
  workspaceName: "w",
  source: "project",
  modelId: 1,
  scheduleJson: "{}",
  scheduleText: "每天 09:00",
  missedPolicy: "skip",
  enabled: true,
  status: "active",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  ...over,
});

const tasks = [
  task({ id: 1, name: "AI 早报", source: "project", enabled: true, status: "active" }),
  task({ id: 2, name: "周报", source: "local", enabled: false, status: "active" }),
  task({ id: 3, name: "监控", source: "local", enabled: false, status: "error" }),
];

describe("filterTasks", () => {
  it("source 维度:cloud 恒空", () => {
    expect(filterTasks(tasks, "cloud", "all", "").length).toBe(0);
    expect(filterTasks(tasks, "local", "all", "").length).toBe(2);
    expect(filterTasks(tasks, "project", "all", "").length).toBe(1);
  });
  it("status 维度:running=enabled&&active;paused=!enabled&&active", () => {
    expect(filterTasks(tasks, "all", "running", "").map((t) => t.id)).toEqual([1]);
    expect(filterTasks(tasks, "all", "paused", "").map((t) => t.id)).toEqual([2]);
    expect(filterTasks(tasks, "all", "error", "").map((t) => t.id)).toEqual([3]);
  });
  it("search 名称包含(大小写不敏感)", () => {
    expect(filterTasks(tasks, "all", "all", "ai").map((t) => t.id)).toEqual([1]);
    expect(filterTasks(tasks, "all", "all", "不存在")).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/automation-filter.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 store**

```ts
// src-react/domains/ai/automation/store/automation.store.ts
/**
 * 自动化视图状态(内存态,zustand;来源/状态/搜索过滤在前端,
 * spec §5:SQLite 数据量小,分类计数由过滤结果派生)。
 */
import { create } from "zustand";
import type { TaskRecord } from "../api/automation.api";

export type SourceFilter = "all" | "local" | "project" | "cloud";
export type StatusFilter = "all" | "running" | "paused" | "error" | "expired";

/** 纯过滤:cloud 无服务端支撑恒空(spec §0 决策) */
export function filterTasks(
  tasks: TaskRecord[],
  source: SourceFilter,
  status: StatusFilter,
  search: string,
): TaskRecord[] {
  return tasks.filter((task) => {
    if (source === "cloud") {
      return false;
    }
    if (source !== "all" && task.source !== source) {
      return false;
    }
    if (status === "running" && !(task.enabled && task.status === "active")) {
      return false;
    }
    if (status === "paused" && (task.enabled || task.status !== "active")) {
      return false;
    }
    if (status === "error" && task.status !== "error") {
      return false;
    }
    if (status === "expired" && task.status !== "expired") {
      return false;
    }
    if (search && !task.name.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    return true;
  });
}

interface AutomationState {
  tab: "tasks" | "runs";
  view: "list" | "market";
  sourceFilter: SourceFilter;
  statusFilter: StatusFilter;
  search: string;
  batchMode: boolean;
  selectedIds: number[];
  setTab: (tab: "tasks" | "runs") => void;
  setView: (view: "list" | "market") => void;
  setSourceFilter: (f: SourceFilter) => void;
  setStatusFilter: (f: StatusFilter) => void;
  setSearch: (s: string) => void;
  enterBatchMode: () => void;
  exitBatchMode: () => void;
  toggleSelected: (id: number) => void;
  selectAll: (ids: number[]) => void;
}

export const useAutomationStore = create<AutomationState>((set) => ({
  tab: "tasks",
  view: "list",
  sourceFilter: "all",
  statusFilter: "all",
  search: "",
  batchMode: false,
  selectedIds: [],
  setTab: (tab) => set({ tab }),
  setView: (view) => set({ view }),
  setSourceFilter: (sourceFilter) => set({ sourceFilter }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setSearch: (search) => set({ search }),
  enterBatchMode: () => set({ batchMode: true, selectedIds: [] }),
  exitBatchMode: () => set({ batchMode: false, selectedIds: [] }),
  toggleSelected: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((x) => x !== id)
        : [...state.selectedIds, id],
    })),
  selectAll: (ids) =>
    set((state) => ({
      selectedIds: state.selectedIds.length === ids.length ? [] : ids,
    })),
}));
```

- [ ] **Step 4: 运行测试至通过**

Run: `npx vitest run tests/ai/automation-filter.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/automation/store/automation.store.ts tests/ai/automation-filter.test.ts
git commit -m "feat(automation): 视图状态 store 与来源/状态/搜索过滤"
```

---

### Task 11: i18n 文案全量（zh-CN + en-US）

**Files:**
- Modify: `src-react/i18n/locales/zh-CN/chat.json`
- Modify: `src-react/i18n/locales/en-US/chat.json`
- Modify: `src-react/i18n/locales/zh-CN/common.json` / `en-US/common.json`（补 `weekday.*` 七键）

**Interfaces:**
- Produces: Task 12-17 全部 `chat:automation.*` 与 `common:weekday.*` 键。**先于组件任务完成，组件只引用不新增。**

- [ ] **Step 1: zh-CN/common.json 顶层追加**

```json
"weekday": {
  "1": "周一",
  "2": "周二",
  "3": "周三",
  "4": "周四",
  "5": "周五",
  "6": "周六",
  "7": "周日"
}
```

- [ ] **Step 2: zh-CN/chat.json 用下面整段替换现有 `"automation": { "title": "自动化" }`（注意同级 `"task"` 键已存在，保留不动）**

```json
"automation": {
  "title": "自动化",
  "tabs": { "tasks": "定时任务", "runs": "运行记录" },
  "toolbar": {
    "searchPlaceholder": "搜索任务名称",
    "refresh": "刷新",
    "batchManage": "批量管理",
    "add": "添加自动化",
    "addCustom": "自定义创建",
    "addFromTemplate": "从模版添加"
  },
  "filter": {
    "all": "全部 ({{count}})",
    "local": "本地 ({{count}})",
    "project": "项目 ({{count}})",
    "cloud": "云端 ({{count}})"
  },
  "status": {
    "all": "全部",
    "running": "运行中",
    "paused": "已暂停",
    "error": "异常",
    "expired": "已过期",
    "errorTip": "异常：{{note}}"
  },
  "list": {
    "sourceProject": "项目 · {{name}}",
    "sourceLocal": "本地",
    "empty": "暂无定时任务",
    "emptyAction": "去创建",
    "batchSelected": "已选择 {{count}} 项",
    "selectAll": "全选",
    "delete": "删除",
    "exitBatch": "退出管理",
    "deleteTitle": "删除定时任务",
    "deleteBody": "将删除 {{count}} 个任务及其全部运行记录，此操作不可恢复。",
    "lastRun": "上次 {{time}}"
  },
  "create": {
    "titleCreate": "添加自动化",
    "titleEdit": "编辑自动化",
    "name": "名称",
    "namePlaceholder": "任务别名，如「每日 AI 早报」",
    "prompt": "提示词",
    "promptPlaceholder": "描述这个任务要让 AI 做什么…",
    "insertVariable": "插入变量",
    "varDate": "日期 {{date}}",
    "varWeekday": "星期 {{weekday}}",
    "varTime": "时间 {{time}}",
    "model": "模型",
    "modelPlaceholder": "请选择模型",
    "param": "模型参数",
    "paramPrecise": "精确",
    "paramBalanced": "均衡",
    "paramCreative": "创意",
    "workspace": "工作空间",
    "workspacePlaceholder": "请选择工作空间",
    "missedPolicy": "错过处理",
    "missedSkip": "跳过",
    "missedCatchUp": "补执行一次",
    "fullAccessWarn": "允许完全访问：该任务将跳过工具审批自动执行，请仅添加信任的任务。",
    "templateSource": "来自模版：{{name}}"
  },
  "schedule": {
    "tabPeriodic": "周期",
    "tabInterval": "间隔",
    "kind": "触发频率",
    "kindOnce": "单次",
    "kindDaily": "每天",
    "kindWeekly": "每周",
    "kindBiweekly": "双周",
    "kindMonthly": "每月",
    "kindYearly": "每年",
    "date": "日期",
    "time": "时间",
    "weekdays": "星期",
    "anchorDate": "起始日期",
    "dayOfMonth": "几号",
    "monthDay": "月 / 日",
    "intervalValue": "间隔",
    "unit": "单位",
    "unitMinute": "分钟",
    "unitHour": "小时",
    "intervalWeekdays": "生效星期（可选）",
    "validity": "有效期",
    "validityLongTerm": "长期有效",
    "validityCustom": "自定义时间段",
    "validityStart": "开始日期",
    "validityEnd": "结束日期",
    "summary": "执行频率",
    "summaryIncomplete": "请完善时间配置",
    "longTerm": "长期有效",
    "textOnce": "{{time}} 执行一次",
    "textDaily": "每天 {{time}}",
    "textWeekly": "每 {{weekdays}} {{time}}",
    "textBiweekly": "每两周 {{weekday}} {{time}}",
    "textMonthly": "每月 {{day}} 日 {{time}}",
    "textYearly": "每年 {{month}} 月 {{day}} 日 {{time}}",
    "textInterval": "{{weekdays}}每 {{value}} {{unit}}执行一次",
    "textRange": "{{start}} 至 {{end}}",
    "errTimeInPast": "所选时间必须晚于当前时间",
    "errIntervalTooSmall": "最小间隔为 5 分钟",
    "errIncomplete": "请完善时间配置"
  },
  "template": {
    "marketTitle": "模版市场",
    "back": "返回",
    "use": "使用模版"
  },
  "runs": {
    "empty": "暂无运行记录",
    "colTime": "触发时间",
    "colTask": "任务",
    "colTrigger": "触发方式",
    "colDuration": "耗时",
    "colStatus": "状态",
    "colTokens": "Token 消耗",
    "triggerSchedule": "定时",
    "triggerCatchUp": "补执行",
    "triggerRetry": "重试",
    "statusSuccess": "成功",
    "statusFailed": "失败",
    "statusSkipped": "已跳过",
    "statusRunning": "运行中",
    "attempt": "第 {{n}} 次",
    "tokens": "{{in}} 入 / {{out}} 出",
    "openSession": "查看会话"
  },
  "toast": {
    "created": "任务已创建",
    "updated": "任务已更新",
    "deleted": "已删除 {{count}} 个任务",
    "enabled": "任务已启用",
    "disabled": "任务已暂停",
    "loadFailed": "读取失败：{{message}}"
  },
  "templateData": {
    "dailyAiNews": { "title": "每日 AI 新闻推送", "desc": "关注当天 AI 领域的重要动态，每天早上 9 点生成三分类早报与趋势点评。" },
    "weeklyReport": { "title": "每周工作周报", "desc": "每周一 18:00 汇总本周产出，自动生成四段式周报。" },
    "biweeklyReview": { "title": "双周代码回顾", "desc": "每两周对工作空间做一次亮点与技术债盘点。" },
    "monthlyBilling": { "title": "每月账单汇总", "desc": "每月 1 号汇总上月模型调用费用，输出费用月报与异常预警。" },
    "yearlyReminder": { "title": "跨年回顾提醒", "desc": "每年 12 月 31 日 23:59 生成本年度使用回顾与展望。" },
    "workdirMonitor": { "title": "工作空间巡检", "desc": "工作日每小时检查目录状态：占用 TOP5 与最近变更。" },
    "standupPrep": { "title": "站会准备", "desc": "工作日 9:30 依据昨日产出准备站会三条。" }
  }
}
```

- [ ] **Step 3: en-US 同构翻译（同键英文值）**

en-US/common.json：

```json
"weekday": {
  "1": "Mon",
  "2": "Tue",
  "3": "Wed",
  "4": "Thu",
  "5": "Fri",
  "6": "Sat",
  "7": "Sun"
}
```

en-US/chat.json 的 `automation` 段同结构替换，参考译文：`tabs.tasks = "Scheduled Tasks"`、`tabs.runs = "Run History"`、`toolbar.add = "Add Automation"`、`addCustom = "Custom"`、`addFromTemplate = "From Template"`、`filter.local = "Local ({{count}})"`、`filter.project = "Project ({{count}})"`、`filter.cloud = "Cloud ({{count}})"`、`status.paused = "Paused"`、`status.error = "Error"`、`status.expired = "Expired"`、`list.empty = "No scheduled tasks"`、`create.fullAccessWarn = "Allow full access: this task runs tools without approval. Only add tasks you trust."`、`schedule.summaryIncomplete = "Please complete the schedule"`、`runs.empty = "No run history"`。**其余键按 zh-CN 语义逐条给出英文，不得留空或复用中文。**

- [ ] **Step 4: 验证 JSON 与既有键不冲突**

Run: `node -e "['zh-CN','en-US'].forEach(l=>{const c=require('/Users/hjx/workspace/mirror/src-react/i18n/locales/'+l+'/chat.json');const n=require('/Users/hjx/workspace/mirror/src-react/i18n/locales/'+l+'/common.json');if(c.automation.title!==undefined && typeof c.automation==='object')console.log(l,'ok',Object.keys(c.automation).length,'keys');if(n.weekday)console.log(l,'weekday ok')})"`
Expected: 两语言各输出 automation ok 与 weekday ok，且 `chat.automation.title` 为字符串（无顶层/嵌套重名覆盖）。

- [ ] **Step 5: Commit**

```bash
git add src-react/i18n/locales
git commit -m "feat(automation): automation 全量 i18n 文案(zh-CN/en-US)"
```

---

### Task 12: SchedulePicker 组件

**Files:**
- Create: `src-react/domains/ai/automation/components/SchedulePicker.tsx`

**Interfaces:**
- Consumes: `ScheduleConfig`/`INTERVAL_MIN_MINUTES`（Task 2）、`describeSchedule`/`describeValidity`/`validateSchedule`（Task 9）、`DatePicker`（`@/components/common/DatePicker`，先读其 props 签名）、`useAutomationStore`（Task 10，不消费——tabSwitchCount 组件本地 state）
- Produces: `export interface SchedulePickerProps { value: ScheduleConfig | null; onChange: (cfg: ScheduleConfig | null) => void; validity: { startAt?: string; endAt?: string }; onValidityChange: (v: { startAt?: string; endAt?: string }) => void; }`（受控组件；Task 13 的 CreateTaskDialog 持有状态并读 `validateSchedule` 决定确定按钮）

- [ ] **Step 1: 读参照文件**

Read: `src-react/components/common/DatePicker.tsx`（props 签名）、`src-react/components/common/MonthPicker.tsx`、`src-react/domains/ai/chat/components/ChatInput.tsx`（变量插入菜单的交互参照）。

- [ ] **Step 2: 实现组件**

```tsx
// src-react/domains/ai/automation/components/SchedulePicker.tsx
/**
 * 频率配置(PRD《执行频率》§2.1 三层级):模式 Tab → 联动表单 →
 * 摘要栏。受控组件,校验由父级调 validateSchedule;周期/间隔 Tab
 * 切换次数记 tabSwitchCount 供埋点(父级经 ref 回调获取,见 Props)。
 */
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/common/DatePicker";
import { INTERVAL_MIN_MINUTES, type ScheduleConfig } from "../api/schedule.schema";
import {
  describeSchedule,
  describeValidity,
} from "../lib/schedule-text";

type PeriodicKind =
  | "once"
  | "daily"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "yearly";

const PERIODIC_KINDS: PeriodicKind[] = [
  "once",
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "yearly",
];

const PARAM_PRESETS = [
  { key: "precise", temperature: 0.2 },
  { key: "balanced", temperature: 0.7 },
  { key: "creative", temperature: 1.0 },
] as const;

/** ISO 1-7 → common:weekday.n */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

export interface SchedulePickerProps {
  value: ScheduleConfig | null;
  onChange: (cfg: ScheduleConfig | null) => void;
  validity: { startAt?: string; endAt?: string };
  onValidityChange: (v: { startAt?: string; endAt?: string }) => void;
  /** 埋点:模式切换累计(tab ↔ interval) */
  onModeSwitch?: () => void;
}

export function SchedulePicker({
  value,
  onChange,
  validity,
  onValidityChange,
  onModeSwitch,
}: SchedulePickerProps) {
  const { t } = useTranslation(["chat", "common"]);
  const mode = value?.mode ?? "periodic";
  const kind: PeriodicKind =
    value?.mode === "periodic" ? value.kind : "daily";
  const [intervalValue, setIntervalValue] = useState(30);
  const [intervalUnit, setIntervalUnit] = useState<"minute" | "hour">("minute");
  const [intervalWeekdays, setIntervalWeekdays] = useState<number[]>([]);
  const [runAtDate, setRunAtDate] = useState<string | undefined>();
  const [runAtTime, setRunAtTime] = useState("09:00");
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [anchorDate, setAnchorDate] = useState<string | undefined>();
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [monthDay, setMonthDay] = useState({ month: 12, day: 31 });

  const summary = useMemo(
    () =>
      value
        ? `${describeSchedule(value, t)} · ${describeValidity(validity, t)}`
        : t("chat:automation.schedule.summaryIncomplete"),
    [value, validity, t],
  );

  function switchMode(next: "periodic" | "interval") {
    if (next !== mode) {
      onModeSwitch?.();
    }
    if (next === "interval") {
      setIntervalConfig();
    } else {
      onChange({ mode: "periodic", kind: "daily", time });
    }
  }

  function setIntervalConfig() {
    onChange({
      mode: "interval",
      value: Math.max(intervalValue, INTERVAL_MIN_MINUTES === 5 && intervalUnit === "minute" ? 5 : intervalValue),
      unit: intervalUnit,
      ...(intervalWeekdays.length ? { weekdays: [...intervalWeekdays] } : {}),
    });
  }

  function switchKind(next: PeriodicKind) {
    if (next === "once") {
      onChange({
        mode: "periodic",
        kind: "once",
        runAt: `${runAtDate ?? ""}T${runAtTime}:00.000Z`,
      });
      return;
    }
    if (next === "daily") {
      onChange({ mode: "periodic", kind: "daily", time });
    } else if (next === "weekly") {
      onChange({ mode: "periodic", kind: "weekly", weekdays: [...weekdays], time });
    } else if (next === "biweekly") {
      onChange({
        mode: "periodic",
        kind: "biweekly",
        anchorDate: anchorDate ?? "",
        weekday: weekdays[0] ?? 1,
        time,
      });
    } else if (next === "monthly") {
      onChange({ mode: "periodic", kind: "monthly", dayOfMonth, time });
    } else {
      onChange({
        mode: "periodic",
        kind: "yearly",
        month: monthDay.month,
        day: monthDay.day,
        time,
      });
    }
  }

  /** 当前 kind 变更后的字段回填 */
  function patchCurrent(patch: Partial<Record<string, unknown>>) {
    if (!value) {
      return;
    }
    onChange({ ...value, ...patch } as ScheduleConfig);
  }

  return (
    <div className="rounded-lg border border-border/50 p-3 space-y-3">
      {/* 模式 Tab(自绘两按钮,项目无 Tabs 组件) */}
      <div className="flex gap-1 rounded-md bg-muted p-1 w-fit">
        {(["periodic", "interval"] as const).map((m) => (
          <Button
            key={m}
            type="button"
            size="sm"
            variant={mode === m ? "default" : "ghost"}
            onClick={() => switchMode(m)}
          >
            {t(`chat:automation.schedule.tab${m === "periodic" ? "Periodic" : "Interval"}`)}
          </Button>
        ))}
      </div>

      {mode === "periodic" ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Label className="w-20 shrink-0">{t("chat:automation.schedule.kind")}</Label>
            <Select value={kind} onValueChange={(v) => switchKind(v as PeriodicKind)}>
              <SelectTrigger className="w-40" />
              <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                {PERIODIC_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`chat:automation.schedule.kind${k[0].toUpperCase()}${k.slice(1)}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <KindFields
            kind={kind}
            state={{ runAtDate, runAtTime, time, weekdays, anchorDate, dayOfMonth, monthDay }}
            setState={{
              setRunAtDate: (d) => {
                setRunAtDate(d);
                if (kind === "once" && d) {
                  patchCurrent({ runAt: `${d}T${runAtTime}:00.000Z` });
                }
              },
              setRunAtTime: (tm) => {
                setRunAtTime(tm);
                if (kind === "once" && runAtDate) {
                  patchCurrent({ runAt: `${runAtDate}T${tm}:00.000Z` });
                }
              },
              setTime: (tm) => {
                setTime(tm);
                patchCurrent({ time: tm });
              },
              toggleWeekday: (n) => {
                const next = weekdays.includes(n)
                  ? weekdays.filter((x) => x !== n)
                  : [...weekdays, n];
                setWeekdays(next);
                patchCurrent(
                  kind === "weekly"
                    ? { weekdays: next }
                    : { weekday: next[0] ?? 1 },
                );
              },
              setAnchorDate: (d) => {
                setAnchorDate(d);
                patchCurrent({ anchorDate: d });
              },
              setDayOfMonth: (d) => {
                setDayOfMonth(d);
                patchCurrent({ dayOfMonth: d });
              },
              setMonthDay: (md) => {
                setMonthDay(md);
                patchCurrent({ month: md.month, day: md.day });
              },
            }}
          />
        </div>
      ) : (
        <IntervalFields
          value={intervalValue}
          unit={intervalUnit}
          weekdays={intervalWeekdays}
          onChange={(v, unit) => {
            setIntervalValue(v);
            setIntervalUnit(unit);
            onChange({
              mode: "interval",
              value: v,
              unit,
              ...(intervalWeekdays.length ? { weekdays: [...intervalWeekdays] } : {}),
            });
          }}
          onToggleWeekday={(n) => {
            const next = intervalWeekdays.includes(n)
              ? intervalWeekdays.filter((x) => x !== n)
              : [...intervalWeekdays, n];
            setIntervalWeekdays(next);
            onChange({
              mode: "interval",
              value: intervalValue,
              unit: intervalUnit,
              ...(next.length ? { weekdays: next } : {}),
            });
          }}
        />
      )}

      {/* 有效期 */}
      <ValidityFields validity={validity} onValidityChange={onValidityChange} />

      {/* 摘要栏 */}
      <div className="rounded-md bg-primary-subtle px-3 py-2 text-sm text-foreground">
        <span className="text-muted-foreground">{t("chat:automation.schedule.summary")}：</span>
        {summary}
      </div>
    </div>
  );
}
```

同文件继续写三个子组件（保持单文件内聚，避免碎片文件）：

```tsx
function KindFields({
  kind,
  state,
  setState,
}: {
  kind: PeriodicKind;
  state: {
    runAtDate?: string;
    runAtTime: string;
    time: string;
    weekdays: number[];
    anchorDate?: string;
    dayOfMonth: number;
    monthDay: { month: number; day: number };
  };
  setState: Record<string, (v: never) => void> & {
    setRunAtDate: (d?: string) => void;
    setRunAtTime: (t: string) => void;
    setTime: (t: string) => void;
    toggleWeekday: (n: number) => void;
    setAnchorDate: (d?: string) => void;
    setDayOfMonth: (d: number) => void;
    setMonthDay: (md: { month: number; day: number }) => void;
  };
}) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {kind === "once" && (
        <>
          <DatePicker
            value={state.runAtDate}
            onChange={(d) => setState.setRunAtDate(d)}
          />
          <Input
            type="time"
            className="w-28"
            value={state.runAtTime}
            onChange={(e) => setState.setRunAtTime(e.target.value)}
          />
        </>
      )}
      {(kind === "daily" || kind === "weekly" || kind === "biweekly" || kind === "monthly" || kind === "yearly") && (
        <Input
          type="time"
          aria-label={t("chat:automation.schedule.time")}
          className="w-28"
          value={state.time}
          onChange={(e) => setState.setTime(e.target.value)}
        />
      )}
      {(kind === "weekly" || kind === "biweekly") && (
        <div className="flex gap-1">
          {WEEKDAYS.map((n) => (
            <Button
              key={n}
              type="button"
              size="sm"
              variant={
                (kind === "weekly"
                  ? state.weekdays.includes(n)
                  : state.weekdays[0] === n)
                  ? "default"
                  : "outline"
              }
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              onClick={() => setState.toggleWeekday(n)}
            >
              {t(`common:weekday.${n}`)}
            </Button>
          ))}
        </div>
      )}
      {kind === "biweekly" && (
        <DatePicker
          value={state.anchorDate}
          onChange={(d) => setState.setAnchorDate(d)}
        />
      )}
      {kind === "monthly" && (
        <Input
          type="number"
          min={1}
          max={31}
          className="w-20"
          value={state.dayOfMonth}
          onChange={(e) => setState.setDayOfMonth(Number(e.target.value))}
        />
      )}
      {kind === "yearly" && (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={1}
            max={12}
            className="w-16"
            value={state.monthDay.month}
            onChange={(e) =>
              setState.setMonthDay({
                ...state.monthDay,
                month: Number(e.target.value),
              })
            }
          />
          <span className="text-muted-foreground">/</span>
          <Input
            type="number"
            min={1}
            max={31}
            className="w-16"
            value={state.monthDay.day}
            onChange={(e) =>
              setState.setMonthDay({
                ...state.monthDay,
                day: Number(e.target.value),
              })
            }
          />
        </div>
      )}
    </div>
  );
}

function IntervalFields({
  value,
  unit,
  weekdays,
  onChange,
  onToggleWeekday,
}: {
  value: number;
  unit: "minute" | "hour";
  weekdays: number[];
  onChange: (value: number, unit: "minute" | "hour") => void;
  onToggleWeekday: (n: number) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="w-20 shrink-0">{t("chat:automation.schedule.intervalValue")}</Label>
        <Input
          type="number"
          min={INTERVAL_MIN_MINUTES}
          className="w-24"
          value={value}
          onChange={(e) => onChange(Number(e.target.value) || 1, unit)}
        />
        <Select
          value={unit}
          onValueChange={(v) => onChange(value, v as "minute" | "hour")}
        >
          <SelectTrigger className="w-24" />
          <SelectContent className="border border-border/50 rounded-lg shadow-lg">
            <SelectItem value="minute">{t("chat:automation.schedule.unitMinute")}</SelectItem>
            <SelectItem value="hour">{t("chat:automation.schedule.unitHour")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Label className="w-20 shrink-0">{t("chat:automation.schedule.intervalWeekdays")}</Label>
        <div className="flex gap-1">
          {WEEKDAYS.map((n) => (
            <Button
              key={n}
              type="button"
              size="sm"
              variant={weekdays.includes(n) ? "default" : "outline"}
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              onClick={() => onToggleWeekday(n)}
            >
              {t(`common:weekday.${n}`)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ValidityFields({
  validity,
  onValidityChange,
}: {
  validity: { startAt?: string; endAt?: string };
  onValidityChange: (v: { startAt?: string; endAt?: string }) => void;
}) {
  const { t } = useTranslation(["chat"]);
  /** 显式记录用户选择:自定义模式在起止未选时 validity 为空,
   * 不能由 validity 反推显示值(否则回落长期有效) */
  const [mode, setMode] = useState<"longTerm" | "custom">("longTerm");
  const custom = mode === "custom";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label className="w-20 shrink-0">{t("chat:automation.schedule.validity")}</Label>
      <Select
        value={custom ? "custom" : "longTerm"}
        onValueChange={(v) => {
          setMode(v as "longTerm" | "custom");
          onValidityChange(v === "custom" ? {} : {});
        }}
      >
        <SelectTrigger className="w-36" />
        <SelectContent className="border border-border/50 rounded-lg shadow-lg">
          <SelectItem value="longTerm">
            {t("chat:automation.schedule.validityLongTerm")}
          </SelectItem>
          <SelectItem value="custom">
            {t("chat:automation.schedule.validityCustom")}
          </SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <>
          <DatePicker
            value={validity.startAt?.slice(0, 10)}
            onChange={(d) => onValidityChange({ ...validity, startAt: d })}
          />
          <span className="text-muted-foreground">→</span>
          <DatePicker
            value={validity.endAt?.slice(0, 10)}
            onChange={(d) => onValidityChange({ ...validity, endAt: d })}
          />
        </>
      )}
    </div>
  );
}
```

注意：
- `ValidityFields` 的 `onValueChange` 两个分支都清空 `{}` 是刻意语义：选「长期有效」清空区间；切到「自定义」清空等待用户选起止。custom 的判定由 validity 是否有值驱动，Select 显示值需 `useMemo` 保持一致。
- `DatePicker` 的 props 若与假设（`value?: string; onChange: (date?: string) => void`）不符，以实际签名为准适配（Step 1 已读）。
- `switchKind("once")` 时若 `runAtDate` 未选，产出的 runAt 为空串 → zod 不过 → `validateSchedule` 前父组件 `scheduleSchema.safeParse` 失败 → 确定置灰（`onChange` 允许传出非法中间态，提交前统一校验）。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src-react/domains/ai/automation/components/SchedulePicker.tsx
git commit -m "feat(automation): 频率配置组件(周期/间隔双模式+联动+摘要)"
```

---

### Task 13: CreateTaskDialog 组件

**Files:**
- Create: `src-react/domains/ai/automation/components/CreateTaskDialog.tsx`

**Interfaces:**
- Consumes: `AutomationApi`（Task 4）、`SchedulePicker`（Task 12）、`validateSchedule`（Task 9）、`ModelApi`（`@/domains/ai/api/model.api` 的 `ModelApi.listAll()`，先读签名）、`WorkspaceApi`（`@/domains/ai/api/workspace.api`，先读 `workspace:list` 对应方法名）
- Produces: `export interface CreateTaskDialogProps { open: boolean; onOpenChange: (open: boolean) => void; editTask?: TaskRecord; template?: TemplateRecord; onSaved?: () => void; }`（Task 14/16 依赖；template 预填来自模版市场）

- [ ] **Step 1: 读参照文件**

Read: `src-react/domains/ai/api/model.api.ts`（模型列表方法与 ModelRecord 形状）、`src-react/domains/ai/api/workspace.api.ts`（workspace 列表方法）、`src-react/domains/ai/assistant/components/AssistantDialog.tsx`（Dialog 表单 + React Query 拉数据的既有写法）。

- [ ] **Step 2: 实现**

```tsx
// src-react/domains/ai/automation/components/CreateTaskDialog.tsx
/**
 * 创建/编辑自动化任务 Modal(spec §5):名称/prompt(变量插入)/模型+参数
 * 预设/工作空间/完全访问警示/SchedulePicker。模板与编辑复用同表单,
 * 初始值优先级 editTask > template > 空。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AutomationApi, type TaskRecord, type TemplateRecord } from "../api/automation.api";
import { ModelApi } from "@/domains/ai/api/model.api";
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import { camelSlug } from "../lib/camel-slug";
import { scheduleSchema, type ScheduleConfig } from "../api/schedule.schema";
import { validateSchedule } from "../lib/schedule-text";
import { SchedulePicker } from "./SchedulePicker";

/** lib/camel-slug.ts(本任务一并创建):slug → 小驼峰,映射 i18n templateData 键 */
// export function camelSlug(slug: string): string {
//   return slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
// }

const PARAM_PRESETS = [
  { key: "precise", temperature: 0.2 },
  { key: "balanced", temperature: 0.7 },
  { key: "creative", temperature: 1.0 },
] as const;

export interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTask?: TaskRecord;
  template?: TemplateRecord;
  onSaved?: () => void;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  editTask,
  template,
  onSaved,
}: CreateTaskDialogProps) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const { data: models = [] } = useQuery({
    queryKey: ["models", "all"],
    queryFn: () => ModelApi.listAll(),
    enabled: open,
  });
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
    enabled: open,
  });

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState<number | null>(null);
  const [temperature, setTemperature] = useState(0.7);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [missedPolicy, setMissedPolicy] = useState<"skip" | "catchUpOnce">("skip");
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null);
  const [validity, setValidity] = useState<{ startAt?: string; endAt?: string }>({});
  const [saving, setSaving] = useState(false);
  const switchCountRef = useRef(0);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  /** open 时按 editTask > template 初始化 */
  useEffect(() => {
    if (!open) {
      return;
    }
    switchCountRef.current = 0;
    if (editTask) {
      setName(editTask.name);
      setPrompt(editTask.prompt);
      setModelId(editTask.modelId);
      setTemperature(editTask.temperature ?? 0.7);
      setWorkspaceId(editTask.workspaceId);
      setMissedPolicy(editTask.missedPolicy);
      setSchedule(JSON.parse(editTask.scheduleJson) as ScheduleConfig);
      setValidity({
        startAt: editTask.startAt,
        endAt: editTask.endAt,
      });
      return;
    }
    if (template) {
      setName(t(`chat:automation.templateData.${camelSlug(template.slug)}.title`));
      setPrompt(template.prompt);
      setTemperature(template.temperature);
      setSchedule(JSON.parse(template.scheduleJson) as ScheduleConfig);
    } else {
      setSchedule({ mode: "periodic", kind: "daily", time: "09:00" });
    }
  }, [open, editTask, template, t]);

  /** 工作空间默认模型联动 */
  useEffect(() => {
    if (workspaceId) {
      const ws = workspaces.find((w) => w.id === workspaceId);
      if (ws?.defaultModelId) {
        setModelId((prev) => prev ?? ws.defaultModelId!);
      }
    }
  }, [workspaceId, workspaces]);

  const parsed = scheduleSchema.safeParse(schedule);
  const validation = validateSchedule(
    parsed.success ? schedule : null,
    validity,
    new Date(),
  );
  const canSubmit = Boolean(
    name.trim() && prompt.trim() && modelId && workspaceId &&
      parsed.success && validation === "ok" && !saving,
  );

  async function handleSubmit() {
    if (!canSubmit || !schedule || !modelId || !workspaceId) {
      return;
    }
    setSaving(true);
    try {
      const { describeSchedule, describeValidity } = await import("../lib/schedule-text");
      const params = {
        name: name.trim(),
        prompt,
        workspaceId,
        modelId,
        temperature,
        schedule: schedule as ScheduleConfig,
        scheduleText: `${describeSchedule(schedule, t)} · ${describeValidity(validity, t)}`,
        startAt: validity.startAt ? new Date(validity.startAt).toISOString() : undefined,
        endAt: validity.endAt ? new Date(validity.endAt).toISOString() : undefined,
        missedPolicy,
        templateSlug: template?.slug,
      };
      const saved = editTask
        ? await AutomationApi.update(editTask.id, params)
        : await AutomationApi.create(params);
      if (!editTask) {
        void AutomationApi.stat({
          mode: schedule.mode,
          kind: schedule.mode === "periodic" ? schedule.kind : "interval",
          hasEndAt: Boolean(validity.endAt),
          tabSwitchCount: switchCountRef.current,
        });
      }
      toast.success(t(editTask ? "chat:automation.toast.updated" : "chat:automation.toast.created"));
      await queryClient.invalidateQueries({ queryKey: ["automation", "tasks"] });
      onSaved?.();
      onOpenChange(false);
      void saved;
    } catch (e) {
      toast.error(t("chat:automation.toast.loadFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(false);
    }
  }

  /** 变量插入到光标处 */
  function insertVariable(token: string) {
    const el = promptRef.current;
    if (!el) {
      setPrompt((p) => p + token);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    setPrompt(`${prompt.slice(0, start)}${token}${prompt.slice(end)}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto border border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>
            {t(editTask ? "chat:automation.create.titleEdit" : "chat:automation.create.titleCreate")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("chat:automation.create.name")}</Label>
            <Input
              value={name}
              placeholder={t("chat:automation.create.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>{t("chat:automation.create.prompt")}</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 hover:bg-primary-subtle hover:text-primary">
                    {t("chat:automation.create.insertVariable")}
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="border border-border/50 rounded-lg shadow-lg">
                  {(["Date", "Weekday", "Time"] as const).map((v) => (
                    <DropdownMenuItem key={v} onClick={() => insertVariable(`{{${v.toLowerCase()}}}`)}>
                      {t(`chat:automation.create.var${v}`, { [v.toLowerCase()]: `{{${v.toLowerCase()}}}` })}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Textarea
              ref={promptRef}
              rows={5}
              value={prompt}
              placeholder={t("chat:automation.create.promptPlaceholder")}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("chat:automation.create.workspace")}</Label>
              <Select
                value={workspaceId ? String(workspaceId) : undefined}
                onValueChange={(v) => setWorkspaceId(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("chat:automation.create.workspacePlaceholder")} />
                </SelectTrigger>
                <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("chat:automation.create.model")}</Label>
              <Select
                value={modelId ? String(modelId) : undefined}
                onValueChange={(v) => setModelId(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("chat:automation.create.modelPlaceholder")} />
                </SelectTrigger>
                <SelectContent className="border border-border/50 rounded-lg shadow-lg max-h-48">
                  {models.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.name || m.modelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Label className="w-20 shrink-0">{t("chat:automation.create.param")}</Label>
            <div className="flex gap-1">
              {PARAM_PRESETS.map((p) => (
                <Button
                  key={p.key}
                  type="button"
                  size="sm"
                  variant={temperature === p.temperature ? "default" : "outline"}
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  onClick={() => setTemperature(p.temperature)}
                >
                  {t(`chat:automation.create.param${p.key[0].toUpperCase()}${p.key.slice(1)}`)}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Label className="w-20 shrink-0">{t("chat:automation.create.missedPolicy")}</Label>
            <div className="flex gap-1">
              {(["skip", "catchUpOnce"] as const).map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={missedPolicy === p ? "default" : "outline"}
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  onClick={() => setMissedPolicy(p)}
                >
                  {t(p === "skip" ? "chat:automation.create.missedSkip" : "chat:automation.create.missedCatchUp")}
                </Button>
              ))}
            </div>
          </div>

          <SchedulePicker
            value={schedule}
            onChange={setSchedule}
            validity={validity}
            onValidityChange={setValidity}
            onModeSwitch={() => {
              switchCountRef.current += 1;
            }}
          />

          {validation !== "ok" && (
            <p className="text-sm text-red-500">
              {t(`chat:automation.schedule.err${validation[0].toUpperCase()}${validation.slice(1)}`)}
            </p>
          )}

          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 p-2 text-sm text-red-600 dark:text-red-400">
            <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
            {t("chat:automation.create.fullAccessWarn")}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={handleSubmit}>
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

注意：
- `ModelApi.listAll()` / `WorkspaceApi.list()` 已核对真实签名（model.api.ts:58 / workspace.api.ts:32），ModelRecord 有 `name?`（显示名兜底 `m.name || m.modelId`）、WorkspaceRecord 有 `defaultModelId?`。
- 红色警示是 PRD 明确的语义色（危险提示），不受主题色规范约束，与 `AlertDialog` destructive 语义一致。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src-react/domains/ai/automation/components/CreateTaskDialog.tsx
git commit -m "feat(automation): 创建/编辑任务弹窗(模板预填+变量插入+校验)"
```

---

### Task 14: TaskListView（列表 + 筛选 + 批量管理 + 空状态）

**Files:**
- Create: `src-react/domains/ai/automation/components/FilterMenu.tsx`
- Create: `src-react/domains/ai/automation/components/TaskRow.tsx`
- Create: `src-react/domains/ai/automation/views/TaskListView.tsx`

**Interfaces:**
- Consumes: `useAutomationStore`/`filterTasks`（Task 10）、`AutomationApi`（Task 4）、`CreateTaskDialog`（Task 13）、i18n（Task 11）
- Produces: `export default function TaskListView()`（AutomationView 直接渲染；内部消费 React Query `["automation","tasks"]`——**query 定义在 AutomationView（Task 17）并经 props 传入 `tasks`**，TaskListView 不自建查询，接口：`{ tasks: TaskRecord[]; isLoading: boolean }`）

- [ ] **Step 1: FilterMenu.tsx**

```tsx
// src-react/domains/ai/automation/components/FilterMenu.tsx
/** 漏斗筛选:全部/本地/项目/云端,选中项对勾 + 分类计数(spec §5) */
import { useTranslation } from "react-i18next";
import { Check, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAutomationStore, type SourceFilter } from "../store/automation.store";
import type { TaskRecord } from "../api/automation.api";

const SOURCES: SourceFilter[] = ["all", "local", "project", "cloud"];

export function FilterMenu({ tasks }: { tasks: TaskRecord[] }) {
  const { t } = useTranslation(["chat"]);
  const { sourceFilter, setSourceFilter } = useAutomationStore();
  const counts = {
    all: tasks.length,
    local: tasks.filter((x) => x.source === "local").length,
    project: tasks.filter((x) => x.source === "project").length,
    cloud: 0,
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("chat:automation.filter.all", { count: counts.all })}>
          <Filter className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 border border-border/50 rounded-lg shadow-lg">
        {SOURCES.map((s) => (
          <DropdownMenuItem key={s} onClick={() => setSourceFilter(s)} className="justify-between">
            {t(`chat:automation.filter.${s}`, { count: counts[s] })}
            {sourceFilter === s && <Check className="h-4 w-4 text-emerald-500" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: TaskRow.tsx**

```tsx
// src-react/domains/ai/automation/components/TaskRow.tsx
/** 单行任务:名称/归属/scheduleText/启停开关/状态;行主体点击进编辑 */
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { AutomationApi, type TaskRecord } from "../api/automation.api";
import { useAutomationStore } from "../store/automation.store";

export function TaskRow({
  task,
  onClick,
}: {
  task: TaskRecord;
  onClick: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const { batchMode, selectedIds, toggleSelected } = useAutomationStore();
  async function handleToggle(next: boolean) {
    try {
      await AutomationApi.toggle(task.id, next);
      toast.success(t(next ? "chat:automation.toast.enabled" : "chat:automation.toast.disabled"));
    } catch (e) {
      toast.error(t("chat:automation.toast.loadFailed", { message: e instanceof Error ? e.message : String(e) }));
    }
  }
  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer hover:bg-primary-subtle"
      onClick={onClick}
    >
      {batchMode && (
        <Checkbox
          checked={selectedIds.includes(task.id)}
          onCheckedChange={() => toggleSelected(task.id)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{task.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {task.source === "project"
            ? t("chat:automation.list.sourceProject", { name: task.workspaceName })
            : t("chat:automation.list.sourceLocal")}
          {" · "}
          {task.scheduleText}
        </p>
      </div>
      {task.status === "error" && (
        <Badge variant="destructive" title={t("chat:automation.status.errorTip", { note: task.statusNote ?? "" })}>
          {t("chat:automation.status.error")}
        </Badge>
      )}
      {task.status === "expired" && (
        <Badge variant="secondary">{t("chat:automation.status.expired")}</Badge>
      )}
      <span className="text-xs text-muted-foreground">
        {task.enabled ? t("chat:automation.status.running") : t("chat:automation.status.paused")}
      </span>
      <Switch
        checked={task.enabled}
        onCheckedChange={handleToggle}
        onClick={(e) => e.stopPropagation()}
        disabled={task.status === "expired"}
      />
    </div>
  );
}
```

- [ ] **Step 3: TaskListView.tsx**

```tsx
// src-react/domains/ai/automation/views/TaskListView.tsx
/** 任务列表:状态 pill + 行列表 + 批量管理工具栏变体 + 空状态 */
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AutomationApi, type TaskRecord, type TemplateRecord } from "../api/automation.api";
import { filterTasks, useAutomationStore, type StatusFilter } from "../store/automation.store";
import { TaskRow } from "../components/TaskRow";

const STATUS: StatusFilter[] = ["all", "running", "paused", "error", "expired"];

export default function TaskListView({
  tasks,
  isLoading,
}: {
  tasks: TaskRecord[];
  isLoading: boolean;
}) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const {
    sourceFilter,
    statusFilter,
    setStatusFilter,
    search,
    batchMode,
    selectedIds,
    enterBatchMode,
    exitBatchMode,
    selectAll,
  } = useAutomationStore();
  const [editing, setEditing] = useState<TaskRecord | undefined>();
  const [template, setTemplate] = useState<TemplateRecord | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const deferredSearch = useDeferredValue(search);
  const visible = filterTasks(tasks, sourceFilter, statusFilter, deferredSearch);

  async function handleDelete() {
    setDeleting(true);
    try {
      await AutomationApi.remove(selectedIds);
      toast.success(t("chat:automation.toast.deleted", { count: selectedIds.length }));
      exitBatchMode();
      await queryClient.invalidateQueries({ queryKey: ["automation", "tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["automation", "runs"] });
    } catch (e) {
      toast.error(t("chat:automation.toast.loadFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  }

  if (!isLoading && tasks.length === 0) {
    return (
      <>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <CalendarClock className="h-12 w-12 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">{t("chat:automation.list.empty")}</p>
          <Button onClick={() => { setTemplate(undefined); setDialogOpen(true); }}>
            {t("chat:automation.list.emptyAction")}
          </Button>
        </div>
        <CreateTaskDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editTask={editing}
          template={template}
        />
      </>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
      {/* 状态过滤 pill 行(或批量管理工具栏变体) */}
      {batchMode ? (
        <div className="flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2">
          <Checkbox
            checked={selectedIds.length === visible.length && visible.length > 0}
            onCheckedChange={() => selectAll(visible.map((x) => x.id))}
            aria-label={t("chat:automation.list.selectAll")}
          />
          <Button variant="destructive" size="sm" disabled={!selectedIds.length} onClick={() => setConfirmOpen(true)}>
            <Trash2 className="h-4 w-4 mr-1" />
            {t("chat:automation.list.delete")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("chat:automation.list.batchSelected", { count: selectedIds.length })}
          </span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={exitBatchMode}>
            {t("chat:automation.list.exitBatch")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          {STATUS.map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "secondary" : "ghost"}
              size="sm"
              className="rounded-full"
              onClick={() => setStatusFilter(s)}
            >
              {t(`chat:automation.status.${s}`)}
            </Button>
          ))}
        </div>
      )}

      {!isLoading && visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t("chat:automation.list.empty")}
        </p>
      ) : (
        visible.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onClick={() => { setEditing(task); setDialogOpen(true); }}
          />
        ))
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat:automation.list.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:automation.list.deleteBody", { count: selectedIds.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={handleDelete}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

注意：主 return 末尾（AlertDialog 之后）同样渲染一份 `<CreateTaskDialog open={dialogOpen} onOpenChange={setDialogOpen} editTask={editing} template={template} />`，两个分支共享同一实例（顶部 `import { CreateTaskDialog } from "../components/CreateTaskDialog"`）。

- [ ] **Step 4: 类型检查 + Commit**

Run: `npm run typecheck`
Expected: 通过。

```bash
git add src-react/domains/ai/automation/components/FilterMenu.tsx src-react/domains/ai/automation/components/TaskRow.tsx src-react/domains/ai/automation/views/TaskListView.tsx
git commit -m "feat(automation): 任务列表视图(筛选菜单/行组件/批量管理/空状态)"
```

---

### Task 15: RunHistoryView

**Files:**
- Create: `src-react/domains/ai/automation/views/RunHistoryView.tsx`

**Interfaces:**
- Consumes: `AutomationApi.runs`（Task 4）、`useAutomationStore`（Task 10）
- Produces: `export default function RunHistoryView()`（内部自建 React Query `["automation","runs", page]`，AutomationView 收到 `automation:tasks-changed` 时 invalidate 前缀）

- [ ] **Step 1: 实现**

```tsx
// src-react/domains/ai/automation/views/RunHistoryView.tsx
/** 运行记录:分页 20/页;行点击跳转聊天会话(复用 ?session= 选中机制) */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AutomationApi } from "../api/automation.api";

function formatDuration(ms?: number): string {
  if (ms === undefined) {
    return "-";
  }
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function RunHistoryView() {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ["automation", "runs", page],
    queryFn: () => AutomationApi.runs(page),
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  if (!isLoading && total === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <History className="h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{t("chat:automation.runs.empty")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
            <tr className="border-b border-border/50">
              <th className="px-4 py-2 font-medium">{t("chat:automation.runs.colTime")}</th>
              <th className="px-4 py-2 font-medium">{t("chat:automation.runs.colTask")}</th>
              <th className="px-4 py-2 font-medium">{t("chat:automation.runs.colTrigger")}</th>
              <th className="px-4 py-2 font-medium">{t("chat:automation.runs.colDuration")}</th>
              <th className="px-4 py-2 font-medium">{t("chat:automation.runs.colStatus")}</th>
              <th className="px-4 py-2 font-medium">{t("chat:automation.runs.colTokens")}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((run) => (
              <tr
                key={run.id}
                className={`border-b border-border/30 ${run.sessionId ? "cursor-pointer hover:bg-primary-subtle" : ""}`}
                onClick={() => run.sessionId && navigate(`/module/ai?session=${run.sessionId}`)}
              >
                <td className="px-4 py-2 text-muted-foreground">{formatDateTime(run.startedAt)}</td>
                <td className="px-4 py-2">
                  {run.taskName}
                  {run.attempt > 1 && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {t("chat:automation.runs.attempt", { n: run.attempt })}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">{t(`chat:automation.runs.trigger${run.triggerType[0].toUpperCase()}${run.triggerType.slice(1)}`)}</td>
                <td className="px-4 py-2">{formatDuration(run.durationMs)}</td>
                <td className="px-4 py-2">
                  {run.status === "success" && <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-0">{t("chat:automation.runs.statusSuccess")}</Badge>}
                  {run.status === "failed" && <Badge variant="destructive" title={run.error}>{t("chat:automation.runs.statusFailed")}</Badge>}
                  {run.status === "skipped" && <Badge variant="secondary">{t("chat:automation.runs.statusSkipped")}</Badge>}
                  {run.status === "running" && <Badge variant="outline">{t("chat:automation.runs.statusRunning")}</Badge>}
                </td>
                <td className="px-4 py-2 text-muted-foreground">
                  {run.promptTokens !== undefined
                    ? t("chat:automation.runs.tokens", { in: run.promptTokens, out: run.completionTokens ?? 0 })
                    : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/50 px-4 py-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground">{page} / {totalPages}</span>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
```

注：`run.triggerType` 的首字母大写映射 `triggerSchedule/triggerCatchUp/triggerRetry` 键；成功态 Badge 用 emerald 语义色（状态语义色允许，同 destructive 先例）。

- [ ] **Step 2: 类型检查 + Commit**

Run: `npm run typecheck`
Expected: 通过。

```bash
git add src-react/domains/ai/automation/views/RunHistoryView.tsx
git commit -m "feat(automation): 运行记录视图(分页/状态/Token/跳转会话)"
```

---

### Task 16: TemplateMarketView

**Files:**
- Create: `src-react/domains/ai/automation/views/TemplateMarketView.tsx`

**Interfaces:**
- Consumes: `AutomationApi.templates`（Task 4）、`CreateTaskDialog`（Task 13）、i18n templateData（Task 11）
- Produces: `export default function TemplateMarketView()`（视图内自建 query `["automation","templates"]`）

- [ ] **Step 1: 实现**

```tsx
// src-react/domains/ai/automation/views/TemplateMarketView.tsx
/** 模版市场:双列卡片,点击复用模板进 CreateTaskDialog(spec §5) */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import * as Icons from "lucide-react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AutomationApi, type TemplateRecord } from "../api/automation.api";
import { camelSlug } from "../lib/camel-slug";
import { CreateTaskDialog } from "../components/CreateTaskDialog";
import { useAutomationStore } from "../store/automation.store";

function TemplateIcon({ name }: { name: string }) {
  const Icon = (Icons as unknown as Record<string, Icons.LucideIcon>)[name] ?? Icons.Sparkles;
  return <Icon className="h-6 w-6 text-primary" />;
}

export default function TemplateMarketView() {
  const { t } = useTranslation(["chat"]);
  const setView = useAutomationStore((s) => s.setView);
  const [selected, setSelected] = useState<TemplateRecord | undefined>();
  const { data: templates = [] } = useQuery({
    queryKey: ["automation", "templates"],
    queryFn: () => AutomationApi.templates(),
  });

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <Button variant="ghost" size="icon" onClick={() => setView("list")} aria-label={t("chat:automation.template.back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-sm font-medium">{t("chat:automation.template.marketTitle")}</h2>
      </div>
      <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-4 pt-0">
        {templates.map((tpl) => (
          <button
            key={tpl.slug}
            type="button"
            className="flex flex-col items-start gap-2 rounded-lg border border-border/50 p-4 text-left shadow-sm transition-colors hover:bg-primary-subtle hover:border-primary/30"
            onClick={() => setSelected(tpl)}
          >
            <TemplateIcon name={tpl.icon} />
            <p className="text-sm font-medium text-foreground">
              {t(`chat:automation.templateData.${camelSlug(tpl.slug)}.title`)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(`chat:automation.templateData.${camelSlug(tpl.slug)}.desc`)}
            </p>
          </button>
        ))}
      </div>
      <CreateTaskDialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(undefined)}
        template={selected}
      />
    </div>
  );
}
```

注：`camelSlug` 来自 Task 13 创建的 `lib/camel-slug.ts`（避免 market → dialog → market 循环引用）。

- [ ] **Step 2: 类型检查 + Commit**

Run: `npm run typecheck`
Expected: 通过。

```bash
git add src-react/domains/ai/automation/views/TemplateMarketView.tsx src-react/domains/ai/automation/lib/camel-slug.ts
git commit -m "feat(automation): 模版市场双列卡片视图"
```

---

### Task 17: AutomationView 壳整合（重写占位页）

**Files:**
- Modify: `src-react/domains/ai/automation/views/AutomationView.tsx`（整体重写）
- Create: `src-react/domains/ai/automation/lib/use-automation-tasks.ts`（query + 事件失效 hook）

**Interfaces:**
- Consumes: 全部前序前端产物；`on`（`@/lib/ipc`）、`AUTOMATION_CHANGED_EVENT`（Task 4）

- [ ] **Step 1: use-automation-tasks.ts**

```ts
// src-react/domains/ai/automation/lib/use-automation-tasks.ts
/** 任务列表 query + 主进程 automation:tasks-changed 事件失效(spec §5) */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { on } from "@/lib/ipc";
import { AutomationApi, AUTOMATION_CHANGED_EVENT } from "../api/automation.api";

export function useAutomationTasks() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["automation", "tasks"],
    queryFn: () => AutomationApi.list(),
  });
  useEffect(() => {
    return on(AUTOMATION_CHANGED_EVENT, () => {
      void queryClient.invalidateQueries({ queryKey: ["automation"] });
    });
  }, [queryClient]);
  return query;
}
```

- [ ] **Step 2: 重写 AutomationView.tsx**

```tsx
// src-react/domains/ai/automation/views/AutomationView.tsx
/**
 * 自动化壳(spec §5):Tab(定时任务/运行记录) + 工具栏(漏斗/搜索/
 * 刷新/批量管理/添加下拉) + 视图切换(list|market)。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, PlusCircle, RefreshCw, SquarePen, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAutomationStore } from "../store/automation.store";
import { useAutomationTasks } from "../lib/use-automation-tasks";
import { FilterMenu } from "../components/FilterMenu";
import { CreateTaskDialog } from "../components/CreateTaskDialog";
import TaskListView from "./TaskListView";
import RunHistoryView from "./RunHistoryView";
import TemplateMarketView from "./TemplateMarketView";

export default function AutomationView() {
  const { t } = useTranslation(["chat"]);
  const {
    tab,
    setTab,
    view,
    setView,
    search,
    setSearch,
    batchMode,
    enterBatchMode,
  } = useAutomationStore();
  const { data: tasks = [], isLoading, refetch, isFetching } = useAutomationTasks();
  const [createOpen, setCreateOpen] = useState(false);

  if (view === "market") {
    return <TemplateMarketView />;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab 行 + 全局操作区 */}
      <div className="flex items-center gap-1 border-b border-border/50 px-4 pt-3">
        {(["tasks", "runs"] as const).map((x) => (
          <Button
            key={x}
            variant="ghost"
            className={`rounded-none border-b-2 ${tab === x ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
            onClick={() => setTab(x)}
          >
            {t(`chat:automation.tabs.${x}`)}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-1 pb-2">
          {tab === "tasks" && (
            <>
              <FilterMenu tasks={tasks} />
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-8 w-44 pl-7 pr-7"
                  placeholder={t("chat:automation.toolbar.searchPlaceholder")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setSearch("")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </>
          )}
          <Button variant="ghost" size="icon" aria-label={t("chat:automation.toolbar.refresh")} onClick={() => void refetch()}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          {tab === "tasks" && !batchMode && (
            <Button variant="outline" size="sm" className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30" onClick={enterBatchMode}>
              <SquarePen className="h-4 w-4 mr-1" />
              {t("chat:automation.toolbar.batchManage")}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" />
                {t("chat:automation.toolbar.add")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border border-border/50 rounded-lg shadow-lg">
              <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                <PlusCircle className="h-4 w-4 mr-2" />
                {t("chat:automation.toolbar.addCustom")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setView("market")}>
                <SquarePen className="h-4 w-4 mr-2" />
                {t("chat:automation.toolbar.addFromTemplate")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {tab === "tasks" ? (
        <TaskListView tasks={tasks} isLoading={isLoading} />
      ) : (
        <RunHistoryView />
      )}

      <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
```

注：搜索防抖按 spec 300ms——输入框直写 store、`TaskListView` 的 `filterTasks` 用 `useDeferredValue(search)` 包裹即可（React 19 自带），无需手写 timer。

- [ ] **Step 3: 手动冒烟（dev 启动）**

Run: `npm run dev`（用户侧启动；或按 run skill）
验证点：
1. `/module/ai/automation` 页渲染 Tab + 工具栏，无任务时空状态；
2. 「添加自动化 → 自定义创建」建一个 1 分钟后触发的 once 任务，确定后列表出现；
3. 等待触发（tick ≤30s + nextRunAt），运行记录 Tab 出现一条 success/failed，聊天页能看到新会话与消息；
4. 「从模版添加」进入市场，点卡片弹预填表单；
5. 批量管理勾选删除走二次确认；筛选/搜索/状态 pill 生效；启停 Switch 生效。

- [ ] **Step 4: Commit**

```bash
git add src-react/domains/ai/automation
git commit -m "feat(automation): 自动化壳视图整合(Tab/工具栏/视图切换)"
```

---

### Task 18: 收尾验证

**Files:** 无新增（验证 + 文档微调）

- [ ] **Step 1: 全量检查**

Run: `npm run lint && npm run typecheck && npx vitest run`
Expected: 三项全绿；automation 相关测试共 8 个文件全部 PASS。

- [ ] **Step 2: 对照 spec 逐节核对**

打开 `docs/superpowers/specs/2026-09-06-ai-automation-module-design.md`，逐节（§0 决策表 / §2 数据模型 / §3 调度 / §4 决策树与执行 / §5 视图 / §6 IPC / §7 异常 / §8 测试）核对实现；发现偏差：小偏差修代码，语义偏差记录到计划末尾「执行备注」并向用户说明。

- [ ] **Step 3: 清理与提交**

确认无 console.log 残留（lint 已拦）；`git status` 干净。

```bash
git add -A
git commit -m "chore(automation): 收尾核对与清理"
```

---

## 执行备注（执行中追加）

- （执行者按 Task 18 Step 2 追加）
