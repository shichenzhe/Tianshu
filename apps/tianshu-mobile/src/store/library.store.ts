// 资料库远端数据 store（A5 批）：浏览（list+面包屑）/搜索/最近/收藏四面 +
// 元数据写面 + 文本/图片内容读取。读面直通，写面经 enqueueWrite 串行；
// 请求前经 请求序号+activeConnId+transport 三重校验，另加 library 能力/
// 连接前置门禁（无连接/无能力不发请求）。写后局部刷新：浏览态重拉当前
// 目录，搜索/最近/收藏态置脏（下次进入该模式重拉）；toggleFavorite 即时
// 乐观更新行，失败回滚。
import { create } from "zustand";
import {
  ENDPOINTS,
  type LibraryItemDto,
  type LibraryReadImageResult,
} from "@tianshu/protocol";
import { wireRequest } from "../transport/wire";
import { activeTransport, useConnectionsStore } from "./connections.store";

export type LibraryRow = LibraryItemDto;
export type LibraryMode = "browse" | "search" | "recent" | "favorites";

/** 非浏览态写后脏标记：true = 下次进入该模式需重拉 */
interface LibraryStale {
  search: boolean;
  recent: boolean;
  favorites: boolean;
}

interface LibraryState {
  mode: LibraryMode;
  items: LibraryRow[];
  breadcrumbs: LibraryRow[];
  keyword: string;
  currentParentId: number | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** 首次成功加载后置位（页头下内容区加载/空态判定） */
  initialized: boolean;
  stale: LibraryStale;
  load(parentId?: number | null): Promise<void>;
  search(keyword: string): Promise<void>;
  loadRecent(): Promise<void>;
  loadFavorites(): Promise<void>;
  setMode(mode: Exclude<LibraryMode, "search">): Promise<void>;
  setKeyword(keyword: string): void;
  /** 移动目标选择：全量拍平树（folder 行缩进按 location 深度） */
  loadTree(): Promise<LibraryRow[]>;
  subtreeCount(id: number): Promise<number | null>;
  createFolder(name: string): Promise<boolean>;
  createFile(name: string): Promise<boolean>;
  addLink(url: string, title: string | null): Promise<boolean>;
  rename(id: number, name: string): Promise<boolean>;
  move(ids: number[], targetParentId: number | null): Promise<boolean>;
  remove(ids: number[]): Promise<boolean>;
  toggleFavorite(id: number): Promise<boolean>;
  markViewed(id: number): Promise<boolean>;
  readText(id: number): Promise<string>;
  readImage(id: number): Promise<LibraryReadImageResult>;
  /** 资料库编辑批：文本内容全量覆写（写面串行纪律同 installUpload 先例；
   *  成功回传刷新行并就地更新列表 size/updatedAt；失败抛 codedError——
   *  error.code 挂服务端稳定码，调用方按码出 toast） */
  writeContent(id: number, content: string): Promise<LibraryRow>;
  /** 资料库上传批：二进制文件入库（base64 ≤3MB 客户端预检在 logic 链）；
   *  parentId=null 传根目录；成功就地插入列表行（浏览态行补丁不重拉，
   *  非浏览态置脏）；失败抛 codedError（LIBRARY_UPLOAD_INVALID） */
  uploadFile(
    parentId: number | null,
    name: string,
    base64: string,
  ): Promise<LibraryRow>;
  resetForTest(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/** 业务错抛错时把服务端 code 挂 error.code（A5 尾：readImage 失败按码
 *  出独立文案），message 口径不变 */
function codedError(message: string, code: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  return error;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

const ITEM_KINDS = new Set(["folder", "file", "link"]);

function parseItem(value: unknown): LibraryRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "number" ||
    typeof row.name !== "string" ||
    typeof row.kind !== "string" ||
    !ITEM_KINDS.has(row.kind) ||
    typeof row.createdAt !== "string" ||
    typeof row.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: row.id,
    parentId: nullableNumber(row.parentId),
    name: row.name,
    kind: row.kind as LibraryRow["kind"],
    fileType: nullableString(row.fileType),
    mimeType: nullableString(row.mimeType),
    size: nullableNumber(row.size),
    url: nullableString(row.url),
    favorite: row.favorite === true,
    lastViewedAt: nullableString(row.lastViewedAt),
    location: Array.isArray(row.location)
      ? row.location.filter((seg): seg is string => typeof seg === "string")
      : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseItems(data: unknown): LibraryRow[] | null {
  if (!Array.isArray(data)) return null;
  const items = data.map(parseItem);
  return items.every((item) => item !== null) ? (items as LibraryRow[]) : null;
}

function parseListResult(data: unknown): {
  items: LibraryRow[];
  breadcrumbs: LibraryRow[];
} | null {
  if (typeof data !== "object" || data === null) return null;
  const result = data as { items?: unknown; breadcrumbs?: unknown };
  const items = parseItems(result.items);
  const breadcrumbs = Array.isArray(result.breadcrumbs)
    ? parseItems(result.breadcrumbs)
    : [];
  if (!items || !breadcrumbs) return null;
  return { items, breadcrumbs };
}

function parseReadResult(data: unknown): { content: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const result = data as { kind?: unknown; content?: unknown };
  if (result.kind !== "text" || typeof result.content !== "string") {
    return null;
  }
  return { content: result.content };
}

function parseReadImageResult(data: unknown): LibraryReadImageResult | null {
  if (typeof data !== "object" || data === null) return null;
  const result = data as { mime?: unknown; dataBase64?: unknown };
  if (
    typeof result.mime !== "string" ||
    typeof result.dataBase64 !== "string"
  ) {
    return null;
  }
  return { mime: result.mime, dataBase64: result.dataBase64 };
}

let reqSeq = 0;
let writeChain: Promise<unknown> = Promise.resolve();
let pendingWrites = 0;

interface RequestToken {
  seq: number;
  connId: string | null;
  transport: ReturnType<typeof activeTransport>;
}

/** 请求前置四重门禁：活动连接存在 + library 能力已协商 + transport 可用，
 *  不满足不发请求（返回 null，调用方静默返回） */
function beginRequest(): RequestToken | null {
  const connId = useConnectionsStore.getState().activeConnId;
  if (!connId) return null;
  const capabilities =
    useConnectionsStore.getState().capabilitiesByConn[connId];
  if (!capabilities?.includes("library")) return null;
  const transport = activeTransport();
  if (!transport) return null;
  return { seq: ++reqSeq, connId, transport };
}

function isCurrentRequest(token: RequestToken): boolean {
  return (
    token.seq === reqSeq &&
    token.connId === useConnectionsStore.getState().activeConnId &&
    token.transport === activeTransport()
  );
}

const INITIAL_STALE: LibraryStale = {
  search: false,
  recent: true,
  favorites: true,
};

export const useLibraryStore = create<LibraryState>((set, get) => {
  /** 写成功后局部刷新：浏览态重拉当前目录；其余态置对应脏标记 */
  function refreshAfterWrite() {
    const { mode, currentParentId } = get();
    if (mode === "browse") {
      void get().load(currentParentId);
      return;
    }
    set((state) => ({ stale: { ...state.stale, [mode]: true } }));
  }

  /** 写面统一出口：串行排队 + saving 态 + 三重防迟到校验；响应 data 不消费
   *  （服务端不返权威列表），成功后走 refreshAfterWrite 局部刷新 */
  async function enqueueWrite(path: string, body: unknown): Promise<boolean> {
    const token = beginRequest();
    if (!token) return false;
    pendingWrites += 1;
    set({ saving: true, loading: false, error: null });
    const doWrite = async (): Promise<boolean> => {
      try {
        const result = await wireRequest("POST", path, body, token.transport);
        if (!isCurrentRequest(token)) return false;
        if (!result.ok) {
          set({ error: result.message });
          return false;
        }
        refreshAfterWrite();
        return true;
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
        return false;
      } finally {
        pendingWrites -= 1;
        // 只由最后一项在途写清除；旧写迟到不得提前解锁后续写。
        if (pendingWrites === 0) set({ saving: false });
      }
    };
    const queued = writeChain.then(doWrite);
    writeChain = queued;
    return queued;
  }

  /** 收藏星乐观翻转（toggleFavorite 成功前即时更新行） */
  function flipFavoriteRow(id: number, favorite: boolean) {
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, favorite } : item,
      ),
    }));
  }

  /** 列表读取通用骨架：wire 请求 + 防迟到 + 业务错置 error 态 */
  async function fetchList(
    path: string,
    body: unknown,
    apply: (items: LibraryRow[]) => void,
  ): Promise<boolean> {
    const token = beginRequest();
    if (!token) return false;
    set({ loading: true, error: null });
    try {
      const result = await wireRequest("POST", path, body, token.transport);
      if (!isCurrentRequest(token)) return false;
      if (!result.ok) {
        set({ error: result.message });
        return false;
      }
      const items = parseItems(result.data);
      if (!items) {
        set({ error: "Invalid library list response" });
        return false;
      }
      apply(items);
      set({ error: null, initialized: true });
      return true;
    } catch (error) {
      if (isCurrentRequest(token)) set({ error: errorMessage(error) });
      return false;
    } finally {
      if (isCurrentRequest(token)) set({ loading: false });
    }
  }

  return {
    mode: "browse",
    items: [],
    breadcrumbs: [],
    keyword: "",
    currentParentId: null,
    loading: false,
    saving: false,
    error: null,
    initialized: false,
    stale: { ...INITIAL_STALE },

    load: async (parentId = null) => {
      const token = beginRequest();
      if (!token) return;
      set({
        loading: true,
        error: null,
        mode: "browse",
        currentParentId: parentId,
      });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.library.list,
          { parentId },
          token.transport,
        );
        if (!isCurrentRequest(token)) return;
        if (!result.ok) {
          set({ error: result.message });
          return;
        }
        const parsed = parseListResult(result.data);
        if (!parsed) {
          set({ error: "Invalid library list response" });
          return;
        }
        set({
          items: parsed.items,
          breadcrumbs: parsed.breadcrumbs,
          error: null,
          initialized: true,
        });
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
      } finally {
        if (isCurrentRequest(token)) set({ loading: false });
      }
    },

    search: async (keyword) => {
      set({ mode: "search", keyword });
      const ok = await fetchList(
        ENDPOINTS.library.search,
        { keyword },
        (items) => set({ items, breadcrumbs: [] }),
      );
      if (ok) set((state) => ({ stale: { ...state.stale, search: false } }));
    },

    loadRecent: async () => {
      set({ mode: "recent" });
      // 非脏态进入仅切模式：写后脏标记驱动「下次进入重拉」
      if (!get().stale.recent) return;
      const ok = await fetchList(ENDPOINTS.library.listRecent, null, (items) =>
        set({ items, breadcrumbs: [] }),
      );
      if (ok) set((state) => ({ stale: { ...state.stale, recent: false } }));
    },

    loadFavorites: async () => {
      set({ mode: "favorites" });
      if (!get().stale.favorites) return;
      const ok = await fetchList(
        ENDPOINTS.library.listFavorites,
        null,
        (items) => set({ items, breadcrumbs: [] }),
      );
      if (ok) {
        set((state) => ({ stale: { ...state.stale, favorites: false } }));
      }
    },

    setMode: async (mode) => {
      if (mode === "browse") {
        await get().load(get().currentParentId);
        return;
      }
      if (mode === "recent") {
        await get().loadRecent();
        return;
      }
      await get().loadFavorites();
    },

    setKeyword: (keyword) => {
      set({ keyword });
    },

    loadTree: async () => {
      const token = beginRequest();
      if (!token) return [];
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.library.tree,
          null,
          token.transport,
        );
        if (!isCurrentRequest(token) || !result.ok) return [];
        return parseItems(result.data) ?? [];
      } catch {
        return [];
      }
    },

    subtreeCount: async (id) => {
      const token = beginRequest();
      if (!token) return null;
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.library.subtreeCount,
          { id },
          token.transport,
        );
        if (!isCurrentRequest(token) || !result.ok) return null;
        return typeof result.data === "number" ? result.data : null;
      } catch {
        return null;
      }
    },

    createFolder: (name) =>
      enqueueWrite(ENDPOINTS.library.createFolder, {
        name,
        parentId: get().currentParentId,
      }),

    createFile: (name) =>
      enqueueWrite(ENDPOINTS.library.createFile, {
        name,
        parentId: get().currentParentId,
      }),

    addLink: (url, title) =>
      enqueueWrite(ENDPOINTS.library.addLink, {
        url,
        title,
        parentId: get().currentParentId,
      }),

    rename: (id, name) => enqueueWrite(ENDPOINTS.library.rename, { id, name }),

    move: (ids, targetParentId) =>
      enqueueWrite(ENDPOINTS.library.move, { ids, targetParentId }),

    remove: (ids) => enqueueWrite(ENDPOINTS.library.delete, { ids }),

    toggleFavorite: (id) => {
      const previous = get().items.find((item) => item.id === id)?.favorite;
      if (previous !== undefined) flipFavoriteRow(id, !previous);
      return enqueueWrite(ENDPOINTS.library.toggleFavorite, { id }).then(
        (ok) => {
          if (!ok && previous !== undefined) flipFavoriteRow(id, previous);
          return ok;
        },
      );
    },

    markViewed: (id) => enqueueWrite(ENDPOINTS.library.markViewed, { id }),

    readText: async (id) => {
      const token = beginRequest();
      if (!token) throw new Error("no connection");
      const result = await wireRequest(
        "POST",
        ENDPOINTS.library.read,
        { id },
        token.transport,
      );
      if (!isCurrentRequest(token)) throw new Error("stale response");
      if (!result.ok) {
        throw codedError(
          result.message || result.code || "read failed",
          result.code,
        );
      }
      const parsed = parseReadResult(result.data);
      if (!parsed) throw new Error("Invalid library read response");
      return parsed.content;
    },

    readImage: async (id) => {
      const token = beginRequest();
      if (!token) throw new Error("no connection");
      const result = await wireRequest(
        "POST",
        ENDPOINTS.library.readImage,
        { id },
        token.transport,
      );
      if (!isCurrentRequest(token)) throw new Error("stale response");
      if (!result.ok) {
        throw codedError(
          result.message || result.code || "read failed",
          result.code,
        );
      }
      const parsed = parseReadImageResult(result.data);
      if (!parsed) throw new Error("Invalid library readImage response");
      return parsed;
    },

    writeContent: async (id, content) => {
      const token = beginRequest();
      if (!token) throw new Error("no connection");
      pendingWrites += 1;
      set({ saving: true, loading: false, error: null });
      const doWrite = async (): Promise<LibraryRow> => {
        try {
          const result = await wireRequest(
            "POST",
            ENDPOINTS.library.writeContent,
            { id, content },
            token.transport,
          );
          if (!isCurrentRequest(token)) throw new Error("stale response");
          if (!result.ok) {
            // 失败置错误码（业务码优先，供调用方按码出文案）
            set({ error: result.code || result.message });
            throw codedError(
              result.message || result.code || "write failed",
              result.code,
            );
          }
          const item = parseItem(result.data);
          if (!item) {
            set({ error: "Invalid library writeContent response" });
            throw new Error("Invalid library writeContent response");
          }
          // 成功刷新：size/updatedAt 就地更新当前列表行；非浏览态置脏
          // （下次进入重拉），浏览态行补丁已足够（尺寸/时间即时可见）
          set((state) => ({
            items: state.items.map((row) => (row.id === item.id ? item : row)),
          }));
          const { mode } = get();
          if (mode !== "browse") {
            set((state) => ({ stale: { ...state.stale, [mode]: true } }));
          }
          return item;
        } catch (error) {
          // 业务错分支已按码置 error——仅无码异常（网络/形状）在此补置，
          // 不得覆盖错误码
          if (isCurrentRequest(token) && !(error as { code?: unknown }).code) {
            set({ error: errorMessage(error) });
          }
          throw error;
        } finally {
          pendingWrites -= 1;
          if (pendingWrites === 0) set({ saving: false });
        }
      };
      const queued = writeChain.then(doWrite);
      // 失败不阻断后续写：链上吞错续排（installUpload 返回 null 天然不抛，
      // 本方法抛 codedError 语义，链本身须保持 resolved）
      writeChain = queued.catch(() => {});
      return queued;
    },

    /** 资料库上传批：二进制入库写面（串行/防迟到/saving 纪律同
     *  writeContent）。成功回传新行：浏览态就地插入当前目录列表行（不重拉），
     * 非浏览态置脏；失败抛 codedError（LIBRARY_UPLOAD_INVALID 等） */
    uploadFile: async (parentId, name, base64) => {
      const token = beginRequest();
      if (!token) throw new Error("no connection");
      pendingWrites += 1;
      set({ saving: true, loading: false, error: null });
      const doWrite = async (): Promise<LibraryRow> => {
        try {
          const result = await wireRequest(
            "POST",
            ENDPOINTS.library.uploadFile,
            // parentId 缺省=根目录（协议可选键，null 序列化为缺省）
            { parentId: parentId ?? undefined, name, base64 },
            token.transport,
          );
          if (!isCurrentRequest(token)) throw new Error("stale response");
          if (!result.ok) {
            set({ error: result.code || result.message });
            throw codedError(
              result.message || result.code || "upload failed",
              result.code,
            );
          }
          const item = parseItem(result.data);
          if (!item) {
            set({ error: "Invalid library uploadFile response" });
            throw new Error("Invalid library uploadFile response");
          }
          const { mode, currentParentId } = get();
          if (mode === "browse" && currentParentId === parentId) {
            // 浏览态行补丁：新行就地插入当前目录（不重拉）
            set((state) => ({ items: [item, ...state.items] }));
          } else if (mode !== "browse") {
            set((state) => ({ stale: { ...state.stale, [mode]: true } }));
          }
          return item;
        } catch (error) {
          if (isCurrentRequest(token) && !(error as { code?: unknown }).code) {
            set({ error: errorMessage(error) });
          }
          throw error;
        } finally {
          pendingWrites -= 1;
          if (pendingWrites === 0) set({ saving: false });
        }
      };
      const queued = writeChain.then(doWrite);
      // 失败不阻断后续写（同 writeContent 链纪律）
      writeChain = queued.catch(() => {});
      return queued;
    },

    resetForTest: () => {
      reqSeq += 1;
      writeChain = Promise.resolve();
      pendingWrites = 0;
      set({
        mode: "browse",
        items: [],
        breadcrumbs: [],
        keyword: "",
        currentParentId: null,
        loading: false,
        saving: false,
        error: null,
        initialized: false,
        stale: { ...INITIAL_STALE },
      });
    },
  };
});
