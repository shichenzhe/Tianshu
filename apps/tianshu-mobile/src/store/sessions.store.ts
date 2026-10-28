import { create } from "zustand";
import {
  ENDPOINTS,
  type ServerEvent,
  type SessionLastMessage,
} from "@tianshu/protocol";

import {
  activeTransport,
  subscribeTransportEvents,
  useConnectionsStore,
} from "./connections.store";
import {
  computeActivityAfter,
  type SessionTimeFilter,
} from "../logic/session-time-filter";
import type { TransportRequestResult } from "../transport/types";

/** 会话列表行子集（server-face session/query records 按需裁剪；title 防御 null） */
export interface SessionBrief {
  id: number;
  title: string | null;
  updatedAt: string;
  archivedAt: string | null;
  /** 置顶时间戳（LA 批字段透传；null=未置顶）——本地重排消费 */
  pinnedAt: string | null;
  /** 归属工作空间（MB-T2 分组消费；HD-A2 起列表行透传） */
  workspaceId?: number | null;
  /** B5 撤销批：归档撤销窗口内的暂存标记（默认视图下行不即删——窗口到点
   *  settleArchive 落定移除；撤销即清） */
  pendingArchive?: boolean;
  /** P1 未读角标批：未读 assistant 消息数（服务端查询期动态算；旧被控端
   *  未下发=0）；session/read 上报成功或 session.updated 事件同步 */
  unreadCount: number;
  /** P1 未读角标批：末条消息摘要（无消息/旧被控端未下发=null） */
  lastMessage: SessionLastMessage | null;
}

interface QueryPageData {
  records: SessionBrief[];
  total: number;
}

/** A8 工作空间管理批：工作空间概要（MB-T2 起消费；directoryPath/
 *  defaultModelId 本批补齐——wire 四字段已有，纯投影）。directoryPath
 *  移动端仅展示 basename（自由传路径是桌面 GUI 写面，本批不做绑定/解绑） */
export interface WorkspaceBrief {
  id: number;
  name: string;
  /** 绑定目录原值（null=未绑定） */
  directoryPath: string | null;
  /** 空间默认模型（库内行 id；v1 仅透传，不做远程切换选择器） */
  defaultModelId: number | null;
}

