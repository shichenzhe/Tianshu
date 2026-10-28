import { create } from "zustand";

import { useSessionsStore } from "@/store/sessions.store";

interface SearchUiState {
  searchOpen: boolean;
  toggleSearch: () => void;
  closeSearch: () => void;
}

/** 筛选随搜索面板开合（用户走查裁定：筛选收进搜索功能）——收起即
 *  复位为「未归档」+「全部时间」（A11：时间筛选同行收进面板，同 rationale——
 *  避免筛选藏起后列表状态不可见）。 */
function resetFilters(): void {
  useSessionsStore.setState({ showArchived: false, timeFilter: "all" });
}

/** 会话搜索 UI 态：仅当前运行期有效，不做持久化。 */
export const useSearchUiStore = create<SearchUiState>((set, get) => ({
  searchOpen: false,
  toggleSearch: () => {
    if (get().searchOpen) resetFilters();
    set((state) => ({ searchOpen: !state.searchOpen }));
  },
  closeSearch: () => {
    resetFilters();
    set({ searchOpen: false });
  },
}));
