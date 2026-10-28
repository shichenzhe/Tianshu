// src-react/domains/ai/server/views/ServerConsoleView.tsx
/**
 * 「主机」页（T17/T18；HD-P2c/P3b/P3d 收敛）：连接管理为主体——
 * 无编排能力时列表居中独占（HD-P3d 去冗余：详情卡/上下文条与列表行
 * 三重重复信息全删）；选中无头端（capabilities 含 graph）才展开右栏
 * 编排遥控（GraphPanel + AutomationPanel——单 UI 无等价物）。会话/
 * 聊天与模型配置遥控已由单 UI（HostSwitcher + api 主机路由 +
 * providerSave 写面）取代。capability 判定用连接运行时上报值，勿
 * import CAPABILITIES 常量做客户端判定。
 * 页面标题经 usePageHeader 迁入 TopBar 中段。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import ServerApi, { onRemoteEvent } from "../api/server.api";
import ConnectionList from "../components/ConnectionList";
import { CONNECTIONS_QUERY_KEY } from "../components/ConnectionDialog";
import GraphPanel from "../components/GraphPanel";
import AutomationPanel from "../components/AutomationPanel";
import BridgeApprovalCard from "../components/BridgeApprovalCard";
import { usePageHeader } from "@/components/layout/page-header.store";

export default function ServerConsoleView() {
  const { t } = useTranslation(["ai"]);
  const queryClient = useQueryClient();
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);

  // 初始选中粘性活动连接（后端 option 持久化的 activeConnId）
  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: () => ServerApi.listConnections(),
    refetchInterval: 5_000,
  });

  useEffect(() => {
    if (selectedConnId !== null) return;
    const active = connectionsQuery.data?.activeConnId;
    if (active) setSelectedConnId(active);
  }, [connectionsQuery.data, selectedConnId]);

  // 编排能力门控（Ruling 11）：无头端（capabilities 含 graph）才展开
  // 右栏遥控；桌面被控端/普通直连无此面——列表居中独占
  const selectedConnection = connectionsQuery.data?.connections.find(
    (c) => c.id === selectedConnId,
  );
  const graphCapable = (selectedConnection?.capabilities ?? []).includes(
    "graph",
  );

  // 重连全量刷新（spec §13 项 2）：server.connected 下发渲染层——连接态
  // 即时刷新（免等 5s 轮询；会话/消息缓存失效重取在 HostSwitcher 侧承接）
  useEffect(() => {
    if (selectedConnId === null) return;
    return onRemoteEvent(selectedConnId, (event) => {
      if (event.type === "server.connected") {
        void queryClient.invalidateQueries({
          queryKey: ["server", "connections"],
        });
      }
    });
  }, [selectedConnId, queryClient]);

  // 页面顶行（TopBar 中段）：标题迁入（同 ProviderSettingsView 口径）
  usePageHeader({
    title: (
      <h2 className="truncate text-sm font-medium text-foreground">
        {t("ai:server.pageTitle")}
      </h2>
    ),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 桥审批卡（TB-T2，spec §4.2）：无头端 write 桥调用在本机执行前的
          人工门——广播事件无连接定向，置顶常挂（无待办时零渲染） */}
      <BridgeApprovalCard />
      <div className="flex min-h-0 flex-1">
        {graphCapable && selectedConnId ? (
          <>
            <ConnectionList
              className="w-72 shrink-0 border-r border-border/50"
              selectedConnId={selectedConnId}
              onSelect={setSelectedConnId}
            />
            {/* 编排遥控区（GA-T8 Ruling 11）：graph 面板 + automation 面板 */}
            <div
              data-testid="orchestration-area"
              className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3"
            >
              <GraphPanel connId={selectedConnId} />
              <AutomationPanel connId={selectedConnId} />
            </div>
          </>
        ) : (
          // 无编排面（HD-P3e）：列表平铺（max-w 居中限宽）——无外层卡、
          // 无内部滚动条，页面文档流自滚；主机管理即页面主体
          <div className="mx-auto w-full max-w-lg py-4">
            <ConnectionList
              variant="page"
              selectedConnId={selectedConnId}
              onSelect={setSelectedConnId}
            />
          </div>
        )}
      </div>
    </div>
  );
}