interface SessionsState {
  items: SessionBrief[];
  /** 工作空间概要（MB-T2 分组；拉取失败空表——分组退化为全兜底不阻断） */
  workspaces: WorkspaceBrief[];
  /** 体验精修批：按需单拉工作空间概要（专家页对话式创建等入口——不连带
   *  会话列表主拉）；失败保留旧表 */
  loadWorkspaces(): Promise<void>;
  total: number;
  page: number;
  keyword: string;
  /** 归档筛选（LA 交互批）：false=仅未归档（默认，对齐桌面侧栏语义）；
   *  true=含归档全量。切换即重拉第一页 */
  showArchived: boolean;
  /** 时间筛选（A11 批）：all=不限（默认）；today/week/month=本机滚动窗——
   *  选中非 all 时 session/query 带 activityAfter（客户端算好阈值上送，
   *  服务端按 会话活动时间 lastMessageAt ?? updatedAt >= 阈值 过滤）。
   *  与归档筛选独立可叠加。切换即重拉第一页（清组缓存由调用方做，照
   *  归档切换先例） */
  timeFilter: SessionTimeFilter;
  loading: boolean;
  /** 下拉刷新指示器专用（loadFirst/事件重拉置位）：与 loading（含分页
   *  续拉）分离——续页加载不再误亮顶部刷新条 */
  refreshing: boolean;
  loadFirst(): Promise<void>;
  loadMore(): Promise<void>;
  search(kw: string): void;
  setShowArchived(v: boolean): void;
  /** A11 时间筛选：同值幂等；切换即重拉第一页 */
  setTimeFilter(v: SessionTimeFilter): void;
  /** 置顶/归档/重命名切换（session/update；成功本地即时反映+重排，失败 false） */
  update(
    id: number,
    params: { pinned?: boolean; archived?: boolean; title?: string },
  ): Promise<boolean>;
  /** P1 未读角标批：已读上报生效后应用服务端游标后的未读数——主列表与
   *  组缓存同步清角标（迟到旧响应的时序过滤在调用方 stream.store 做） */
  applyRead(id: number, unreadCount: number): void;
  /** B5 撤销批：归档撤销窗口到点落定——默认视图下移除暂存行（组缓存同步
   *  滤行）；已撤销（无 pendingArchive 标记）/已移除为 no-op */
  settleArchive(id: number): void;
  /** 新建会话（workspaceId 缺省挂被控端默认空间）；成功返回 brief 即时入列 */
  create(title?: string, workspaceId?: number): Promise<SessionBrief | null>;
  remove(id: number): Promise<boolean>;
  /** A8 工作空间管理批：新建空间（workspace/create；icon 可选 emoji——
   *  wire 概要不回读 icon）；成功投影四字段入清单并返回 */
  createWorkspace(name: string, icon?: string): Promise<WorkspaceBrief | null>;
  /** A8：重命名（workspace/update；归属校验在被控端） */
  renameWorkspace(id: number, name: string): Promise<boolean>;
  /** A8：删除（workspace/delete——桌面同级联语义：消息→会话→空间行，
   *  不删磁盘文件）；成功后本地从清单移除、清该组缓存，该空间会话行
   *  （服务端已级联删除）同步从主列表滤除 */
  deleteWorkspace(id: number): Promise<boolean>;
  /** GL-P5 组懒加载缓存（首页分组折叠）：key=workspaceId（-1=未归属哨兵） */
  workspaceSessions: Record<number, WorkspaceSessionsState>;
  /** 展开组时拉取（首页组第一页 50；loaded 缓存复用，收缩不清）；null=未归属 */
  loadWorkspaceSessions(workspaceId: number | null): Promise<void>;
  /** 清组缓存（筛选切换/下拉刷新——下次展开重拉） */
  clearWorkspaceSessions(): void;
  /** 事件订阅装配（App 级只绑一次：session.updated 原地刷新+重排、server.connected 全量重拉） */
  bindEvents(): void;
}

const PAGE_SIZE = 50;

/** GL-P5 未归属组哨兵 key（workspaceId null 的会话） */
export const UNGROUPED_KEY = -1;

/** GL-P5 组会话缓存项：loaded=true 展开复用（收缩不清缓存）；失败不置
 *  loaded——重展开重试 */
export interface WorkspaceSessionsState {
  items: SessionBrief[];
  loading: boolean;
  loaded: boolean;
}

/** search 防抖句柄（模块级：跨 setState 存续） */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
/** bindEvents 幂等守卫（模块级：App 生命周期单份订阅） */
let eventsBound = false;
/** loadFirst 时序令牌：迟到的旧响应不得覆写新 keyword 的结果 */
let loadSeq = 0;
/** A8 工作空间写面：串行链（防并发写乱序——本地投影随 run 串行落地，同连接
 *  内按入队序生效，无需序号）；防迟到靠 begin 快照 connId/transport 双因子
 *  （响应落地前已换连接即丢弃，照 library store 模式） */
let workspaceWriteChain: Promise<unknown> = Promise.resolve();

interface WorkspaceWriteToken {
  connId: string | null;
  transport: NonNullable<ReturnType<typeof activeTransport>>;
}

function beginWorkspaceWrite(): WorkspaceWriteToken | null {
  const transport = activeTransport();
  if (!transport) return null;
  return {
    connId: useConnectionsStore.getState().activeConnId,
    transport,
  };
}

function isCurrentWorkspaceWrite(token: WorkspaceWriteToken): boolean {
  return (
    token.connId === useConnectionsStore.getState().activeConnId &&
    token.transport === activeTransport()
  );
}

