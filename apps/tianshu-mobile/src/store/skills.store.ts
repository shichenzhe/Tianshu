// 技能远端数据 store（A3 批）：已装列表（skills/query 扩展概要——场景/
// 来源/内置标记）+ 正文预览（skills/read）+ 场景打标（setScenarios）/
// 卸载（uninstall，builtin 服务端拒）写面 + SkillHub 市场面（categories/
// top/list 分页/install——zip 宿主侧下载，手机零流量）。
// A3 尾：zip 上传安装面（installUpload——document-picker 选包经 base64
// 上传，写面串行同 enqueueWrite 纪律）+ 统计读面（skills/stats——技能
// 详情弹层「调用 N 次 · 最近使用」行，空统计不显，失败静默降级）。
// 读面直通，写面经 enqueueWrite 串行；skillhub 市场面走能力门禁
// （capabilities 含 "skillhub" 才发请求，无头端不报即静默降级）。
// 请求序号按资源拆五份（installed/stats/categories/market/install）——
// 并行 loadCategories→loadMarketTop→load 不再互相过期丢响应（旧全局
// reqSeq 下先到者 finally 被防迟到挡下不复位 loading，致市场/已装列表
// 永久转圈）；market（top/list 筛选）与 install 读写拆分——安装响应慢
// 期间切分类/搜索不再互判过期（各自 finally 均能复位进度态）。
import { create } from "zustand";
import {
  ENDPOINTS,
  SKILL_SCENARIOS,
  type SkillHubCategoryDto,
  type SkillHubDetailDto,
  type SkillHubSkillDto,
  type SkillInstallResultDto,
  type SkillScenario,
} from "@tianshu/protocol";
import { wireRequest } from "../transport/wire";
import { activeTransport, useConnectionsStore } from "./connections.store";

/** 已装技能行（skills/query 扩展概要） */
export interface SkillManageRow {
  name: string;
  enabled: boolean;
  scenarios: SkillScenario[];
  source: string | null;
  builtin: boolean;
}

/** 技能统计行（skills/stats——lastUsedAt 归一为 epoch ms，缺席 null） */
export interface SkillStatEntry {
  usedCount: number;
  lastUsedAt: number | null;
}

/** 市场列表载荷（skillhub/list 查询参数） */
export interface SkillMarketQuery {
  keyword?: string;
  category?: string;
  page?: number;
  pageSize?: number;
}

