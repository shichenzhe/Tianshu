// 专家远端数据 store（A2 批）：我的专家（列表/详情/保存三态/删除）+
// 市场（概要列表/按 slug 全文/添加并启用——marketDetail 取全文后经
// assistant/save 新建）。读面直通，写面经 enqueueWrite 串行；请求前经
// 资源内请求序号（mine/market 各自独立——跨资源并行互不过期，同资源内
// 后发仍使先发过期）+activeConnId+transport 三重防迟到校验。市场概要列表不带
// systemPrompt（协议契约），编辑表单数据从 detail 面取全量。
import { create } from "zustand";
import {
  ENDPOINTS,
  type AssistantDetailResult,
  type AssistantSavePayload,
  type ExpertMarketDetail,
  type ExpertMarketSummary,
} from "@tianshu/protocol";
import { wireRequest } from "../transport/wire";
import { activeTransport, useConnectionsStore } from "./connections.store";

/** assistant/query 行（我的专家列表——概要面，builtin 详情才可见） */
export interface ExpertMineRow {
  id: number;
  name: string;
  description: string | null;
  icon: string | null;
  profession: string | null;
}

interface ExpertsState {
  mine: ExpertMineRow[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** 首次成功加载后置位（内容区加载/空态判定） */
  initialized: boolean;
  marketList: ExpertMarketSummary[];
  marketLoading: boolean;
  marketError: string | null;
  marketInitialized: boolean;
  loadMine(): Promise<void>;
  /** 详情读面：归属校验后全量透出；失败返回 null（code 入 error 语义由
   *  调用方按最后 error 态感知） */
  loadDetail(id: number): Promise<AssistantDetailResult | null>;
  save(payload: AssistantSavePayload): Promise<boolean>;
  remove(id: number): Promise<boolean>;
  loadMarket(): Promise<void>;
  loadMarketDetail(slug: string): Promise<ExpertMarketDetail | null>;
  /** 市场「添加并启用」：marketDetail 取全文 → assistant/save 新建 */
  installFromMarket(slug: string): Promise<boolean>;
  /** 导出：assistant/export 产 JSON 文本（归属校验；builtin 同样可导）；
   *  失败返回 null（error 态同 detail 语义） */
  exportExpert(id: number): Promise<string | null>;
  /** 导入：assistant/import 服务端解析校验新建（写面串行+防迟到内建），
   *  成功后重拉我的列表；失败列表不动 */
  importExpert(json: string): Promise<boolean>;
  resetForTest(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseMineRow(value: unknown): ExpertMineRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "number" || typeof row.name !== "string") return null;
  return {
    id: row.id,
    name: row.name,
    description: nullableString(row.description),
    icon: nullableString(row.icon),
    profession: nullableString(row.profession),
  };
}

function parseMineList(data: unknown): ExpertMineRow[] | null {
  if (!Array.isArray(data)) return null;
  const rows = data.map(parseMineRow);
  return rows.every((row) => row !== null) ? (rows as ExpertMineRow[]) : null;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

function parseMarketSummary(value: unknown): ExpertMarketSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.slug !== "string" ||
    typeof row.name !== "string" ||
    typeof row.description !== "string" ||
    typeof row.categoryId !== "string"
  ) {
    return null;
  }
  const tags = parseStringArray(row.tags);
  if (!tags) return null;
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    profession: typeof row.profession === "string" ? row.profession : "",
    tags,
    categoryId: row.categoryId,
    isTeam: row.isTeam === true,
    // 排序三档字段 + 分类名 i18n 键（体验精修批契约增量；旧被控端
    // 未下发=undefined——消费端回退名称排序/原值分类）
    score: optionalNumber(row.score),
    downloads: optionalNumber(row.downloads),
    createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
    categoryTitleKey: nullableString(row.categoryTitleKey) ?? undefined,
  };
}

function parseMarketList(data: unknown): ExpertMarketSummary[] | null {
  if (!Array.isArray(data)) return null;
  const rows = data.map(parseMarketSummary);
  return rows.every((row) => row !== null)
    ? (rows as ExpertMarketSummary[])
    : null;
}

