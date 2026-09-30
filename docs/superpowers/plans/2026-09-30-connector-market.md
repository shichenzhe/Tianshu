# 连接器市场与 MCP 服务管理弹窗 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「专家·技能·连接器」页的连接器 Tab 从 MCP 服务器表格重构为连接器卡片市场 + MCP 管理弹窗（列表态/JSON 编辑态），数据库为真相源、JSON 编辑器为视图。

**Architecture:** 前端新增市场视图与弹窗（视觉对齐技能市场 `SkillHubCard` 范式）；`mcp-json.ts` 纯函数承担 JSON ⇄ 记录序列化/校验；后端 `mcp.repo.ts` 新增 `mcpServer:sync` 按 name 全量 diff 回写（复用现有 create/update/delete 的 McpManager 联动）与 `mcpServer:openHub` 外链。

**Tech Stack:** React 19 + shadcn/ui + Tailwind 4 + React Query + react-i18next + shiki（已在依赖中）+ Prisma 7（better-sqlite3）+ Vitest。

**Spec:** `docs/superpowers/specs/2026-09-30-connector-market-design.md`

## Global Constraints

- 禁止 JSX/逻辑中硬编码用户可见中英文，一律 `t()`；zh-CN 与 en-US 的 `ai.json` 同步新增 key；禁止同一 namespace 内顶层 key 与嵌套对象 key 重名。
- 禁止硬编码主题色（`bg-blue-*` 等），用 `bg-primary-subtle` / `text-primary` / `hover:border-primary/30` 等主题变量；弹窗 `border-border/50 rounded-lg shadow-lg`。
- 生产环境禁用 `console`/`debugger`（ESLint）。
- 文件名 kebab-case；函数 ≤20 行、单一职责；重复 ≥2 次抽函数。
- Prettier：双引号、分号、2 空格缩进、行宽 80、无尾随逗号（项目已有 .prettierrc，格式由 lint 保证）。
- 完成口径：`npm run typecheck`、`npm run lint`、`npm run test` 全绿。
- 提交信息风格：`feat(连接器): 中文描述`（对齐 git log 现有 conventional + 中文风格）。

---

### Task 1: mcp-json.ts 纯函数（序列化 / 校验 / 模板合入 / diff 判定）

**Files:**
- Create: `src-react/domains/ai/mcp/lib/mcp-json.ts`
- Test: `tests/ai/mcp-json.test.ts`

**Interfaces:**
- Consumes: `McpServerRecord`（`src-react/domains/ai/api/mcp.api.ts` 已有）。
- Produces（后续任务依赖，签名不得改动）:
  - `type McpServerJsonEntry = { command?: string; args?: string[] | string; env?: Record<string, string> | string; url?: string; headers?: Record<string, string> | string }`
  - `type McpServerSyncEntry = { transport: "stdio" | "http"; command?: string; args?: string; env?: string; url?: string; headers?: string }`（args/env/headers 已归一为 JSON 字符串，与 DB 列口径一致；不含 name——map 的 key 即 name；不含 enabled）
  - `function recordsToJsonText(records: McpServerRecord[]): string`
  - `function parseMcpConfig(raw: string): Record<string, McpServerSyncEntry>`（错误抛 `Error`，message 为 `"<CODE>:<detail>"` 错误码格式，见步骤 3 的错误码表）
  - `function mergeTemplate(text: string, template: Record<string, McpServerJsonEntry>): string`
  - `function syncParamsChanged(existing: { transport: string; command?: string | null; args?: string | null; env?: string | null; url?: string | null; headers?: string | null }, entry: McpServerSyncEntry): boolean`

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/mcp-json.test.ts`：

```ts
/**
 * mcp-json 纯函数测试：序列化（排序/双 transport/enabled 不出现）、
 * 解析（归一/transport 推断/类型校验/名称校验/行号定位）、模板合入、
 * diff 判定（canonical JSON 比较防键序误判）
 */
import { describe, expect, it } from "vitest";

import {
  mergeTemplate,
  parseMcpConfig,
  recordsToJsonText,
  syncParamsChanged,
} from "../../src-react/domains/ai/mcp/lib/mcp-json";
import type { McpServerRecord } from "../../src-react/domains/ai/api/mcp.api";

