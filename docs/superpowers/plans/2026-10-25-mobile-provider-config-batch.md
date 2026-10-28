# 移动端服务商配置批（A1+B3）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.
> Spec: `docs/superpowers/specs/2026-10-25-mobile-provider-config-batch.md`（已评审通过）

**Goal:** 移动端经被控面协议管理桌面端/无头端服务商与模型（增删改/启停/测试/远端拉取导入）。

**Architecture:** 协议包收编 save upsert 契约类型（单份权威源）→ 桌面被控面注册 provider/save（掩码防回写逐字对齐无头端、顺序应用无事务——spec §1.2 差异声明）→ 移动端 providers.store + /providers 管理页。

**Tech Stack:** @tianshu/protocol（纯类型）、Electron server-face、Expo/RN + Zustand。

## Global Constraints

- 工作分支 main，直接提交（用户长期裁定，不开 worktree/分支）。
- 移动端 lint 环境态不可用：mobile 侧验收固定 typecheck + vitest + prettier（在 apps/tianshu-mobile 下跑，**Bash 每跑一次 cwd 漂回仓库根，命令必须显式 cd**）；mirror 根侧验收 `npm run typecheck` + 根 vitest（server-face 相关）。
- **禁止根目录 npm install**（nativewind 本地树铁律）；协议包 dist 用 `npm --prefix packages/tianshu-protocol run build` 重建。
- i18n：移动端新增文案 zh-CN + en-US 同步，禁止顶层/嵌套 key 重名。
- 移动端样式禁硬编码主题色（label2/sep/card/field 等语义类除外，主题色走 `useThemeColors()`）。
- 协议包零运行时依赖，只放类型 + 常量（class-validator 装饰器 DTO 留无头端原位，收编仅 type 层形状）。
- 协议常量零改动（ENDPOINTS.provider.save 已存在）——`tests/ai/server/protocol-package.test.ts` 不动。
- server-face 文件 mirror 独有，`npm run check:drift` 不受影响。

---

### Task 1: 协议包收编 provider-save 契约类型

**Files:**
- Create: `packages/tianshu-protocol/src/provider-save-contract.ts`
- Modify: `packages/tianshu-protocol/src/index.ts`

**Interfaces:**
- Produces: `@tianshu/protocol` 导出 `ProviderSaveItem`、`ModelSaveItem`、`ProviderSavePayload`（字段逐字镜像无头端 `apps/tianshu-server/src/modules/provider/dto/provider-save.dto.ts` 的 ProviderItemDto/ModelItemDto——注意是**形状**收编，装饰器 DTO 类留无头端原位不动）。

- [ ] **Step 1:** `provider-save-contract.ts` 新文件，逐字内容：

```ts
/**
 * provider/save upsert 契约（A1 批自无头端 ProviderSaveDto 收编——单份权威
 * 源；class-validator 装饰器 DTO 类留 apps/tianshu-server 原位，此处仅类型
 * 层形状。三态语义：undefined=未传保留现值；null=显式清除；脱敏掩码
 * REDACTED_SECRET 由服务端按未传处理，防回写覆盖真实密钥）。
 */

/** 服务商配置项（save upsert 语义：带 id 更新，不带 id 新建） */
export interface ProviderSaveItem {
  /** 服务商标识；缺省新建 */
  id?: number;
  name: string;
  /** 服务商类型（openai-compatible/anthropic/gemini/ollama/comfyui） */
  type: string;
  baseUrl: string;
  /** API 密钥（未传保留现值；显式 null 清除；未配置为 null） */
  apiKey?: string | null;
  /** 额外请求头 JSON 字符串（形如 {"X-Key":"v"}；语义同 apiKey） */
  extraHeaders?: string | null;
  /** 是否启用；新建缺省 true */
  enabled?: boolean;
}

/** 模型配置项（save upsert 语义同上；经所属 provider 校验归属） */
export interface ModelSaveItem {
  /** 模型行标识（库内行标识）；缺省新建 */
  id?: number;
  /** 所属服务商（新建必填；更新时校验 {id,providerId} 对账） */
  providerId: number;
  /** 模型标识（上游模型名） */
  modelId: string;
  /** 展示名 */
  name?: string | null;
  /** 类型 llm|embedding|tts|reranker|asr；缺省 llm */
  type?: string;
  enabled?: boolean;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  contextWindow?: number | null;
}

/** provider/save 请求体：两数组均可选、至少一项为数组；非全量覆盖 */
export interface ProviderSavePayload {
  providers?: ProviderSaveItem[];
  models?: ModelSaveItem[];
}
```