function parseTeamMembers(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const member = item as Record<string, unknown>;
    if (
      typeof member.id !== "string" ||
      typeof member.name !== "string" ||
      typeof member.profession !== "string" ||
      typeof member.systemPrompt !== "string"
    ) {
      return [];
    }
    return [
      {
        id: member.id,
        name: member.name,
        profession: member.profession,
        systemPrompt: member.systemPrompt,
      },
    ];
  });
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** 详情/市场全文共用解析（detail 面必填更严：builtin/createdAt 必校） */
function parseAssistantDetail(
  value: unknown,
  requireMeta: boolean,
): AssistantDetailResult | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "number" ||
    typeof row.name !== "string" ||
    typeof row.systemPrompt !== "string"
  ) {
    return null;
  }
  if (
    requireMeta &&
    (typeof row.builtin !== "boolean" ||
      typeof row.createdAt !== "string" ||
      typeof row.updatedAt !== "string")
  ) {
    return null;
  }
  const tags = parseStringArray(row.tags);
  const quickPrompts = parseStringArray(row.quickPrompts);
  const skillNames = parseStringArray(row.skillNames);
  if (row.tags !== undefined && !tags) return null;
  if (row.quickPrompts !== undefined && !quickPrompts) return null;
  if (row.skillNames !== undefined && !skillNames) return null;
  return {
    id: row.id,
    name: row.name,
    icon: nullableString(row.icon) ?? undefined,
    systemPrompt: row.systemPrompt,
    temperature: optionalNumber(row.temperature),
    topP: optionalNumber(row.topP),
    maxTokens: optionalNumber(row.maxTokens),
    builtin: row.builtin === true,
    description: nullableString(row.description) ?? undefined,
    tags: tags ?? undefined,
    sourceSlug: nullableString(row.sourceSlug) ?? undefined,
    profession: nullableString(row.profession) ?? undefined,
    quickPrompts: quickPrompts ?? undefined,
    categoryId: nullableString(row.categoryId) ?? undefined,
    skillNames: skillNames ?? undefined,
    expertType:
      row.expertType === "agent" || row.expertType === "team"
        ? row.expertType
        : undefined,
    members: parseTeamMembers(row.members),
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
  };
}

function parseMarketDetail(value: unknown): ExpertMarketDetail | null {
  const base = parseMarketSummary(value);
  if (!base || typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.systemPrompt !== "string") return null;
  const quickPrompts = parseStringArray(row.quickPrompts);
  const skillNames = parseStringArray(row.skillNames);
  return {
    ...base,
    icon: nullableString(row.icon) ?? undefined,
    systemPrompt: row.systemPrompt,
    temperature: optionalNumber(row.temperature),
    topP: optionalNumber(row.topP),
    maxTokens: optionalNumber(row.maxTokens),
    quickPrompts: quickPrompts ?? undefined,
    skillNames: skillNames ?? undefined,
    members: parseTeamMembers(row.members),
  };
}

/** 资源内请求序号：mine 与 market 各自独立——首屏并行 loadMine+loadMarket
 *  不再互相过期（旧全局 reqSeq 下先到者响应被丢弃且 finally 不复位
 *  loading，致「我的」永久转圈）；同资源内后发仍使先发过期 */
type ExpertResource = "mine" | "market";
const reqSeqs: Record<ExpertResource, number> = { mine: 0, market: 0 };
let writeChain: Promise<unknown> = Promise.resolve();
let pendingWrites = 0;

interface RequestToken {
  resource: ExpertResource;
  seq: number;
  connId: string | null;
  transport: ReturnType<typeof activeTransport>;
}

function beginRequest(resource: ExpertResource): RequestToken | null {
  const connId = useConnectionsStore.getState().activeConnId;
  if (!connId) return null;
  const transport = activeTransport();
  if (!transport) return null;
  return { resource, seq: ++reqSeqs[resource], connId, transport };
}

function isCurrentRequest(token: RequestToken): boolean {
  return (
    token.seq === reqSeqs[token.resource] &&
    token.connId === useConnectionsStore.getState().activeConnId &&
    token.transport === activeTransport()
  );
}