interface SkillsState {
  rows: SkillManageRow[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  initialized: boolean;
  /** 正文预览（skills/read——按名直取不入 state） */
  readContent(name: string): Promise<string>;
  load(): Promise<void>;
  /** 启停（skills/setEnabled——乐观补丁+失败回滚由调用方组合） */
  setEnabled(name: string, enabled: boolean): Promise<boolean>;
  patchEnabled(name: string, enabled: boolean): void;
  setScenarios(name: string, scenarios: SkillScenario[]): Promise<boolean>;
  uninstall(name: string): Promise<boolean>;
  /** A3 尾：zip 上传安装（{name, base64}；conflict 原样返回供覆盖确认；
   *  写面串行 + uploadingZip 单槽进度态） */
  installUpload(
    name: string,
    base64: string,
    overwrite?: boolean,
  ): Promise<SkillInstallResultDto | null>;
  uploadingZip: boolean;
  /** A3 尾：统计读面（技能详情弹层消费；load 成功后顺带拉取） */
  stats: Record<string, SkillStatEntry>;
  loadStats(): Promise<void>;
  /** SkillHub 市场面（能力门禁 skillhub——categories/featured/list/install） */
  categories: SkillHubCategoryDto[];
  marketItems: SkillHubSkillDto[];
  marketTotal: number;
  marketPage: number;
  marketLoading: boolean;
  marketLoadingMore: boolean;
  marketError: string | null;
  /** 安装失败错码（与 marketError 分列：marketError 由列表筛选面写、
   *  UI 行内展示；installError 由安装链写、toast 消费——互不串扰） */
  installError: string | null;
  marketKeyword: string;
  marketCategory: string | null;
  installingSlug: string | null;
  /** detail 批：hub 详情（正文/统计/作者/安全归一）——详情页增广区
   *  消费；失败写 detailError 静默降级（概要区照常渲染） */
  detail: SkillHubDetailDto | null;
  detailLoading: boolean;
  detailError: string | null;
  loadDetail(slug: string): Promise<void>;
  loadCategories(): Promise<void>;
  /** 推荐位（skillhub/top——初始浏览态） */
  loadMarketTop(): Promise<void>;
  /** 条件列表（skillhub/list；reset=true 翻回第一页，否则下一页追加） */
  searchMarket(query: SkillMarketQuery, reset: boolean): Promise<void>;
  setMarketKeyword(keyword: string): void;
  setMarketCategory(category: string | null): void;
  /** 安装；conflict 原样返回供调用方弹覆盖确认 */
  install(
    slug: string,
    overwrite?: boolean,
  ): Promise<SkillInstallResultDto | null>;
  resetForTest(): void;
}

const MARKET_PAGE_SIZE = 20;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseScenarios(value: unknown): SkillScenario[] | null {
  if (!Array.isArray(value)) return null;
  const scenarios = value.filter((item): item is SkillScenario =>
    (SKILL_SCENARIOS as readonly string[]).includes(item as string),
  );
  return scenarios.length === value.length ? scenarios : null;
}

function parseRow(value: unknown): SkillManageRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string") return null;
  const scenarios = parseScenarios(row.scenarios);
  if (row.scenarios !== undefined && !scenarios) return null;
  return {
    name: row.name,
    enabled: row.enabled !== false,
    scenarios: scenarios ?? [],
    source: nullableString(row.source),
    builtin: row.builtin === true,
  };
}

function parseRows(data: unknown): SkillManageRow[] | null {
  if (!Array.isArray(data)) return null;
  const rows = data.map(parseRow);
  return rows.every((row) => row !== null) ? (rows as SkillManageRow[]) : null;
}

function parseCategories(data: unknown): SkillHubCategoryDto[] | null {
  if (!Array.isArray(data)) return null;
  const rows = data.map((value) => {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.key !== "string" ||
      typeof row.name !== "string" ||
      typeof row.nameEn !== "string"
    ) {
      return null;
    }
    return {
      key: row.key,
      name: row.name,
      nameEn: row.nameEn,
      sortOrder: typeof row.sortOrder === "number" ? row.sortOrder : 0,
    };
  });
  return rows.every((row) => row !== null)
    ? (rows as SkillHubCategoryDto[])
    : null;
}

function parseSkill(value: unknown): SkillHubSkillDto | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.slug !== "string" ||
    typeof row.name !== "string" ||
    typeof row.description !== "string" ||
    typeof row.category !== "string" ||
    typeof row.version !== "string" ||
    typeof row.source !== "string"
  ) {
    return null;
  }
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    description_zh:
      typeof row.description_zh === "string" ? row.description_zh : "",
    iconUrl: nullableString(row.iconUrl),
    category: row.category,
    version: row.version,
    downloads: typeof row.downloads === "number" ? row.downloads : 0,
    stars: typeof row.stars === "number" ? row.stars : 0,
    score: typeof row.score === "number" ? row.score : 0,
    source: row.source,
  };
}

/** 市场行按 slug 去重（保首见）——上游 hub top/list 会出同 slug 重复行
 *  （真机 LogBox 报 duplicate key `.$dev-expert`/`.$agent-browser`，
 *  SkillHubSection keyExtractor 取 slug），客户端去重兜底，防 RN key 冲突 */
function dedupeSkillsBySlug(skills: SkillHubSkillDto[]): SkillHubSkillDto[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.slug)) return false;
    seen.add(skill.slug);
    return true;
  });
}

/** skillhub/detail 响应形状守卫：skill.slug 非空字符串才收（可选段
 *  宽容——overviewMd/stats 等缺省不拒收，消费端占位兜底） */