- [ ] **Step 2:** `src/index.ts`：头注释「七模块聚合」改「八模块聚合」并补一行 `provider-save-contract（provider/save upsert 契约，A1 批）`；export 块按字母序增 `export * from "./provider-save-contract";`（放在 monitor-contract 后）。

- [ ] **Step 3:** 重建 dist：`npm --prefix packages/tianshu-protocol run build`。

- [ ] **Step 4:** 验证：根 `npm run typecheck` 绿。

- [ ] **Step 5:** 提交：`feat(protocol): A1 provider/save upsert 契约收编——ProviderSaveItem/ModelSaveItem/ProviderSavePayload 类型单份入协议包（装饰器 DTO 留无头端原位）`

---

### Task 2: 桌面被控面 provider/save 路由

**Files:**
- Modify: `electron/domains/server-face/deps.ts`（ServerFaceProviders 接口，:131-150）
- Modify: `electron/domains/server-face/ipc.ts`（providers 桥，:300-320）
- Modify: `electron/domains/server-face/routes.ts`（仿 handleProviderDelete :453-471；注册表 :893 附近）
- Modify: `tests/ai/server-face/routes.test.ts`（providers 替身 :216-222 补 save；新用例仿 :866 FA 批 describe 风格）

**Interfaces:**
- Consumes: Task 1 的 `ProviderSavePayload`/`ProviderSaveItem`/`ModelSaveItem`（`@tianshu/protocol`）；既有 `deps.providerRepo: ProviderRepository`（create/update/delete）、`deps.modelRepo: ModelRepository`（create/update）；`REDACTED_SECRET`（@tianshu/protocol，ipc.ts 已 import）。
- Produces: `POST provider/save` 路由（body = ProviderSavePayload，成功返回脱敏 bundle `{providers, models}`）；`ServerFaceProviders.save(payload, userId)` 新成员。

- [ ] **Step 1:** `deps.ts` `ServerFaceProviders` 接口在 `listRemote` 后增成员（顶部 import 增 `type ProviderSavePayload` from "@tianshu/protocol"）：

```ts
  /** A1 批写面：批量 upsert（掩码防回写语义在 ipc.ts 桥实现；顺序应用无
      事务——spec §1.2 差异声明；成功返回脱敏 bundle） */
  save(
    payload: ProviderSavePayload,
    userId: number,
  ): Promise<{ providers: unknown[]; models: unknown[] }>;
```

- [ ] **Step 2:** `routes.ts`（顶部 import 增 `type ProviderSavePayload` from "@tianshu/protocol"）在 `handleProviderQuery`（:447-451）后增 handler：

```ts
/** provider/save：批量 upsert（providers→models 顺序应用无事务——spec §1.2
 * 差异声明；任一项失败即停返回该项错误；成功后回脱敏 bundle） */
async function handleProviderSave(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { providers?: unknown; models?: unknown };
  if (!Array.isArray(p.providers) && !Array.isArray(p.models)) {
    return bizError("5000", "providers/models 至少一项为数组");
  }
  return withUserId(async (userId) => {
    try {
      return ok(await faceDeps().providers.save(p as ProviderSavePayload, userId));
    } catch (e) {
      return bizError(
        "5000",
        e instanceof Error ? `保存失败：${e.message}` : "保存失败",
      );
    }
  });
}
```

注册表 `ROUTES`（provider/query :892 后）增 `"POST provider/save": handleProviderSave,`。

- [ ] **Step 3:** `ipc.ts` providers 桥（:300-320 对象内，listRemote 后）增 `save` 实现——先写失败测试再实现（Step 4/5 顺序）。实现代码：

