/**
 * 远程请求错误描述（GA-T8 抽取）：Error 取 message、其余 String 化——
 * toast 文案插值用（RemoteSessionPanel/GraphPanel/AutomationPanel 共用）
 */
export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
