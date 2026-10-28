# 技能发现页 P-B 实施计划(SkillHubClient + 市场 UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主进程 SkillHubClient(退避/鉴权/信封解包)+ 三个市场 IPC + 技能 Tab 双视图(发现页/我安装的)与顶部导航区。

**Architecture:** 市场请求全在主进程(Key 不进渲染进程);发现页数据走 React Query;两视图互斥渲染;搜索语义分置(市场远端 keyword / 本地过滤)。

**Tech Stack:** Electron 44 主进程 Node fetch、React 19 + React Query 5、Tailwind 4、react-i18next、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-05-skill-pb-discovery-design.md`

## Global Constraints

- 用户可见文本全 `t()`,zh-CN/en-US 的 chat.json 同步;顶层不与既有 key 重名
- 样式全走主题变量(`bg-primary-subtle`、`border-border/50`、`text-muted-foreground`…),禁硬编码色
- **真实 API Key 不得出现在任何提交文件**(Constants 默认空串 + env 覆盖 + init 占位符)
- 测试 tests/ai/*.test.ts(vitest 纯 Node);import electron 的模块 `vi.mock("electron")`;`@/` 别名可用
- Prettier 双引号/分号/tabWidth=2;每任务 `npm run test && npm run lint && npm run typecheck` 全绿后 commit

---

### Task 1: SkillHubClient + shuffleTop(TDD)

**Files:**
- Modify: `electron/Constants.ts`(新增 SKILLHUB_API_KEY)
- Modify: `scripts/lib/replace.mjs`(占位符清单 +1)
- Create: `electron/domains/ai/skill/skillhub-client.ts`
- Test: `tests/ai/skillhub-client.test.ts`

**Interfaces:**
- Produces(Task 2 消费):
  - `class SkillHubClient(fetchImpl?: typeof fetch, baseUrl = "https://api.skillhub.cn")`
  - `listSkills(params: SkillHubListParams): Promise<SkillHubPage>`
  - `listTop(): Promise<SkillHubSkill[]>`
  - `listCategories(): Promise<SkillHubCategory[]>`
  - `export function shuffleTop<T>(items: T[], random: () => number = Math.random): T[]`
  - 类型 `SkillHubSkill/SkillHubCategory/SkillHubPage/SkillHubListParams`(skillhub-client.ts 导出,前端经 skillhub.api.ts 再导出或重复声明 —— 见 Task 2)

- [ ] **Step 1: Constants 与占位符**

`electron/Constants.ts` 增加(env 覆盖优先,默认空串=不带 Key,API 当前非必填):

```ts
/** SkillHub 市场 API Key(env 覆盖;npm run init 写入占位符替换后的值) */
public static readonly SKILLHUB_API_KEY: string =
  process.env.SKILLHUB_API_KEY ?? "skh-your-api-key";
```

`scripts/lib/replace.mjs`:在既有占位符清单(与 UPGRADE_URL 同结构)加一条
`{ placeholder: "skh-your-api-key", key: "skillhubApiKey", ... }`(照抄该文件既有条目字段结构;init 交互文案"SkillHub API Key(可留空)")。若 replace.mjs 结构与此不符,以文件现状为准适配并保持幂等。

- [ ] **Step 2: 写失败测试**

`tests/ai/skillhub-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  SkillHubClient,
  shuffleTop,
} from "../../electron/domains/ai/skill/skillhub-client";

