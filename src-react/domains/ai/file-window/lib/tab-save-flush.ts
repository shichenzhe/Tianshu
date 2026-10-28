/**
 * tab 保存流注册表：draft 受控在 FileTabContent/LibraryTabBody（组件局部
 * state），关闭确认「保存并关闭」（CloseConfirmBar，视图层）无从取草稿
 * 值——由内容区挂载时注册 flush（走保存流写盘），卸载（关 tab/关窗）即
 * 除名。全 tab 常驻挂载（视图 display 隐藏非卸载），切 tab 草稿不丢、
 * 注册表覆盖全部存活 tab；flushTabSave 对已除名 tab 为 no-op 不误写。
 */
const flushers = new Map<string, () => Promise<void>>();

export function registerTabFlush(
  tabId: string,
  flush: () => Promise<void>,
): void {
  flushers.set(tabId, flush);
}

export function unregisterTabFlush(tabId: string): void {
  flushers.delete(tabId);
}

export async function flushTabSave(tabId: string): Promise<void> {
  await flushers.get(tabId)?.();
}
