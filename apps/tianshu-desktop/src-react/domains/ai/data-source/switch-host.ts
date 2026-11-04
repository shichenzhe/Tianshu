/**
 * 主机切换入口（HD-T4，spec §2.1）：switchHost 副作用承载——
 * - react-query 缓存清空（数据按主机隔离的最小实现：切换即全清，
 *   queryKey 不带主机维度——spec §2.4 隔离策略 P1 简化口径）
 * - 会话搜索与流式缓冲复位（跨主机残留态无意义）
 * - 远程 caps 自连接注册表运行时上报回填（switchHost 先置空面）
 * 缓存清空经 deps 注入（组件传 queryClient.clear——本模块不依赖
 * react-query，保持 data-source 层纯 store/协议）。
 */
import {
  useHostStore,
  capsOfCapabilities,
  type ActiveHost,
} from "./host.store";
import { useSessionSearchStore } from "../store/session-search.store";
import { useChatStore } from "../chat/store/chat.store";
import ServerApi from "../server/api/server.api";

export async function switchToHost(
  next: ActiveHost,
  deps: { clearCache: () => void },
): Promise<void> {
  useHostStore.getState().switchHost(next, {
    onSwitched: () => {
      deps.clearCache();
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
