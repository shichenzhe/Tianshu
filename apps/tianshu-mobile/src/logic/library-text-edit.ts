// 资料库文本编辑视图数据面（资料库编辑批）：加载/草稿/保存状态机纯
// 函数——编辑弹层组件仅做渲染与事件转发，可测逻辑全收此。口径：保存
// 成功即关闭（原稿随成功回传刷新，无需本地 reconcile）；取消时仅有改动
// 才需确认；保存中锁输入防重入。

export type LibraryTextEditState =
  | { status: "loading" }
  | { status: "ready"; original: string; draft: string; saving: boolean }
  | { status: "failed" };

/** 弹层打开初始态（内容经 library/read 拉取中） */
export function initialEditState(): LibraryTextEditState {
  return { status: "loading" };
}

/** readText 成功 → 就绪态（原稿=草稿起点） */
export function editLoaded(content: string): LibraryTextEditState {
  return { status: "ready", original: content, draft: content, saving: false };
}

/** readText 失败 → 失败态（弹层出失败文案，不进入编辑） */
export function editLoadFailed(): LibraryTextEditState {
  return { status: "failed" };
}

/** 草稿变更（仅就绪态生效；保存中忽略——防迟到输入覆盖提交内容） */
export function editDraftChanged(
  state: LibraryTextEditState,
  draft: string,
): LibraryTextEditState {
  if (state.status !== "ready" || state.saving) return state;
  return { ...state, draft };
}

/** 保存开始：置 saving 锁（输入框 disabled + 按钮转圈） */
export function editSaveStarted(
  state: LibraryTextEditState,
): LibraryTextEditState {
  if (state.status !== "ready") return state;
  return { ...state, saving: true };
}

/** 保存落定（成功关闭走调用方；失败解锁留在编辑态可改可重试） */
export function editSaveSettled(
  state: LibraryTextEditState,
): LibraryTextEditState {
  if (state.status !== "ready") return state;
  return { ...state, saving: false };
}

/** 是否有未保存改动（取消确认判定：无改动直退） */
export function hasUnsavedChanges(state: LibraryTextEditState): boolean {
  return state.status === "ready" && state.draft !== state.original;
}