type SessionRow = {
  id?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  archivedAt?: unknown;
  pinnedAt?: unknown;
  workspaceId?: unknown;
  /** P1 未读角标批：query records 动态字段（旧端可能缺席） */
  unreadCount?: unknown;
  lastMessage?: unknown;
};

/** wire 判别结果：null = 无连接/网络异常/业务错；ok = 判过 body.success 的成功帧 */
type WireOk = { ok: true; data: unknown };

/** 统一重排（对齐桌面 session-list.ts 语义）：置顶（pinnedAt 倒序）在前；
 *  其余按 updatedAt 倒序（本地无 lastMessageAt，近似）——session.updated
 *  事件与置顶/归档动作后即时应用，活跃会话上浮 */
export function reorderSessions(items: SessionBrief[]): SessionBrief[] {
  return [...items].sort((a, b) => {
    const ap = a.pinnedAt ?? "";
    const bp = b.pinnedAt ?? "";
    if (ap !== bp) return bp.localeCompare(ap);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** update 行级投影：置顶/归档/重命名字段合并。B5 撤销批——默认视图归档
 *  不即删行，置 archivedAt + pendingArchive 暂存（撤销窗口内行可还原，
 *  窗口到点由 settleArchive 落定移除）；撤销/取消归档清标记还原 */
function projectUpdate(
  item: SessionBrief,
  params: { pinned?: boolean; archived?: boolean; title?: string },
  now: string,
  showArchived: boolean,
): SessionBrief {
  return {
    ...item,
    title: params.title ?? item.title,
    pinnedAt:
      params.pinned === undefined ? item.pinnedAt : params.pinned ? now : null,
    archivedAt:
      params.archived === undefined
        ? item.archivedAt
        : params.archived
          ? now
          : null,
    pendingArchive:
      params.archived === true
        ? !showArchived
        : params.archived === false
          ? false
          : item.pendingArchive,
  };
}

/** P1 未读角标批：lastMessage wire 判别——形状不符（旧端/畸形）一律 null，
 *  不部分采纳（防半残摘要上屏） */
function toLastMessage(v: unknown): SessionLastMessage | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (
    typeof m.id !== "number" ||
    typeof m.role !== "string" ||
    (m.kind !== "text" &&
      m.kind !== "image" &&
      m.kind !== "tool" &&
      m.kind !== "empty") ||
    typeof m.text !== "string" ||
    typeof m.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: m.id,
    role: m.role,
    kind: m.kind,
    text: m.text,
    createdAt: m.createdAt,
  };
}

/** P1 未读角标批：session.updated 载荷角标投影——unreadCount/lastMessage 为
 *  服务端动态字段，旧被控端可能整段未下发：缺省保留原值（无副字段时返回
 *  空 patch），未命中会话的行不受影响由调用方过滤 */
function projectEventBadge(payload: {
  unreadCount?: unknown;
  lastMessage?: unknown;
}): { unreadCount?: number; lastMessage?: SessionLastMessage | null } {
  const patch: {
    unreadCount?: number;
    lastMessage?: SessionLastMessage | null;
  } = {};
  if (typeof payload.unreadCount === "number") {
    patch.unreadCount = payload.unreadCount;
  }
  if ("lastMessage" in payload) {
    patch.lastMessage = toLastMessage(payload.lastMessage);
  }
  return patch;
}

function toBrief(row: SessionRow): SessionBrief | null {
  if (typeof row.id !== "number" || typeof row.updatedAt !== "string")
    return null;
  return {
    id: row.id,
    title: typeof row.title === "string" ? row.title : null,
    updatedAt: row.updatedAt,
    archivedAt: typeof row.archivedAt === "string" ? row.archivedAt : null,
    pinnedAt: typeof row.pinnedAt === "string" ? row.pinnedAt : null,
    unreadCount: typeof row.unreadCount === "number" ? row.unreadCount : 0,
    lastMessage: toLastMessage(row.lastMessage),
    ...(typeof row.workspaceId === "number"
      ? { workspaceId: row.workspaceId }
      : {}),
  };
}

function toBriefList(rows: unknown): SessionBrief[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => (r && typeof r === "object" ? toBrief(r as SessionRow) : null))
    .filter((r): r is SessionBrief => r !== null);
}

function parsePage(data: unknown): QueryPageData | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { records?: unknown; total?: unknown };
  if (!Array.isArray(d.records) || typeof d.total !== "number") return null;
  return { records: toBriefList(d.records), total: d.total };
}