function parseDetail(value: unknown): SkillHubDetailDto | null {
  if (typeof value !== "object" || value === null) return null;
  const detail = value as { skill?: { slug?: unknown } };
  if (
    typeof detail.skill?.slug !== "string" ||
    detail.skill.slug === ""
  ) {
    return null;
  }
  return value as SkillHubDetailDto;
}

function parseSkillArray(data: unknown): SkillHubSkillDto[] | null {
  if (!Array.isArray(data)) return null;
  // 逐行过滤：非法行跳过、合法行保留（照 sessions「非法行整行过滤」先
  // 例）——任一条六字段不合规不再整页 null；数组级 null 仅保留给非数组
  // 响应（上游数据完整度差异不再把整页打成「Invalid skillhub response」）
  return dedupeSkillsBySlug(
    data.map(parseSkill).filter((row): row is SkillHubSkillDto => row !== null),
  );
}

function parsePage(data: unknown): {
  total: number;
  skills: SkillHubSkillDto[];
} | null {
  if (typeof data !== "object" || data === null) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.total !== "number") return null;
  const skills = parseSkillArray(row.skills);
  if (!skills) return null;
  return { total: row.total, skills };
}

/** stats 载荷 → 按名索引（lastUsedAt ISO 串/epoch ms 均收，归一 epoch ms；
 *  非法行跳过；非数组返回 null——loadStats 静默不降 error） */
function parseStats(data: unknown): Record<string, SkillStatEntry> | null {
  if (!Array.isArray(data)) return null;
  const stats: Record<string, SkillStatEntry> = {};
  for (const value of data) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.name !== "string" || typeof row.usedCount !== "number") {
      continue;
    }
    let lastUsedAt: number | null = null;
    if (typeof row.lastUsedAt === "number") {
      lastUsedAt = row.lastUsedAt;
    } else if (typeof row.lastUsedAt === "string") {
      const ms = new Date(row.lastUsedAt).getTime();
      lastUsedAt = Number.isNaN(ms) ? null : ms;
    }
    stats[row.name] = { usedCount: row.usedCount, lastUsedAt };
  }
  return stats;
}

function parseInstallResult(data: unknown): SkillInstallResultDto | null {
  if (typeof data !== "object" || data === null) return null;
  const row = data as Record<string, unknown>;
  if (row.status === "conflict" && typeof row.name === "string") {
    return { status: "conflict", name: row.name };
  }
  if (row.status === "installed" && typeof row.record === "object") {
    const record = row.record as Record<string, unknown>;
    if (
      typeof record === "object" &&
      record !== null &&
      typeof record.id === "number" &&
      typeof record.name === "string" &&
      typeof record.source === "string"
    ) {
      return {
        status: "installed",
        record: {
          id: record.id,
          name: record.name,
          source: record.source,
          slug: nullableString(record.slug),
          version: nullableString(record.version),
        },
      };
    }
  }
  return null;
}

/** 资源内请求序号：installed（列表/正文/写面/zip 上传）/ stats / categories /
 *  market（top/list 筛选）/ install（市场安装）各自独立——SkillHubSection
 *  连发 loadCategories→loadMarketTop→load 与 load 成功后顺带 loadStats 不
 *  再互相过期（旧全局 reqSeq 下先到者响应被丢弃、finally 被防迟到挡下不
 *  复位 loading/marketLoading）；market 与 install 拆分后筛选与安装交错不
 *  互判过期（安装响应慢期间切分类，筛选结果照常落地）；同资源内后发仍
 *  使先发过期 */
type SkillResource =
  | "installed"
  | "stats"
  | "categories"
  | "market"
  | "install"
  | "detail";
const reqSeqs: Record<SkillResource, number> = {
  installed: 0,
  stats: 0,
  categories: 0,
  market: 0,
  install: 0,
  detail: 0,
};
let writeChain: Promise<unknown> = Promise.resolve();
let pendingWrites = 0;

interface RequestToken {
  resource: SkillResource;
  seq: number;
  connId: string | null;
  transport: ReturnType<typeof activeTransport>;
}