function record(partial: Partial<McpServerRecord>): McpServerRecord {
  return {
    id: 1,
    name: "demo",
    transport: "stdio",
    command: "npx",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("recordsToJsonText", () => {
  it("stdio 记录序列化为 command/args/env 原生对象形态", () => {
    const text = recordsToJsonText([
      record({
        name: "b",
        args: '["--port", "8080"]',
        env: '{"KEY":"value"}',
      }),
    ]);
    expect(JSON.parse(text)).toEqual({
      mcpServers: {
        b: { command: "npx", args: ["--port", "8080"], env: { KEY: "value" } },
      },
    });
  });

  it("http 记录序列化为 url/headers；输出按 name 字典序且不含 enabled", () => {
    const text = recordsToJsonText([
      record({ name: "z", transport: "http", command: undefined, url: "https://z.dev/mcp" }),
      record({ name: "a", transport: "http", command: undefined, url: "https://a.dev/mcp", headers: '{"Authorization":"Bearer t"}' }),
    ]);
    expect(Object.keys(JSON.parse(text).mcpServers)).toEqual(["a", "z"]);
    expect(JSON.parse(text).mcpServers.a).toEqual({
      url: "https://a.dev/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(text).not.toContain("enabled");
  });

  it("空记录集输出空 mcpServers 骨架", () => {
    expect(recordsToJsonText([])).toBe('{\n  "mcpServers": {}\n}');
  });

  it("坏 JSON 列省略字段不抛错", () => {
    const text = recordsToJsonText([record({ name: "x", args: "{broken" })]);
    expect(JSON.parse(text).mcpServers.x).toEqual({ command: "npx" });
  });
});

describe("parseMcpConfig", () => {
  it("归一：原生对象 → JSON 字符串列 + 推断 transport", () => {
    const result = parseMcpConfig(
      '{\n  "mcpServers": {\n    "a": { "command": "npx", "args": ["-y", "p"], "env": { "K": "v" } }\n  }\n}',
    );
    expect(result.a).toEqual({
      transport: "stdio",
      command: "npx",
      args: '["-y","p"]',
      env: '{"K":"v"}',
      url: undefined,
      headers: undefined,
    });
  });

  it("JSON 字符串口径的 args/env 同样接受并原样归一", () => {
    const result = parseMcpConfig(
      '{"mcpServers":{"h":{"url":"https://h.dev","headers":"{\\"A\\":\\"b\\"}"}}}',
    );
    expect(result.h).toEqual({
      transport: "http",
      url: "https://h.dev",
      headers: '{"A":"b"}',
      command: undefined,
      args: undefined,
      env: undefined,
    });
  });

  it("非法 JSON 抛带行号的 PARSE 错误码", () => {
    try {
      parseMcpConfig('{\n  "mcpServers": {\n');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("MCP_JSON_PARSE:3");
    }
  });

  it("顶层缺 mcpServers 抛 STRUCTURE 错误码", () => {
    expect(() => parseMcpConfig("{}")).toThrow("MCP_JSON_STRUCTURE:mcpServers");
  });

  it("command 与 url 同时缺失/同时存在抛 TRANSPORT 错误码", () => {
    expect(() => parseMcpConfig('{"mcpServers":{"a":{"command":"npx","url":"https://a"}}}')).toThrow(
      "MCP_ENTRY_TRANSPORT:a",
    );
    expect(() => parseMcpConfig('{"mcpServers":{"a":{}}}')).toThrow("MCP_ENTRY_TRANSPORT:a");
  });

  it("名称含连续下划线抛 NAME 错误码", () => {
    expect(() => parseMcpConfig('{"mcpServers":{"a__b":{"command":"npx"}}}')).toThrow(
      "MCP_NAME_INVALID:a__b",
    );
  });

  it("args 非字符串数组 / env 非字符串值对象 抛类型错误码", () => {
    expect(() => parseMcpConfig('{"mcpServers":{"a":{"command":"npx","args":["x",1]}}}')).toThrow(
      "MCP_ARGS_INVALID:a",
    );
    expect(() => parseMcpConfig('{"mcpServers":{"a":{"command":"npx","env":{"K":1}}}}')).toThrow(
      "MCP_ENV_INVALID:a",
    );
    expect(() => parseMcpConfig('{"mcpServers":{"a":{"url":"https://a","headers":"not json"}}}')).toThrow(
      "MCP_HEADERS_INVALID:a",
    );
  });
});

describe("mergeTemplate", () => {
  it("模板 key 不存在则插入，已存在则保留原值", () => {
    const merged = mergeTemplate(
      '{\n  "mcpServers": {\n    "feishu": { "command": "keep" }\n  }\n}',
      { feishu: { command: "skip" }, tushare: { url: "https://tushare/mcp" } },
    );
    const parsed = JSON.parse(merged);
    expect(parsed.mcpServers.feishu).toEqual({ command: "keep" });
    expect(parsed.mcpServers.tushare).toEqual({ url: "https://tushare/mcp" });
  });
});

describe("syncParamsChanged", () => {
  it("字段全等（含键序不同的 canonical JSON）判定未变", () => {
    expect(
      syncParamsChanged(
        { transport: "stdio", command: "npx", args: '["--a","--b"]', env: '{"X":"1"}' },
        { transport: "stdio", command: "npx", args: '["--a", "--b"]', env: '{"X":"1"}' },
      ),
    ).toBe(false);
  });

  it("canonical 键序不同但内容相同判定未变", () => {
    expect(
      syncParamsChanged(
        { transport: "stdio", command: "npx", env: '{"A":"1","B":"2"}' },
        { transport: "stdio", command: "npx", env: '{"B":"2","A":"1"}' },
      ),
    ).toBe(false);
  });

  it("任一字段实质变化判定已变", () => {
    expect(
      syncParamsChanged(
        { transport: "http", url: "https://a" },
        { transport: "http", url: "https://b" },
      ),
    ).toBe(true);
    expect(
      syncParamsChanged(
        { transport: "stdio", command: "npx" },
        { transport: "stdio", command: "npx", args: '["--x"]' },
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/ai/mcp-json.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

创建 `src-react/domains/ai/mcp/lib/mcp-json.ts`：

```ts
/**
 * mcp.json 风格配置 ⇄ McpServerRecord 纯函数（编辑器视图层与 sync 入参的桥）：
 * - recordsToJsonText：DB 记录 → 排序稳定的 mcp.json 文本（编辑器初始内容）
 * - parseMcpConfig：编辑器文本 → 校验归一后的 sync 入参（args/env/headers
 *   归一为 JSON 字符串列，与 DB 存储口径一致；enabled 不进 JSON）
 * - mergeTemplate：市场模板合入现有 JSON（同 key 保留原值）
 * - syncParamsChanged：sync diff 判定（canonical JSON 比较防键序误判）
 * 错误 message 统一 "<CODE>:<detail>"，UI 层按错误码 i18n 映射（详见弹窗组件）
 */
import type { McpServerRecord } from "../../api/mcp.api";

export interface McpServerJsonEntry {
  command?: string;
  args?: string[] | string;
  env?: Record<string, string> | string;
  url?: string;
  headers?: Record<string, string> | string;
}

/** sync 单条入参（key 即 name；transport 由 command/url 推断） */
export interface McpServerSyncEntry {
  transport: "stdio" | "http";
  command?: string;
  args?: string;
  env?: string;
  url?: string;
  headers?: string;
}

/** 安全 parse JSON 列：坏数据返回 undefined（展示不因脏列中断） */
function safeParse(raw?: string | null): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 浅拷贝并去掉值为 undefined 的 key */
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}

export function recordsToJsonText(records: McpServerRecord[]): string {
  const mcpServers: Record<string, McpServerJsonEntry> = {};
  for (const r of [...records].sort((a, b) => a.name.localeCompare(b.name))) {
    mcpServers[r.name] =
      r.transport === "stdio"
        ? compact({ command: r.command, args: safeParse(r.args), env: safeParse(r.env) })
        : compact({ url: r.url, headers: safeParse(r.headers) });
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** JSON.parse 失败的 position 换算行号（1 起） */
function errorLine(raw: string, e: unknown): number {
  const pos = /position (\d+)/.exec(e instanceof Error ? e.message : "")?.[1];
  if (!pos) {
    return 1;
  }
  return raw.slice(0, Number(pos)).split("\n").length;
}

function normalizeArray(name: string, field: string, raw: unknown): string | undefined {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  const ok =
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!ok) {
    throw new Error(`MCP_ARGS_INVALID:${name}`);
  }
  return value === undefined ? undefined : JSON.stringify(value);
}

function normalizeObject(code: string, name: string, raw: unknown): string | undefined {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  const ok =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string");
  if (!ok) {
    throw new Error(`${code}:${name}`);
  }
  return value === undefined ? undefined : JSON.stringify(value);
}

export function parseMcpConfig(raw: string): Record<string, McpServerSyncEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`MCP_JSON_PARSE:${errorLine(raw, e)}`);
  }
  const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error("MCP_JSON_STRUCTURE:mcpServers");
  }
  const result: Record<string, McpServerSyncEntry> = {};
  for (const [name, entryRaw] of Object.entries(servers)) {
    result[name] = parseEntry(name, entryRaw);
  }
  return result;
}

function parseEntry(name: string, entryRaw: unknown): McpServerSyncEntry {
  if (typeof entryRaw !== "object" || entryRaw === null) {
    throw new Error(`MCP_ENTRY_TRANSPORT:${name}`);
  }
  if (name.includes("__")) {
    throw new Error(`MCP_NAME_INVALID:${name}`);
  }
  const entry = entryRaw as McpServerJsonEntry;
  const command = nonEmpty(entry.command);
  const url = nonEmpty(entry.url);
  if (Boolean(command) === Boolean(url)) {
    throw new Error(`MCP_ENTRY_TRANSPORT:${name}`);
  }
  return {
    transport: command ? "stdio" : "http",
    command,
    args: normalizeArray(name, "args", entry.args),
    env: normalizeObject("MCP_ENV_INVALID", name, entry.env),
    url,
    headers: normalizeObject("MCP_HEADERS_INVALID", name, entry.headers),
  };
}

/** 非空字符串收窄（空串/空白视为未提供） */
function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function mergeTemplate(
  text: string,
  template: Record<string, McpServerJsonEntry>,
): string {
  const parsed = JSON.parse(text) as { mcpServers: Record<string, McpServerJsonEntry> };
  for (const [key, value] of Object.entries(template)) {
    parsed.mcpServers[key] ??= value;
  }
  return JSON.stringify(parsed, null, 2);
}

/** 与现有行比较连接参数是否实质变化（args/env/headers canonical 化后比较） */
export function syncParamsChanged(
  existing: {
    transport: string;
    command?: string | null;
    args?: string | null;
    env?: string | null;
    url?: string | null;
    headers?: string | null;
  },
  entry: McpServerSyncEntry,
): boolean {
  return (
    existing.transport !== entry.transport ||
    existing.command !== entry.command ||
    existing.url !== entry.url ||
    canonical(existing.args) !== canonical(entry.args) ||
    canonical(existing.env) !== canonical(entry.env) ||
    canonical(existing.headers) !== canonical(entry.headers)
  );
}

/** canonical JSON：parse 后重排序序列化；空/坏值统一 undefined */
function canonical(raw?: string | null): string | undefined {
  const value = safeParse(raw);
  return value === undefined ? undefined : JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
```

注意：`normalizeArray` 的 `field` 参数未用于错误信息（错误码统一 `MCP_ARGS_INVALID`），实现时删掉该参数保持无死参——最终签名为 `normalizeArray(name: string, raw: unknown)`，测试中 `args` 的三种错误都落在 `MCP_ARGS_INVALID`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- tests/ai/mcp-json.test.ts`
Expected: PASS（全部用例）。

注意 `args: '["--y","p"]'` 这类断言取决于 `JSON.stringify(["-y","p"])` 的紧凑输出（`["-y","p"]` 无空格）——实现里 `JSON.stringify(value)` 天然无空格，断言按此写。

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/mcp/lib/mcp-json.ts tests/ai/mcp-json.test.ts
git commit -m "feat(连接器): mcp-json 纯函数——记录集⇄mcp.json 序列化/校验归一/模板合入/diff 判定"
```

---

### Task 2: 后端 sync / openHub IPC + API 层

**Files:**
- Modify: `src-react/domains/ai/api/mcp.api.ts`（文件尾部 `McpServerApi` 类内加两方法；顶部 import 类型）
- Modify: `electron/domains/ai/mcp/mcp.repo.ts`（类内加 `sync`；构造器 `registerIpcHandlers` 加两条 handler；顶部 import `shell`）
- Modify: `electron/commons/ipc-channels.ts`（白名单 `mcpServer:statuses` 后加两行）
- Test: `tests/ai/mcp-sync.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `McpServerSyncEntry`、`syncParamsChanged`；`McpRepository` 现有 `create/update/delete`（含 McpManager 联动）。
- Produces:
  - `McpServerApi.sync(entries: Record<string, McpServerSyncEntry>): Promise<McpServerSyncResult>`
  - `McpServerApi.openHub(): Promise<void>`
  - `type McpServerSyncResult = { created: number; updated: number; deleted: number }`（在 mcp.api.ts 定义并导出）
  - 后端 `McpRepository.sync(entries, userId): Promise<McpServerSyncResult>`

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/mcp-sync.test.ts`：

```ts
/**
 * mcpServer:sync diff 回写测试：manager 缺省（undefined）退化为纯 CRUD，
 * 覆盖三分支（增/删/改）、同名参数未变跳过、enabled 保留库值、userId 隔离、
 * 计数返回；openHub 走 shell.openExternal（mock electron）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../electron/commons/ipc-user", () => ({ handleUser: vi.fn() }));
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { shell } from "electron";
import McpRepository from "../../electron/domains/ai/mcp/mcp.repo";

type Row = {
  id: number;
  userId: number | null;
  name: string;
  transport: string;
  command?: string | null;
  args?: string | null;
  env?: string | null;
  url?: string | null;
  headers?: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const table: Row[] = [];
let nextId = 1;

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    mcpServer: {
      findMany: vi.fn(async ({ where }: { where: { userId: number } }) =>
        table.filter((r) => r.userId === where.userId),
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: number; userId: number } }) =>
        table.find((r) => r.id === where.id && r.userId === where.userId),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: number } }) =>
        table.find((r) => r.id === where.id),
      ),
      create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        const row: Row = {
          id: nextId++,
          userId: null,
          name: "",
          transport: "stdio",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as Row;
        table.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
        const row = table.find((r) => r.id === where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: number } }) => {
        const idx = table.findIndex((r) => r.id === where.id);
        return table.splice(idx, 1)[0];
      }),
    },
  },
}));

function seed(partial: Partial<Row>): Row {
  const row: Row = {
    id: nextId++,
    userId: 1,
    name: "demo",
    transport: "stdio",
    command: "npx",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as Row;
  table.push(row);
  return row;
}

function makeRepo() {
  return new McpRepository(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await import("../../electron/commons/prisma-client")).default as any,
    undefined,
  );
}

beforeEach(() => {
  table.length = 0;
  nextId = 1;
  vi.clearAllMocks();
});

describe("McpRepository.sync", () => {
  it("新增（JSON 有/库无）→ create 且 enabled 默认 true", async () => {
    const repo = await makeRepo();
    const result = await repo.sync(
      { feishu: { transport: "stdio", command: "npx" } },
      1,
    );
    expect(result).toEqual({ created: 1, updated: 0, deleted: 0 });
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ name: "feishu", userId: 1, enabled: true });
  });

  it("删除（JSON 无/库有）→ delete", async () => {
    seed({ userId: 1, name: "old" });
    const repo = await makeRepo();
    const result = await repo.sync({}, 1);
    expect(result).toEqual({ created: 0, updated: 0, deleted: 1 });
    expect(table).toHaveLength(0);
  });

  it("同名参数变化 → update 且保留库内 enabled=false", async () => {
    seed({ userId: 1, name: "a", url: "https://old", transport: "http", enabled: false });
    const repo = await makeRepo();
    const result = await repo.sync(
      { a: { transport: "http", url: "https://new" } },
      1,
    );
    expect(result).toEqual({ created: 0, updated: 1, deleted: 0 });
    expect(table[0]).toMatchObject({ url: "https://new", enabled: false });
  });

  it("同名参数未变 → 跳过（updated=0）", async () => {
    seed({ userId: 1, name: "a", command: "npx", args: '["--x"]' });
    const repo = await makeRepo();
    const result = await repo.sync(
      { a: { transport: "stdio", command: "npx", args: '["--x"]' } },
      1,
    );
    expect(result).toEqual({ created: 0, updated: 0, deleted: 0 });
  });

  it("混合 diff：只触碰本人行（userId 隔离）", async () => {
    seed({ userId: 2, name: "other" });
    seed({ userId: 1, name: "mine", transport: "stdio", command: "old" });
    const repo = await makeRepo();
    const result = await repo.sync(
      { mine: { transport: "stdio", command: "new" }, fresh: { transport: "http", url: "https://f" } },
      1,
    );
    expect(result).toEqual({ created: 1, updated: 1, deleted: 0 });
    expect(table.find((r) => r.name === "other")).toBeTruthy();
    expect(table.find((r) => r.name === "mine")).toMatchObject({ command: "new" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/ai/mcp-sync.test.ts`
Expected: FAIL（`sync` 不是函数）。

- [ ] **Step 3: 实现 API 层**

`src-react/domains/ai/api/mcp.api.ts`：在 `McpServerStatus` 接口后加：

```ts
/** sync 结果计数（toast 汇总用） */
export interface McpServerSyncResult {
  created: number;
  updated: number;
  deleted: number;
}
```

`McpServerApi` 类内（`statuses` 方法后）加：

```ts
  /** JSON 编辑器保存：按 name 全量 diff 回写（增/改/删），返回计数 */
  static async sync(
    entries: Record<string, McpServerSyncEntry>,
  ): Promise<McpServerSyncResult> {
    return invoke<McpServerSyncResult>("mcpServer:sync", entries);
  }

  /** MCP Hub 外链（主进程写死白名单地址，渲染层不可传 URL） */
  static async openHub(): Promise<void> {
    return invoke<void>("mcpServer:openHub");
  }
```

文件顶部 import 区加：

```ts
import type { McpServerSyncEntry } from "../lib/mcp-json";
export type { McpServerSyncEntry } from "../lib/mcp-json";
```

- [ ] **Step 4: 实现后端 sync / openHub**

`electron/domains/ai/mcp/mcp.repo.ts`：

顶部 import 加（与现有 mcp.api 类型 import 相邻）：

```ts
import { shell } from "electron";
import { syncParamsChanged, type McpServerSyncEntry } from "../../../../src-react/domains/ai/mcp/lib/mcp-json";
import type { McpServerSyncResult } from "../../../../src-react/domains/ai/api/mcp.api";
```

类注释块下方加常量（模块级，import 之后）：

```ts
/** MCP Hub 外链地址（spec 假设：占位可替换；渲染层不传 URL 防任意跳转） */
const MCP_HUB_URL = "https://mcp.so";
```

`registerIpcHandlers` 末尾（`statuses` handler 后）加：

```ts
    handleUser("mcpServer:sync", (_, userId, entries: Record<string, McpServerSyncEntry>) =>
      this.sync(entries, userId),
    );
    handleUser("mcpServer:openHub", () => this.openHub());
```

类内加方法（`statuses` 方法后）：

```ts
  /** MCP Hub 外链（主进程写死地址，渲染层不可传 URL） */
  private async openHub(): Promise<void> {
    await shell.openExternal(MCP_HUB_URL);
  }

  /**
   * JSON 编辑器保存：与本人现有行按 name 全量 diff——
   * JSON 有/库无→create（enabled: true）；JSON 无/库有→delete；
   * 同名参数变→update（enabled 保留库值，参数变更不自动重连，语义同 update）。
   * 逐条复用 create/update/delete（内含 userId 归属校验与 McpManager 联动）；
   * 不包 $transaction——create 的 connect 为 fire-and-forget 不入事务，
   * 中途失败由下次 sync 重新 diff 自愈（编辑器内容即用户意图）
   */
  async sync(
    entries: Record<string, McpServerSyncEntry>,
    userId: number,
  ): Promise<McpServerSyncResult> {
    const rows = await this.prismaClient.mcpServer.findMany({
      where: { userId },
    });
    const byName = new Map(rows.map((row) => [row.name, row]));
    let created = 0;
    let updated = 0;
    let deleted = 0;
    for (const [name, entry] of Object.entries(entries)) {
      const existing = byName.get(name);
      if (!existing) {
        await this.create({ name, ...entry, enabled: true }, userId);
        created += 1;
        continue;
      }
      if (syncParamsChanged(existing, entry)) {
        await this.update(
          { id: existing.id, name, ...entry, enabled: existing.enabled },
          userId,
        );
        updated += 1;
      }
      byName.delete(name);
    }
    for (const row of byName.values()) {
      await this.delete(row.id, userId);
      deleted += 1;
    }
    return { created, updated, deleted };
  }
```

说明：spec 原文写「事务包裹」，实现改为逐条执行——`this.create` 内部混合行写与 fire-and-forget `connect`，无法整体入 `$transaction`；选择复用既有方法（DRY、联动逻辑零重复），失败自愈语义如注释。此偏差已在此记录。

`electron/commons/ipc-channels.ts`：在 `"mcpServer:statuses",` 后加：

```ts
  "mcpServer:sync",
  "mcpServer:openHub",
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test -- tests/ai/mcp-sync.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck 确认跨进程类型链无断点**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/ai/api/mcp.api.ts electron/domains/ai/mcp/mcp.repo.ts electron/commons/ipc-channels.ts tests/ai/mcp-sync.test.ts
git commit -m "feat(连接器): mcpServer:sync 按 name 全量 diff 回写 + openHub 白名单外链"
```

---

### Task 3: 市场 24 连接器静态数据 + i18n 描述

**Files:**
- Create: `src-react/domains/ai/mcp/lib/market-connectors.ts`
- Modify: `src-react/i18n/locales/zh-CN/ai.json`（`mcp` 节加 `connectors` 对象）
- Modify: `src-react/i18n/locales/en-US/ai.json`（同上）

**Interfaces:**
- Consumes: Task 1 的 `McpServerJsonEntry`。
- Produces:
  - `interface MarketConnector { id: string; name: string; icon: LucideIcon; template: McpServerJsonEntry }`
  - `const MARKET_CONNECTORS: MarketConnector[]`（24 项）
  - `id` 即模板 key 与「已添加」匹配键（DB `name === id` 视为已添加）；`name` 仅展示。

- [ ] **Step 1: 写数据模块**

创建 `src-react/domains/ai/mcp/lib/market-connectors.ts`：

```ts
/**
 * 连接器市场静态清单（PRD 24 项）：id 为 JSON 模板 key 与「已添加」匹配键
 * （DB name === id 即已添加），name 仅展示；图标用 lucide（无品牌资产版权）；
 * 模板为占位骨架（spec 假设：真实配置无公开权威来源，整体替换本文件即可）
 */
import {
  Bell,
  BookOpen,
  Building2,
  CandlestickChart,
  ClipboardList,
  Cloud,
  Database,
  Eye,
  Feather,
  FileSpreadsheet,
  FileText,
  Gift,
  GitBranch,
  Globe,
  HardDrive,
  KanbanSquare,
  Library,
  LineChart,
  Mail,
  MessageSquare,
  Newspaper,
  Scale,
  Search,
  TrendingUp,
  Video,
  type LucideIcon,
} from "lucide-react";

import type { McpServerJsonEntry } from "./mcp-json";

export interface MarketConnector {
  id: string;
  name: string;
  icon: LucideIcon;
  template: McpServerJsonEntry;
}

/** stdio 骨架：本地/CLI 型连接器 */
function stdio(pkg: string, envKey?: string): McpServerJsonEntry {
  return {
    command: "npx",
    args: ["-y", pkg],
    ...(envKey ? { env: { [envKey]: "YOUR_API_KEY" } } : {}),
  };
}

/** http 骨架：数据服务型连接器 */
function http(host: string): McpServerJsonEntry {
  return { url: `https://${host}/mcp`, headers: { Authorization: "Bearer YOUR_TOKEN" } };
}

export const MARKET_CONNECTORS: MarketConnector[] = [
  { id: "tongdaxin", name: "通达信", icon: TrendingUp, template: http("mcp.tongdaxin.example") },
  { id: "tencent-stock", name: "腾讯自选股", icon: LineChart, template: http("mcp.zixuangu.example") },
  { id: "qq-mail", name: "QQ邮箱", icon: Mail, template: stdio("qq-mail-mcp") },
  { id: "ima", name: "ima", icon: BookOpen, template: stdio("ima-mcp") },
  { id: "lexiang", name: "乐享知识库", icon: Library, template: stdio("lexiang-mcp", "LEXIANG_TOKEN") },
  { id: "tencent-docs", name: "腾讯文档", icon: FileText, template: stdio("tencent-docs-mcp", "TENCENT_DOCS_TOKEN") },
  { id: "tencent-meeting", name: "腾讯会议", icon: Video, template: stdio("tencent-meeting-mcp", "MEETING_SDK_ID") },
  { id: "wecom", name: "企业微信", icon: MessageSquare, template: stdio("wecom-mcp", "WECOM_CORP_ID") },
  { id: "feishu", name: "飞书", icon: Feather, template: stdio("@larksuiteoapi/lark-mcp", "FEISHU_APP_ID") },
  { id: "dingtalk", name: "钉钉", icon: Bell, template: stdio("dingtalk-mcp", "DINGTALK_TOKEN") },
  { id: "tencent-survey", name: "腾讯问卷", icon: ClipboardList, template: stdio("tencent-survey-mcp", "SURVEY_TOKEN") },
  { id: "tapd", name: "TAPD", icon: KanbanSquare, template: stdio("tapd-mcp", "TAPD_TOKEN") },
  { id: "neodata", name: "NeoData金融数据库", icon: Database, template: http("mcp.neodata.example") },
  { id: "cnb", name: "CNB", icon: GitBranch, template: stdio("cnb-mcp", "CNB_TOKEN") },
  { id: "weiyun", name: "微云", icon: Cloud, template: stdio("weiyun-mcp", "WEIYUN_TOKEN") },
  { id: "fubangshou", name: "福帮手", icon: Gift, template: stdio("fubangshou-mcp") },
  { id: "jinshan-docs", name: "金山文档|WPS云文档", icon: FileSpreadsheet, template: stdio("wps-mcp", "WPS_TOKEN") },
  { id: "beida-fabao", name: "北大法宝·法律智能检索", icon: Scale, template: http("mcp.pkulaw.example") },
  { id: "qichacha", name: "企查查", icon: Building2, template: http("mcp.qcc.example") },
  { id: "tianyancha", name: "天眼查", icon: Eye, template: http("mcp.tianyancha.example") },
  { id: "baidu-netdisk", name: "百度网盘", icon: HardDrive, template: http("mcp.netdisk.example") },
  { id: "tushare", name: "Tushare", icon: CandlestickChart, template: http("mcp.tushare.example") },
  { id: "dun-bradstreet", name: "邓白氏寰球全球", icon: Globe, template: http("mcp.dnb.example") },
  { id: "xinhua-finance", name: "新华财经资讯MCP", icon: Newspaper, template: http("mcp.xinhua.example") },
];
```

图标名与 lucide-react 实际导出以 `npm run typecheck` 为准：若无 `KanbanSquare` 用 `ListChecks`（TAPD），无 `CandlestickChart` 用 `BarChart3`（Tushare），并同步 import 列表。

- [ ] **Step 2: 加 i18n 描述**

`src-react/i18n/locales/zh-CN/ai.json` 的 `mcp` 对象内（与 `invalidName` 平级）加：

```json
"connectors": {
  "tongdaxin": { "description": "查询全球股票行情数据、条件选股、研报与自选股管理。" },
  "tencent-stock": { "description": "直连腾讯自选股，实时掌握毫秒级行情与持仓动态。" },
  "qq-mail": { "description": "收发、搜索和整理 QQ 邮件，用自然语言读取与回复邮件。" },
  "ima": { "description": "腾讯 AI 知识管家，连接后支持搜索、读取和写入个人知识库。" },
  "lexiang": { "description": "搜索、创建和管理乐享知识库中的文档与页面。" },
  "tencent-docs": { "description": "创建、编辑和协作腾讯文档，用自然语言管理在线文档。" },
  "tencent-meeting": { "description": "通过命令创建、查询和管理腾讯会议与日程。" },
  "wecom": { "description": "企业微信官方套件，覆盖消息、邮件、日程与通讯录能力。" },
  "feishu": { "description": "通过命令行管理飞书/Lark 全产品能力：文档、多维表格与消息。" },
  "dingtalk": { "description": "通过命令行管理钉钉全产品能力：AI 表格、待办与审批。" },
  "tencent-survey": { "description": "创建、管理和分析腾讯问卷，用自然语言设计问卷。" },
  "tapd": { "description": "管理需求、缺陷、任务和迭代，查询项目进度与报表。" },
  "neodata": { "description": "一键安装免费使用，面向投研分析的专业金融数据库。" },
  "cnb": { "description": "通过自然语言管理 CNB 平台：仓库、Issue 与流水线。" },
  "weiyun": { "description": "查看、下载、删除微云文件，并支持上传新文件。" },
  "fubangshou": { "description": "保留身份、场景、进度和礼包状态，跨会话延续服务。" },
  "jinshan-docs": { "description": "金山文档官方技能：对话即操作，知识一键存入云文档。" },
  "beida-fabao": { "description": "检索与核验一体：语义检索与关键词检索法律法规与案例。" },
  "qichacha": { "description": "查询和核实企业工商登记信息，支持股东结构与关联分析。" },
  "tianyancha": { "description": "查询多维度企业数据：工商、股权、风险与经营状况。" },
  "baidu-netdisk": { "description": "文件与分类浏览、关键词搜索，支持下载与上传网盘文件。" },
  "tushare": { "description": "金融数据服务，支持 A 股、指数、基金与宏观等多类数据。" },
  "dun-bradstreet": { "description": "通过自然语言查询邓白氏全球企业档案与商业信息。" },
  "xinhua-finance": { "description": "公告、新闻、政策数据，包含股票资讯与宏观经济信息。" }
},
```

`src-react/i18n/locales/en-US/ai.json` 同位置加（key 结构完全一致）：

```json
"connectors": {
  "tongdaxin": { "description": "Query global stock quotes, screen stocks, and manage research reports." },
  "tencent-stock": { "description": "Connect to Tencent stock watchlist with real-time quotes." },
  "qq-mail": { "description": "Send, search and organize QQ Mail; read and reply via natural language." },
  "ima": { "description": "Tencent AI knowledge assistant: search, read and write your knowledge base." },
  "lexiang": { "description": "Search, create and manage documents in Lexiang knowledge base." },
  "tencent-docs": { "description": "Create, edit and collaborate on Tencent Docs via natural language." },
  "tencent-meeting": { "description": "Create, query and manage Tencent Meetings from chat." },
  "wecom": { "description": "Official WeCom suite covering messaging, mail, calendar and contacts." },
  "feishu": { "description": "Manage all Feishu/Lark products: docs, base tables and messages." },
  "dingtalk": { "description": "Manage all DingTalk products: AI tables, todos and approvals." },
  "tencent-survey": { "description": "Create, manage and analyze Tencent Surveys via natural language." },
  "tapd": { "description": "Manage requirements, bugs, tasks and iterations; track progress." },
  "neodata": { "description": "Free professional financial database for investment research." },
  "cnb": { "description": "Manage CNB platform via natural language: repos, issues and pipelines." },
  "weiyun": { "description": "View, download and delete Weiyun files; upload new ones." },
  "fubangshou": { "description": "Keeps identity, scenario, progress and gift state across sessions." },
  "jinshan-docs": { "description": "Official Kingsoft Docs skill: act in chat, save to cloud docs." },
  "beida-fabao": { "description": "Search and verify laws, regulations and cases via semantic and keyword search." },
  "qichacha": { "description": "Query and verify business registration, shareholders and relations." },
  "tianyancha": { "description": "Query multi-dimension company data: registration, equity and risk." },
  "baidu-netdisk": { "description": "Browse and search files by category; download and upload." },
  "tushare": { "description": "Financial data service covering A-shares, indices, funds and macro." },
  "dun-bradstreet": { "description": "Query Dun & Bradstreet global company profiles via natural language." },
  "xinhua-finance": { "description": "Announcements, news and policy data incl. stock and macro info." }
},
```

- [ ] **Step 3: typecheck 验证**

Run: `npm run typecheck`
Expected: 无错误（若 lucide 图标名不存在会在此暴露，按 Step 1 备选替换）。

- [ ] **Step 4: Commit**

```bash
git add src-react/domains/ai/mcp/lib/market-connectors.ts src-react/i18n/locales/zh-CN/ai.json src-react/i18n/locales/en-US/ai.json
git commit -m "feat(连接器): 市场 24 连接器静态清单（lucide 图标 + 占位模板）与双语描述"
```

---

### Task 4: JsonConfigEditor 组件（行号 + shiki 高亮 overlay）

**Files:**
- Modify: `src-react/domains/ai/chat/components/CodeBlock.tsx`（`getHighlighter` 加 `export`）
- Create: `src-react/domains/ai/mcp/components/JsonConfigEditor.tsx`
- Test: `tests/ai/json-config-editor.test.tsx`

**Interfaces:**
- Consumes: CodeBlock 的共享 highlighter（`getHighlighter(lang: string): Promise<Highlighter | null>`，已存在，仅需导出）；shiki 双主题（github-light/github-dark，CSS 变量切换由现有 skins.css 承担）。
- Produces:
  - `export default function JsonConfigEditor({ value, onChange, invalid }: { value: string; onChange: (next: string) => void; invalid?: boolean }): JSX.Element`

- [ ] **Step 1: 导出共享 highlighter**

`src-react/domains/ai/chat/components/CodeBlock.tsx`：把 `async function getHighlighter(lang: string): Promise<Highlighter | null> {` 改为 `export async function getHighlighter(...)`（其余不动），并同步更新文件头注释中的函数说明为「共享（CodeBlock 与 JsonConfigEditor 复用）」。

- [ ] **Step 2: 写失败测试**

创建 `tests/ai/json-config-editor.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * JsonConfigEditor 测试：受控 value 渲染、输入回调上抛、invalid 红框类、
 * 行号随行数变化；shiki 懒加载异步，测试只断言同步渲染与回退纯文本
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/domains/ai/chat/components/CodeBlock", () => ({
  getHighlighter: vi.fn(async () => null),
}));

import JsonConfigEditor from "@/domains/ai/mcp/components/JsonConfigEditor";

describe("JsonConfigEditor", () => {
  it("渲染受控 value 并在输入时上抛 onChange", () => {
    const onChange = vi.fn();
    render(<JsonConfigEditor value={'{"mcpServers": {}}'} onChange={onChange} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue('{"mcpServers": {}}');
    fireEvent.change(textarea, { target: { value: "{}" } });
    expect(onChange).toHaveBeenCalledWith("{}");
  });

  it("行号 gutter 与内容行数一致", () => {
    const { container } = render(
      <JsonConfigEditor
        value={'{\n  "mcpServers": {\n    "a": {}\n  }\n}'}
        onChange={vi.fn()}
      />,
    );
    // gutter 带 aria-hidden（getByRole 会排除），用 DOM 查询
    const gutter = container.querySelector('div[role="presentation"]');
    expect(gutter?.textContent).toBe("12345");
  });

  it("invalid 时编辑器带红框类", () => {
    const { container } = render(
      <JsonConfigEditor value="not json" onChange={vi.fn()} invalid />,
    );
    expect(container.querySelector(".border-destructive")).toBeTruthy();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm run test -- tests/ai/json-config-editor.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 4: 写实现**

创建 `src-react/domains/ai/mcp/components/JsonConfigEditor.tsx`：

```tsx
/**
 * mcp.json 编辑器：textarea（前景透明）+ shiki 高亮 overlay + 自绘行号。
 * 高亮 200ms 防抖重绘；shiki 未就绪/失败时回退纯文本（escape 后原样展示）。
 * 对齐保证：overlay 与 textarea 共用 font-mono/text-[13px]/leading-6/
 * p-3 pl-12/whitespace-pre-wrap/break-all，gutter 固定 w-10
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { getHighlighter } from "../../chat/components/CodeBlock";
import { cn } from "@/lib/utils";

interface JsonConfigEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** JSON 非法时红框（由父层校验后传入） */
  invalid?: boolean;
}

/** 高亮未就绪时的回退：HTML 转义纯文本 */
function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export default function JsonConfigEditor({
  value,
  onChange,
  invalid,
}: JsonConfigEditorProps) {
  const [html, setHtml] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void (async () => {
        const highlighter = await getHighlighter("json");
        if (!highlighter) {
          setHtml(null);
          return;
        }
        const out = highlighter.codeToHtml(value, {
          lang: "json",
          themes: { light: "github-light", dark: "github-dark" },
        });
        setHtml(out);
      })();
    }, 200);
    return () => clearTimeout(timerRef.current);
  }, [value]);

  const lineNumbers = useMemo(
    () => value.split("\n").map((_, i) => i + 1).join(""),
    [value],
  );

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border bg-muted/30 font-mono text-[13px] leading-6",
        invalid ? "border-destructive" : "border-border/50",
      )}
    >
      <div
        role="presentation"
        aria-hidden
        className="absolute inset-y-0 left-0 z-10 w-10 select-none overflow-hidden border-r border-border/30 py-3 pr-2 text-right text-muted-foreground/60"
      >
        {lineNumbers}
      </div>
      {html !== null ? (
        <div
          aria-hidden
          className="pointer-events-none max-h-[55vh] overflow-hidden py-0 [&_code]:leading-6 [&_pre]:bg-transparent [&_pre]:p-3 [&_pre]:pl-12 [&_pre]:whitespace-pre-wrap [&_pre]:break-all"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div
          aria-hidden
          className="pointer-events-none max-h-[55vh] overflow-hidden whitespace-pre-wrap break-all p-3 pl-12"
        >
          {value}
        </div>
      )}
      <textarea
        role="textbox"
        spellCheck={false}
        aria-label="mcp.json"
        className="absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre-wrap break-all bg-transparent p-3 pl-12 font-mono text-[13px] leading-6 text-transparent caret-foreground outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
```

实现对齐说明：shiki `codeToHtml` 产物为 `<pre><code>...`，外层 div 用 Tailwind 任意选择器 `[&_pre]:p-3 [&_pre]:pl-12 ...` 强制 overlay 与 textarea 的 padding/换行/行高一致；textarea `text-transparent` + `caret-foreground` 让光标可见而字符隐藏，高亮层在下。overlay `max-h-[55vh] overflow-hidden` 与 textarea `overflow-auto` 同步滚动不可行（absolute 覆盖整体）——首版接受「编辑区整体高度随内容增长、外层 Dialog 内容滚动」的简单模型，textarea `overflow-auto` 仅为长内容兜底。行高一致性以 `[&_code]:leading-6` + 容器 `leading-6` 锁定。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test -- tests/ai/json-config-editor.test.tsx`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src-react/domains/ai/chat/components/CodeBlock.tsx src-react/domains/ai/mcp/components/JsonConfigEditor.tsx tests/ai/json-config-editor.test.tsx
git commit -m "feat(连接器): JSON 编辑器组件——行号 gutter + shiki overlay 高亮 + 非法红框"
```

---

### Task 5: McpManageDialog（列表态/空态/编辑态 + sync 保存流）

**Files:**
- Create: `src-react/domains/ai/mcp/components/McpManageDialog.tsx`
- Modify: `src-react/i18n/locales/zh-CN/ai.json`、`src-react/i18n/locales/en-US/ai.json`（`mcp` 节加 `manage` 与 `market` 中的保存/错误文案）
- Test: `tests/ai/mcp-manage-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 `parseMcpConfig/mergeTemplate/recordsToJsonText/McpServerJsonEntry`；Task 2 `McpServerApi.sync/openHub` 与既有 `McpServerApi.list/statuses/setEnabled/reconnect/delete`；Task 4 `JsonConfigEditor`；现 `McpServerDialog` 不动。
- Produces:
  - `export default function McpManageDialog({ open, onOpenChange, initialTemplate }: { open: boolean; onOpenChange: (open: boolean) => void; initialTemplate?: Record<string, McpServerJsonEntry> }): JSX.Element`
  - i18n key 前缀 `ai:mcp.manage.*` 与 `ai:mcp.market.*`（Task 6 复用 market 节）。

- [ ] **Step 1: 加 i18n 文案**

zh-CN `mcp` 节内（`connectors` 平级）加：

```json
"manage": {
  "title": "MCP 服务管理",
  "subtitle": "安装 MCP 服务，为 AI 扩展更多工具能力",
  "empty": "暂无 MCP 服务器",
  "emptyTip": "点击配置按钮添加 MCP 服务器",
  "configure": "配置",
  "backToList": "返回 MCP 列表",
  "save": "保存",
  "searchPlaceholder": "搜索 MCP",
  "searchMcp": "搜索 MCP"
},
"market": {
  "searchPlaceholder": "搜索连接器",
  "customConnector": "自定义连接器",
  "configureMcp": "配置 MCP",
  "added": "已添加",
  "add": "添加",
  "hub": "MCP Hub",
  "jsonSyncNote": "JSON 与已安装服务实时同步，保存后生效",
  "syncSaved": "保存成功（新增 {{created}} · 更新 {{updated}} · 移除 {{deleted}}）",
  "errParse": "第 {{value}} 行：JSON 格式错误，请检查",
  "errName": "「{{value}}」：名称不能包含连续下划线",
  "errTransport": "「{{value}}」：需提供 command（stdio）或 url（http）之一",
  "errArgs": "「{{value}}」：args 必须为字符串数组",
  "errEnv": "「{{value}}」：env 必须为字符串值对象",
  "errHeaders": "「{{value}}」：headers 必须为字符串值对象",
  "errStructure": "顶层缺少 mcpServers 对象"
}
```

en-US 同位置加：

```json
"manage": {
  "title": "MCP Services",
  "subtitle": "Install MCP services to extend AI tool capabilities",
  "empty": "No MCP server yet",
  "emptyTip": "Click Configure to add an MCP server",
  "configure": "Configure",
  "backToList": "Back to MCP list",
  "save": "Save",
  "searchPlaceholder": "Search MCP",
  "searchMcp": "Search MCP"
},
"market": {
  "searchPlaceholder": "Search connectors",
  "customConnector": "Custom connector",
  "configureMcp": "Configure MCP",
  "added": "Added",
  "add": "Add",
  "hub": "MCP Hub",
  "jsonSyncNote": "JSON syncs with installed services; takes effect after save",
  "syncSaved": "Saved ({{created}} added · {{updated}} updated · {{deleted}} removed)",
  "errParse": "Line {{value}}: invalid JSON, please check",
  "errName": "\"{{value}}\": name must not contain consecutive underscores",
  "errTransport": "\"{{value}}\": provide either command (stdio) or url (http)",
  "errArgs": "\"{{value}}\": args must be an array of strings",
  "errEnv": "\"{{value}}\": env must be an object of string values",
  "errHeaders": "\"{{value}}\": headers must be an object of string values",
  "errStructure": "Missing mcpServers object at top level"
}
```

- [ ] **Step 2: 写失败测试**

创建 `tests/ai/mcp-manage-dialog.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * McpManageDialog 测试：空态渲染与引导、配置按钮进编辑态、
 * 非法 JSON 保存不调 sync、合法 JSON 调 sync 并回列表态。
 * useQuery mock 为可控数据；McpServerApi 模块级 mock
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";

afterEach(cleanup);

const state = {
  servers: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<Record<string, unknown>>,
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: vi.fn(({ queryKey }) => ({
    data: queryKey[0] === "mcpServers" ? state.servers : state.statuses,
  })),
}));
vi.mock("@/domains/ai/chat/components/CodeBlock", () => ({
  getHighlighter: vi.fn(async () => null),
}));

const syncMock = vi.fn();
const openHubMock = vi.fn();
vi.mock("@/domains/ai/api/mcp.api", () => ({
  default: {
    list: vi.fn(),
    sync: syncMock,
    openHub: openHubMock,
    setEnabled: vi.fn(),
    reconnect: vi.fn(),
    delete: vi.fn(),
  },
}));

import McpManageDialog from "@/domains/ai/mcp/components/McpManageDialog";

beforeEach(() => {
  state.servers = [];
  state.statuses = [];
  vi.clearAllMocks();
});

function open() {
  render(<McpManageDialog open onOpenChange={vi.fn()} />);
}

describe("McpManageDialog", () => {
  it("空态：显示空文案与引导配置按钮，点击进入编辑态显示默认骨架", () => {
    open();
    expect(screen.getByText("ai:mcp.manage.empty")).toBeTruthy();
    // 空态下标题区与中央引导各有一个「配置」按钮，取第一个（标题区）
    const [configureBtn] = screen.getAllByRole("button", {
      name: "ai:mcp.manage.configure",
    });
    fireEvent.click(configureBtn);
    expect(screen.getByRole("textbox")).toHaveValue('{\n  "mcpServers": {}\n}');
  });

  it("列表态：已有服务器显示行（名称可见）", () => {
    state.servers = [
      { id: 1, name: "feishu", transport: "stdio", command: "npx", enabled: true },
    ];
    open();
    expect(screen.getByText("feishu")).toBeTruthy();
  });

  it("非法 JSON：保存不调 sync 并 toast 错误", async () => {
    syncMock.mockResolvedValue({ created: 0, updated: 0, deleted: 0 });
    open();
    const [configureBtn] = screen.getAllByRole("button", {
      name: "ai:mcp.manage.configure",
    });
    fireEvent.click(configureBtn);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "{ broken" } });
    fireEvent.click(screen.getByRole("button", { name: "ai:mcp.manage.save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("合法 JSON：调 sync、toast 成功并回列表态", async () => {
    syncMock.mockResolvedValue({ created: 1, updated: 0, deleted: 0 });
    open();
    const [configureBtn] = screen.getAllByRole("button", {
      name: "ai:mcp.manage.configure",
    });
    fireEvent.click(configureBtn);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: '{"mcpServers":{"a":{"command":"npx"}}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "ai:mcp.manage.save" }));
    await waitFor(() => expect(syncMock).toHaveBeenCalledWith({ a: { transport: "stdio", command: "npx", args: undefined, env: undefined, url: undefined, headers: undefined } }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // 回列表态：编辑器消失、标题回到 manage.title
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });
});
```

注意：第 3 例 `syncMock` 也给了 resolve 值——`vi.clearAllMocks()` 清实现，显式重设以防测试顺序耦合；断言依赖「校验前置、不达 IPC」而非 mock 拒绝。

- [ ] **Step 3: 运行测试确认失败**

Run: `npm run test -- tests/ai/mcp-manage-dialog.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 4: 写实现**

创建 `src-react/domains/ai/mcp/components/McpManageDialog.tsx`：

```tsx
/**
 * MCP 服务管理弹窗：列表态（已安装表格 + 空态插画）/ 编辑态（JSON 编辑器）。
 * 打开带 initialTemplate（市场 + 入口）直入编辑态并合入模板；
 * 保存流：parseMcpConfig 前端校验（错误码 → i18n）→ sync → invalidate 回列表态。
 * 行内启停/重连/删除迁自原 McpSettingsView；编辑统一走 JSON 编辑器（无行内编辑）
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, Plus, RefreshCw, Server, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import McpServerApi, {
  type McpServerRecord,
  type McpServerState,
  type McpServerStatus,
} from "../../api/mcp.api";
import { mapIpcError } from "../../chat/lib/error-message";
import {
  mergeTemplate,
  parseMcpConfig,
  recordsToJsonText,
  type McpServerJsonEntry,
} from "../lib/mcp-json";
import JsonConfigEditor from "./JsonConfigEditor";

const SERVERS_KEY = ["mcpServers"] as const;
const STATUSES_KEY = ["mcp-statuses"] as const;
const STATUS_POLL_MS = 3000;

/** 错误码 → i18n key（mcp-json 抛 "<CODE>:<detail>"） */
const ERROR_KEYS: Record<string, string> = {
  MCP_JSON_PARSE: "ai:mcp.market.errParse",
  MCP_JSON_STRUCTURE: "ai:mcp.market.errStructure",
  MCP_NAME_INVALID: "ai:mcp.market.errName",
  MCP_ENTRY_TRANSPORT: "ai:mcp.market.errTransport",
  MCP_ARGS_INVALID: "ai:mcp.market.errArgs",
  MCP_ENV_INVALID: "ai:mcp.market.errEnv",
  MCP_HEADERS_INVALID: "ai:mcp.market.errHeaders",
};

const STATE_CLASS: Record<McpServerState, string> = {
  connected: "text-primary",
  error: "text-destructive",
  connecting: "text-muted-foreground",
  disabled: "text-muted-foreground",
};

interface McpManageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 市场 + 入口携带的模板（打开即编辑态合入） */
  initialTemplate?: Record<string, McpServerJsonEntry>;
}

export default function McpManageDialog({
  open,
  onOpenChange,
  initialTemplate,
}: McpManageDialogProps) {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const serversQuery = useQuery({
    queryKey: SERVERS_KEY,
    queryFn: () => McpServerApi.list(),
  });
  const statusesQuery = useQuery({
    queryKey: STATUSES_KEY,
    queryFn: () => McpServerApi.statuses(),
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.state === "connecting")
        ? STATUS_POLL_MS
        : false,
  });

  const servers = serversQuery.data ?? [];
  const [mode, setMode] = useState<"list" | "edit">("list");
  const [jsonText, setJsonText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<McpServerRecord | null>(null);

  // 打开时按入口决定初始态：带模板直入编辑态并合入；否则列表态
  useEffect(() => {
    if (!open) {
      return;
    }
    const base = recordsToJsonText(servers);
    setJsonText(
      initialTemplate ? mergeTemplate(base, initialTemplate) : base,
    );
    setInvalid(false);
    setSearch("");
    setMode(initialTemplate ? "edit" : "list");
    // servers 为异步数据，打开时可能尚未就绪——就绪后重算初始文本（仅编辑态且未改动前）
    // 简化：以打开瞬间为准，编辑态文本由用户主导；列表态数据照常刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTemplate]);

  const statusById = new Map(
    (statusesQuery.data ?? []).map((status) => [status.id, status]),
  );
  const visibleServers = servers.filter((s) =>
    s.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: SERVERS_KEY });
    await queryClient.invalidateQueries({ queryKey: STATUSES_KEY });
  };

  const syncErrorMessage = (e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    const idx = raw.indexOf(":");
    const key = ERROR_KEYS[idx > 0 ? raw.slice(0, idx) : ""];
    return key ? t(key, { value: raw.slice(idx + 1) }) : mapIpcError(e);
  };

  const handleSave = async () => {
    if (saving) {
      return;
    }
    let entries: Record<string, ReturnType<typeof parseMcpConfig>[string]>;
    try {
      entries = parseMcpConfig(jsonText);
    } catch (e) {
      setInvalid(true);
      toast.error(syncErrorMessage(e));
      return;
    }
    setInvalid(false);
    setSaving(true);
    try {
      const result = await McpServerApi.sync(entries);
      await invalidate();
      toast.success(
        t("ai:mcp.market.syncSaved", {
          created: result.created,
          updated: result.updated,
          deleted: result.deleted,
        }),
      );
      setMode("list");
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (server: McpServerRecord, enabled: boolean) => {
    try {
      await McpServerApi.setEnabled(server.id, enabled);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleReconnect = async (server: McpServerRecord) => {
    try {
      await McpServerApi.reconnect(server.id);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleDelete = async () => {
    if (!deleting) {
      return;
    }
    try {
      await McpServerApi.delete(deleting.id);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden border border-border/50 rounded-lg shadow-lg p-0 sm:max-w-2xl">
        {mode === "list" ? (
          <ListPane
            servers={visibleServers}
            statusById={statusById}
            search={search}
            onSearch={setSearch}
            loading={serversQuery.isPending}
            onConfigure={() => setMode("edit")}
            onToggle={handleToggle}
            onReconnect={handleReconnect}
            onDelete={setDeleting}
            t={t}
          />
        ) : (
          <EditPane
            jsonText={jsonText}
            invalid={invalid}
            saving={saving}
            onChange={(v) => setJsonText(v)}
            onBack={() => setMode("list")}
            onSave={handleSave}
            t={t}
          />
        )}
      </DialogContent>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ai:mcp.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `${deleting.name} · ${t("ai:mcp.deleteConfirmDesc")}`
                : t("ai:mcp.deleteConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
```

同文件内（非导出）加两个子组件——`ListPane`（标题区 + 工具栏 + 表格行/空态）与 `EditPane`（顶部返回/取消/保存 + 说明文案 + JsonConfigEditor）。关键 JSX：

```tsx
function ListPane({ servers, statusById, search, onSearch, loading, onConfigure, onToggle, onReconnect, onDelete, t }: {
  servers: McpServerRecord[];
  statusById: Map<number, McpServerStatus>;
  search: string;
  onSearch: (v: string) => void;
  loading: boolean;
  onConfigure: () => void;
  onToggle: (server: McpServerRecord, enabled: boolean) => void;
  onReconnect: (server: McpServerRecord) => void;
  onDelete: (server: McpServerRecord) => void;
  t: (k: string) => string;
}) {
  return (
    <>
      <DialogHeader className="border-b border-border/50 p-5 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-base">
              {t("ai:mcp.manage.title")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              {t("ai:mcp.manage.subtitle")}
            </DialogDescription>
          </div>
          <Button size="sm" onClick={onConfigure}>
            <Plus className="mr-1 h-4 w-4" />
            {t("ai:mcp.manage.configure")}
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={t("ai:mcp.manage.searchPlaceholder")}
            className="h-8 flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            onClick={() => void McpServerApi.openHub()}
          >
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            {t("ai:mcp.market.hub")}
          </Button>
        </div>
      </DialogHeader>
      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {t("common:loading")}
          </p>
        ) : servers.length === 0 ? (
          <EmptyPane onConfigure={onConfigure} t={t} />
        ) : (
          <div className="space-y-2">
            {servers.map((server) => (
              <ServerRow
                key={server.id}
                server={server}
                status={statusById.get(server.id)}
                onToggle={onToggle}
                onReconnect={onReconnect}
                onDelete={onDelete}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
```

`EmptyPane`（空态：Server 图标 + 主副文案 + 居中配置按钮）：

```tsx
function EmptyPane({ onConfigure, t }: { onConfigure: () => void; t: (k: string) => string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-14 text-center">
      <Server className="h-12 w-12 text-muted-foreground/40" strokeWidth={1.5} />
      <div>
        <p className="text-sm font-medium">{t("ai:mcp.manage.empty")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("ai:mcp.manage.emptyTip")}
        </p>
      </div>
      <Button size="sm" variant="outline" className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30" onClick={onConfigure}>
        {t("ai:mcp.manage.configure")}
      </Button>
    </div>
  );
}
```

`ServerRow`（迁自原 McpSettingsView 的行：名称 + transport Badge + 状态 + 工具数 + Switch + 重连/删除 icon 钮，去掉编辑钮）：

```tsx
function ServerRow({ server, status, onToggle, onReconnect, onDelete, t }: {
  server: McpServerRecord;
  status?: McpServerStatus;
  onToggle: (server: McpServerRecord, enabled: boolean) => void;
  onReconnect: (server: McpServerRecord) => void;
  onDelete: (server: McpServerRecord) => void;
  t: (k: string) => string;
}) {
  return (
    <div className="bg-card flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{server.name}</span>
          <Badge variant="secondary">{t(`ai:mcp.${server.transport}`)}</Badge>
        </div>
        {status ? (
          <span
            className={`text-xs ${STATE_CLASS[status.state]}`}
            title={status.error}
          >
            {t(`ai:mcp.status.${status.state}`)} · {status.toolCount} {t("ai:mcp.tools")}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {server.enabled ? "—" : t("ai:mcp.status.disabled")}
          </span>
        )}
      </div>
      <Switch
        checked={server.enabled}
        onCheckedChange={(enabled) => onToggle(server, enabled)}
        aria-label={t("ai:mcp.enabled")}
      />
      {server.enabled && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-primary"
          onClick={() => onReconnect(server)}
          aria-label={t("ai:mcp.reconnect")}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-destructive"
        onClick={() => onDelete(server)}
        aria-label={t("common:delete")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
```

`EditPane`：

```tsx
function EditPane({ jsonText, invalid, saving, onChange, onBack, onSave, t }: {
  jsonText: string;
  invalid: boolean;
  saving: boolean;
  onChange: (v: string) => void;
  onBack: () => void;
  onSave: () => void;
  t: (k: string) => string;
}) {
  return (
    <>
      <DialogHeader className="border-b border-border/50 p-5 pb-4">
        <div className="flex items-center justify-between gap-4">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 hover:bg-primary-subtle hover:text-primary"
            onClick={onBack}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("ai:mcp.manage.backToList")}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={onBack}>
              {t("common:cancel")}
            </Button>
            <Button size="sm" className="h-8" disabled={saving} onClick={onSave}>
              {t("ai:mcp.manage.save")}
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("ai:mcp.market.jsonSyncNote")}
        </p>
      </DialogHeader>
      <div className="flex-1 overflow-y-auto p-5">
        <JsonConfigEditor value={jsonText} onChange={onChange} invalid={invalid} />
      </div>
    </>
  );
}
```

注意事项：
- `t` 传参类型写 `(k: string) => string` 会丢插值重载，`handleSave` 内 `t("ai:mcp.market.syncSaved", {...})` 用 hook 的原始 `t`；子组件 prop 类型可放宽为 `TFunction`（`import type { TFunction } from "i18next"`），实现时统一用 `TFunction` 避免类型收窄报错。
- `handleSave` 里 `ReturnType<typeof parseMcpConfig>[string]` 直接写 `Record<string, McpServerSyncEntry>` 更清晰——import `type McpServerSyncEntry` 使用之。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test -- tests/ai/mcp-manage-dialog.test.tsx`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src-react/domains/ai/mcp/components/McpManageDialog.tsx src-react/i18n/locales/zh-CN/ai.json src-react/i18n/locales/en-US/ai.json tests/ai/mcp-manage-dialog.test.tsx
git commit -m "feat(连接器): MCP 服务管理弹窗——列表/空态/JSON 编辑三态与 sync 保存流"
```

---

### Task 6: ConnectorMarketView + 挂载 + 删除旧视图

**Files:**
- Create: `src-react/domains/ai/mcp/components/ConnectorCard.tsx`
- Create: `src-react/domains/ai/mcp/views/ConnectorMarketView.tsx`
- Modify: `src-react/domains/ai/experts/views/ExpertsView.tsx:14,92`（import 与挂载换新视图）
- Delete: `src-react/domains/ai/mcp/views/McpSettingsView.tsx`
- Test: `tests/ai/connector-market.test.tsx`

**Interfaces:**
- Consumes: Task 3 `MARKET_CONNECTORS/MarketConnector`；Task 5 `McpManageDialog`；既有 `McpServerDialog`、`McpServerApi.list`；i18n `ai:mcp.market.*`（Task 5 已加）。
- Produces: `export default function ConnectorMarketView(): JSX.Element`（ExpertsView 挂载）。

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/connector-market.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * ConnectorMarketView 测试：渲染 24 卡片、搜索过滤、
 * 已添加卡片按钮为 Check 禁用、未添加点击 + 打开管理弹窗（编辑态带模板）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

afterEach(cleanup);

const state = { servers: [] as Array<Record<string, unknown>> };

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: vi.fn(() => ({ data: state.servers })),
}));
vi.mock("@/domains/ai/chat/components/CodeBlock", () => ({
  getHighlighter: vi.fn(async () => null),
}));
vi.mock("@/domains/ai/api/mcp.api", () => ({
  default: { list: vi.fn(), sync: vi.fn(), openHub: vi.fn() },
}));

import ConnectorMarketView from "@/domains/ai/mcp/views/ConnectorMarketView";
import { MARKET_CONNECTORS } from "@/domains/ai/mcp/lib/market-connectors";

beforeEach(() => {
  state.servers = [];
});

describe("ConnectorMarketView", () => {
  it("渲染全部 24 张卡片", () => {
    render(<ConnectorMarketView />);
    for (const c of MARKET_CONNECTORS) {
      expect(screen.getByText(c.name)).toBeTruthy();
    }
  });

  it("搜索过滤：仅匹配项可见", () => {
    render(<ConnectorMarketView />);
    fireEvent.change(screen.getByPlaceholderText("ai:mcp.market.searchPlaceholder"), {
      target: { value: "飞书" },
    });
    expect(screen.getByText("飞书")).toBeTruthy();
    expect(screen.queryByText("钉钉")).toBeNull();
  });

  it("已添加（DB name === id）按钮禁用且带 added 文案", () => {
    state.servers = [{ id: 1, name: "feishu", transport: "stdio", enabled: true }];
    render(<ConnectorMarketView />);
    const feishuBtn = screen.getByRole("button", { name: "ai:mcp.market.added 飞书" });
    expect(feishuBtn).toHaveProperty("disabled", true);
  });

  it("未添加点击 + 打开管理弹窗并进入编辑态（预填模板可见）", () => {
    render(<ConnectorMarketView />);
    fireEvent.click(screen.getByRole("button", { name: "ai:mcp.market.add 飞书" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("textbox")).toBeTruthy();
    expect(within(dialog).getByRole("textbox")).toHaveValue(
      expect.stringContaining("feishu"),
    );
  });
});
```

注意「已添加」按钮的 `aria-label` 组装方式由实现决定——实现里统一 `aria-label={t("ai:mcp.market.added") + " " + connector.name}` / `t("ai:mcp.market.add") + " " + connector.name`，测试按此断言。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- tests/ai/connector-market.test.tsx`
Expected: FAIL（视图不存在）。

- [ ] **Step 3: 写 ConnectorCard**

创建 `src-react/domains/ai/mcp/components/ConnectorCard.tsx`：

```tsx
/**
 * 市场连接器卡（对齐 SkillHubCard 范式）：lucide 图标主题色块 + 名称 +
 * i18n 描述 line-clamp-3 + 右上三态钮（+ 添加 / Check 已添加禁用——
 * 与 SkillHubCard 的 Loader 态不同：本市场点 + 是同步打开弹窗，无异步过程）
 */
import { useTranslation } from "react-i18next";
import { Check, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { MarketConnector } from "../lib/market-connectors";

export default function ConnectorCard({
  connector,
  added,
  onAdd,
}: {
  connector: MarketConnector;
  added: boolean;
  onAdd: (connector: MarketConnector) => void;
}) {
  const { t } = useTranslation(["ai"]);
  const Icon = connector.icon;
  const label = `${added ? t("ai:mcp.market.added") : t("ai:mcp.market.add")} ${connector.name}`;

  return (
    <Card className="flex flex-col border-border/50 rounded-lg shadow-sm transition-colors hover:border-primary/30">
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between">
          <div className="bg-primary-subtle text-primary flex h-9 w-9 items-center justify-center rounded-lg">
            <Icon className="h-5 w-5" />
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={added}
            aria-label={label}
            className={cn(
              "h-8 w-8 p-0 hover:bg-primary-subtle",
              added ? "text-muted-foreground" : "hover:text-primary",
            )}
            onClick={() => onAdd(connector)}
          >
            {added ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-sm font-medium">{connector.name}</p>
        <p className="line-clamp-3 min-h-10 text-xs leading-5 text-muted-foreground">
          {t(`ai:mcp.connectors.${connector.id}.description`)}
        </p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: 写 ConnectorMarketView**

创建 `src-react/domains/ai/mcp/views/ConnectorMarketView.tsx`：

```tsx
/**
 * 连接器市场：工具栏（搜索 / 自定义连接器→结构化表单 / 配置 MCP→管理弹窗）
 * + 24 卡片响应式网格（2/3/4 列）。已添加判定：DB name === 市场 id
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import McpServerApi from "../../api/mcp.api";
import { mapIpcError } from "../../chat/lib/error-message";
import type { McpServerJsonEntry } from "../lib/mcp-json";
import { MARKET_CONNECTORS, type MarketConnector } from "../lib/market-connectors";
import ConnectorCard from "../components/ConnectorCard";
import McpManageDialog from "../components/McpManageDialog";
import McpServerDialog from "../components/McpServerDialog";

const SERVERS_KEY = ["mcpServers"] as const;

export default function ConnectorMarketView() {
  const { t, i18n } = useTranslation(["ai", "common"]);
  const [search, setSearch] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [manageTemplate, setManageTemplate] = useState<
    Record<string, McpServerJsonEntry> | undefined
  >();
  const [customOpen, setCustomOpen] = useState(false);

  const serversQuery = useQuery({
    queryKey: SERVERS_KEY,
    queryFn: () => McpServerApi.list(),
  });
  const installedIds = useMemo(
    () => new Set((serversQuery.data ?? []).map((server) => server.name)),
    [serversQuery.data],
  );

  const keyword = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      MARKET_CONNECTORS.filter(
        (c) =>
          c.name.toLowerCase().includes(keyword) ||
          i18n
            .t(`ai:mcp.connectors.${c.id}.description`)
            .toLowerCase()
            .includes(keyword),
      ),
    [keyword, i18n],
  );

  const openManage = (template?: Record<string, McpServerJsonEntry>) => {
    setManageTemplate(template);
    setManageOpen(true);
  };

  const openAdd = (connector: MarketConnector) => {
    openManage({ [connector.id]: connector.template });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("ai:mcp.market.searchPlaceholder")}
            className="pl-8"
          />
        </div>
        <Button
          variant="outline"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() => setCustomOpen(true)}
        >
          <Plus className="mr-1 h-4 w-4" />
          {t("ai:mcp.market.customConnector")}
        </Button>
        <Button
          variant="outline"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() => openManage()}
        >
          <Settings2 className="mr-1 h-4 w-4" />
          {t("ai:mcp.market.configureMcp")}
        </Button>
      </div>

      {serversQuery.isError ? (
        <p className="py-10 text-center text-sm text-destructive">
          {mapIpcError(serversQuery.error)}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {visible.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              added={installedIds.has(connector.id)}
              onAdd={openAdd}
            />
          ))}
        </div>
      )}

      <McpManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        initialTemplate={manageTemplate}
      />
      <McpServerDialog open={customOpen} onOpenChange={setCustomOpen} />
    </div>
  );
}
```

- [ ] **Step 5: 挂载新视图、删旧视图**

`src-react/domains/ai/experts/views/ExpertsView.tsx`：
- 第 14 行 `import McpSettingsView from "../../mcp/views/McpSettingsView";` → `import ConnectorMarketView from "../../mcp/views/ConnectorMarketView";`
- 第 92 行 `{tab === "connectors" && <McpSettingsView />}` → `{tab === "connectors" && <ConnectorMarketView />}`
- 顶部文件注释中「连接器=MCP」字样改为「连接器=连接器市场」。

删除旧文件：

```bash
git rm src-react/domains/ai/mcp/views/McpSettingsView.tsx
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm run test -- tests/ai/connector-market.test.tsx`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/ai/mcp/components/ConnectorCard.tsx src-react/domains/ai/mcp/views/ConnectorMarketView.tsx src-react/domains/ai/experts/views/ExpertsView.tsx tests/ai/connector-market.test.tsx
git commit -m "feat(连接器): 市场视图替换服务器表格——24 卡片网格/搜索/添加直达 JSON 编辑"
```

---

### Task 7: 全量验证与手动验收

**Files:** 无新增（验证任务）。

- [ ] **Step 1: 全量静态检查与测试**

```bash
npm run typecheck
npm run lint
npm run test
```

Expected: 三项全绿；`grep -rn "McpSettingsView" src-react tests` 无输出。

- [ ] **Step 2: 手动验收（npm run dev）**

启动应用进入「专家 → 连接器」逐项核对：

1. 市场显示 24 卡片，2/3/4 列随窗口宽度切换；搜索「飞书」只剩飞书卡。
2. 点飞书卡 `+`：弹窗直入编辑态，JSON 含 `feishu` 模板（`YOUR_API_KEY` 占位可见）；保存 → toast 计数、回列表态、市场飞书卡变 Check。
3. 弹窗列表态：飞书行显示连接状态（connecting 轮询收敛 connected/error）、启停 Switch、重连、删除确认。
4. 编辑器手改 JSON：破坏格式保存 → toast 报行号 + 红框；修好后保存成功。
5. 「⊕ 自定义连接器」打开结构化表单，新建一个 http 服务，保存后弹窗列表出现。
6. JSON 里删掉该服务保存 → 列表与市场状态同步消失。
7. 「MCP Hub」按钮打开系统浏览器。
8. 切换主题（蓝/红/绿/橙）确认卡片色块、弹窗高亮、hover 色全部跟随；切换语言确认全部文案双语。

- [ ] **Step 3: 收尾提交（如有零星修正）**

```bash
git add -A
git commit -m "fix(连接器): 市场重构收尾修正——验收问题清零"
```

---

## Self-Review 记录

- **Spec 覆盖**：市场视图（Task 3/6）、弹窗三态（Task 5）、JSON 编辑器（Task 4）、sync 协议（Task 1/2）、openHub（Task 2）、i18n 双语（Task 3/5）、删除旧视图（Task 6）、测试策略（Task 1/2/4/5/6 + Task 7 全绿口径）——逐节有对应任务。
- **已知偏差（已在计划内记录）**：sync 不包 $transaction（复用 create/update/delete 的联动语义优先，失败自愈）；市场 `+` 无 Loader 中间态（同步打开弹窗，无异步）；PRD 路径提示改说明文案、Hub 网络探测不做（spec 已拍板）。
- **类型一致性**：`McpServerSyncEntry`/`McpServerJsonEntry` 定义于 Task 1，Task 2/3/5/6 均自此 import；`McpServerSyncResult` 定义于 Task 2 的 mcp.api.ts，repo 返回同构对象。