```ts
      // A1 批写面：批量 upsert——providers 先行（models 可能引用新建
      // provider）；掩码防回写逐字对齐无头端 repository.ts:67-76（脱敏
      // 响应原样回传时按未传：undefined 保留现值 / 新建落空值）；顺序
      // 应用无事务，失败即停抛错（route 层转 5000）
      save: async (payload, userId) => {
        for (const item of payload.providers ?? []) {
          const apiKey =
            item.apiKey === REDACTED_SECRET ? undefined : item.apiKey;
          const extraHeaders =
            typeof item.extraHeaders === "string" &&
            item.extraHeaders.includes(REDACTED_SECRET)
              ? undefined
              : item.extraHeaders;
          try {
            if (item.id != null) {
              await deps.providerRepo.update(
                {
                  id: item.id,
                  name: item.name,
                  type: item.type as ProviderType,
                  baseUrl: item.baseUrl,
                  apiKey,
                  extraHeaders,
                  enabled: item.enabled,
                },
                userId,
              );
            } else {
              await deps.providerRepo.create(
                {
                  name: item.name,
                  type: item.type as ProviderType,
                  baseUrl: item.baseUrl,
                  apiKey: apiKey ?? undefined,
                  extraHeaders: extraHeaders ?? undefined,
                  enabled: item.enabled,
                },
                userId,
              );
            }
          } catch (e) {
            throw new Error(
              `服务商「${item.name}」保存失败：${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        for (const item of payload.models ?? []) {
          try {
            if (item.id != null) {
              await deps.modelRepo.update(
                {
                  id: item.id,
                  modelId: item.modelId,
                  name: item.name,
                  enabled: item.enabled,
                  type: item.type as ModelType,
                  temperature: item.temperature,
                  topP: item.topP,
                  maxTokens: item.maxTokens,
                  contextWindow: item.contextWindow,
                },
                userId,
              );
            } else {
              const created = await deps.modelRepo.create(
                {
                  providerId: item.providerId,
                  modelId: item.modelId,
                  name: item.name ?? undefined,
                  type: item.type as ModelType,
                  temperature: item.temperature ?? undefined,
                  topP: item.topP ?? undefined,
                  maxTokens: item.maxTokens ?? undefined,
                  contextWindow: item.contextWindow ?? undefined,
                },
                userId,
              );
              // ModelCreateParams 无 enabled 字段（缺省 true）——新建即
              // 停用需补一次 update
              if (item.enabled === false) {
                await deps.modelRepo.update(
                  { id: created.id, enabled: false },
                  userId,
                );
              }
            }
          } catch (e) {
            throw new Error(
              `模型「${item.modelId}」保存失败：${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        return {
          providers: (await deps.providerRepo.list(userId)).map(
            redactProviderSecrets,
          ),
          models: await deps.modelRepo.listAll(userId),
        };
      },
```

⚠️ 实现期修正上示 `as never` 占位：type 字段实际 cast 目标为 `ProviderType`/`ModelType`（分别 from `../../../src-react/domains/ai/api/provider.api` 与 `model.api`，type-only import 增入）；以 repo 参数类型实际定义为准（先读 `src-react/domains/ai/api/provider.api.ts:35-53` 与 `model.api.ts:38-60` 再落 cast）。

- [ ] **Step 4:** `tests/ai/server-face/routes.test.ts` providers 替身（:215-221）补 `save: vi.fn(async () => ({ providers: [], models: [] })),`——否则接口缺成员全文件 typecheck 红。

- [ ] **Step 5:** 同文件新增 describe（放在 FA 批 describe :866 之后，仿其风格）：

```ts
describe("provider/save（A1 批写面：批量 upsert 桥）", () => {
  it("providers+models 载荷透传 deps.save 并回其 bundle", async () => {
    const d = wireDeps();
    d.providers.save.mockResolvedValue({
      providers: [{ id: 1, name: "ACME", apiKey: "MASKED" }],
      models: [],
    });
    const result = await handleRoute("POST", "provider/save", {
      providers: [{ name: "ACME", type: "openai-compatible", baseUrl: "https://api.acme.test" }],
      models: [{ providerId: 1, modelId: "gpt-x" }],
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ code: "2000", success: true });
    expect(d.providers.save).toHaveBeenCalledWith(
      expect.objectContaining({ providers: [expect.objectContaining({ name: "ACME" })] }),
      expect.any(Number),
    );
  });

  it("两数组均缺 → 5000", async () => {
    wireDeps();
    await expectBizError("POST", "provider/save", {}, "5000");
  });

  it("deps.save 抛错 → 5000 且 message 带项标识", async () => {
    const d = wireDeps();
    d.providers.save.mockRejectedValue(new Error("服务商「ACME」保存失败：归属校验"));
    const result = await handleRoute("POST", "provider/save", {
      providers: [{ name: "ACME" }],
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ code: "5000", success: false });
    expect(JSON.stringify(result.body)).toContain("ACME");
  });
});
```

（装配函数为 `wireDeps`——:190 定义、:253 调 setServerFaceDeps，返回 `{...fake, chat, providers, …}`；用例取返回值上的 `providers` mock。）

- [ ] **Step 6:** 验证：根 `npm run typecheck` 绿；`npx vitest run tests/ai/server-face` 全绿（基线 86 用例 + 新增）。

- [ ] **Step 7:** 提交：`feat(server-face): A1 provider/save 只读对面之写面——批量 upsert 桥（掩码防回写对齐无头端、顺序应用无事务差异声明、成功后脱敏 bundle）`

---

### Task 3: 移动端 providers.store + i18n 命名空间

**Files:**
- Create: `apps/tianshu-mobile/src/store/providers.store.ts`
- Create: `apps/tianshu-mobile/src/store/providers.store.test.ts`
- Create: `apps/tianshu-mobile/src/i18n/locales/zh-CN/providers.json`
- Create: `apps/tianshu-mobile/src/i18n/locales/en-US/providers.json`
- Modify: `apps/tianshu-mobile/src/i18n/index.ts`（namespaces 注册）

**Interfaces:**
- Consumes: Task 1 协议类型（dist 已重建）；`wireRequest`（`src/transport/wire.ts`）；`ENDPOINTS.provider.query/save/delete/test/fetchModels`。
- Produces: `useProvidersStore`（state `{bundle, loading, error, saving}`；actions `load/saveProvider/saveModel/removeProviders/removeModels/testProvider/fetchRemote/resetForTest`）；i18n 命名空间 `providers`（Task 4 消费全部 key）。

- [ ] **Step 1（先写失败测试）:** `providers.store.test.ts`，仿 `sessions.store.test.ts` :1-60 的 hoisted connections 替身（同一 vi.mock("./connections.store") 模式，测试只需 `activeTransport`——可裁剪掉 subscribeTransportEvents 断言相关部分，但保留 mock 形），测试用例：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS } from "@tianshu/protocol";

const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
  useConnectionsStore: {
    getState: () => ({ activeConnId: "c1" }),
    subscribe: () => () => {},
  },
}));

vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
  useConnectionsStore: connMock.useConnectionsStore,
}));

import { useProvidersStore } from "./providers.store";

function makeTransport() {
  return { request: vi.fn() };
}

const BUNDLE = {
  providers: [
    { id: 1, name: "ACME", type: "openai-compatible", baseUrl: "https://api.acme.test", apiKey: "REDACTED_SECRET", extraHeaders: null, enabled: true },
  ],
  models: [
    { id: 7, providerId: 1, modelId: "gpt-x", name: "GPT-X", type: "llm", enabled: true, temperature: null, topP: null, maxTokens: null, contextWindow: null },
  ],
};

describe("providers.store", () => {
  beforeEach(() => {
    connMock.activeTransport.mockReset();
    useProvidersStore.getState().resetForTest();
  });

  it("load 解包 bundle 并清 error", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue({ status: 200, body: { code: "2000", success: true, data: BUNDLE, message: "success" } });
    connMock.activeTransport.mockReturnValue(t);
    await useProvidersStore.getState().load();
    const s = useProvidersStore.getState();
    expect(s.bundle?.providers).toHaveLength(1);
    expect(s.bundle?.models[0].modelId).toBe("gpt-x");
    expect(s.error).toBeNull();
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.provider.query, null);
  });

  it("saveProvider 构造单元素 providers 数组调 save 并本地合并回包行", async () => {
    const t = makeTransport();
    const saved = { ...BUNDLE.providers[0], name: "ACME 2" };
    t.request.mockResolvedValue({ status: 200, body: { code: "2000", success: true, data: { ...BUNDLE, providers: [saved] }, message: "success" } });
    connMock.activeTransport.mockReturnValue(t);
    await useProvidersStore.getState().load();
    await useProvidersStore.getState().saveProvider({ id: 1, name: "ACME 2", type: "openai-compatible", baseUrl: "https://api.acme.test" });
    const req = t.request.mock.calls[1];
    expect(req[1]).toBe(ENDPOINTS.provider.save);
    expect(req[2]).toEqual({ providers: [{ id: 1, name: "ACME 2", type: "openai-compatible", baseUrl: "https://api.acme.test" }] });
    expect(useProvidersStore.getState().bundle?.providers[0].name).toBe("ACME 2");
  });

  it("wire 业务错 → error 置位且 bundle 不丢", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue({ status: 200, body: { code: "5000", success: false, data: null, message: "保存失败" } });
    connMock.activeTransport.mockReturnValue(t);
    await useProvidersStore.getState().saveProvider({ name: "X", type: "openai-compatible", baseUrl: "u" });
    expect(useProvidersStore.getState().error).toBe("保存失败");
  });

  it("removeModels 走 provider/delete 带 modelIds", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue({ status: 200, body: { code: "2000", success: true, data: BUNDLE, message: "success" } });
    connMock.activeTransport.mockReturnValue(t);
    await useProvidersStore.getState().removeModels([7]);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.provider.delete, { modelIds: [7] });
  });
});
```

（`request` 返回形态以 `src/transport/wire.ts` :14-43 的 wireRequest 实际消费口径为准——实现前读 wire.ts 对齐 mock 的 body 包装形状。）

- [ ] **Step 2:** 跑测试确认失败（store 不存在）：`cd apps/tianshu-mobile && npx vitest run src/store/providers.store.test.ts`。

- [ ] **Step 3:** 实现 `providers.store.ts`：

```ts
// 服务商/模型远端数据 store（A1 批）：bundle 读写 + 删除 + 测试/远端拉取
// 直通。请求全走 wireRequest（无连接/业务错统一 error 态）；保存成功按
// 返回 bundle 整包替换（不重拉全量——服务端响应即脱敏后权威态）。
import { create } from "zustand";
import { ENDPOINTS, type ProviderSaveItem, type ModelSaveItem } from "@tianshu/protocol";
import { wireRequest } from "../transport/wire";