/** A8：workspace/query 行投影——id/name 必守，directoryPath/defaultModelId
 *  旧被控端未下发时归 null（纯投影补齐，不阻断整表） */
function toWorkspaceBrief(row: unknown): WorkspaceBrief | null {
  if (typeof row !== "object" || row === null) return null;
  const w = row as Record<string, unknown>;
  if (typeof w.id !== "number" || typeof w.name !== "string") return null;
  return {
    id: w.id,
    name: w.name,
    directoryPath: typeof w.directoryPath === "string" ? w.directoryPath : null,
    defaultModelId:
      typeof w.defaultModelId === "number" ? w.defaultModelId : null,
  };
}

/** 统一请求出口：HTTP 200 亦可能业务错，须判 body.success（server-face 契约） */
async function request(
  path: string,
  body: unknown,
  transport: ReturnType<typeof activeTransport> = activeTransport(),
): Promise<WireOk | null> {
  if (!transport) return null;
  try {
    const result: TransportRequestResult = await transport.request(
      "POST",
      path,
      body,
    );
    if (typeof result.body !== "object" || result.body === null) return null;
    const b = result.body as { success?: unknown; data?: unknown };
    if (b.success !== true) return null;
    return { ok: true, data: b.data ?? null };
  } catch {
    return null; // 网络层异常静默：保留已有列表不清空
  }
}

