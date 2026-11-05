/**
 * 主机切换入口（HD-T4，spec §2.1）：switchHost 副作用承载——
 * - react-query 切前 kick（批3B，design §5 项1）：不再 clear() 全清——
 *   queryKeyHashFn 已按 activeHost 隔离缓存（data-source/host-query）。
 *   kickQueries 在切 store **之前**执行 resetQueries({type:"active"})：
 *   ① 活动观察者的 data 置 undefined——tracked props 语义下 data 变更
 *   必达 re-render（invalidate 不行：fetchStatus 不在 tracked props，
 *   通知被吞观察者不跳主机）；② 活动条目的 refetch 同步起步锁定旧主机
 *   ——刷新结果正确归位旧条目（回切数据新鲜）；③ 通知经 notifyManager
 *   延后一拍，观察者 re-render 时 activeHost 已切——按新主机 hash 跳新
 *   缓存项并自取数（query 实例变更即取）；④ 非活动条目（其他主机/已
 *   卸载查询）缓存原样保留。若 kick 晚于 store 切换，旧条目刷新会以
 *   新主机取数写入旧条目——跨主机数据污染，时序勿动。
 * - 会话搜索与流式缓冲复位（跨主机残留态无意义）
 * - 远程 caps 自连接注册表运行时上报回填（switchHost 先置空面）
 * - 同主机幂等直 return（零副作用零请求——此前仍拉 listConnections
 *   回填 caps，批3B 消灭该重复请求）
 * kick 经 deps 注入（组件传 queryClient.resetQueries——本模块不依赖
 * react-query，保持 data-source 层纯 store/协议）。
 */
import {
  useHostStore,
  capsOfCapabilities,
  isSameHost,
  type ActiveHost,
} from "./host.store";
import { useSessionSearchStore } from "../store/session-search.store";
import { useChatStore } from "../chat/store/chat.store";
import ServerApi from "../server/api/server.api";

export async function switchToHost(
  next: ActiveHost,
  deps: { kickQueries: () => void },
): Promise<void> {
  if (isSameHost(useHostStore.getState().activeHost, next)) return;
  // 先 kick 后切 store（时序语义见头注释）
  deps.kickQueries();
  useHostStore.getState().switchHost(next, {
    onSwitched: () => {
      useSessionSearchStore.getState().reset();
      useChatStore.getState().resetAll();
    },
  });
  if (next.kind === "remote") {
    // caps 回填：注册表运行时上报（连接查无——已删/注册表过期，保持空面）
    const { connections } = await ServerApi.listConnections();
    const conn = connections.find((c) => c.id === next.connId);
    useHostStore.setState({
      caps: capsOfCapabilities(conn?.capabilities ?? []),
    });
  }
}
