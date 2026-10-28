# 安全中心 SP1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立安全中心的配置基座（option 表 14 项安全配置 + 内置清单常量）与审计链（v9 `securityAuditLog` 表 + 哈希链），并在设置面板交付安全中心首页（沙箱安全/数据安全/审计中心三卡片）。

**Architecture:** 后端新域 `electron/domains/security/`（SecurityService 内存缓存读写 + AuditLogService 异步缓冲哈希链落库），配置存 `option` 表 type=`"security"`（read-time fallback，不播种），审计存 v9 新表。前端新域 `src-react/domains/security/`，入口挂 `SettingsDialog` 新 `security` tab。现有命令拦截/审批决议通过注入回调接入审计（保持模块纯函数可测）。

**Tech Stack:** Electron 44 主进程 + Prisma 7/better-sqlite3 + React 19 + i18next + Vitest。

**Spec:** `docs/superpowers/specs/2026-09-15-security-center-sp1-design.md`（本计划从 spec 出发，执行者须先读 spec）

## Global Constraints

- 遵循仓库 CLAUDE.md 全部规范：文件名 kebab-case；Prettier 双引号、分号、tabWidth=2、printWidth=80、无尾随逗号；生产代码禁 `console`/`debugger`（主进程日志用 `electron/commons/Log`，即 winston）；函数不超过 20 行；用户可见文本一律 `t()`，禁止硬编码。
- i18n：`zh-CN` 与 `en-US` 两个 locale 文件**同步**添加 key；新 namespace `security` 需在 `src-react/i18n/index.ts` 登记；禁止顶层 key 与嵌套对象 key 重名。
- 新 IPC 通道三处登记：`ipcMain.handle`（主进程服务）+ `src-react/lib/ipc.ts` 的 `IPCChannel` 联合类型 + 前端 api 类。
- 颜色只用主题变量（`bg-primary-subtle` 等），禁止 `bg-blue-*` 等硬编码色。
- 测试命令：`npm run test`（Vitest）；类型检查 `npm run typecheck`。
- 每个任务完成即 commit，conventional commit 中文描述（照 `git log` 现有风格），不加 Co-Authored-By footer。
- 主进程 prisma 单例：`import prisma from "../../commons/prisma-client"`（相对路径按文件层级调整）。
- spec 偏差注记（计划期决策）：① 审计事件不区分"允许并记住"（toolPermission 表已是事实源）；② 退出 flush 钩子用 `app.on("quit")`（Application.ts 惯例）而非 will-quit；③ macOS 钥匙串路径用规范大小写 `~/Library/Keychains/`。

---

### Task 1: 数据库 v9 迁移（securityAuditLog 表）

**Files:**
- Create: `electron/infrastructure/script/v8` 同级新建 `electron/infrastructure/script/v9/upgrade-table.sql`
- Modify: `prisma/schema.prisma`（文件末尾追加 model）
- Modify: `electron/Constants.ts:11`

**Interfaces:**
- Consumes: 无
- Produces: prisma model `securityAuditLog`（delegate 名 `prisma.securityAuditLog`，Task 5/6 依赖）

- [ ] **Step 1: 写迁移脚本**

`electron/infrastructure/script/v9/upgrade-table.sql`：

```sql
--/p 安全审计日志表（安全中心 SP1）：哈希链防篡改，sequence 唯一标识链序
CREATE TABLE securityAuditLog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence INTEGER NOT NULL,
  category TEXT NOT NULL,
  eventType TEXT NOT NULL,
  decision TEXT NOT NULL,
  detail TEXT,
  commandPreview TEXT,
  commandHash TEXT,
  sessionId INTEGER,
  prevHash TEXT,
  hash TEXT NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_audit_sequence ON securityAuditLog (sequence);
CREATE INDEX idx_audit_createdAt ON securityAuditLog (createdAt);
CREATE INDEX idx_audit_category ON securityAuditLog (category);
```

- [ ] **Step 2: schema.prisma 末尾追加 model**（与 SQL 列一致）

```prisma
model securityAuditLog {
  id             Int      @id @default(autoincrement())
  sequence       Int      @unique(map: "idx_audit_sequence")
  category       String
  eventType      String
  decision       String
  detail         String?
  commandPreview String?
  commandHash    String?
  sessionId      Int?
  prevHash       String?
  hash           String
  createdAt      DateTime @default(now())

  @@index([createdAt], map: "idx_audit_createdAt")
  @@index([category], map: "idx_audit_category")
}
```

- [ ] **Step 3: 版本号**

`electron/Constants.ts` 的 `DATABASE_VERSION: number = 8` 改为 `9`。

- [ ] **Step 4: 生成客户端并验证**

Run: `npx prisma generate && npm run typecheck`
Expected: 两者均无错误（说明 schema 与生成客户端一致）。

- [ ] **Step 5: Commit**

```bash
git add electron/infrastructure/script/v9 prisma/schema.prisma electron/Constants.ts
git commit -m "feat(安全中心): v9 迁移——securityAuditLog 审计表（哈希链字段 + 三索引）"
```

---

### Task 2: 哈希链纯函数（hash-chain）

**Files:**
- Create: `electron/domains/security/audit/hash-chain.ts`
- Test: `tests/security/hash-chain.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，`node:crypto`）
- Produces（Task 5 依赖，签名逐字）:
  - `stableStringify(value: unknown): string`
  - `computeEntryHash(entry: Record<string, unknown>, prevHash: string | null): string`
  - `verifyChain(entries: Array<Record<string, unknown> & { prevHash: string | null; hash: string }>): boolean`

- [ ] **Step 1: 写失败测试**

`tests/security/hash-chain.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  stableStringify,
  computeEntryHash,
  verifyChain,
} from "../../electron/domains/security/audit/hash-chain";