export interface ProviderRow {
  id: number; name: string; type: string; baseUrl: string;
  apiKey: string | null; extraHeaders: string | null; enabled: boolean;
}
export interface ModelRow {
  id: number; providerId: number; modelId: string; name: string | null;
  type: string; enabled: boolean; temperature: number | null; topP: number | null;
  maxTokens: number | null; contextWindow: number | null;
}
export interface ProviderBundle { providers: ProviderRow[]; models: ModelRow[] }

interface ProvidersState {
  bundle: ProviderBundle | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load(): Promise<void>;
  saveProvider(item: ProviderSaveItem): Promise<boolean>;
  saveModel(item: ModelSaveItem): Promise<boolean>;
  removeProviders(ids: number[]): Promise<boolean>;
  removeModels(ids: number[]): Promise<boolean>;
  testProvider(providerId: number): Promise<{ ok: boolean; message: string } | null>;
  fetchRemote(providerId: number): Promise<{ success: boolean; message: string; models: Array<{ modelId: string; name?: string }> } | null>;
  resetForTest(): void;
}
```

实现要点（每个 action 一个 try/catch，wireRequest 失败臂 `r.message` 置 error 返 false/对应失败态；成功按 data 形状防御解析后整包替换 bundle——`load`/`save*`/`remove*` 成功后均 `set({ bundle: parsed, error: null })`；`saving` 仅 save* 动作置位；`testProvider`/`fetchRemote` 不改 bundle、失败返 null）。

- [ ] **Step 4:** 跑测试绿：`cd apps/tianshu-mobile && npx vitest run src/store/providers.store`。

- [ ] **Step 5:** i18n 命名空间 `providers`（zh/en 双份 + `src/i18n/index.ts` 两处 namespaces 数组各增 `"providers"`——先读该文件 :31-48 对齐注册写法）。zh-CN 全量 key：

```json
{
  "title": "服务商配置",
  "addProvider": "新建服务商",
  "editProvider": "编辑服务商",
  "deleteProvider": "删除服务商",
  "deleteProviderConfirm": "删除后其下全部模型一并删除，确定删除？",
  "deleteModel": "删除模型",
  "name": "名称",
  "type": "类型",
  "baseUrl": "基础地址",
  "apiKey": "API 密钥",
  "apiKeyConfigured": "已配置",
  "apiKeyKeep": "不修改则留空",
  "clear": "清除",
  "extraHeaders": "额外请求头（JSON）",
  "invalidJson": "JSON 格式不合法",
  "enabled": "启用",
  "models": "模型",
  "addModel": "手动添加",
  "editModel": "编辑模型",
  "modelId": "模型标识",
  "displayName": "展示名",
  "temperature": "温度",
  "topP": "Top P",
  "maxTokens": "最大 Token 数",
  "contextWindow": "上下文窗口",
  "maxTokensLtContext": "最大 Token 数须小于上下文窗口",
  "test": "测试",
  "testing": "测试中…",
  "testOk": "连接正常",
  "fetchRemote": "拉取远端模型",
  "fetching": "拉取中…",
  "import": "导入",
  "imported": "已导入",
  "selectAll": "全选",
  "modelsCount": "{{count}} 个模型",
  "saveFailed": "保存失败：{{message}}",
  "loadFailed": "加载失败",
  "retry": "重试",
  "empty": "暂无服务商，点右上角新建",
  "noConnection": "当前主机无服务商能力"
}
```

en-US 同构直译（"Provider Settings"/"New Provider"/…，`modelsCount: "{{count}} models"`）。

- [ ] **Step 6:** 三件套：`cd apps/tianshu-mobile && npm run typecheck && npm run test && npx prettier --check src/store/providers.store.ts src/store/providers.store.test.ts src/i18n`（全绿；既有 268 测试不得红）。

- [ ] **Step 7:** 提交：`feat(mobile): A1 providers.store+i18n 命名空间——bundle 读写/删除/测试/远端拉取（wireRequest 统一出口），密钥三态语义注释，双语 key 全量落盘`

---

### Task 4: 移动端 /providers 管理页

**Files:**
- Create: `apps/tianshu-mobile/src/app/providers.tsx`
- Modify: `apps/tianshu-mobile/src/app/_layout.tsx`（Stack 注册，:59-69）
- Modify: `apps/tianshu-mobile/src/app/(tabs)/settings.tsx`（入口行，监控行 :281-290 后）

**Interfaces:**
- Consumes: Task 3 的 `useProvidersStore`/`ProviderRow`/`ModelRow`；i18n `providers:*`；`useThemeColors()`；`GroupSection`/`ListItem` 组件（src/components/，T11 批产物）；settings 页既有 capabilities 选择器（:143-146）。
- Produces: `/providers` 路由页（Stack 注册 `headerShown: false`）；我的页「服务商配置」入口行（capability `provider` 门禁）。

- [ ] **Step 1:** `settings.tsx` 监控入口行（:281-290）后增入口行（同 GroupSection/ListItem 惯例）：

```tsx
{capabilities?.includes("provider") && (
  <ListItem
    icon={<Building2 size={20} color={colors.label} />}
    title={t("providers:title")}
    showChevron
    onPress={() => router.push("/providers")}
  />
)}
```

（icon 用 lucide `Building2`；`colors` 为页面既有 `useThemeColors()`；`t` 的 useTranslation namespaces 数组增 `"providers"`。）

- [ ] **Step 2:** `_layout.tsx` Stack（:59-69）增 `<Stack.Screen name="providers" options={{ headerShown: false }} />`。

- [ ] **Step 3:** `src/app/providers.tsx` 页面——自绘顶栏（返回 ChevronLeft + 大标题 `t("providers:title")` + 右上「+」MessageSquarePlus 17px 主题色，对齐会话组头冒泡+惯例）。结构：

```
SafeArea ScrollView（flex-1 页根语境——ScrollView 基样式 flexGrow:1 在此合法）
├─ 三态：loading 指示 / error+重试钮 / 空文案（t providers:empty）
├─ 服务商组卡（GroupSection）：行 = 名称 + 副标 type + 右槽 模型数
│   （providers:modelsCount）+ 停用标（!enabled → label2「已停用」）；
│   行 onPress 展开/切详情态（selectedProviderId 本地 state）
├─ 详情卡（选中 provider）：baseUrl 行 / apiKey 行（有值显示
│   t(apiKeyConfigured)，无值 label2「—」）/ enabled Switch 行（翻
│   转走 saveProvider 带全字段——对齐无头端三态：enabled 之外字段
│   原样回传）/ 「编辑」行 / 「删除」行（Alert.alert 确认，副标题
│   deleteProviderConfirm）/ 「拉取远端模型」行
├─ 模型组卡（选中 provider 的 models）：行 = 显示名(回退 modelId) +
│   enabled Switch（翻转 → saveModel 全字段回传）+ 点击进模型编辑
│   Dialog；组尾「+ 手动添加」行 → 模型 Dialog 空表单
├─ ProviderDialog（Modal）：预设横滑 chips（静态：OpenAI 兼容/
│   Anthropic/Gemini/Ollama/ComfyUI——选预设回填 type+baseUrl）、
│   名称/type/baseUrl TextInput、apiKey（编辑态 placeholder
│   apiKeyKeep，值留空=不传该键；显式清除钮 → 传 null）、
│   extraHeaders TextInput（提交前 JSON.parse 校验，败 → error 红字
│   invalidJson）、enabled Switch；确定钮禁用态=名称/baseUrl 空
├─ ModelDialog（Modal）：modelId/展示名/type 五选分段/LLM 时四参数
│   数值输入（maxTokens/contextWindow 正整数 + maxTokensLtContext
│   校验，逻辑照抄桌面 ModelDialog.tsx:82-115 口径）
└─ RemoteImportSheet（Modal）：fetchRemote 结果列表——已导入 modelId
    置灰排尾（对照 bundle.models 的 modelId 集）、逐项勾选+全选、
    「导入 N 个」钮逐项 saveModel（{providerId, modelId, type 启发：
    名称含 embed→embedding 等，从简 llm 缺省}）→ 完成关层
