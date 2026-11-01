/** 底部面板在系统安全区之外保留 8pt；无安全区时至少留 16pt。 */
export function sheetBottomPadding(bottomInset: number): number {
  return Math.max(16, bottomInset + 8);
}
