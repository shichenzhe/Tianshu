/**
 * queryKey 主机隔离（批3B，design §5 项1）：activeHost 归一进 react-query
 * 的 queryKeyHashFn——同 key 在不同主机下落不同 queryHash（缓存项自然
 * 隔离、互不污染），切换不清缓存（旧主机数据原地保留=回切秒开）。
 *
 * 为什么收口在 hash 而非逐处给 queryKey 加主机前缀：全仓 queryKey 内联
 * 构造 283 处（115 文件），逐处机械替换漏一处即跨主机数据污染；hash 收口
 * 在 client 默认层一处（main.tsx 装配），useQuery/useQueries/setQueryData/
 * invalidate 全走 defaultQueryOptions → 同口径单点生效零遗漏。
 *
 * 失效语义：invalidateQueries 按 queryKey 前缀匹配是主机无关的（跨主机
 * 同名 key 一并标脏——非活动主机仅标脏不重取，无数据面影响）；exact
 * 匹配经 query.options.queryKeyHashFn 同口径归一不受影响。
 *
 * 切换时序（switch-host 的 kickQueries 先行，见其头注释）：kick 在切
 * store 前对活动查询 resetQueries——data 置空变更 tracked props 必达
 * re-render（invalidate 的 fetchStatus 不被 track、通知被吞），旧条目
 * 的 refetch 同步起步锁定旧主机（刷新正确归位旧条目，回切受益）；通知
 * 经 notifyManager 延后一拍，观察者 re-render 时 activeHost 已切——
 * 按新主机 hash 跳到新缓存项并自取数（shouldFetchOptionally：query
 * 实例变更即取）。非活动条目缓存不受 kick 影响。
 */
import { activeHost, type ActiveHost } from "./host.store";

/** 主机维度的缓存命名空间令牌：本机 "local"；远程 "conn:<connId>" */
export function hostQueryToken(host: ActiveHost = activeHost()): string {
  return host.kind === "local" ? "local" : `conn:${host.connId}`;
}

/** react-query hashKey 同构的稳定序列化（对象键排序——键序不敏感） */
function stableKeyString(value: unknown): string {
  return JSON.stringify(value, (_, val) => {
    if (Array.isArray(val)) return val;
    if (val !== null && typeof val === "object") {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (val as Record<string, unknown>)[key];
          return acc;
        }, {});
    }
    return val;
  });
}

/** queryKeyHashFn：主机令牌前缀 + 稳定序列化（同 key 跨主机不同 hash） */
export function hostScopedQueryHash(queryKey: unknown): string {
  return `${hostQueryToken()}|${stableKeyString(queryKey)}`;
}