export const useExpertsStore = create<ExpertsState>((set, get) => {
  /** 写面统一出口：串行排队 + saving 态 + 三重防迟到校验 */
  async function enqueueWrite(path: string, body: unknown): Promise<boolean> {
    const token = beginRequest("mine");
    if (!token) return false;
    pendingWrites += 1;
    set({ saving: true, loading: false, error: null });
    const doWrite = async (): Promise<boolean> => {
      try {
        const result = await wireRequest("POST", path, body, token.transport);
        if (!isCurrentRequest(token)) return false;
        if (!result.ok) {
          set({ error: result.code || result.message });
          return false;
        }
        return true;
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
        return false;
      } finally {
        pendingWrites -= 1;
        if (pendingWrites === 0) set({ saving: false });
      }
    };
    const queued = writeChain.then(doWrite);
    writeChain = queued;
    return queued;
  }

  return {
    mine: [],
    loading: false,
    saving: false,
    error: null,
    initialized: false,
    marketList: [],
    marketLoading: false,
    marketError: null,
    marketInitialized: false,

    loadMine: async () => {
      const token = beginRequest("mine");
      if (!token) return;
      set({ loading: true, error: null });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.assistant.query,
          null,
          token.transport,
        );
        if (!isCurrentRequest(token)) return;
        if (!result.ok) {
          set({ error: result.code || result.message });
          return;
        }
        const rows = parseMineList(result.data);
        if (!rows) {
          set({ error: "Invalid assistant list response" });
          return;
        }
        set({ mine: rows, error: null, initialized: true });
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
      } finally {
        if (isCurrentRequest(token)) set({ loading: false });
      }
    },

    loadDetail: async (id) => {
      const token = beginRequest("mine");
      if (!token) return null;
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.assistant.detail,
          { id },
          token.transport,
        );
        if (!isCurrentRequest(token)) return null;
        if (!result.ok) {
          set({ error: result.code || result.message });
          return null;
        }
        return parseAssistantDetail(result.data, true);
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
        return null;
      }
    },

    save: async (payload) => {
      const ok = await enqueueWrite(ENDPOINTS.assistant.save, payload);
      if (ok) await get().loadMine();
      return ok;
    },

    remove: async (id) => {
      const ok = await enqueueWrite(ENDPOINTS.assistant.delete, { id });
      if (ok) await get().loadMine();
      return ok;
    },

    loadMarket: async () => {
      const token = beginRequest("market");
      if (!token) return;
      set({ marketLoading: true, marketError: null });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.assistant.marketList,
          null,
          token.transport,
        );
        if (!isCurrentRequest(token)) return;
        if (!result.ok) {
          set({ marketError: result.code || result.message });
          return;
        }
        const rows = parseMarketList(result.data);
        if (!rows) {
          set({ marketError: "Invalid expert market list response" });
          return;
        }
        set({ marketList: rows, marketError: null, marketInitialized: true });
      } catch (error) {
        if (isCurrentRequest(token)) {
          set({ marketError: errorMessage(error) });
        }
      } finally {
        if (isCurrentRequest(token)) set({ marketLoading: false });
      }
    },

    loadMarketDetail: async (slug) => {
      const token = beginRequest("market");
      if (!token) return null;
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.assistant.marketDetail,
          { slug },
          token.transport,
        );
        if (!isCurrentRequest(token)) return null;
        if (!result.ok) {
          set({ marketError: result.code || result.message });
          return null;
        }
        return parseMarketDetail(result.data);
      } catch (error) {
        if (isCurrentRequest(token)) {
          set({ marketError: errorMessage(error) });
        }
        return null;
      }
    },

    installFromMarket: async (slug) => {
      const detail = await get().loadMarketDetail(slug);
      if (!detail) return false;
      return get().save({
        name: detail.name,
        icon: detail.icon ?? null,
        systemPrompt: detail.systemPrompt,
        description: detail.description,
        tags: detail.tags,
        profession: detail.profession,
        categoryId: detail.categoryId,
        // 市场来源回填（体验精修批契约增量——入库记出处）
        sourceSlug: detail.slug,
        quickPrompts: detail.quickPrompts ?? null,
        skillNames: detail.skillNames ?? null,
        temperature: detail.temperature ?? null,
        topP: detail.topP ?? null,
        maxTokens: detail.maxTokens ?? null,
        ...(detail.isTeam
          ? { expertType: "team" as const, members: detail.members ?? [] }
          : {}),
      });
    },

    exportExpert: async (id) => {
      const token = beginRequest("mine");
      if (!token) return null;
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.assistant.export,
          { id },
          token.transport,
        );
        if (!isCurrentRequest(token)) return null;
        if (!result.ok) {
          set({ error: result.code || result.message });
          return null;
        }
        const data = result.data as { json?: unknown } | null;
        if (typeof data?.json !== "string") {
          set({ error: "Invalid assistant export response" });
          return null;
        }
        return data.json;
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
        return null;
      }
    },

    importExpert: async (json) => {
      const ok = await enqueueWrite(ENDPOINTS.assistant.import, { json });
      if (ok) await get().loadMine();
      return ok;
    },

    resetForTest: () => {
      reqSeqs.mine += 1;
      reqSeqs.market += 1;
      writeChain = Promise.resolve();
      pendingWrites = 0;
      set({
        mine: [],
        loading: false,
        saving: false,
        error: null,
        initialized: false,
        marketList: [],
        marketLoading: false,
        marketError: null,
        marketInitialized: false,
      });
    },
  };
});