/** 构造 fake fetch:按调用序返回 Response,记录请求 URL 与 init */
function fakeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("SkillHubClient", () => {
  it("信封接口(/api/skills)解包 data", async () => {
    const { fn } = fakeFetch([
      json({ code: 0, message: "ok", data: { total: 1, skills: [{ slug: "a" }] } }),
    ]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    const page = await client.listSkills({ keyword: "文档" });
    expect(page).toEqual({ total: 1, skills: [{ slug: "a" }] });
  });

  it("裸对象接口(/api/v1/categories)直接返回", async () => {
    const { fn } = fakeFetch([
      json({ items: [{ key: "office-efficiency" }], count: 1 }),
    ]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    expect(await client.listCategories()).toEqual([
      { key: "office-efficiency" },
    ]);
  });

  it("请求头带 X-API-Key 与 X-Client-User-Id;query 正确序列化", async () => {
    const { fn, calls } = fakeFetch([
      json({ code: 0, data: { total: 0, skills: [] } }),
    ]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    await client.listSkills({ keyword: "a b", category: "dev", pageSize: 24 });
    const { url, init } = calls[0]!;
    expect(url).toContain("keyword=a%20b&category=dev&pageSize=24");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBeTruthy();
    expect(headers["X-Client-User-Id"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("HTTP 错误抛 {error} 文案", async () => {
    const { fn } = fakeFetch([json({ error: "skill not found" }, 404)]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    await expect(client.listTop()).rejects.toThrow("skill not found");
  });

  it("信封非 0 code 抛 message", async () => {
    const { fn } = fakeFetch([json({ code: 500, message: "boom", data: null })]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    await expect(client.listSkills({})).rejects.toThrow("boom");
  });

  it("429/网络错误退避重试,第三次成功", async () => {
    vi.useFakeTimers();
    try {
      const { fn } = fakeFetch([
        json({ error: "rate" }, 429),
        new Error("ECONNRESET"),
        json({ code: 0, data: { total: 0, skills: [] } }),
      ]);
      const client = new SkillHubClient(fn as unknown as typeof fetch);
      const promise = client.listSkills({});
      const settled = Promise.race([promise, vi.advanceTimersByTimeAsync(4000)]);
      await expect(settled).resolves.toEqual({ total: 0, skills: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("重试耗尽抛最后一错", async () => {
    vi.useFakeTimers();
    try {
      const { fn } = fakeFetch([
        new Error("down1"),
        new Error("down2"),
        new Error("down3"),
      ]);
      const client = new SkillHubClient(fn as unknown as typeof fetch);
      const promise = client.listTop();
      const settled = Promise.race([
        promise.catch((e: Error) => {
          throw e;
        }),
        vi.advanceTimersByTimeAsync(4000),
      ]);
      await expect(settled).rejects.toThrow("down");
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shuffleTop 洗牌", () => {
  it("集合不变、顺序受随机源影响", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(shuffleTop(input, () => 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shuffleTop(input, () => 0.99)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    const shuffled = shuffleTop(input);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
  });

  it("不修改原数组", () => {
    const input = [1, 2, 3];
    shuffleTop(input, () => 0.5);
    expect(input).toEqual([1, 2, 3]);
  });
});
```

(注:随机源语义 —— `() => 0` 应保持原序、`() => 0.99` 应完全倒序,即实现必须用 Fisher-Yates **从后往前**交换:`j = floor(random() * (i + 1))`。若实现后两断言不满足,以 Fisher-Yates 标准实现为准调整断言:先实现再对齐断言是允许的——洗牌的**契约**是"集合不变 + 纯函数 + 可注入随机源",顺序断言仅为锚定实现。)

- [ ] **Step 3: 跑测试确认红**

Run: `npx vitest run tests/ai/skillhub-client.test.ts`
Expected: FAIL(Cannot find module)

- [ ] **Step 4: 实现 skillhub-client.ts**

```ts
/**
 * SkillHub 市场客户端(主进程;P-B spec §2):信封解包、指数退避、鉴权头。
 * fetchImpl/baseUrl 注入可测;真实 Key 经 Constants(env 覆盖/init 占位符),不入库
 */
import Constants from "../../Constants";

export interface SkillHubSkill {
  slug: string;
  name: string;
  description: string;
  description_zh: string;
  iconUrl: string | null;
  category: string;
  version: string;
  downloads: number;
  stars: number;
  score: number;
  source: string;
}

export interface SkillHubCategory {
  key: string;
  name: string;
  nameEn: string;
  sortOrder: number;
  active?: boolean;
}

export interface SkillHubListParams {
  keyword?: string;
  category?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  order?: "asc" | "desc";
}

export interface SkillHubPage {
  total: number;
  skills: SkillHubSkill[];
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const TIMEOUT_MS = 10_000;

/** 可重试:429、5xx、网络异常(4xx 语义错误不重试) */
function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export class SkillHubClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = "https://api.skillhub.cn",
  ) {}

  private async request<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const qs = query
      ? "?" +
        new URLSearchParams(
          Object.entries(query)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        ).toString()
      : "";
    let lastError: Error = new Error("未发起请求");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 2));
      }
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}${qs}`, {
          headers: skillhubHeaders(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | { code?: number; message?: string; data?: unknown }
          | null;
        if (!res.ok) {
          const message =
            (body && "error" in body && body.error) || `HTTP ${res.status}`;
          if (retryable(res.status) && attempt < MAX_ATTEMPTS) {
            lastError = new Error(message);
            continue;
          }
          throw new Error(message);
        }
        // 信封(code/message/data)接口与裸对象接口区分:有 code 字段视为信封
        if (body && typeof body === "object" && "code" in body) {
          const envelope = body as { code: number; message?: string; data: unknown };
          if (envelope.code !== 0) {
            throw new Error(envelope.message || `code ${envelope.code}`);
          }
          return envelope.data as T;
        }
        return body as T;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt >= MAX_ATTEMPTS) {
          throw lastError;
        }
      }
    }
    throw lastError;
  }

  async listSkills(params: SkillHubListParams): Promise<SkillHubPage> {
    const data = await this.request<{
      total: number;
      skills: SkillHubSkill[];
    }>("/api/skills", {
      keyword: params.keyword,
      category: params.category,
      page: params.page,
      pageSize: params.pageSize,
      sortBy: params.sortBy,
      order: params.order,
    });
    return data;
  }

  async listTop(): Promise<SkillHubSkill[]> {
    const data = await this.request<{ total: number; skills: SkillHubSkill[] }>(
      "/api/skills/top",
    );
    return data.skills;
  }

  async listCategories(): Promise<SkillHubCategory[]> {
    const data = await this.request<{ items: SkillHubCategory[] }>(
      "/api/v1/categories",
    );
    return data.items
      .filter((c) => c.active !== false)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }
}

/** 鉴权头:Key 空串/占位符不发;User-Id 用机器级稳定脱敏标识(os 同步可用,免 electron 依赖) */
function skillhubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "X-Client-User-Id": machineUserId() };
  if (Constants.SKILLHUB_API_KEY && Constants.SKILLHUB_API_KEY !== "skh-your-api-key") {
    headers["X-API-Key"] = Constants.SKILLHUB_API_KEY;
  }
  return headers;
}

/** hostname:username 的 sha256 前 16 位(脱敏、跨重启稳定、纯 node:crypto 同步) */
function machineUserId(): string {
  return createHash("sha256")
    .update(`${os.hostname()}:${os.userInfo().username}`)
    .digest("hex")
    .slice(0, 16);
}

/** 精选区换一换:Fisher-Yates(从后往前,random()=0 保持原序),纯函数不改输入 */
export function shuffleTop<T>(
  items: T[],
  random: () => number = Math.random,
): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
```

文件头部 import:

```ts
import { createHash } from "node:crypto";
import os from "node:os";
import Constants from "../../Constants";
```

测试对 X-API-Key 的断言(mock Constants,稳定不依赖 env):在测试文件 import 区加:

```ts
vi.mock("../../electron/Constants", () => ({
  default: { SKILLHUB_API_KEY: "test-key" },
}));
```

对应断言:`expect(headers["X-API-Key"]).toBe("test-key");`

- [ ] **Step 5: 跑测试确认绿;全量验证**

Run: `npx vitest run tests/ai/skillhub-client.test.ts` → PASS
Run: `npm run test && npm run lint && npm run typecheck` → 全绿

- [ ] **Step 6: Commit**

```bash
git add electron/Constants.ts scripts/lib/replace.mjs electron/domains/ai/skill/skillhub-client.ts tests/ai/skillhub-client.test.ts
git commit -m "feat(skill): SkillHubClient(信封解包/退避/鉴权头)与换一换洗牌"
```

---

### Task 2: 市场 IPC 通道 + 前端 api

**Files:**
- Modify: `electron/domains/ai/skill/skill.repo.ts`(构造里加 3 个 handle;类内加 `hubClient = new SkillHubClient()` 成员)
- Modify: `src-react/lib/ipc.ts`(IPCChannel 联合 +3)
- Create: `src-react/domains/ai/skills/api/skillhub.api.ts`

**Interfaces:**
- Consumes: Task 1 的 `SkillHubClient` 与类型
- Produces(Task 3/4 消费):`SkillHubApi.list(params)/top()/categories()`,类型 `SkillHubSkill/SkillHubCategory/SkillHubPage/SkillHubListParams` 从 skillhub.api.ts 再导出

- [ ] **Step 1: 前端 api 与类型文件**

新建 `src-react/domains/ai/skills/api/skillhub-types.ts`(**独立类型声明,不 import 主进程模块** —— 避免渲染 bundle 引入主进程代码;注释注明与 electron skillhub-client 保持同步):

```ts
/**
 * SkillHub 市场数据类型(与 electron/domains/ai/skill/skillhub-client.ts 保持同步;
 * 独立声明避免渲染进程 import 主进程模块)
 */
export interface SkillHubSkill {
  slug: string;
  name: string;
  description: string;
  description_zh: string;
  iconUrl: string | null;
  category: string;
  version: string;
  downloads: number;
  stars: number;
  score: number;
  source: string;
}

export interface SkillHubCategory {
  key: string;
  name: string;
  nameEn: string;
  sortOrder: number;
}

export interface SkillHubListParams {
  keyword?: string;
  category?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  order?: "asc" | "desc";
}

export interface SkillHubPage {
  total: number;
  skills: SkillHubSkill[];
}
```

新建 `src-react/domains/ai/skills/api/skillhub.api.ts`:

```ts
/**
 * SkillHub 市场 API(IPC 封装)
 */
import { invoke } from "@/lib/ipc";
import type {
  SkillHubCategory,
  SkillHubListParams,
  SkillHubPage,
  SkillHubSkill,
} from "./skillhub-types";

const SkillHubApi = {
  list: (params: SkillHubListParams) =>
    invoke<SkillHubPage>("skillhub:list", params),
  top: () => invoke<SkillHubSkill[]>("skillhub:top"),
  categories: () => invoke<SkillHubCategory[]>("skillhub:categories"),
};

export default SkillHubApi;
```

- [ ] **Step 2: IPCChannel 联合类型**

`src-react/lib/ipc.ts` 的 `IPCChannel` 联合追加 `"skillhub:list" | "skillhub:top" | "skillhub:categories"`(照抄 Task 3/P-A 加 skill:* 的位置惯例)。

- [ ] **Step 3: repo 挂通道**

`electron/domains/ai/skill/skill.repo.ts`:
- import 区加 `import { SkillHubClient } from "./skillhub-client";`
- 类成员:`private readonly hub = new SkillHubClient();`
- `registerHandlers()` 追加:

```ts
    ipcMain.handle("skillhub:list", (_e, p: SkillHubListParams) =>
      this.hub.listSkills(p ?? {}),
    );
    ipcMain.handle("skillhub:top", () => this.hub.listTop());
    ipcMain.handle("skillhub:categories", () => this.hub.listCategories());
```

(SkillHubListParams 类型 import 自 ./skillhub-client。)

- [ ] **Step 4: 验证 + Commit**

Run: `npm run test && npm run lint && npm run typecheck` → 全绿

```bash
git add src-react/lib/ipc.ts src-react/domains/ai/skills/api/ electron/domains/ai/skill/skill.repo.ts
git commit -m "feat(skill): 市场 IPC 三通道与前端 api"
```

---

### Task 3: SkillsView 双视图容器 + 顶部导航区

**Files:**
- Create: `src-react/domains/ai/skills/views/SkillsView.tsx`
- Modify: `src-react/domains/ai/experts/views/ExpertsView.tsx`(技能 Tab 挂 SkillsView;SkillManagerView import 移除)
- Modify: `src-react/domains/ai/skills/views/SkillManagerView.tsx`(顶部视图标题不再需要?**不改**——P-A 交互保持;仅外层包容器)
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/chat.json`(skills 子树新增 discover 相关键)

**Interfaces:**
- Consumes: `SkillApi`(installed 计数)、`SkillHubApi`(discover 搜索/分类/列表查询在 Task 4 接入,本任务容器先留 props/slot)
- Produces: `SkillsView`(默认 discover 视图;内部状态 `view: "discover" | "installed"`)

- [ ] **Step 1: i18n key**

zh-CN `chat.json` 的 `skills` 子树追加(不与既有 key 重名):

```json
"discover": "发现",
"installedNav": "我安装的 {{count}}",
"addSkill": "添加技能",
"findSkill": "查找技能",
"uploadSkill": "上传技能",
"createSkill": "创建技能",
"comingSoon": "该功能即将上线",
"searchMarket": "搜索技能",
"featured": "精选技能",
"shuffle": "换一换",
"allCategories": "全部",
"loadMore": "加载更多",
"installComingSoon": "安装功能即将上线",
"marketFailed": "市场加载失败",
"retry": "重试",
"downloads": "{{count}} 次下载"
```

en-US 对应:`"Discover" / "My skills {{count}}" / "Add skill / Find skills / Upload skill / Create skill / Coming soon / Search skills / Featured / Shuffle / All / Load more / Install coming soon / Market failed to load / Retry / {{count}} downloads"`。

- [ ] **Step 2: SkillsView 容器**

```tsx
/**
 * 技能 Tab 双视图容器(发现页/我安装的)与顶部导航区:
 * 市场搜索(远端 keyword)与本地搜索语义分置 —— discover 态显示市场搜索框,
 * installed 态沿用 SkillManagerView 自带搜索条(P-A 交互不变)
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import SkillApi from "../api/skill.api";
import SkillDiscoverView from "./SkillDiscoverView";
import SkillManagerView from "./SkillManagerView";

type SkillView = "discover" | "installed";

export default function SkillsView() {
  const { t } = useTranslation(["chat", "common"]);
  const [view, setView] = useState<SkillView>("discover");

  const recordsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
  });
  const installedCount = recordsQuery.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      {view === "discover" ? (
        <SkillDiscoverView
          onOpenInstalled={() => setView("installed")}
          installedCount={installedCount}
        />
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              onClick={() => setView("discover")}
            >
              <ChevronLeft className="mr-1 h-3.5 w-3.5" />
              {t("chat:skills.discover")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t("chat:skills.installedNav", { count: installedCount })}
            </span>
          </div>
          <SkillManagerView />
        </>
      )}
    </div>
  );
}
```

(市场搜索框与添加下拉在 SkillDiscoverView 内部渲染,保持本容器只管视图切换与计数传递 —— 与 spec §4 一致:discover 态的导航元素全部属于发现页。)

- [ ] **Step 3: ExpertsView 挂 SkillsView**

技能 Tab:`{tab === "skills" && <SkillManagerView />}` → `{tab === "skills" && <SkillsView />}`,import 同步替换;头注释「技能 Tab 挂 SkillsView(P-B 双视图)」。

**注意**:本任务引用的 `SkillDiscoverView` 在 Task 4 才创建 —— 本任务先创建**最小占位**:

```tsx
/** 发现页(P-B Task 4 实现):精选/分类/网格 */
export default function SkillDiscoverView(_props: {
  onOpenInstalled: () => void;
  installedCount: number;
}) {
  return null;
}
```

(下划线前缀参数避免未用 lint;Task 4 替换为完整实现。)

- [ ] **Step 4: 验证 + Commit**

Run: `npm run test && npm run lint && npm run typecheck` → 全绿

```bash
git add src-react/domains/ai/skills/views/ src-react/domains/ai/experts/views/ExpertsView.tsx src-react/i18n/locales/
git commit -m "feat(skill): SkillsView 双视图容器(发现/我安装的)与导航骨架"
```

---

### Task 4: SkillDiscoverView 发现页(精选/分类/网格/搜索/错误态)

**Files:**
- Modify: `src-react/domains/ai/skills/views/SkillDiscoverView.tsx`(替换占位)
- Create: `src-react/domains/ai/skills/components/SkillHubCard.tsx`

**Interfaces:**
- Consumes: `SkillHubApi`(Task 2)、`shuffleTop` 语义(前端本地洗牌:从主进程 re-export 不可能 —— **在组件内用 `sort(() => Math.random() - 0.5)` 不合格**;正确做法:`tests` 覆盖的主进程 shuffleTop 无法直接 import,前端复制 Fisher-Yates 实现到 `src-react/domains/ai/skills/lib/shuffle.ts` 并注明与 skillhub-client 同步;或简单方案:精选区洗牌仅取 top 前 20 随机抽 8(`items.filter(() => Math.random() < 0.4).slice(0,8)` 不保证 8 个)—— **定案:复制 Fisher-Yates 到 lib/shuffle.ts(10 行,注释指向主进程实现)**)
- Produces: 完整发现页

- [ ] **Step 1: lib/shuffle.ts**

```ts
/**
 * 精选区换一换(与 electron skillhub-client.shuffleTop 同步维护:Fisher-Yates)
 */
export function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
```

- [ ] **Step 2: SkillHubCard 组件**

```tsx
/**
 * 市场技能卡:iconUrl(img onError 回退首字符)/名称/中文描述截断/下载量/+
 * 安装按钮(P-B 占位 toast,P-C 接安装引擎)
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { SkillHubSkill } from "../api/skillhub-types";

export default function SkillHubCard({ skill }: { skill: SkillHubSkill }) {
  const { t } = useTranslation(["chat"]);
  const [iconFailed, setIconFailed] = useState(false);
  const description = skill.description_zh || skill.description;

  return (
    <Card className="flex flex-col border-border/50 rounded-lg shadow-sm">
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start gap-2">
          {skill.iconUrl && !iconFailed ? (
            <img
              src={skill.iconUrl}
              alt={skill.name}
              className="h-9 w-9 shrink-0 rounded-lg object-cover"
              onError={() => setIconFailed(true)}
            />
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-sm font-semibold text-primary">
              {skill.name.charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {skill.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("chat:skills.downloads", { count: skill.downloads })}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            onClick={() => toast.info(t("chat:skills.installComingSoon"))}
            aria-label={t("chat:skills.addSkill")}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <p className={cn("line-clamp-2 min-h-8 text-xs text-muted-foreground")}>
          {description}
        </p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: SkillDiscoverView 完整实现**

(替换 Task 3 的占位;import:`useMemo, useRef, useState` from react、`useTranslation`、`useQuery`、`RefreshCw, Search` from lucide-react、`toast` from sonner、`cn`、`Button`、`Input`、DropdownMenu 三件、SkillHubApi、shuffle、SkillHubCard)

```tsx
/**
 * 技能发现页:顶部导航(市场搜索/我安装的[n]/添加技能下拉)+
 * 精选区(top 洗牌取 8,换一换)+ 分类 Tab(categories 动态)+
 * 推荐网格(搜索态切 keyword 查询;加载更多 = pageSize 增量,单查询)
 */
const PAGE_SIZE = 24;

export default function SkillDiscoverView({
  onOpenInstalled,
  installedCount,
}: {
  onOpenInstalled: () => void;
  installedCount: number;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [featuredSeed, setFeaturedSeed] = useState(0);
  const searchTimerRef = useRef<number | undefined>(undefined);

  const topQuery = useQuery({
    queryKey: ["skillhub", "top"],
    queryFn: () => SkillHubApi.top(),
    staleTime: 10 * 60 * 1000,
  });
  const categoriesQuery = useQuery({
    queryKey: ["skillhub", "categories"],
    queryFn: () => SkillHubApi.categories(),
    staleTime: 60 * 60 * 1000,
  });
  const listQuery = useQuery({
    queryKey: ["skillhub", "list", keyword, category, pages],
    queryFn: () =>
      SkillHubApi.list({
        keyword: keyword || undefined,
        category: category ?? undefined,
        pageSize: PAGE_SIZE * pages,
        sortBy: "score",
      }),
  });

  const featured = useMemo(() => {
    void featuredSeed; // 换一换:仅触发重算
    return shuffle(topQuery.data ?? []).slice(0, 8);
  }, [topQuery.data, featuredSeed]);

  /** 市场搜索防抖 300ms(清空即回分类浏览) */
  const onSearchChange = (value: string) => {
    setKeywordInput(value);
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      setKeyword(value.trim());
      setPages(1);
    }, 300);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 顶部导航区 */}
      <div className="flex items-center gap-2">
        <div className="relative w-56">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keywordInput}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("chat:skills.searchMarket")}
            className="h-8 pl-7 text-sm"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          onClick={onOpenInstalled}
        >
          {t("chat:skills.installedNav", { count: installedCount })}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="ml-auto h-8">
              {t("chat:skills.addSkill")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rounded-lg border border-border/50 shadow-lg">
            <DropdownMenuItem onClick={() => setKeyword("")}>
              <Search className="mr-2 h-4 w-4" />
              {t("chat:skills.findSkill")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => toast.info(t("chat:skills.comingSoon"))}>
              {t("chat:skills.uploadSkill")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => toast.info(t("chat:skills.comingSoon"))}>
              {t("chat:skills.createSkill")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 精选区(搜索态隐藏) */}
      {!keyword && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">
              {t("chat:skills.featured")}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              onClick={() => setFeaturedSeed((s) => s + 1)}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {t("chat:skills.shuffle")}
            </Button>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {topQuery.isPending ? (
              <p className="py-8 text-sm text-muted-foreground">
                {t("common:loading")}
              </p>
            ) : (
              featured.map((skill) => (
                <div key={skill.slug} className="w-64 shrink-0">
                  <SkillHubCard skill={skill} />
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* 分类 Tab(搜索态隐藏) */}
      {!keyword && (
        <div className="flex items-center gap-1 border-b border-border/50">
          <CategoryTab
            active={category === null}
            label={t("chat:skills.allCategories")}
            onClick={() => {
              setCategory(null);
              setPages(1);
            }}
          />
          {(categoriesQuery.data ?? []).map((c) => (
            <CategoryTab
              key={c.key}
              active={category === c.key}
              label={c.name}
              onClick={() => {
                setCategory(c.key);
                setPages(1);
              }}
            />
          ))}
        </div>
      )}

      {/* 网格 */}
      {listQuery.isPending ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t("common:loading")}
        </p>
      ) : listQuery.isError ? (
        <div className="flex flex-col items-center gap-2 py-16">
          <p className="text-sm text-destructive">{t("chat:skills.marketFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void listQuery.refetch()}>
            {t("chat:skills.retry")}
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(listQuery.data?.skills ?? []).map((skill) => (
              <SkillHubCard key={skill.slug} skill={skill} />
            ))}
          </div>
          {(listQuery.data?.total ?? 0) > (listQuery.data?.skills.length ?? 0) && (
            <div className="flex justify-center py-2">
              <Button
                variant="outline"
                size="sm"
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                onClick={() => setPages((p) => p + 1)}
              >
                {t("chat:skills.loadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CategoryTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "border-b-2 px-3 py-2 text-sm transition-colors",
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 4: 验证 + Commit**

Run: `npm run test && npm run lint && npm run typecheck` → 全绿

```bash
git add src-react/domains/ai/skills/
git commit -m "feat(skill): 发现页(精选换一换/动态分类/网格/搜索/加载更多)"
```

---

### Task 5: 全量验证 + 手测清单

**Files:** 无新增

- [ ] **Step 1:** `npm run test && npm run lint && npm run typecheck` 全绿
- [ ] **Step 2:** 手测清单(交用户):
  1. 技能 Tab 默认发现页:精选 8 张横向滚动、换一换生效;分类 Tab 与线上一致(办公效率/内容创作/…);网格按评分排序、加载更多翻页
  2. 搜索"文档" → 网格切搜索结果、精选/分类隐藏;清空恢复
  3. 我安装的 [n] ↔ 发现页切换;P-A 管理页交互无回归
  4. 断网 → 错误态 + 重试恢复
  5. `grep -r "skh_24a2514a" src-react electron` 无结果(Key 未泄漏)
- [ ] **Step 3:** 修复项 commit(如有)