export const useSessionsStore = create<SessionsState>((set, get) => {
  /** A11：选中非 all 时算滚动窗阈值（null 不出键） */
  const activityAfterParam = (): { activityAfter?: string } => {
    const v = computeActivityAfter(get().timeFilter);
    return v == null ? {} : { activityAfter: v };
  };

  /** A8 工作空间写面统一出口：enqueueWrite 串行 + 防迟到（begin 快照
   *  connId/transport 双因子，响应落地前已换连接即丢弃）；返回成功帧
   *  （调用方自行消费 data 投影；delete 成功帧 data 即 null），失败/迟到
   *  返回 null */
  async function enqueueWorkspaceWrite(
    path: string,
    body: unknown,
  ): Promise<WireOk | null> {
    const token = beginWorkspaceWrite();
    if (!token) return null;
    const run = async (): Promise<WireOk | null> => {
      const r = await request(path, body, token.transport);
      if (!isCurrentWorkspaceWrite(token)) return null;
      return r;
    };
    const queued = workspaceWriteChain.then(run);
    // 链尾始终落 resolved：单写失败不阻断后续排队写
    workspaceWriteChain = queued.catch(() => undefined);
    return queued;
  }

  /** 拉指定页（loadFirst/loadMore 共用；append=false 为覆写语义） */
  async function fetchPage(page: number, append: boolean): Promise<void> {
    const token = ++loadSeq;
    set({ loading: true, ...(append ? {} : { refreshing: true }) });
    const r = await request(ENDPOINTS.session.query, {
      page,
      pageSize: PAGE_SIZE,
      keyword: get().keyword,
      // 默认仅未归档（对齐桌面侧栏）；showArchived 时不带字段=全量
      ...(get().showArchived ? {} : { archived: false }),
      // A11：时间筛选非 all 时带上送（与归档筛选独立可叠加）
      ...activityAfterParam(),
    });
    // 时序守卫：期间已发起更新的拉取（换 keyword/重拉），旧响应丢弃
    if (token !== loadSeq) return;
    // MB-T2：覆写语义（loadFirst/重拉）时另拉空间概要（失败空表——
    // 分组退化为全兜底，不阻断列表；loadMore 续页不重复拉）
    if (!append) {
      const ws = await request(ENDPOINTS.workspace.query, {});
      if (token !== loadSeq) return;
      if (ws !== null && Array.isArray(ws.data)) {
        const workspaces = ws.data
          .map(toWorkspaceBrief)
          .filter((w): w is WorkspaceBrief => w !== null);
        set({ workspaces });
      }
    }
    if (r === null) {
      // 无连接 → 置空表；网络异常/业务错 → 保守不动旧表
      if (activeTransport() === null) {
        set({
          items: [],
          total: 0,
          page: 1,
          loading: false,
          refreshing: false,
        });
      } else {
        set({ loading: false, refreshing: false });
      }
      return;
    }
    const parsed = parsePage(r.data);
    if (!parsed) {
      set({ loading: false, refreshing: false });
      return;
    }
    if (append) {
      const merged = new Map(get().items.map((i) => [i.id, i]));
      for (const row of parsed.records) merged.set(row.id, row); // 跨页重复 id 后写覆盖
      set({
        items: [...merged.values()],
        total: parsed.total,
        page,
        loading: false,
        refreshing: false,
      });
    } else {
      set({
        items: parsed.records,
        total: parsed.total,
        page,
        loading: false,
        refreshing: false,
      });
    }
  }

  return {
    items: [],
    workspaces: [],
    total: 0,
    page: 1,
    keyword: "",
    showArchived: false,
    timeFilter: "all",
    loading: false,
    refreshing: false,
    workspaceSessions: {},

    loadFirst: () => fetchPage(1, false),

    loadWorkspaces: async () => {
      const r = await request(ENDPOINTS.workspace.query, {});
      if (r === null) return; // 无连接/失败：保留旧表
      if (!Array.isArray(r.data)) return;
      set({
        workspaces: r.data
          .map(toWorkspaceBrief)
          .filter((w): w is WorkspaceBrief => w !== null),
      });
    },

    loadMore: () => {
      const { items, total, loading, page } = get();
      if (loading || items.length >= total) return Promise.resolve();
      return fetchPage(page + 1, true);
    },

    // —— GL-P5 组懒加载（首页分组折叠）：展开才查，缓存复用 ——
    loadWorkspaceSessions: async (workspaceId) => {
      const key = workspaceId ?? UNGROUPED_KEY;
      const cur = get().workspaceSessions[key];
      if (cur?.loading || cur?.loaded) return;
      set((s) => ({
        workspaceSessions: {
          ...s.workspaceSessions,
          [key]: { items: cur?.items ?? [], loading: true, loaded: false },
        },
      }));
      const r = await request(ENDPOINTS.session.query, {
        page: 0,
        pageSize: PAGE_SIZE,
        keyword: "",
        ...(workspaceId != null ? { workspaceId } : {}),
        ...(get().showArchived ? {} : { archived: false }),
        // A11：组懒加载与主列表同参（时间筛选同步覆盖两处）
        ...activityAfterParam(),
      });
      // 失败不置 loaded：无连接/网络错——重展开重试；成功归一（未归属组
      // 端点不支持反过滤，前端滤 workspaceId==null）
      let next: WorkspaceSessionsState;
      if (r === null) {
        next = { items: cur?.items ?? [], loading: false, loaded: false };
      } else {
        const records = parsePage(r.data)?.records ?? [];
        next = {
          items:
            workspaceId == null
              ? records.filter((x) => x.workspaceId == null)
              : records,
          loading: false,
          loaded: true,
        };
      }
      set((s) => ({
        workspaceSessions: {
          ...s.workspaceSessions,
          [key]: next,
        },
      }));
    },

    clearWorkspaceSessions: () => {
      set({ workspaceSessions: {} });
    },

    search: (kw) => {
      set({ keyword: kw });
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        void get().loadFirst();
      }, 400);
    },

    setShowArchived: (v) => {
      if (get().showArchived === v) return;
      set({ showArchived: v });
      void get().loadFirst();
    },

    setTimeFilter: (v) => {
      if (get().timeFilter === v) return;
      set({ timeFilter: v });
      void get().loadFirst();
    },

    update: async (id, params) => {
      const r = await request(ENDPOINTS.session.update, {
        sessionId: id,
        ...params,
      });
      if (r === null) return false;
      const now = new Date().toISOString();
      set((s) => ({
        items: reorderSessions(
          s.items.map((i) =>
            i.id === id ? projectUpdate(i, params, now, s.showArchived) : i,
          ),
        ),
        // 组缓存同步（展开中的组即时反映；B5 起归档/置顶字段一并投影）
        workspaceSessions: Object.fromEntries(
          Object.entries(s.workspaceSessions).map(([key, ws]) => [
            key,
            {
              ...ws,
              items: ws.items.map((i) =>
                i.id === id ? projectUpdate(i, params, now, s.showArchived) : i,
              ),
            },
          ]),
        ),
      }));
      return true;
    },

    applyRead: (id, unreadCount) => {
      set((s) => ({
        items: s.items.map((i) => (i.id === id ? { ...i, unreadCount } : i)),
        // 组缓存同步（展开中的组即时清角标）
        workspaceSessions: Object.fromEntries(
          Object.entries(s.workspaceSessions).map(([key, ws]) => [
            key,
            ws.items.some((i) => i.id === id)
              ? {
                  ...ws,
                  items: ws.items.map((i) =>
                    i.id === id ? { ...i, unreadCount } : i,
                  ),
                }
              : ws,
          ]),
        ),
      }));
    },

    settleArchive: (id) => {
      set((s) => {
        const pending = (i: SessionBrief) =>
          i.id === id && i.pendingArchive === true;
        const inItems = s.items.some(pending);
        const inCaches = Object.values(s.workspaceSessions).some((ws) =>
          ws.items.some(pending),
        );
        if (!inItems && !inCaches) return {}; // 已撤销/已移除：落定 no-op
        return {
          items: s.items.filter((i) => i.id !== id),
          total: Math.max(0, s.total - 1),
          workspaceSessions: Object.fromEntries(
            Object.entries(s.workspaceSessions).map(([key, ws]) => [
              key,
              { ...ws, items: ws.items.filter((i) => i.id !== id) },
            ]),
          ),
        };
      });
    },

    create: async (title, workspaceId) => {
      const r = await request(ENDPOINTS.session.create, {
        ...(title != null ? { title } : {}),
        ...(workspaceId != null ? { workspaceId } : {}),
      });
      if (r === null) return null;
      const brief = toBrief(r.data as SessionRow);
      if (brief) {
        // 新会话即时进列表（T13 审查 M1：返回列表页可见，无需下拉刷新）。
        // 置顶便于立即可见；注：两仓建会话不初始化 lastMessageAt（SQLite
        // DESC 下 NULL 居尾）——未发消息即返回列表时，下次重拉该会话会
        // 沉底，与本地置顶不一致，已知可接受（首条消息发出后即归位）
        const groupKey = brief.workspaceId ?? UNGROUPED_KEY;
        const cached = get().workspaceSessions[groupKey];
        set((s) => ({
          items: [brief, ...s.items],
          total: s.total + 1,
          // 组缓存定向插入（原全清会让展开中的组瞬时显示「暂无会话」）：
          // 仅当归属组已加载时原地前置新会话，其余组缓存不动
          workspaceSessions: cached?.loaded
            ? {
                ...s.workspaceSessions,
                [groupKey]: { ...cached, items: [brief, ...cached.items] },
              }
            : s.workspaceSessions,
        }));
      }
      return brief;
    },

    remove: async (id) => {
      const r = await request(ENDPOINTS.session.delete, { id });
      if (r === null) return false; // 无连接/失败：保留原表
      set((s) => ({
        items: s.items.filter((i) => i.id !== id),
        total: Math.max(0, s.total - 1),
        // GL-P5：组缓存同步滤行（删除即时反映在展开组）
        workspaceSessions: Object.fromEntries(
          Object.entries(s.workspaceSessions).map(([key, ws]) => [
            key,
            { ...ws, items: ws.items.filter((i) => i.id !== id) },
          ]),
        ),
      }));
      return true;
    },

    // —— A8 工作空间管理批：写面（串行 + 防迟到，见 enqueueWorkspaceWrite） ——

    createWorkspace: async (name, icon) => {
      const r = await enqueueWorkspaceWrite(ENDPOINTS.workspace.create, {
        name,
        ...(icon ? { icon } : {}),
      });
      if (r === null) return null;
      const brief = toWorkspaceBrief(r.data);
      if (!brief) return null; // 畸形响应：服务端已建行，靠下趟 loadFirst 对齐
      set((s) => ({ workspaces: [...s.workspaces, brief] }));
      return brief;
    },

    renameWorkspace: async (id, name) => {
      const r = await enqueueWorkspaceWrite(ENDPOINTS.workspace.update, {
        id,
        name,
      });
      if (r === null) return false;
      set((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
      }));
      return true;
    },

    deleteWorkspace: async (id) => {
      const r = await enqueueWorkspaceWrite(ENDPOINTS.workspace.delete, {
        id,
      });
      if (r === null) return false; // 成功帧 data 即 null——判帧不判 data
      set((s) => {
        const cascaded = s.items.filter((i) => i.workspaceId === id).length;
        const restCaches = { ...s.workspaceSessions };
        delete restCaches[id]; // 组缓存整组清（该组会话服务端已级联删除）
        return {
          workspaces: s.workspaces.filter((w) => w.id !== id),
          // 级联语义同步：该空间会话行从主列表滤除（服务端已删）
          items: s.items.filter((i) => i.workspaceId !== id),
          total: Math.max(0, s.total - cascaded),
          workspaceSessions: restCaches,
        };
      });
      return true;
    },

    bindEvents: () => {
      if (eventsBound) return;
      eventsBound = true;
      subscribeTransportEvents((e: ServerEvent) => {
        if (e.type === "server.connected") {
          void get().loadFirst();
          return;
        }
        if (e.type === "session.updated") {
          const { id, title, updatedAt } = e.payload;
          const badge = projectEventBadge(e.payload);
          // 原地刷新后重排（LA 交互批）：活跃会话上浮，置顶恒在前；
          // GL-P5：组缓存同步（命中组原地更新——事件载荷无 workspaceId，
          // 新建/跨组移动靠 create 清缓存与下拉刷新兜底）；
          // P1 未读角标批：unreadCount/lastMessage 一并投影（read 提交后
          // 服务端复用本事件清角标——updatedAt 保持库值不上浮）
          set((s) => ({
            items: reorderSessions(
              s.items.map((i) =>
                i.id === id ? { ...i, title, updatedAt, ...badge } : i,
              ),
            ),
            workspaceSessions: Object.fromEntries(
              Object.entries(s.workspaceSessions).map(([key, ws]) => [
                key,
                ws.items.some((i) => i.id === id)
                  ? {
                      ...ws,
                      items: reorderSessions(
                        ws.items.map((i) =>
                          i.id === id
                            ? { ...i, title, updatedAt, ...badge }
                            : i,
                        ),
                      ),
                    }
                  : ws,
              ]),
            ),
          }));
        }
      });
    },
  };
});

// 连接切换串台清空（M4）：activate 换目标（新 id ≠ 旧 id）时旧连接的
// 会话立即清表再 loadFirst——切端列表窗口期不残留上一被控端数据。
// store 级 subscribe（非 React 订阅）：列表页未挂载也即时清空；同 id
// 重连不触发（server.connected → bindEvents 全量重拉已覆盖）
let subscribedConnId = useConnectionsStore.getState().activeConnId;
useConnectionsStore.subscribe((s) => {
  if (s.activeConnId === subscribedConnId) return;
  subscribedConnId = s.activeConnId;
  useSessionsStore.setState({ items: [], total: 0, page: 1 });
  void useSessionsStore.getState().loadFirst();
});