```

样式全语义类 + `useThemeColors()`；所有写操作前 `saving` 态禁用钮；保存失败 Toast/红字（store error）。

- [ ] **Step 4:** 三件套：`cd apps/tianshu-mobile && npm run typecheck && npm run test && npx prettier --check src/app/providers.tsx src/app/_layout.tsx "src/app/(tabs)/settings.tsx"`。

- [ ] **Step 5:** 提交：`feat(mobile): A1 服务商配置页——我的页 capability 门禁入口+/providers 全管理（provider/model 增删改启停、密钥三态表单、远端拉取导入去重置灰）`

---

## 依赖与冲突扫描（Pre-flight）

| 检查对 | 结论 |
|---|---|
| T1 → T2（协议类型） | T2 deps/routes import 协议新类型，T1 先合入并重建 dist |
| T2 → T3（save 端点可用性） | 无编译耦合；T3 mock 走 wireRequest 不触 face。但端到端语义依赖 T2 路由，顺序不可换 |
| T3 → T4（store/i18n） | T4 消费 T3 全部产物，顺序不可换 |
| T2 与 monitor 批 | face 文件同区（routes.ts/deps.ts/ipc.ts）——A6 已合入，基于现状增量；routes.test.ts 装配函数共享，T2 改 mock 时不得动既有用例 |
| drift 巡检 | 本批 face 文件 mirror 独有；协议包 dist 重建后 server 仓消费端不受影响（形状逐字一致） |
| 协议钉测试 | ENDPOINTS/CAPABILITIES 零改动，protocol-package.test.ts 不动 |
