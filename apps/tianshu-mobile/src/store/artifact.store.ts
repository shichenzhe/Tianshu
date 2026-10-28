// 本地产物 store（AR 批）：跨会话 write_file 记录聚合列表 + 收藏切换 +
// 文本/图片预览。桌面被控面专属三端点（artifact 表只在桌面端）——无头端
// 连接下 artifact/list 回 HTTP 404（无业务体），经 wire status 透出判
// isEndpointMissing → unsupported 置位（视图层隐藏本地产物入口；网络
// 错误等可重试态与端点缺失严格区分）。防迟到按资源拆分（load/preview
// 各自 seq——全资源互判过期教训）；toggleFavorite 乐观翻转失败回滚
// （library.store 先例）。
import { create } from "zustand";
import {
  ENDPOINTS,
  type ArtifactReadResult,
  type ArtifactWireItem,
} from "@tianshu/protocol";
import { isEndpointMissing, wireRequest } from "../transport/wire";
import { activeTransport, useConnectionsStore } from "./connections.store";

/** 预览态（read 联合直存 + 行展示名） */
export interface ArtifactPreview {
  name: string;
  content: ArtifactReadResult;
}

interface ArtifactState {
  rows: ArtifactWireItem[];
  loading: boolean;
  error: string | null;
  /** 首次成功加载后置位（空态判定） */
  initialized: boolean;
  /** 端点不存在（无头端被控端）——视图层隐藏本地产物入口 */
  unsupported: boolean;
  preview: ArtifactPreview | null;
  previewLoading: boolean;
  previewError: string | null;
  load(force?: boolean): Promise<void>;
  toggleFavorite(item: ArtifactWireItem): Promise<void>;
  openPreview(item: ArtifactWireItem): Promise<void>;
  closePreview(): void;
  reset(): void;
}

/** 防迟到序号（load / preview 两资源各自独立——并行互不过期） */
let loadSeq = 0;
let previewSeq = 0;

export const useArtifactStore = create<ArtifactState>((set, get) => ({
  rows: [],
  loading: false,
  error: null,
  initialized: false,
  unsupported: false,
  preview: null,
  previewLoading: false,
  previewError: null,

  async load(force = false) {
    if (!activeTransport()) return;
    if (get().loading && !force) return;
    const seq = ++loadSeq;
    set({ loading: true, error: null });
    const result = await wireRequest("POST", ENDPOINTS.artifact.list);
    if (seq !== loadSeq) return;
    if (isEndpointMissing(result)) {
      set({ loading: false, unsupported: true });
      return;
    }
    if (!result.ok) {
      set({ loading: false, error: result.message || "loadFailed" });
      return;
    }
    const rows = Array.isArray(result.data)
      ? (result.data as ArtifactWireItem[])
      : [];
    set({ rows, loading: false, initialized: true });
  },

  async toggleFavorite(item) {
    // 乐观翻转（行内星标即响应），失败回滚
    const before = get().rows;
    set({
      rows: before.map((row) =>
        row.workspaceId === item.workspaceId && row.relPath === item.relPath
          ? { ...row, favorite: !row.favorite }
          : row,
      ),
    });
    const result = await wireRequest(
      "POST",
      ENDPOINTS.artifact.toggleFavorite,
      {
        workspaceId: item.workspaceId,
        relPath: item.relPath,
      },
    );
    if (!result.ok) {
      set({ rows: before });
    }
  },

  async openPreview(item) {
    const seq = ++previewSeq;
    set({ previewLoading: true, previewError: null, preview: null });
    const result = await wireRequest("POST", ENDPOINTS.artifact.read, {
      workspaceId: item.workspaceId,
      relPath: item.relPath,
    });
    if (seq !== previewSeq) return;
    if (!result.ok) {
      // PREVIEW_UNSUPPORTED：被控端已给中文文案（html/pdf/音视频类）
      set({
        previewLoading: false,
        previewError: result.message || result.code || "previewFailed",
      });
      return;
    }
    set({
      preview: { name: item.name, content: result.data as ArtifactReadResult },
      previewLoading: false,
    });
  },

  closePreview() {
    previewSeq++;
    set({ preview: null, previewError: null, previewLoading: false });
  },

  reset() {
    loadSeq++;
    previewSeq++;
    set({
      rows: [],
      loading: false,
      error: null,
      initialized: false,
      unsupported: false,
      preview: null,
      previewLoading: false,
      previewError: null,
    });
  },
}));

/** 连接切换复位（消费层 useEffect 挂接——store 不自订阅避免环） */
export function resetArtifactOnConnectionChange(activeConnId: string | null) {
  if (!activeConnId) useArtifactStore.getState().reset();
}

// 连接清空即复位（断开/登出场景）；换连接由视图层 load(force) 自然覆盖
useConnectionsStore.subscribe((state, prev) => {
  if (!state.activeConnId && prev.activeConnId) {
    useArtifactStore.getState().reset();
  }
});