function beginRequest(resource: SkillResource): RequestToken | null {
  const connId = useConnectionsStore.getState().activeConnId;
  if (!connId) return null;
  const transport = activeTransport();
  if (!transport) return null;
  return { resource, seq: ++reqSeqs[resource], connId, transport };
}

/** skillhub 面额外能力门禁（categories/market/install 三资源共用）：
 *  无 skillhub 能力不发请求（返回 null） */
function beginGatedRequest(
  resource: Extract<
    SkillResource,
    "categories" | "market" | "install" | "detail"
  >,
): RequestToken | null {
  const token = beginRequest(resource);
  if (!token) return null;
  const capabilities =
    useConnectionsStore.getState().capabilitiesByConn[token.connId ?? ""];
  if (!capabilities?.includes("skillhub")) return null;
  return token;
}

function isCurrentRequest(token: RequestToken): boolean {
  return (
    token.seq === reqSeqs[token.resource] &&
    token.connId === useConnectionsStore.getState().activeConnId &&
    token.transport === activeTransport()
  );
}

export const useSkillsStore = create<SkillsState>((set, get) => {
  /** 写面统一出口：串行排队 + saving 态 + 三重防迟到；成功后重拉列表
   *  （服务端不回权威列表，重拉即对齐） */
  async function enqueueWrite(path: string, body: unknown): Promise<boolean> {
    const token = beginRequest("installed");
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

  /** 市场列表请求骨架（skillhub/list 分页追加语义） */
  async function fetchMarketPage(body: unknown, reset: boolean): Promise<void> {
    const token = beginGatedRequest("market");
    if (!token) return;
    if (reset) {
      set({ marketLoading: true, marketError: null, marketPage: 0 });
    } else {
      set({ marketLoadingMore: true, marketError: null });
    }
    try {
      const result = await wireRequest(
        "POST",
        ENDPOINTS.skillhub.list,
        body,
        token.transport,
      );
      if (!isCurrentRequest(token)) return;
      if (!result.ok) {
        set({ marketError: result.code || result.message });
        return;
      }
      const page = parsePage(result.data);
      if (!page) {
        set({ marketError: "Invalid skillhub list response" });
        return;
      }
      set((state) => {
        // 翻页追加同样过 slug 去重——上游分页若与已载页重叠（或未实现
        // 分页每页同集），追加不产生重复行
        const merged = reset
          ? page.skills
          : dedupeSkillsBySlug([...state.marketItems, ...page.skills]);
        return {
          marketItems: merged,
          marketTotal: page.total,
          marketPage: reset ? 1 : state.marketPage + 1,
          marketError: null,
        };
      });
    } catch (error) {
      if (isCurrentRequest(token)) {
        set({ marketError: errorMessage(error) });
      }
    } finally {
      if (isCurrentRequest(token)) {
        set({ marketLoading: false, marketLoadingMore: false });
      }
    }
  }

  return {
    rows: [],
    loading: false,
    saving: false,
    error: null,
    initialized: false,

    load: async () => {
      const token = beginRequest("installed");
      if (!token) return;
      set({ loading: true, error: null });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.skills.query,
          null,
          token.transport,
        );
        if (!isCurrentRequest(token)) return;
        if (!result.ok) {
          set({ error: result.code || result.message });
          return;
        }
        const rows = parseRows(result.data);
        if (!rows) {
          set({ error: "Invalid skills list response" });
          return;
        }
        set({ rows, error: null, initialized: true });
        // A3 尾：统计面顺带拉取（旧被控端无此端点——loadStats 内静默降级）
        void get().loadStats();
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
      } finally {
        if (isCurrentRequest(token)) set({ loading: false });
      }
    },

    readContent: async (name) => {
      const token = beginRequest("installed");
      if (!token) throw new Error("no connection");
      const result = await wireRequest(
        "POST",
        ENDPOINTS.skills.read,
        { name },
        token.transport,
      );
      if (!isCurrentRequest(token)) throw new Error("stale response");
      if (!result.ok) {
        throw new Error(result.message || result.code || "read failed");
      }
      if (
        typeof result.data !== "object" ||
        result.data === null ||
        typeof (result.data as { content?: unknown }).content !== "string"
      ) {
        throw new Error("Invalid skill read response");
      }
      return (result.data as { content: string }).content;
    },

    setEnabled: (name, enabled) =>
      enqueueWrite(ENDPOINTS.skills.setEnabled, { name, enabled }),

    patchEnabled: (name, enabled) => {
      set((state) => ({
        rows: state.rows.map((row) =>
          row.name === name ? { ...row, enabled } : row,
        ),
      }));
    },

    setScenarios: async (name, scenarios) => {
      const ok = await enqueueWrite(ENDPOINTS.skills.setScenarios, {
        name,
        scenarios,
      });
      if (ok) await get().load();
      return ok;
    },

    uninstall: async (name) => {
      const ok = await enqueueWrite(ENDPOINTS.skills.uninstall, { name });
      if (ok) await get().load();
      return ok;
    },

    uploadingZip: false,

    installUpload: async (name, base64, overwrite = false) => {
      const token = beginRequest("installed");
      if (!token) return null;
      pendingWrites += 1;
      set({ saving: true, uploadingZip: true, error: null });
      const doWrite = async (): Promise<SkillInstallResultDto | null> => {
        try {
          const result = await wireRequest(
            "POST",
            ENDPOINTS.skills.installUpload,
            { name, base64, overwrite },
            token.transport,
          );
          if (!isCurrentRequest(token)) return null;
          if (!result.ok) {
            set({ error: result.code || result.message });
            return null;
          }
          const parsed = parseInstallResult(result.data);
          if (!parsed) {
            set({ error: "Invalid skills installUpload response" });
            return null;
          }
          if (parsed.status === "installed") await get().load();
          return parsed;
        } catch (error) {
          if (isCurrentRequest(token)) set({ error: errorMessage(error) });
          return null;
        } finally {
          pendingWrites -= 1;
          if (pendingWrites === 0) set({ saving: false });
          // 单槽进度态无条件复位（成功后重拉会推进 reqSeq，旧 token
          // 校验不再适用——与 install 的 installingSlug 同纪律）
          set({ uploadingZip: false });
        }
      };
      const queued = writeChain.then(doWrite);
      writeChain = queued;
      return queued;
    },

    stats: {},

    loadStats: async () => {
      const token = beginRequest("stats");
      if (!token) return;
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.skills.stats,
          null,
          token.transport,
        );
        if (!isCurrentRequest(token) || !result.ok) return;
        const stats = parseStats(result.data);
        if (stats) set({ stats });
      } catch {
        // 统计面失败静默（旧被控端无此端点——详情弹层无统计行即降级）
      }
    },

    categories: [],
    marketItems: [],
    marketTotal: 0,
    marketPage: 0,
    marketLoading: false,
    marketLoadingMore: false,
    marketError: null,
    installError: null,
    marketKeyword: "",
    marketCategory: null,
    installingSlug: null,
    detail: null,
    detailLoading: false,
    detailError: null,

    loadDetail: async (slug) => {
      // 独立 detail 资源序号：详情页增广区与市场筛选/安装互不过期
      const token = beginGatedRequest("detail");
      if (!token) return;
      set({ detail: null, detailLoading: true, detailError: null });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.skillhub.detail,
          { slug },
          token.transport,
        );
        if (!isCurrentRequest(token)) return;
        if (!result.ok) {
          set({ detailError: result.code || result.message });
          return;
        }
        const detail = parseDetail(result.data);
        if (!detail) {
          set({ detailError: "Invalid skillhub detail response" });
          return;
        }
        set({ detail });
      } catch (error) {
        if (isCurrentRequest(token)) {
          set({ detailError: errorMessage(error) });
        }
      } finally {
        if (isCurrentRequest(token)) set({ detailLoading: false });
      }
    },

    loadCategories: async () => {
      const token = beginGatedRequest("categories");
      if (!token) return;
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.skillhub.categories,
          null,
          token.transport,
        );
        if (!isCurrentRequest(token) || !result.ok) return;
        const categories = parseCategories(result.data);
        if (categories) set({ categories });
      } catch {
        // 分类面失败静默（列表仍可用 key 浏览）
      }
    },

    loadMarketTop: async () => {
      // skillhub/top 返回数组（非分页形状）——直接替换浏览态
      const token = beginGatedRequest("market");
      if (!token) return;
      set({ marketLoading: true, marketError: null, marketPage: 1 });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.skillhub.top,
          null,
          token.transport,
        );
        if (!isCurrentRequest(token)) return;
        if (!result.ok) {
          set({ marketError: result.code || result.message });
          return;
        }
        const skills = parseSkillArray(result.data);
        if (!skills) {
          set({ marketError: "Invalid skillhub top response" });
          return;
        }
        set({
          marketItems: skills,
          marketTotal: skills.length,
          marketPage: 1,
          marketError: null,
        });
      } catch (error) {
        if (isCurrentRequest(token)) {
          set({ marketError: errorMessage(error) });
        }
      } finally {
        if (isCurrentRequest(token)) set({ marketLoading: false });
      }
    },

    searchMarket: async (query, reset) => {
      const page = reset ? 1 : get().marketPage + 1;
      if (reset) set({ marketKeyword: query.keyword ?? "" });
      if (query.category !== undefined || reset) {
        set({ marketCategory: query.category ?? null });
      }
      await fetchMarketPage(
        {
          keyword: query.keyword || undefined,
          category: query.category || undefined,
          page,
          pageSize: MARKET_PAGE_SIZE,
          sortBy: "score",
        },
        reset,
      );
    },

    setMarketKeyword: (keyword) => {
      set({ marketKeyword: keyword });
    },

    setMarketCategory: (category) => {
      set({ marketCategory: category });
    },

    install: async (slug, overwrite) => {
      // 独立 install 资源序号：筛选（market）请求不再使安装响应被判过期，
      // 反之亦然——安装响应慢期间切分类，筛选结果照常落地、安装完成
      // 也正常 toast
      const token = beginGatedRequest("install");
      if (!token) return null;
      set({ installingSlug: slug, installError: null });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.skillhub.install,
          { slug, overwrite },
          token.transport,
        );
        if (!isCurrentRequest(token)) return null;
        if (!result.ok) {
          set({ installError: result.code || result.message });
          return null;
        }
        const parsed = parseInstallResult(result.data);
        if (!parsed) {
          set({ installError: "Invalid skillhub install response" });
          return null;
        }
        // installed 重拉走 installed 资源序号——本 token 属 install 资源，
        // 不受影响（内部重拉推进 reqSeqs.installed 而非 reqSeqs.install）
        if (parsed.status === "installed") await get().load();
        return parsed;
      } catch (error) {
        if (isCurrentRequest(token)) {
          set({ installError: errorMessage(error) });
        }
        return null;
      } finally {
        // installingSlug 为单槽进度态：无条件复位（成功后重拉会推进
        // reqSeqs.installed，与本 token 的 install 序号无关——同旧纪律）
        set({ installingSlug: null });
      }
    },

    resetForTest: () => {
      reqSeqs.installed += 1;
      reqSeqs.stats += 1;
      reqSeqs.categories += 1;
      reqSeqs.market += 1;
      reqSeqs.install += 1;
      reqSeqs.detail += 1;
      writeChain = Promise.resolve();
      pendingWrites = 0;
      set({
        rows: [],
        loading: false,
        saving: false,
        error: null,
        initialized: false,
        categories: [],
        marketItems: [],
        marketTotal: 0,
        marketPage: 0,
        marketLoading: false,
        marketLoadingMore: false,
        marketError: null,
        installError: null,
        marketKeyword: "",
        marketCategory: null,
        installingSlug: null,
        uploadingZip: false,
        stats: {},
        detail: null,
        detailLoading: false,
        detailError: null,
      });
    },
  };
});