describe("stableStringify", () => {
  it("对象 key 顺序无关，结果稳定", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it("剔除 undefined 值", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it("嵌套对象递归排序", () => {
    expect(stableStringify({ x: { b: 1, a: 2 } }, )).toBe('{"x":{"a":2,"b":1}}');
  });
});

describe("computeEntryHash", () => {
  it("同一 prevHash + 同内容 → 同 hash", () => {
    const e = { sequence: 1, category: "config", hash: "旧值应被忽略" };
    expect(computeEntryHash(e, null)).toBe(
      computeEntryHash({ ...e, hash: "另一个旧值" }, null)
    );
  });
  it("prevHash 不同 → hash 不同（链式依赖）", () => {
    const e = { sequence: 1, eventType: "audit.cleared" };
    expect(computeEntryHash(e, null)).not.toBe(computeEntryHash(e, "abc"));
  });
});

describe("verifyChain", () => {
  const mk = (seq: number, prevHash: string | null, e: Record<string, unknown> = {}) => {
    const entry = { sequence: seq, category: "config", ...e, prevHash };
    return { ...entry, hash: computeEntryHash(entry, prevHash) };
  };
  it("合法链返回 true", () => {
    const e1 = mk(1, null);
    const e2 = mk(2, e1.hash);
    expect(verifyChain([e1, e2])).toBe(true);
  });
  it("断链（prevHash 不接续）返回 false", () => {
    const e1 = mk(1, null);
    const e3 = mk(3, "伪造hash");
    expect(verifyChain([e1, e3])).toBe(false);
  });
  it("被篡改内容（hash 与重算不符）返回 false", () => {
    const e1 = mk(1, null);
    const tampered = { ...e1, eventType: "被改了" };
    expect(verifyChain([tampered])).toBe(false);
  });
});
```

注意：测试里 `stableStringify({ x: { b: 1, a: 2 } }, )` 的尾随逗号是笔误示范——实际写入时去掉（Prettier 无尾随逗号）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/security/hash-chain.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`electron/domains/security/audit/hash-chain.ts`：

```ts
/**
 * 审计日志哈希链（SP1 spec §6.3）：每条 entry 的 hash 覆盖自身规范化
 * 内容与前条 hash，事后删改任一环节都会导致链校验失败。
 * 纯函数 + node:crypto，可被 vitest 直接测试。
 */
import { createHash } from "node:crypto";

/** 规范化 JSON：对象 key 递归排序、undefined 值剔除 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

/** 条目 hash：sha256(prevHash + 规范化内容)；entry 自身的 hash 字段不参与 */
export function computeEntryHash(
  entry: Record<string, unknown>,
  prevHash: string | null,
): string {
  const { hash: _omit, ...rest } = entry;
  return createHash("sha256")
    .update(prevHash ?? "")
    .update(stableStringify(rest))
    .digest("hex");
}

/** 链完整性校验：逐条重算 hash 并比对 prevHash 接续（entries 须按链序传入） */
export function verifyChain(
  entries: Array<Record<string, unknown> & { prevHash: string | null; hash: string }>,
): boolean {
  let prev: string | null = null;
  for (const entry of entries) {
    if (entry.prevHash !== prev) return false;
    if (computeEntryHash(entry, prev) !== entry.hash) return false;
    prev = entry.hash;
  }
  return true;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/security/hash-chain.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/audit/hash-chain.ts tests/security/hash-chain.test.ts
git commit -m "feat(安全中心): 审计哈希链纯函数——stableStringify/computeEntryHash/verifyChain"
```

---

### Task 3: 共享类型 + 默认值 + 配置存取纯函数层

**Files:**
- Create: `src-react/domains/security/model/types.ts`
- Create: `electron/domains/security/defaults.ts`
- Create: `electron/domains/security/config-store.ts`
- Test: `tests/security/config-store.test.ts`

**Interfaces:**
- Consumes: `parseBoolOption`（`electron/domains/app-settings/option-store.ts` 已有，直接 import）
- Produces（Task 4/5/8/9 依赖，签名逐字）:
  - types.ts：`CmdRule`、`SecurityConfig`、`SecurityConfigKey`、`SecurityConfigState`、`AuditCategory`、`AuditDecision`、`AuditEntry`、`AuditListResult`、`AuditListParams`、`SecurityEvent`、`SecurityEventSink`
  - defaults.ts：`SECURITY_DEFAULTS: SecurityConfig`、`defaultFileBlocklist(platform: NodeJS.Platform): string[]`
  - config-store.ts：`SECURITY_OPTION_TYPE`、`SecurityOptionPrismaLike`、`listSecurityOptions(db)`、`setSecurityOption(db, name, value)`、`normalizeFileBackupMaxSizeMB(v)`、`normalizeBulkDeleteThreshold(v)`、`pickCommandRuleArray(v)`、`pickStringArray(v)`、`parseSecurityConfig(rows)`、`serializeSecurityValue(key, value)`、`stripBuiltinItems(list, builtin)`、`mergeRuleList(builtin, custom)`、`copySecurityConfig(config)`

- [ ] **Step 1: 共享类型**

`src-react/domains/security/model/types.ts`：

```ts
/**
 * 安全中心共享类型（SP1 spec §6.4）：前后端 import type 共享
 * （主进程侧参照 provider.repo.ts 的跨进程类型引入惯例）
 */

export type CmdRule = { prefix: string[]; reason?: string };

export type SecurityConfig = {
  sandboxEnabled: boolean;
  fileAllowlist: string[];
  fileBlocklist: string[];
  cmdAllow: CmdRule[];
  cmdAsk: CmdRule[];
  programBlacklist: string[];
  domainAllow: string[];
  domainDeny: string[];
  blockAllNetwork: boolean;
  maliciousDomainProtection: boolean;
  fileBackupEnabled: boolean;
  fileBackupMaxSizeMB: number;
  deleteProtection: boolean;
  bulkDeleteThreshold: number;
};

export type SecurityConfigKey = keyof SecurityConfig;

/** 读接口：内置清单（只读常量）与用户配置分离（spec §5.2） */
export type SecurityConfigState = {
  defaults: { fileBlocklist: string[] };
  config: SecurityConfig;
};

export type AuditCategory =
  | "command-safety"
  | "file-safety"
  | "network"
  | "data-safety"
  | "config";

export type AuditDecision =
  | "approved"
  | "rejected"
  | "blocked"
  | "allowed"
  | "failed"
  | "info";

export type AuditEntry = {
  id: number;
  sequence: number;
  category: AuditCategory;
  eventType: string;
  decision: AuditDecision;
  detail: string | null;
  commandPreview: string | null;
  commandHash: string | null;
  sessionId: number | null;
  prevHash: string | null;
  hash: string;
  createdAt: string;
};

export type AuditListParams = {
  page?: number;
  pageSize?: number;
  keyword?: string;
};

export type AuditListResult = {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
};

/** 安全事件（审计写入输入）：category 由 eventType 前缀推导 */
export type SecurityEvent = {
  eventType: string;
  decision: AuditDecision;
  detail?: Record<string, unknown>;
  commandPreview?: string;
  commandHash?: string;
  sessionId?: number | null;
};

export type SecurityEventSink = (event: SecurityEvent) => void;
```

- [ ] **Step 2: 默认值与内置清单**

`electron/domains/security/defaults.ts`：

```ts
/**
 * 安全配置默认值 + 内置敏感路径清单（SP1 spec §5.1/§5.2）。
 * 内置清单永不落盘（WorkBuddy 同构三层防删的第一层），
 * 展示合并与保存剔除见 config-store.ts 的 mergeRuleList/stripBuiltinItems。
 */
import type { SecurityConfig } from "../../src-react/domains/security/model/types";

/** 14 项安全配置默认值（read-time fallback 的唯一事实源） */
export const SECURITY_DEFAULTS: SecurityConfig = {
  sandboxEnabled: true,
  fileAllowlist: [],
  fileBlocklist: [],
  cmdAllow: [],
  cmdAsk: [],
  programBlacklist: ["rm"],
  domainAllow: [],
  domainDeny: [],
  blockAllNetwork: false,
  maliciousDomainProtection: true,
  fileBackupEnabled: true,
  fileBackupMaxSizeMB: 3000,
  deleteProtection: true,
  bulkDeleteThreshold: 50,
};

/** 内置文件黑名单全量清单（照 WorkBuddy 默认文件安全规则，PRD 同源） */
export const BUILTIN_FILE_BLOCKLIST_ALL = [
  "~/.ssh/",
  "~/.aws/",
  "~/.gnupg/",
  "~/.gpg/",
  "~/.kube/config",
  "~/.docker/config.json",
  "~/.docker/daemon.json",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.gem/credentials",
  "~/.config/gh/hosts.yml",
  "~/.git-credentials",
  "~/.config/gcloud/",
  "~/.azure/",
  "~/.terraform.d/credentials.tfrc.json",
  "~/Library/Keychains/",
];

/** 按平台过滤内置清单（Windows 剔除 macOS 钥匙串） */
export function defaultFileBlocklist(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return BUILTIN_FILE_BLOCKLIST_ALL.filter((p) => p !== "~/Library/Keychains/");
  }
  return [...BUILTIN_FILE_BLOCKLIST_ALL];
}
```

注意：`defaults.ts` 从 `src-react` 引类型在本项目有先例（provider.repo.ts 同款 import type），vite/tsc 均已配置允许。

- [ ] **Step 3: 写失败测试**

`tests/security/config-store.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  normalizeFileBackupMaxSizeMB,
  normalizeBulkDeleteThreshold,
  pickCommandRuleArray,
  pickStringArray,
  parseSecurityConfig,
  serializeSecurityValue,
  stripBuiltinItems,
  mergeRuleList,
} from "../../electron/domains/security/config-store";
import { SECURITY_DEFAULTS } from "../../electron/domains/security/defaults";

describe("normalize 族", () => {
  it("备份配额钳制 ≥1000 并取整", () => {
    expect(normalizeFileBackupMaxSizeMB(500)).toBe(1000);
    expect(normalizeFileBackupMaxSizeMB(2500.7)).toBe(2501);
    expect(normalizeFileBackupMaxSizeMB("3000")).toBe(3000);
  });
  it("批量删除阈值：整数 1–99999 保留，非法回落 50", () => {
    expect(normalizeBulkDeleteThreshold(120)).toBe(120);
    expect(normalizeBulkDeleteThreshold(0)).toBe(50);
    expect(normalizeBulkDeleteThreshold(100000)).toBe(50);
    expect(normalizeBulkDeleteThreshold("abc")).toBe(50);
  });
  it("命令规则：剔除空 token、剔除非法条目", () => {
    expect(
      pickCommandRuleArray([{ prefix: ["git", "", "push"] }, { prefix: [] }, "x" ])
    ).toEqual([{ prefix: ["git", "push"] }]);
  });
  it("字符串名单：仅保留非空字符串", () => {
    expect(pickStringArray(["a", "", 1, "b"])).toEqual(["a", "b"]);
  });
});

describe("parseSecurityConfig（read-time fallback）", () => {
  it("空行集 → 全默认", () => {
    expect(parseSecurityConfig([])).toEqual(SECURITY_DEFAULTS);
  });
  it("畸形 JSON → 该项回退默认，不抛错", () => {
    const rows = [{ name: "fileAllowlist", value: "{broken" }];
    expect(parseSecurityConfig(rows).fileAllowlist).toEqual([]);
  });
  it("合法行覆盖默认", () => {
    const rows = [
      { name: "sandboxEnabled", value: "false" },
      { name: "programBlacklist", value: '["rm","mkfs"]' },
    ];
    const parsed = parseSecurityConfig(rows);
    expect(parsed.sandboxEnabled).toBe(false);
    expect(parsed.programBlacklist).toEqual(["rm", "mkfs"]);
  });
});

describe("序列化与内置项处理", () => {
  it("serializeSecurityValue：bool/number 转字符串，数组转 JSON", () => {
    expect(serializeSecurityValue("sandboxEnabled", false)).toBe("false");
    expect(serializeSecurityValue("bulkDeleteThreshold", 80)).toBe("80");
    expect(serializeSecurityValue("domainDeny", ["a.com"])).toBe('["a.com"]');
  });
  it("stripBuiltinItems 剔除与内置相同的项", () => {
    expect(stripBuiltinItems(["/tmp", "~/.ssh/"], ["~/.ssh/"])).toEqual(["/tmp"]);
  });
  it("mergeRuleList：内置在前、去重", () => {
    expect(mergeRuleList(["~/.ssh/"], ["/tmp", "~/.ssh/"])).toEqual([
      "~/.ssh/",
      "/tmp",
    ]);
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `npx vitest run tests/security/config-store.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 5: 实现 config-store.ts**

`electron/domains/security/config-store.ts`：

```ts
/**
 * 安全配置存取纯函数层（SP1 spec §6.1）：注入 db 接口的纯函数
 * （照 app-settings/option-store.ts 模式），vitest 可直接测。
 * 写为 upsert 语义（updateMany 命中 0 行则 create）。
 */
import type {
  CmdRule,
  SecurityConfig,
  SecurityConfigKey,
} from "../../src-react/domains/security/model/types";
import { parseBoolOption } from "../app-settings/option-store";
import { SECURITY_DEFAULTS } from "./defaults";

export const SECURITY_OPTION_TYPE = "security";

/** prisma option delegate 结构子集（真实客户端/测试 stub 均可注入） */
export interface SecurityOptionPrismaLike {
  findMany(args: {
    where: { type: string };
    select: { name: true; value: true };
  }): Promise<Array<{ name: string; value: string }>>;
  updateMany(args: {
    where: { type: string; name: string };
    data: { value: string };
  }): Promise<{ count: number }>;
  create(args: {
    data: { type: string; name: string; value: string };
  }): Promise<unknown>;
}

export async function listSecurityOptions(
  db: SecurityOptionPrismaLike,
): Promise<Array<{ name: string; value: string }>> {
  return db.findMany({
    where: { type: SECURITY_OPTION_TYPE },
    select: { name: true, value: true },
  });
}

/** upsert：先 updateMany（type+name 定位），命中 0 行则 create */
export async function setSecurityOption(
  db: SecurityOptionPrismaLike,
  name: string,
  value: string,
): Promise<void> {
  const result = await db.updateMany({
    where: { type: SECURITY_OPTION_TYPE, name },
    data: { value },
  });
  if (result.count === 0) {
    await db.create({ data: { type: SECURITY_OPTION_TYPE, name, value } });
  }
}

// ---------- normalize 族（spec §6.1，照 WorkBuddy 钳制规则） ----------

export function normalizeFileBackupMaxSizeMB(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return SECURITY_DEFAULTS.fileBackupMaxSizeMB;
  return Math.max(1000, Math.round(n));
}

export function normalizeBulkDeleteThreshold(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 99999
    ? n
    : SECURITY_DEFAULTS.bulkDeleteThreshold;
}

/** 命令规则校验：prefix 非空字符串数组（空 token 剔除），reason 可选 */
export function pickCommandRuleArray(v: unknown): CmdRule[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((item): CmdRule[] => {
    if (typeof item !== "object" || item === null) return [];
    const { prefix, reason } = item as { prefix?: unknown; reason?: unknown };
    const tokens = pickStringArray(prefix);
    if (tokens.length === 0) return [];
    return typeof reason === "string" && reason
      ? [{ prefix: tokens, reason }]
      : [{ prefix: tokens }];
  });
}

export function pickStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item !== "");
}

function parseJsonArray(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

// ---------- read-time fallback 解析（spec §5.1） ----------

export function parseSecurityConfig(
  rows: Array<{ name: string; value: string }>,
): SecurityConfig {
  const map = new Map(rows);
  return {
    sandboxEnabled: parseBoolOption(map.get("sandboxEnabled"), true),
    fileAllowlist: pickStringArray(parseJsonArray(map.get("fileAllowlist") ?? "[]")),
    fileBlocklist: pickStringArray(parseJsonArray(map.get("fileBlocklist") ?? "[]")),
    cmdAllow: pickCommandRuleArray(parseJsonArray(map.get("cmdAllow") ?? "[]")),
    cmdAsk: pickCommandRuleArray(parseJsonArray(map.get("cmdAsk") ?? "[]")),
    programBlacklist: pickStringArray(
      parseJsonArray(map.get("programBlacklist") ?? JSON.stringify(SECURITY_DEFAULTS.programBlacklist)),
    ),
    domainAllow: pickStringArray(parseJsonArray(map.get("domainAllow") ?? "[]")),
    domainDeny: pickStringArray(parseJsonArray(map.get("domainDeny") ?? "[]")),
    blockAllNetwork: parseBoolOption(map.get("blockAllNetwork"), false),
    maliciousDomainProtection: parseBoolOption(
      map.get("maliciousDomainProtection"),
      true,
    ),
    fileBackupEnabled: parseBoolOption(map.get("fileBackupEnabled"), true),
    fileBackupMaxSizeMB: normalizeFileBackupMaxSizeMB(map.get("fileBackupMaxSizeMB")),
    deleteProtection: parseBoolOption(map.get("deleteProtection"), true),
    bulkDeleteThreshold: normalizeBulkDeleteThreshold(map.get("bulkDeleteThreshold")),
  };
}

// ---------- 序列化与内置项处理 ----------

export function serializeSecurityValue(
  key: SecurityConfigKey,
  value: unknown,
): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** 保存前剔除内置项（三层防删第二层：内置永不落盘） */
export function stripBuiltinItems(list: string[], builtin: string[]): string[] {
  return list.filter((item) => !builtin.includes(item));
}

/** 展示合并：内置在前、去重（三层防删的展示层） */
export function mergeRuleList(builtin: string[], custom: string[]): string[] {
  const customOnly = stripBuiltinItems(custom, builtin);
  return [...builtin, ...customOnly];
}

/** 深拷贝配置（内存缓存返回防御性副本） */
export function copySecurityConfig(config: SecurityConfig): SecurityConfig {
  return {
    ...config,
    fileAllowlist: [...config.fileAllowlist],
    fileBlocklist: [...config.fileBlocklist],
    cmdAllow: config.cmdAllow.map((rule) => ({ ...rule })),
    cmdAsk: config.cmdAsk.map((rule) => ({ ...rule })),
    programBlacklist: [...config.programBlacklist],
    domainAllow: [...config.domainAllow],
    domainDeny: [...config.domainDeny],
  };
}
```

实现注意：`parseSecurityConfig` 已超 20 行——拆为逐字段小函数或以字段映射表实现均可，保持行为与测试一致即可（本计划示例给直写版，执行者可重构为映射表，测试为准）。

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run tests/security/config-store.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/security/model/types.ts electron/domains/security/defaults.ts electron/domains/security/config-store.ts tests/security/config-store.test.ts
git commit -m "feat(安全中心): 配置纯函数层——14 项默认值/normalize 校验/内置清单合并剔除（read-time fallback）"
```

---

### Task 4: SecurityService（内存缓存 + 读写 IPC）

**Files:**
- Create: `electron/domains/security/security.service.ts`
- Test: `tests/security/security-service.test.ts`

**Interfaces:**
- Consumes: Task 3 全部导出；`SecurityEventSink`（types.ts）
- Produces（Task 6/9/11 依赖）:
  - `new SecurityService(opts?: { db?: SecurityOptionPrismaLike; audit?: SecurityEventSink })`
  - `await svc.init(): Promise<void>`（启动加载缓存；Application 接线时调用）
  - `svc.getConfig(): SecurityConfigState`
  - `svc.getConfigValue(): SecurityConfig`（执行层便捷读，Task 11 使用）
  - `await svc.setConfig(key: SecurityConfigKey, value: unknown): Promise<SecurityConfig>`
  - IPC：`security:getConfig` / `security:setConfig`（本任务注册，前端 Task 7 才消费）

- [ ] **Step 1: 写失败测试**

`tests/security/security-service.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import SecurityService from "../../electron/domains/security/security.service";

/** 内存 stub：SecurityOptionPrismaLike 最小实现 */
function makeDb() {
  const rows = new Map<string, string>();
  return {
    rows,
    findMany: async () =>
      [...rows].map(([name, value]) => ({ name, value })),
    updateMany: async ({ where }: { where: { name: string } }) => {
      if (!rows.has(where.name)) return { count: 0 };
      return { count: 1 };
    },
    create: async ({ data }: { data: { name: string; value: string } }) => {
      rows.set(data.name, data.value);
      return {};
    },
  };
}

describe("SecurityService", () => {
  it("init 读 option 行入缓存，缺省回退默认", async () => {
    const db = makeDb();
    db.rows.set("sandboxEnabled", "false");
    const svc = new SecurityService({ db: db as never });
    await svc.init();
    expect(svc.getConfigValue().sandboxEnabled).toBe(false);
    expect(svc.getConfigValue().deleteProtection).toBe(true);
  });
  it("getConfig 返回 defaults/config 分离结构", async () => {
    const svc = new SecurityService({ db: makeDb() as never });
    await svc.init();
    const state = svc.getConfig();
    expect(state.defaults.fileBlocklist).toContain("~/.ssh/");
    expect(state.config.sandboxEnabled).toBe(true);
  });
  it("setConfig 校验+落库+更新缓存+发审计事件", async () => {
    const db = makeDb();
    const events: unknown[] = [];
    const svc = new SecurityService({
      db: db as never,
      audit: (e) => events.push(e),
    });
    await svc.init();
    const updated = await svc.setConfig("bulkDeleteThreshold", 999999999);
    expect(updated.bulkDeleteThreshold).toBe(50); // 非法回落
    expect(db.rows.get("bulkDeleteThreshold")).toBe("50");
    expect(svc.getConfigValue().bulkDeleteThreshold).toBe(50);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "config.bulkDeleteThreshold.updated",
        decision: "info",
      }),
    ]);
  });
  it("setConfig 保存文件黑名单时剔除内置项", async () => {
    const db = makeDb();
    const svc = new SecurityService({ db: db as never });
    await svc.init();
    await svc.setConfig("fileBlocklist", ["/tmp/x", "~/.ssh/"]);
    expect(db.rows.get("fileBlocklist")).toBe('["/tmp/x"]');
  });
  it("未知 key 抛错", async () => {
    const svc = new SecurityService({ db: makeDb() as never });
    await svc.init();
    await expect(svc.setConfig("nope" as never, 1)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/security/security-service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`electron/domains/security/security.service.ts`：

```ts
/**
 * 安全配置服务（SP1 spec §6.1）：内存缓存 + 写时失效。
 * 读走缓存零 DB 开销（SP2-SP6 执行层消费）；写 = normalize → 剔内置 →
 * upsert option → 更新缓存 → 审计 config.<key>.updated。
 */
import { ipcMain } from "electron";
import prisma from "../../commons/prisma-client";
import type {
  SecurityConfig,
  SecurityConfigKey,
  SecurityConfigState,
  SecurityEventSink,
} from "../../src-react/domains/security/model/types";
import {
  copySecurityConfig,
  listSecurityOptions,
  parseSecurityConfig,
  serializeSecurityValue,
  setSecurityOption,
  stripBuiltinItems,
  type SecurityOptionPrismaLike,
} from "./config-store";
import {
  SECURITY_DEFAULTS,
  defaultFileBlocklist,
} from "./defaults";

/** 各 key 的写入时校验/清洗（bool 原样，名单重校验，数值钳制） */
const NORMALIZERS: Record<SecurityConfigKey, (v: unknown) => unknown> = {
  sandboxEnabled: (v) => v === true,
  fileAllowlist: (v, ) => v,
  fileBlocklist: (v) => v,
  cmdAllow: (v) => v,
  cmdAsk: (v) => v,
  programBlacklist: (v) => v,
  domainAllow: (v) => v,
  domainDeny: (v) => v,
  blockAllNetwork: (v) => v === true,
  maliciousDomainProtection: (v) => v === true,
  fileBackupEnabled: (v) => v === true,
  deleteProtection: (v) => v === true,
  fileBackupMaxSizeMB: normalizeImport,
  bulkDeleteThreshold: normalizeImport,
};

export default class SecurityService {
  private config: SecurityConfig = copySecurityConfig(SECURITY_DEFAULTS);
  private builtinBlocklist = defaultFileBlocklist(process.platform);

  constructor(
    private opts: { db?: SecurityOptionPrismaLike; audit?: SecurityEventSink } = {},
  ) {
    this.registerHandlers();
  }

  private get db(): SecurityOptionPrismaLike {
    return this.opts.db ?? prisma.option;
  }

  /** 启动加载：option 行 → read-time fallback → 内存缓存 */
  async init(): Promise<void> {
    const rows = await listSecurityOptions(this.db);
    this.config = parseSecurityConfig(rows);
  }

  /** 读接口（含内置清单分离，spec §5.2） */
  getConfig(): SecurityConfigState {
    return {
      defaults: { fileBlocklist: [...this.builtinBlocklist] },
      config: copySecurityConfig(this.config),
    };
  }

  /** 执行层便捷读（SP2-SP6 消费，纯内存） */
  getConfigValue(): SecurityConfig {
    return copySecurityConfig(this.config);
  }

  /** 单 key 写：校验 → 剔内置 → upsert → 缓存 → 审计 */
  async setConfig(
    key: SecurityConfigKey,
    value: unknown,
  ): Promise<SecurityConfig> {
    if (!(key in SECURITY_DEFAULTS)) {
      throw new Error(`未知安全配置项: ${key}`);
    }
    const normalized = NORMALIZERS[key](value);
    const cleaned = this.cleanValue(key, normalized);
    await setSecurityOption(this.db, key, serializeSecurityValue(key, cleaned));
    (this.config as Record<SecurityConfigKey, unknown>)[key] = cleaned;
    this.opts.audit?.({
      eventType: `config.${key}.updated`,
      decision: "info",
      detail: { key, value: cleaned },
    });
    return copySecurityConfig(this.config);
  }

  private cleanValue(key: SecurityConfigKey, value: unknown): unknown {
    if (key === "fileBlocklist") {
      const list = value as string[];
      return stripBuiltinItems(list, this.builtinBlocklist);
    }
    return value;
  }

  private registerHandlers(): void {
    ipcMain.handle("security:getConfig", () => this.getConfig());
    ipcMain.handle(
      "security:setConfig",
      (_, key: SecurityConfigKey, value: unknown) =>
        this.setConfig(key, value),
    );
  }
}
```

实现注意：上面 `NORMALIZERS` 里的 `normalizeImport` 是占位说明——实际写为从 config-store import 的 `normalizeFileBackupMaxSizeMB` / `normalizeBulkDeleteThreshold`，名单类 key（fileAllowlist/cmdAllow 等）用 `pickStringArray` / `pickCommandRuleArray`（JSON 名单序列化后校验）。即每行形如：
`fileAllowlist: pickStringArray,` `cmdAllow: pickCommandRuleArray,`
`fileBackupMaxSizeMB: normalizeFileBackupMaxSizeMB,` `bulkDeleteThreshold: normalizeBulkDeleteThreshold,`
bool 四项 `sandboxEnabled: (v: unknown) => v === true` 同款。同时删掉示例中 `(v, )` 尾随逗号笔误。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/security/security-service.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/security.service.ts tests/security/security-service.test.ts
git commit -m "feat(安全中心): SecurityService——内存缓存读写 + security:getConfig/setConfig IPC + 写入审计联动"
```

---

### Task 5: AuditLogService（异步缓冲 + 哈希链 + 查询/清空）

**Files:**
- Create: `electron/domains/security/audit/audit-log.service.ts`
- Test: `tests/security/audit-log-service.test.ts`

**Interfaces:**
- Consumes: Task 1 表、Task 2 哈希函数、types.ts
- Produces（Task 6/11 依赖）:
  - `new AuditLogService(db?: AuditPrismaLike)`
  - `await svc.init(): Promise<void>`（恢复链 state）
  - `svc.append(event: SecurityEvent): void`（同步入队）
  - `await svc.flush(): Promise<void>`（测试/退出用）
  - `await svc.list(params: AuditListParams): Promise<AuditListResult>`
  - `await svc.clear(): Promise<void>`
  - `svc.exportEntries(format): Promise<{ ok: boolean; filePath?: string }>`（Task 6 实现文件写入）
  - `AuditPrismaLike` 接口（见 Step 3）

- [ ] **Step 1: 写失败测试**

`tests/security/audit-log-service.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuditLogService from "../../electron/domains/security/audit/audit-log-service";
import { computeEntryHash } from "../../electron/domains/security/audit/hash-chain";

/** 内存 stub：AuditPrismaLike 最小实现（行按 sequence 排序取出） */
function makeDb() {
  const rows: Array<Record<string, unknown>> = [];
  let seq = 0;
  return {
    rows,
    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const d of data) rows.push(d);
      return { count: data.length };
    },
    findMany: async ({ orderBy, take }: { orderBy: Array<Record<string, string>>; take?: number } ) => {
      const sorted = [...rows].sort((a, b) =>
        orderBy?.[0]?.sequence === "desc"
          ? Number(b.sequence) - Number(a.sequence)
          : Number(a.sequence) - Number(b.sequence)
      );
      return take ? sorted.slice(0, take) : sorted;
    },
    count: async () => rows.length,
    deleteMany: async ({ where }: { where?: Record<string, unknown> } ) => {
      const before = rows.length;
      if (where && "id" in where) {
        const ids = new Set((where.id as { in: number[] }).in);
        for (let i = rows.length - 1; i >= 0; i--) {
          if (ids.has(rows[i].id as number)) rows.splice(i, 1);
        }
      }
      return { count: before - rows.length };
    },
    nextId: () => ++seq,
  };
}

vi.mock("electron", () => ({
  app: { on: vi.fn(), getPath: vi.fn(() => "/tmp") },
  dialog: {},
  shell: {},
  ipcMain: { handle: vi.fn() },
}));

describe("AuditLogService", () => {
  let db: ReturnType<typeof makeDb>;
  let svc: AuditLogService;
  beforeEach(async () => {
    vi.useFakeTimers();
    db = makeDb();
    svc = new AuditLogService(db as never);
    await svc.init();
  });

  it("append 入队，flush 后逐条编链落库", async () => {
    svc.append({ eventType: "command-safety.blocked", decision: "blocked" });
    svc.append({ eventType: "config.sandboxEnabled.updated", decision: "info" });
    await svc.flush();
    expect(db.rows).toHaveLength(2);
    expect(db.rows[0]).toMatchObject({
      sequence: 1,
      category: "command-safety",
      prevHash: null,
    });
    expect(db.rows[1]).toMatchObject({
      sequence: 2,
      category: "config",
      prevHash: db.rows[0].hash,
    });
  });

  it("落库条目 hash 可被 computeEntryHash 复算验证", async () => {
    svc.append({ eventType: "audit.cleared", decision: "info" });
    await svc.flush();
    const row = db.rows[0];
    expect(computeEntryHash(row, null)).toBe(row.hash);
  });

  it("init 从既有行恢复链尾（新条目接续 sequence）", async () => {
    svc.append({ eventType: "command-safety.blocked", decision: "blocked" });
    await svc.flush();
    const svc2 = new AuditLogService(db as never);
    await svc2.init();
    svc2.append({ eventType: "config.x.updated", decision: "info" });
    await svc2.flush();
    expect(db.rows[1]).toMatchObject({ sequence: 2, prevHash: db.rows[0].hash });
  });

  it("clear 清空后留痕 audit.cleared 成为新链头", async () => {
    svc.append({ eventType: "command-safety.blocked", decision: "blocked" });
    await svc.flush();
    await svc.clear();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      eventType: "audit.cleared",
      sequence: 2,
      prevHash: null,
    });
  });

  it("list 分页 + keyword 过滤 + 参数钳制", async () => {
    for (let i = 0; i < 3; i++) {
      svc.append({
        eventType: "command-safety.blocked",
        decision: "blocked",
        commandPreview: `rm -rf /-${i}`,
      });
    }
    await svc.flush();
    const page = await svc.list({ page: 1, pageSize: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.total).toBe(3);
    const hit = await svc.list({ keyword: "rm -rf /-1", pageSize: 100 });
    expect(hit.total).toBe(1);
  });

  it("超上限裁剪最旧（>5000）", async () => {
    const many = Array.from({ length: 5010 }, (_, i) => ({
      eventType: "command-safety.blocked",
      decision: "blocked" as const,
      detail: { i },
    }));
    for (const e of many) svc.append(e);
    await svc.flush();
    expect(db.rows.length).toBeLessThanOrEqual(5000);
    expect(db.rows[0]).toMatchObject({ sequence: 11 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/security/audit-log-service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`electron/domains/security/audit/audit-log.service.ts`：

```ts
/**
 * 审计日志服务（SP1 spec §6.2）：append 同步入队（调用方零成本），
 * ≥50 条或 500ms 触发 flush——逐条编 sequence/hash 批量落库、
 * 超 5000 条裁剪最旧；clear 全清后留痕 audit.cleared 为新链头。
 * 查询倒序分页 + keyword（截 200 字符）。
 */
import { app, ipcMain } from "electron";
import prisma from "../../../commons/prisma-client";
import type {
  AuditCategory,
  AuditEntry,
  AuditListParams,
  AuditListResult,
  SecurityEvent,
} from "../../../src-react/domains/security/model/types";
import { computeEntryHash } from "./hash-chain";

const FLUSH_BATCH = 50;
const FLUSH_INTERVAL_MS = 500;
const MAX_ENTRIES = 5000;
const KEYWORD_SLICE = 200;
const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 500;

/** eventType 前缀 → category 映射（缺省 config） */
function categoryOf(eventType: string): AuditCategory {
  const prefix = eventType.split(".")[0] as AuditCategory;
  const known: AuditCategory[] = [
    "command-safety",
    "file-safety",
    "network",
    "data-safety",
    "config",
  ];
  return known.includes(prefix) ? prefix : "config";
}

export interface AuditPrismaLike {
  createMany(args: {
    data: Array<Record<string, unknown>>;
  }): Promise<{ count: number }>;
  findMany(args: {
    where?: Record<string, unknown>;
    orderBy?: Array<Record<string, string>>;
    take?: number;
  }): Promise<Array<Record<string, unknown>>>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
  deleteMany(args?: { where?: Record<string, unknown> }): Promise<{ count: number }>;
}

/** 查询参数规范化（spec §12：纯函数可单测） */
export function normalizeAuditListParams(
  params: AuditListParams,
): { page: number; pageSize: number; keyword: string | undefined } {
  const page = Number.isInteger(params.page) && (params.page ?? 0) >= 1 ? params.page! : 1;
  const rawSize = params.pageSize ?? PAGE_SIZE_DEFAULT;
  const pageSize = Math.min(Math.max(1, Number(rawSize) || PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX);
  const keyword = params.keyword?.trim().slice(0, KEYWORD_SLICE) || undefined;
  return { page, pageSize, keyword };
}

export default class AuditLogService {
  private queue: SecurityEvent[] = [];
  private chain = { sequence: 0, lastHash: null as string | null };
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(private dbOverride?: AuditPrismaLike) {
    app.on("quit", () => void this.flush());
    ipcMain.handle("security:auditList", (_, params: AuditListParams) =>
      this.list(params),
    );
    ipcMain.handle("security:auditClear", () => this.clear());
  }

  private get db(): AuditPrismaLike {
    return this.dbOverride ?? prisma.securityAuditLog;
  }

  /** 启动恢复链尾（空表 = 新链） */
  async init(): Promise<void> {
    const rows = (await this.db.findMany({
      orderBy: [{ sequence: "desc" }],
      take: 1,
    })) as Array<{ sequence: number; hash: string }>;
    if (rows.length > 0) {
      this.chain = { sequence: rows[0].sequence, lastHash: rows[0].hash };
    }
  }

  /** 同步入队；满批立即 flush，否则起 500ms 定时 */
  append(event: SecurityEvent): void {
    this.queue.push(event);
    if (this.queue.length >= FLUSH_BATCH) {
      void this.flush();
    } else if (this.timer === null) {
      this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  /** 落库队列（失败保留重试，spec §11） */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    this.stopTimer();
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.db.createMany({ data: this.buildEntries(batch) });
      await this.prune();
    } catch {
      this.queue.unshift(...batch);
    } finally {
      this.flushing = false;
    }
  }

  private buildEntries(batch: SecurityEvent[]): Array<Record<string, unknown>> {
    return batch.map((event) => {
      const base = {
        sequence: ++this.chain.sequence,
        category: categoryOf(event.eventType),
        eventType: event.eventType,
        decision: event.decision,
        detail: event.detail ? JSON.stringify(event.detail) : null,
        commandPreview: event.commandPreview ?? null,
        commandHash: event.commandHash ?? null,
        sessionId: event.sessionId ?? null,
        prevHash: this.chain.lastHash,
        createdAt: new Date().toISOString(),
      };
      const hash = computeEntryHash(base, this.chain.lastHash);
      this.chain.lastHash = hash;
      return { ...base, hash };
    });
  }

  /** 超 5000 条裁最旧（保留最近 MAX_ENTRIES 条） */
  private async prune(): Promise<void> {
    const total = await this.db.count();
    if (total <= MAX_ENTRIES) return;
    const cutoff = this.chain.sequence - MAX_ENTRIES;
    await this.db.deleteMany({ where: { sequence: { lt: cutoff } } });
  }

  /** 倒序分页 + keyword（detail/commandPreview LIKE） */
  async list(params: AuditListParams): Promise<AuditListResult> {
    const { page, pageSize, keyword } = normalizeAuditListParams(params);
    const where = keyword
      ? { OR: [{ detail: { contains: keyword } }, { commandPreview: { contains: keyword } }] }
      : undefined;
    const [rows, total] = await Promise.all([
      this.db.findMany({
        where,
        orderBy: [{ sequence: "desc" }],
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      this.db.count({ where }),
    ]);
    return {
      entries: rows.map((row) => row as unknown as AuditEntry),
      total,
      page,
      pageSize,
    };
  }

  /** 全清并留痕（清空动作自己成为新链头） */
  async clear(): Promise<void> {
    await this.db.deleteMany();
    this.chain = { sequence: 0, lastHash: null };
    this.append({ eventType: "audit.cleared", decision: "info" });
    await this.flush();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

实现注意：① `findMany` 的 `skip` 参数需加入 `AuditPrismaLike` 签名（示例漏写，补上 `skip?: number`）；② 测试的 makeDb stub `findMany` 需同样支持 `skip`/`where`；③ `createdAt` 落库用 ISO 字符串（stub 对比友好，SQLite TEXT 兼容）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/security/audit-log-service.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/audit/audit-log.service.ts tests/security/audit-log-service.test.ts
git commit -m "feat(安全中心): AuditLogService——异步缓冲 + 哈希链落库 + 5000 条滚动裁剪 + 分页查询/清空留痕"
```

### Task 6: 审计导出 + Application 接线

**Files:**
- Create: `electron/domains/security/audit/audit-export.ts`
- Modify: `electron/domains/security/audit/audit-log.service.ts`（挂接导出与 IPC）
- Modify: `electron/Application.ts`（registerServices 接线）

**Interfaces:**
- Consumes: Task 5 `AuditLogService`、Task 4 `SecurityService`
- Produces:
  - `writeAuditExport(db: AuditPrismaLike, format: "json" | "csv", filePath: string): Promise<void>`（audit-export.ts，纯函数式文件写入）
  - `csvEscape(v: string | number | null): string`
  - AuditLogService 新增：`async exportToFile(format): Promise<{ ok: boolean; filePath?: string }>` 与 IPC `security:auditExport`
  - Application 内单例（Task 11 消费）：`const auditLogService` / `const securityService`

- [ ] **Step 1: 实现导出模块**

`electron/domains/security/audit/audit-export.ts`：

```ts
/**
 * 审计导出（SP1 spec §6.2）：JSON 形状 {"entries":[…]}；CSV 逐列转义。
 * 分批（500 条/批）流式追加写，避免大日志一次性驻留内存。
 */
import fs from "node:fs/promises";
import type { AuditPrismaLike } from "./audit-log.service";

const EXPORT_BATCH = 500;
const CSV_COLUMNS = [
  "id",
  "sequence",
  "category",
  "eventType",
  "decision",
  "detail",
  "commandPreview",
  "commandHash",
  "sessionId",
  "prevHash",
  "hash",
  "createdAt",
] as const;

/** CSV 字段转义：含引号/逗号/换行时引号包裹，内部引号翻倍 */
export function csvEscape(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function entryRow(entry: Record<string, unknown>): string {
  return CSV_COLUMNS.map((col) => csvEscape(entry[col] as string | number | null))
    .join(",");
}

async function writeJson(db: AuditPrismaLike, filePath: string): Promise<void> {
  await fs.writeFile(filePath, '{"entries":[');
  let first = true;
  let after: string | null = null;
  do {
    const rows = await db.findMany({
      orderBy: [{ sequence: "asc" }],
      take: EXPORT_BATCH,
      ...(after ? { where: { sequence: { gt: Number(after) } } } : {}),
    });
    for (const row of rows) {
      await fs.appendFile(filePath, (first ? "" : ",") + JSON.stringify(row));
      first = false;
      after = String(row.sequence);
    }
  } while (true);
}

async function writeCsv(db: AuditPrismaLike, filePath: string): Promise<void> {
  await fs.writeFile(filePath, CSV_COLUMNS.join(",") + "\n");
  let after: string | null = null;
  do {
    const rows = await db.findMany({
      orderBy: [{ sequence: "asc" }],
      take: EXPORT_BATCH,
      ...(after ? { where: { sequence: { gt: Number(after) } } } : {}),
    });
    for (const row of rows) {
      await fs.appendFile(filePath, entryRow(row) + "\n");
      after = String(row.sequence);
    }
  } while (true);
}
```

实现注意：上面两个 `do…while(true)` 需要终止条件——循环内 `rows.length === 0` 时 `break`（写文件收尾：JSON 补 `]}`）。补全后确保两函数行为正确；`writeJson`/`writeCsv` 各自保持在 20 行内可再抽 `fetchBatch` 小函数。`writeAuditExport(db, format, filePath)` 按格式分发。

- [ ] **Step 2: AuditLogService 挂接导出 IPC**

`audit-log.service.ts` 构造器追加（import `dialog`/`shell` from electron、`writeAuditExport`）：

```ts
ipcMain.handle(
  "security:auditExport",
  (_, format: "json" | "csv") => this.exportToFile(format),
);
```

类内新增方法：

```ts
/** 保存框选路径 → 流式写 → 打开所在目录（取消 = ok:false 静默） */
async exportToFile(format: "json" | "csv"): Promise<{ ok: boolean; filePath?: string }> {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const result = await dialog.showSaveDialog({
    defaultPath: `security-audit-log-${date}.${format}`,
  });
  if (result.canceled || !result.filePath) return { ok: false };
  await writeAuditExport(this.db, format, result.filePath);
  shell.showItemInFolder(result.filePath);
  return { ok: true, filePath: result.filePath };
}
```

- [ ] **Step 3: Application 接线**

`electron/Application.ts`：顶部 import 两个服务；`registerServices()` 内、`new ChatService(...)` 之前插入：

```ts
// 安全中心（SP1）：审计链服务先行（SecurityService 写审计依赖），
// 均注入 prisma 单例；init 恢复审计链尾，失败仅日志不阻塞启动
const auditLogService = new AuditLogService();
await auditLogService
  .init()
  .catch((e) => Log.error("审计链恢复失败", e));
const securityService = new SecurityService({
  audit: (event) => auditLogService.append(event),
});
await securityService.init().catch((e) => Log.error("安全配置加载失败", e));
```

（Task 11 会回来把 `auditLogService.append` 传给 ChatService。）

- [ ] **Step 4: 验证**

Run: `npm run typecheck && npm run test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/security/audit/audit-export.ts electron/domains/security/audit/audit-log.service.ts electron/Application.ts
git commit -m "feat(安全中心): 审计导出 JSON/CSV 流式写出 + Application 接线两服务"
```

---

### Task 7: 前端基础（IPC 白名单 + api + i18n）

**Files:**
- Modify: `src-react/lib/ipc.ts`（IPCChannel 追加 6 通道）
- Create: `src-react/domains/security/api/security.api.ts`
- Create: `src-react/i18n/locales/zh-CN/security.json`、`src-react/i18n/locales/en-US/security.json`
- Modify: `src-react/i18n/locales/zh-CN/settings.json`、`src-react/i18n/locales/en-US/settings.json`（nav.security）
- Modify: `src-react/i18n/index.ts`

**Interfaces:**
- Consumes: Task 6 的后端通道
- Produces（Task 8/9/10 依赖）:
  - `SecurityApi.getConfig() / setConfig(key, value) / auditList(params) / auditExport(format) / auditClear() / openBackupDir()`
  - i18n 全部 `security:*` key（Task 8/9/10 直接使用，见各 JSON）

- [ ] **Step 1: IPC 通道登记**

`src-react/lib/ipc.ts` 的 `IPCChannel` 联合类型，在 `// 更新日志` 注释块之前追加：

```ts
  // 安全中心（SP1）
  | "security:getConfig"
  | "security:setConfig"
  | "security:auditList"
  | "security:auditExport"
  | "security:auditClear"
  | "security:openBackupDir";
```

- [ ] **Step 2: 前端 api 类**

`src-react/domains/security/api/security.api.ts`：

```ts
/**
 * 安全中心前端 api（SP1）：全部走 invoke 泛型封装
 */
import { invoke } from "@/lib/ipc";
import type {
  AuditListParams,
  AuditListResult,
  SecurityConfig,
  SecurityConfigKey,
  SecurityConfigState,
} from "../model/types";

export class SecurityApi {
  static getConfig(): Promise<SecurityConfigState> {
    return invoke<SecurityConfigState>("security:getConfig");
  }

  static setConfig(
    key: SecurityConfigKey,
    value: unknown,
  ): Promise<SecurityConfig> {
    return invoke<SecurityConfig>("security:setConfig", key, value);
  }

  static auditList(params: AuditListParams): Promise<AuditListResult> {
    return invoke<AuditListResult>("security:auditList", params);
  }

  static auditExport(
    format: "json" | "csv",
  ): Promise<{ ok: boolean; filePath?: string }> {
    return invoke<{ ok: boolean; filePath?: string }>(
      "security:auditExport",
      format,
    );
  }

  static auditClear(): Promise<void> {
    return invoke<void>("security:auditClear");
  }

  static openBackupDir(): Promise<void> {
    return invoke<void>("security:openBackupDir");
  }
}
```

- [ ] **Step 3: i18n 文件**

`src-react/i18n/locales/zh-CN/security.json`：

```json
{
  "title": "安全中心",
  "sandbox": {
    "title": "沙箱安全",
    "enabled": "沙箱安全",
    "enabledDesc": "开启后，AI 的所有执行操作均受文件、命令、网络安全规则约束",
    "file": "文件安全",
    "fileDesc": "管理文件读写权限与黑白名单",
    "command": "命令安全",
    "commandDesc": "管理 Shell 命令的放行、询问与禁止名单",
    "network": "网络安全",
    "networkDesc": "管理网络出入站请求与域名名单",
    "comingSoon": "即将上线"
  },
  "dataSafety": {
    "title": "数据安全",
    "backup": "自动备份",
    "backupDesc": "每次对话修改文件前，自动创建备份",
    "quota": "备份总上限 {{size}} MB",
    "openBackupDir": "打开备份目录",
    "deleteProtection": "删除保护",
    "deleteProtectionDesc": "开启后文件删除操作移入回收站，而非永久删除",
    "bulkThreshold": "批量删除审批阈值",
    "bulkThresholdDesc": "单次操作删除文件数量超过该阈值时，暂停并请求确认",
    "invalidThreshold": "阈值需为 1–99999 的整数"
  },
  "audit": {
    "title": "审计中心",
    "empty": "暂无记录",
    "viewAll": "查看全部",
    "back": "返回",
    "refresh": "刷新",
    "export": "导出日志",
    "exportJson": "导出 JSON",
    "exportCsv": "导出 CSV",
    "clear": "清空记录",
    "clearTitle": "清空审计记录？",
    "clearDesc": "将删除全部安全操作日志，且不可恢复。",
    "searchPlaceholder": "搜索命令或路径…",
    "pageInfo": "第 {{page}} / {{totalPages}} 页 · 共 {{total}} 条",
    "prev": "上一页",
    "next": "下一页",
    "events": {
      "command-safety_blocked": "拦截危险命令: {{command}}",
      "command-safety_approved": "命令已获批准: {{summary}}",
      "command-safety_rejected": "命令被拒绝: {{summary}}",
      "command-safety_cwd-fallback": "工作目录越界已回退: {{requested}}",
      "file-safety_approved": "文件操作已获批准: {{summary}}",
      "file-safety_rejected": "文件操作被拒绝: {{summary}}",
      "config_updated": "安全配置已更新: {{key}}",
      "audit_cleared": "审计记录已清空"
    }
  },
  "error": {
    "saveFailed": "保存失败，请重试"
  }
}
```

en-US 镜像翻译（`events` 下同名 key，英文文案，例如 `"command-safety_blocked": "Blocked dangerous command: {{command}}"`、`"quota": "Backup quota {{size}} MB"` 等，逐 key 对应，不得遗漏）。

`settings.json`（两个语言）：`nav` 对象加 `"security": "安全中心"` / `"security": "Security Center"`。

`src-react/i18n/index.ts`：import 两个 `security.json`，resources 两语言各加 `security`，`ns` 数组加 `"security"`（照 `project` 的登记样式）。

- [ ] **Step 4: 验证**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add src-react/lib/ipc.ts src-react/domains/security/api/security.api.ts src-react/i18n/locales/zh-CN/security.json src-react/i18n/locales/en-US/security.json src-react/i18n/locales/zh-CN/settings.json src-react/i18n/locales/en-US/settings.json src-react/i18n/index.ts
git commit -m "feat(安全中心): 前端基础——6 通道白名单 + SecurityApi + security 命名空间双语词条"
```

---

### Task 8: 设置面板接入 + 安全中心首页骨架

**Files:**
- Modify: `src-react/domains/app-settings/store/settings-ui.store.ts:10-11`（SettingsTab）
- Modify: `src-react/domains/app-settings/components/SettingsDialog.tsx`（NAV_ITEMS + 右栏分支）
- Create: `src-react/domains/security/components/SecurityCenter.tsx`
- Create: `src-react/domains/security/components/SandboxCard.tsx`

**Interfaces:**
- Consumes: Task 7 `SecurityApi`、i18n key；`SettingSwitchRow`、`SettingsGroup`、`useSaveOrRevert`（app-settings 现有）
- Produces:
  - `<SecurityCenter />`（视图栈容器：`view: "home" | "audit-all"`，Task 10 复用）
  - `<SandboxCard config onToggle />`（props 见代码）

- [ ] **Step 1: SettingsTab 与导航**

`settings-ui.store.ts`：`SettingsTab` 联合类型追加 `"security"`（照注释风格说明安全中心页）。

`SettingsDialog.tsx`：
- `NAV_ITEMS` 追加 `{ id: "security", icon: Shield }`（import `Shield` from lucide-react），插在 `shortcuts` 之后
- 右栏分支链：`activeTab === "security"` 时渲染 `<SecurityCenter />`（包在 `<div className="flex-1 overflow-y-auto p-6">` 内，与其他页同款）

- [ ] **Step 2: SecurityCenter 容器**

`src-react/domains/security/components/SecurityCenter.tsx`：

```tsx
/**
 * 安全中心首页（SP1 spec §9）：Dialog 内视图栈（首页 ↔ 审计全列表；
 * SP2-SP5 的三个二级页后续并入同一视图栈）。配置一次拉取、子卡片
 * 乐观保存（useSaveOrRevert 兜底回滚），照 app-settings 惯例。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import { SecurityApi } from "../api/security.api";
import { useSaveOrRevert } from "@/domains/app-settings/model/use-save-or-revert";
import SandboxCard from "./SandboxCard";
import DataSafetyCard from "./DataSafetyCard";
import AuditCenter from "./AuditCenter";
import SettingsGroup from "@/domains/app-settings/components/SettingsGroup";

type SecurityView = "home" | "audit-all";

export default function SecurityCenter() {
  const { t } = useTranslation(["security"]);
  const saveOrRevert = useSaveOrRevert();
  const [config, setConfig] = useState<SecurityConfig | null>(null);
  const [view, setView] = useState<SecurityView>("home");

  useEffect(() => {
    SecurityApi.getConfig()
      .then((state) => setConfig(state.config))
      .catch(() => setConfig(null));
  }, []);

  /** 单 key 乐观保存：本地先改，失败回滚并 toast（useSaveOrRevert） */
  const updateConfig = useCallback(
    (key: SecurityConfigKey, value: unknown) => {
      if (!config) return;
      const before = config;
      setConfig({ ...config, [key]: value } as SecurityConfig);
      saveOrRevert(
        SecurityApi.setConfig(key, value).then((saved) => setConfig(saved)),
        () => setConfig(before),
      );
    },
    [config, saveOrRevert],
  );

  if (config === null) {
    return <p className="text-sm text-muted-foreground">{t("security:audit.empty")}</p>;
  }

  if (view === "audit-all") {
    return (
      <AuditCenter
        embedded={false}
        onBack={() => setView("home")}
      />
    );
  }

  return (
    <div className="space-y-8">
      <SettingsGroup title={t("security:sandbox.title")}>
        <SandboxCard config={config} onToggle={updateConfig} />
      </SettingsGroup>
      <SettingsGroup title={t("security:dataSafety.title")}>
        <DataSafetyCard config={config} onUpdate={updateConfig} />
      </SettingsGroup>
      <SettingsGroup title={t("security:audit.title")}>
        <AuditCenter embedded onOpenAll={() => setView("audit-all")} />
      </SettingsGroup>
    </div>
  );
}
```

实现注意：`useSaveOrRevert` 现签名内部 `t("settings:error.saveFailed")`——如需 security 命名空间的失败文案，本任务不改该 hook，失败 toast 文案沿用现有 key 即可（`security:error.saveFailed` 留给后续需要时用）。加载失败占位文案复用 `audit.empty` 语义不理想——可在 security.json 顶部补 `"loadFailed": "加载失败，请重试"` 并在此使用。

- [ ] **Step 3: SandboxCard**

`src-react/domains/security/components/SandboxCard.tsx`：

```tsx
/**
 * 沙箱安全卡片：总开关 + 三个二级入口（SP1 占位禁用，SP2/SP3/SP5
 * 上线时逐个启用并接二级页视图）
 */
import { useTranslation } from "react-i18next";
import { ChevronRight, FileLock, TerminalSquare, Globe } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import SettingSwitchRow from "@/domains/app-settings/components/SettingSwitchRow";

interface SandboxCardProps {
  config: SecurityConfig;
  onToggle: (key: SecurityConfigKey, value: unknown) => void;
}

const ENTRIES: { icon: LucideIcon; labelKey: string; descKey: string }[] = [
  { icon: FileLock, labelKey: "security:sandbox.file", descKey: "security:sandbox.fileDesc" },
  { icon: TerminalSquare, labelKey: "security:sandbox.command", descKey: "security:sandbox.commandDesc" },
  { icon: Globe, labelKey: "security:sandbox.network", descKey: "security:sandbox.networkDesc" },
];

export default function SandboxCard({ config, onToggle }: SandboxCardProps) {
  const { t } = useTranslation(["security"]);
  return (
    <div className="space-y-5">
      <SettingSwitchRow
        label="security:sandbox.enabled"
        description="security:sandbox.enabledDesc"
        checked={config.sandboxEnabled}
        onCheckedChange={(checked) => onToggle("sandboxEnabled", checked)}
      />
      <div className="space-y-1">
        {ENTRIES.map(({ icon: Icon, labelKey, descKey }) => (
          <div
            key={labelKey}
            aria-disabled
            className="flex items-center gap-3 rounded-md px-2 py-2 opacity-60"
          >
            <Icon size={16} className="shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm">{t(labelKey)}</p>
              <p className="truncate text-xs text-muted-foreground">{t(descKey)}</p>
            </div>
            <span className="rounded bg-primary-subtle px-1.5 py-0.5 text-xs text-primary">
              {t("security:sandbox.comingSoon")}
            </span>
            <ChevronRight size={14} className="text-muted-foreground" />
          </div>
        ))}
      </div>
    </div>
  );
}
```

注意：`SettingSwitchRow` 内部 `useTranslation(["settings"])`——传 `security:*` key 时该组件的 t 实例解析不到。**不要改 SettingSwitchRow 的现有用法**；给它加可选 `ns` prop（默认 `"settings"`）或在 SandboxCard 直接用 Switch+Label 手写同款行（推荐后者，避免动共享组件；照 SettingSwitchRow 的 JSX 复制，t 取 `security` 实例）。本任务采用手写行方案，最终以页面渲染正确为准。

- [ ] **Step 4: 占位 DataSafetyCard / AuditCenter**

为让 typecheck 通过，先建最小占位（Task 9/10 替换为完整实现）：

`DataSafetyCard.tsx`：

```tsx
export default function DataSafetyCard() {
  return null;
}
```

`AuditCenter.tsx`：

```tsx
export default function AuditCenter() {
  return null;
}
```

（占位组件的 props 形状以 SecurityCenter 调用处为准，Task 9/10 实现同签名。）

- [ ] **Step 5: 验证**

Run: `npm run typecheck && npm run lint`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src-react/domains/app-settings/store/settings-ui.store.ts src-react/domains/app-settings/components/SettingsDialog.tsx src-react/domains/security/components
git commit -m "feat(安全中心): 设置面板接入——security tab + 首页骨架 + 沙箱总开关卡片"
```

### Task 9: DataSafetyCard（数据安全卡片 + 打开备份目录通道）

**Files:**
- Modify: `electron/domains/security/security.service.ts`（新增 `security:openBackupDir` IPC）
- Rewrite: `src-react/domains/security/components/DataSafetyCard.tsx`

**Interfaces:**
- Consumes: Task 7 `SecurityApi.openBackupDir`、Task 3 阈值语义（后端 normalize）
- Produces: `<DataSafetyCard config onUpdate />`（Task 8 已按此签名调用）

- [ ] **Step 1: 主进程 openBackupDir**

`security.service.ts` import `app`/`shell` from electron、`fs` from node:fs/promises、`path`；`registerHandlers` 追加（照 chat.service `skill:openDir` 模式）：

```ts
ipcMain.handle("security:openBackupDir", async (): Promise<void> => {
  const dir = path.join(app.getPath("userData"), "file-history");
  await fs.mkdir(dir, { recursive: true });
  const openError = await shell.openPath(dir);
  if (openError) {
    throw new Error(openError);
  }
});
```

- [ ] **Step 2: DataSafetyCard 完整实现**

`src-react/domains/security/components/DataSafetyCard.tsx`：

```tsx
/**
 * 数据安全卡片（SP1 spec §9.2）：备份开关/配额展示/打开目录、
 * 删除保护开关、批量删除阈值（失焦保存，非法值还原并提示）。
 * 纯持久化——执行层（备份/回收站/审批）SP4 接入。
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import { SecurityApi } from "../api/security.api";

interface DataSafetyCardProps {
  config: SecurityConfig;
  onUpdate: (key: SecurityConfigKey, value: unknown) => void;
}

function SwitchRow({
  labelKey,
  descKey,
  checked,
  onChange,
}: {
  labelKey: string;
  descKey: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useTranslation(["security"]);
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label className="text-sm font-normal">{t(labelKey)}</Label>
        <p className="text-xs text-muted-foreground">{t(descKey)}</p>
      </div>
      <Switch
        aria-label={t(labelKey)}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}

export default function DataSafetyCard({
  config,
  onUpdate,
}: DataSafetyCardProps) {
  const { t } = useTranslation(["security"]);
  const [threshold, setThreshold] = useState(String(config.bulkDeleteThreshold));
  const thresholdRef = useRef(config.bulkDeleteThreshold);

  /** 失焦保存：1–99999 整数，非法还原 + toast；保存后以服务端 normalize 回显 */
  const saveThreshold = () => {
    const n = Number(threshold);
    if (!Number.isInteger(n) || n < 1 || n > 99999) {
      setThreshold(String(thresholdRef.current));
      toast.error(t("security:dataSafety.invalidThreshold"));
      return;
    }
    SecurityApi.setConfig("bulkDeleteThreshold", n)
      .then((saved) => {
        thresholdRef.current = saved.bulkDeleteThreshold;
        setThreshold(String(saved.bulkDeleteThreshold));
      })
      .catch(() => toast.error(t("security:error.saveFailed")));
  };

  return (
    <div className="space-y-5">
      <SwitchRow
        labelKey="security:dataSafety.backup"
        descKey="security:dataSafety.backupDesc"
        checked={config.fileBackupEnabled}
        onChange={(v) => onUpdate("fileBackupEnabled", v)}
      />
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {t("security:dataSafety.quota", { size: config.fileBackupMaxSizeMB })}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() =>
            SecurityApi.openBackupDir().catch(() =>
              toast.error(t("security:error.saveFailed"))
            )
          }
        >
          <FolderOpen size={14} />
          {t("security:dataSafety.openBackupDir")}
        </Button>
      </div>
      <SwitchRow
        labelKey="security:dataSafety.deleteProtection"
        descKey="security:dataSafety.deleteProtectionDesc"
        checked={config.deleteProtection}
        onChange={(v) => onUpdate("deleteProtection", v)}
      />
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label className="text-sm font-normal">
            {t("security:dataSafety.bulkThreshold")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("security:dataSafety.bulkThresholdDesc")}
          </p>
        </div>
        <Input
          aria-label={t("security:dataSafety.bulkThreshold")}
          type="number"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          onBlur={saveThreshold}
          className="w-24 text-right"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 验证 + Commit**

Run: `npm run typecheck && npm run lint`
Expected: 无错误。

```bash
git add electron/domains/security/security.service.ts src-react/domains/security/components/DataSafetyCard.tsx
git commit -m "feat(安全中心): 数据安全卡片——备份开关/配额/打开目录 + 删除保护 + 批量删除阈值"
```

---

### Task 10: AuditCenter（审计中心 UI）

**Files:**
- Rewrite: `src-react/domains/security/components/AuditCenter.tsx`

**Interfaces:**
- Consumes: Task 7 `SecurityApi.auditList/auditExport/auditClear`、i18n `security:audit.*`
- Produces: `<AuditCenter embedded onOpenAll? /> | <AuditCenter embedded={false} onBack />`（Task 8 已按此调用）

- [ ] **Step 1: 实现**

`src-react/domains/security/components/AuditCenter.tsx`：

```tsx
/**
 * 审计中心（SP1 spec §9.2）：卡片态（embedded，最近 8 条 + 查看全部/
 * 导出/清空）与全量态（分页 + keyword + 30s 轮询 + 手动刷新）。
 * eventType → i18n messageKey：events.<点换下划线>，detail JSON 插值；
 * 缺失 key 回落 eventType 原文（旧版本数据向前兼容）。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Download, RefreshCw, Trash2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SecurityApi } from "../api/security.api";
import type { AuditEntry, AuditListResult } from "../model/types";

const CARD_PAGE_SIZE = 8;
const POLL_INTERVAL_MS = 30_000;

/** eventType → messageKey（command-safety.blocked → command-safety_blocked） */
function eventMessageKey(eventType: string): string {
  return `security:audit.events.${eventType.replace(/\./g, "_")}`;
}

function parseDetail(detail: string | null): Record<string, unknown> {
  if (!detail) return {};
  try {
    return JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function entryText(
  t: ReturnType<typeof useTranslation>["t"],
  entry: AuditEntry,
): string {
  const key = eventMessageKey(entry.eventType);
  const detail = parseDetail(entry.detail);
  const summary = String(
    detail.command ?? detail.summary ?? detail.key ?? detail.requested ?? ""
  );
  return i18nKeyExists(key)
    ? t(key, { ...detail, summary, command: summary })
    : entry.eventType;
}
```

实现注意：`i18nKeyExists` 用 `i18n.exists(key)`（import i18n from `@/i18n`）；插值对象展开 detail 的同时保证 `command`/`summary`/`key`/`requested` 四个常用变量可用（detail JSON 里存的键名与 i18n 插值变量对齐：Task 11 的 detail 落库键名必须用 `command`/`summary`/`key`/`requested`）。

组件主体（同文件续）：

```tsx
function AuditRow({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation(["security"]);
  return (
    <div className="flex items-center gap-2 py-1.5 text-xs">
      <Badge variant="outline" className="shrink-0 text-[10px]">
        {t(`security:audit.categories.${entry.category}`)}
      </Badge>
      <span className="min-w-0 flex-1 truncate">{entryText(t, entry)}</span>
      <span className="shrink-0 text-muted-foreground">
        {format(new Date(entry.createdAt), "yyyy/M/d HH:mm:ss")}
      </span>
    </div>
  );
}

export default function AuditCenter({
  embedded,
  onOpenAll,
  onBack,
}: {
  embedded: boolean;
  onOpenAll?: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation(["security"]);
  const [result, setResult] = useState<AuditListResult | null>(null);
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(
    (p: number, kw: string) => {
      SecurityApi.auditList({
        page: p,
        pageSize: embedded ? CARD_PAGE_SIZE : 100,
        keyword: kw || undefined,
      })
        .then(setResult)
        .catch(() => setResult(null));
    },
    [embedded]
  );

  useEffect(() => {
    load(page, keyword);
    if (embedded) return;
    const timer = setInterval(() => load(page, keyword), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, page, keyword, embedded]);

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  const exportLog = (formatType: "json" | "csv") => {
    SecurityApi.auditExport(formatType)
      .then((r) => {
        if (r.ok) toast.success(r.filePath ?? "");
      })
      .catch(() => toast.error(t("security:error.saveFailed")));
  };

  const clearAll = () => {
    SecurityApi.auditClear()
      .then(() => load(1, keyword))
      .catch(() => toast.error(t("security:error.saveFailed")));
  };

  if (result === null) {
    return <p className="text-sm text-muted-foreground">{t("security:audit.empty")}</p>;
  }

  const listBody = (
    <div className="divide-y divide-border/50">
      {result.entries.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          {t("security:audit.empty")}
        </p>
      ) : (
        result.entries.map((entry) => <AuditRow key={entry.id} entry={entry} />)
      )}
    </div>
  );

  if (embedded) {
    return (
      <div className="space-y-3">
        {listBody}
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onOpenAll}>
            {t("security:audit.viewAll")}
          </Button>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => exportLog("json")}>
              <Download size={14} />
              {t("security:audit.exportJson")}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Trash2 size={14} />
                  {t("security:audit.clear")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("security:audit.clearTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("security:audit.clearDesc")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={clearAll}>
                    {t("common:confirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} />
          {t("security:audit.back")}
        </Button>
        <Input
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setPage(1);
          }}
          placeholder={t("security:audit.searchPlaceholder")}
          className="h-8 max-w-xs"
        />
        <Button variant="ghost" size="sm" onClick={() => load(page, keyword)}>
          <RefreshCw size={14} />
          {t("security:audit.refresh")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => exportLog("csv")}>
          <Download size={14} />
          {t("security:audit.exportCsv")}
        </Button>
      </div>
      {listBody}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {t("security:audit.pageInfo", {
            page,
            totalPages,
            total: result.total,
          })}
        </p>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            {t("security:audit.prev")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("security:audit.next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

同时给 `security.json` 的 `audit` 对象补 `"categories": { "command-safety": "命令安全", "file-safety": "文件安全", "network": "网络安全", "data-safety": "数据安全", "config": "配置" }`（en-US 镜如 `Command Safety` 等），Badge 显示类型标签（PRD 要求 `[命令安全]` 式类型标签）。`common:cancel`/`common:confirm` 已存在于 common 命名空间，确认 key 名与现有文件一致后使用。

- [ ] **Step 2: 验证**

Run: `npm run typecheck && npm run lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src-react/domains/security/components/AuditCenter.tsx src-react/i18n/locales/zh-CN/security.json src-react/i18n/locales/en-US/security.json
git commit -m "feat(安全中心): 审计中心 UI——卡片态/全量分页视图 + 导出/清空 + 30s 轮询"
```

---

### Task 11: 事件源接入（命令拦截/审批决议审计）+ 手工验收

**Files:**
- Modify: `electron/domains/ai/agent/command-tool.ts`
- Modify: `electron/domains/ai/chat/chat.service.ts`
- Modify: `electron/Application.ts`（ChatService 注入 audit sink）
- Test: `tests/security/command-tool-audit.test.ts`
- Create: 验收文档（见 Step 5）

**Interfaces:**
- Consumes: Task 5 `AuditLogService.append`（经 `SecurityEventSink`）、`SecurityEvent` 类型、Task 4 已接线的 Application 单例
- Produces: 危险命令拦截/审批决议/cwd 回退三类真实审计事件

- [ ] **Step 1: 写失败测试**

`tests/security/command-tool-audit.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { makeRunCommandTool } from "../../electron/domains/ai/agent/command-tool";
import type { SecurityEvent } from "../../src-react/domains/security/model/types";

const CTX = { workspacePath: "/tmp/ws", sessionId: 1 };

describe("run_command 安全事件", () => {
  it("危险命令命中 → blocked 事件 + commandPreview/commandHash", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    const out = await tool.execute(
      { ...CTX, onSecurityEvent: (e) => events.push(e) },
      { command: "rm -rf /Users/x/data" },
    );
    expect(out).toContain("安全策略拦截");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "command-safety.blocked",
      decision: "blocked",
    });
    expect(events[0].commandPreview).toContain("rm -rf");
    expect(events[0].commandHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cwd 越界回退 → cwd-fallback info 事件", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    await tool.execute(
      { ...CTX, onSecurityEvent: (e) => events.push(e) },
      { command: "echo hi", cwd: "/etc" },
    );
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "command-safety.cwd-fallback",
        decision: "info",
      }),
    ]);
  });

  it("正常命令无事件", async () => {
    const events: SecurityEvent[] = [];
    const tool = makeRunCommandTool();
    await tool.execute(
      { ...CTX, onSecurityEvent: (e) => events.push(e) },
      { command: "echo hi" },
    );
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/security/command-tool-audit.test.ts`
Expected: FAIL（CommandContext 无 onSecurityEvent）。

- [ ] **Step 3: command-tool 接入**

`command-tool.ts`：

1. 顶部 import：`import { createHash } from "node:crypto";` 与 `import type { SecurityEventSink } from "../../../src-react/domains/security/model/types";`
2. `CommandContext` 追加字段：

```ts
/** 安全事件上报（SP1 审计接入）：由 ChatService 装配注入，保持本模块纯函数可测 */
onSecurityEvent?: SecurityEventSink;
```

3. 新增 helper（模块内）：

```ts
function commandSha256(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}
```

4. `runCommandTool.execute` 的危险命令分支改为：

```ts
if (isDangerousCommand(args.command)) {
  ctx.onSecurityEvent?.({
    eventType: "command-safety.blocked",
    decision: "blocked",
    detail: { command: args.command.slice(0, 200) },
    commandPreview: args.command.slice(0, 100),
    commandHash: commandSha256(args.command),
    sessionId: ctx.sessionId,
  });
  return "错误: 该命令被安全策略拦截（高风险破坏性操作）";
}
```

5. `resolveCwd` 越界分支（`return inBounds ? resolved : ctx.workspacePath;` 前）加事件：

```ts
if (!inBounds) {
  ctx.onSecurityEvent?.({
    eventType: "command-safety.cwd-fallback",
    decision: "info",
    detail: { requested: resolved, fallback: ctx.workspacePath },
    sessionId: ctx.sessionId,
  });
}
```

- [ ] **Step 4: chat.service 接入 + Application 注入**

`chat.service.ts`：

1. import `SecurityEventSink` 类型；
2. `AgentStreamOptions` 追加两字段（照现有注释风格）：

```ts
/** 安全事件上报（SP1）：透传给工具 ctx（run_command 拦截/cwd 回退） */
onSecurityEvent?: SecurityEventSink;
/** 审批决议审计（SP1）：approved/denied 由 runToolCall 决议分支回调 */
onApprovalResolved?: (
  toolName: string,
  decision: "approved" | "denied",
  argSummary: string,
) => void;
```

3. `runToolCall` 的 `awaitApproval` 调用后：`decision === "denied"` 分支内与 approved 路径（`if (decision === "denied") {...}` 块后、`onChunk running` 前）各加一行：

```ts
agent.onApprovalResolved?.(def.name, decision, summarizeArgs(def.name, input));
```

（approved 与 denied 都记；`aborted` 不记。放在 `if (decision === "denied")` 块的紧后即可两态覆盖——denied 块 return 前记 denied，否则记 approved。注意 denied 分支块内 return，须在块内 return 之前调用一次，块外调用一次。）
4. `executeToolSafe` 构造 ctx 处追加 `onSecurityEvent: agent.onSecurityEvent,`
5. `ChatService` 构造函数追加第 4 个可选参数 `private auditSink?: SecurityEventSink`；
6. 找到 `AgentStreamOptions` 字面量装配处（在 `send` 等方法内搜 `requestApproval:` 定位），追加：

```ts
onSecurityEvent: (event) => this.auditSink?.(event),
onApprovalResolved: (toolName, decision, argSummary) => {
  const category = toolName === "run_command" ? "command-safety" : "file-safety";
  this.auditSink?.({
    eventType: `${category}.${decision}`,
    decision,
    detail: { tool: toolName, summary: argSummary },
    sessionId: /* 该装配处的会话 id 变量 */,
  });
},
```

`Application.ts`：`new ChatService(sessionRepo, skillRepo, projectRepo)` 改为传入第 4 参 `(event) => auditLogService.append(event)`。

- [ ] **Step 5: 验证 + 验收文档**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全绿（含现有 tests/ai 回归——command-tool/chat 行为不应变化，仅新增回调）。

手工验收文档：查看 `docs/` 现有验收文档的目录惯例（近期提交有"计划与手工验收"先例，通常在 `docs/superpowers/` 下与 plans/specs 平级建 `acceptance/`；若已有惯例目录则放入），新建 `2026-09-15-security-center-sp1.md`，内容为验收清单：

- 设置 → 左栏出现"安全中心"tab（Shield 图标）
- 沙箱总开关默认开，切换后重启应用保持
- 数据安全三配置项可改并持久化；打开备份目录会创建并打开 `userData/file-history`
- 审计中心：初始可能有配置更新事件；对 AI 发起一次写文件请求并批准 → 审计出现 `文件操作已获批准`；触发危险命令（如让 AI 执行 `rm -rf /tmp/xxx` 绝对路径形式）→ 出现 `拦截危险命令`
- 查看全部：分页/keyword/导出 JSON/CSV/清空（确认框）→ 清空后留一条"审计记录已清空"
- en-US 切换后审计文案跟随语言

- [ ] **Step 6: Commit**

```bash
git add electron/domains/ai/agent/command-tool.ts electron/domains/ai/chat/chat.service.ts electron/Application.ts tests/security/command-tool-audit.test.ts
git commit -m "feat(安全中心): 事件源接入——危险命令拦截/审批决议/cwd 回退三类审计事件"
```

（验收文档若目录已确认，一并 add 提交，message 追加 `+ 手工验收清单`。）

---

## 收尾验证（全部任务完成后）

- [ ] `npm run test`：全量测试绿（新增 tests/security/* + 既有回归）
- [ ] `npm run typecheck && npm run lint`：零错误
- [ ] `npm run dev` 冒烟：应用可启动（v9 迁移自动执行——首次启动日志出现"执行升级脚本 …v9"）；安全中心三卡片可交互；审计事件可产生与展示
- [ ] 对照 spec §3 "做" 清单逐项勾验；§13 "不做"清单确认未越界

## Self-Review 记录（计划完成时）

- Spec 覆盖：§4 架构（Task 3-6）、§5 数据模型（Task 1/3）、§6 服务（Task 4/5/6）、§7 IPC（Task 4/5/6/7）、§8 事件源（Task 11）、§9 前端（Task 7-10）、§10 i18n（Task 7）、§11 错误处理（各任务内嵌）、§12 测试（Task 2-5/11）、§13 边界（收尾验证核对）——无缺口。
- 类型一致性：`SecurityEventSink`/`SecurityEvent`（Task 3 定义，Task 5/8/11 消费）、`AuditPrismaLike`（Task 5 定义，Task 6 消费）、`AuditCenter`/`DataSafetyCard` props（Task 8 调用处与 Task 9/10 实现签名一致）。
- 已知占位说明：Task 8 Step 4 的 null 占位组件由 Task 9/10 当任务内 Rewrite 覆盖，属计划内中间态。

