/**
 * 顶栏主机切换器（HD-T4，spec §2.1/§3；HD-P3c 常驻化）：单 UI 多主机——
 * 切换当前数据源主机（本机 / 已连接的远程主机）；菜单底部「主机配置」
 * 入口（原侧边栏「服务端」菜单项迁入，无连接时也常驻保证可达）。
 * 非 connected 连接禁用（数据面拉不动，防止切过去全灰误判故障）。
 * 切换副作用（缓存清空/搜索与流式缓冲复位/caps 回填）见
 * data-source/switch-host.ts。
 * HD-P2c 随壳承接：远程主机重连（server.connected）时会话/消息缓存
 * 失效重取（原 RemoteSessionPanel 侧订阅随壳退役）。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Monitor, Server, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ServerApi, { onRemoteEvent } from "../../server/api/server.api";
import { CONNECTIONS_QUERY_KEY } from "../../server/components/ConnectionDialog";
import { useHostStore, type ActiveHost } from "../../data-source/host.store";
import { switchToHost } from "../../data-source/switch-host";

/** 连接状态点色（语义状态色非主题色）：绿=已连/黄=连着中/灰=其余 */
function stateDotClass(state: string): string {
  if (state === "connected") return "bg-emerald-500";
  if (state === "connecting" || state === "reconnecting") return "bg-amber-500";
  return "bg-muted-foreground/40";
}

export default function HostSwitcher() {
  const { t } = useTranslation(["layout"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeHost = useHostStore((s) => s.activeHost);

  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: () => ServerApi.listConnections(),
    refetchInterval: 5_000,
  });
  const connections = connectionsQuery.data?.connections ?? [];

  const doSwitch = (next: ActiveHost) => {
    void switchToHost(next, { clearCache: () => queryClient.clear() });
  };

  // 重连全量刷新（spec §13 项 2，HD-P2c 随壳承接）：远程主机重连时
  // 失效会话/消息缓存重取（断流漏事件不卡流式态）；本地主机不订阅
  useEffect(() => {
    if (activeHost.kind !== "remote") return;
    return onRemoteEvent(activeHost.connId, (event) => {
      if (event.type === "server.connected") {
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({ queryKey: ["messages"] });
      }
    });
  }, [activeHost, queryClient]);

  const activeName =
    activeHost.kind === "local"
      ? t("layout:hostSwitcher.local")
      : (connections.find((c) => c.id === activeHost.connId)?.name ??
        activeHost.connId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid="host-switcher"
          className="h-7 gap-1 px-2 text-xs hover:bg-primary-subtle hover:text-primary"
          aria-label={t("layout:hostSwitcher.tooltip")}
        >
          {activeHost.kind === "local" ? (
            <Monitor className="h-4 w-4" />
          ) : (
            <Server className="h-4 w-4" />
          )}
          <span className="max-w-28 truncate">{activeName}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="border border-border/50 rounded-lg shadow-lg"
      >
        <DropdownMenuItem onClick={() => doSwitch({ kind: "local" })}>
          <Monitor className="mr-2 h-4 w-4" />
          <span className="flex-1">{t("layout:hostSwitcher.local")}</span>
          {activeHost.kind === "local" && (
            <Check className="h-4 w-4 text-primary" />
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {connections.map((conn) => {
          const active =
            activeHost.kind === "remote" && activeHost.connId === conn.id;
          return (
            <DropdownMenuItem
              key={conn.id}
              disabled={conn.state !== "connected"}
              onClick={() => doSwitch({ kind: "remote", connId: conn.id })}
            >
              <span
                className={cn(
                  "mr-2 h-2 w-2 shrink-0 rounded-full",
                  stateDotClass(conn.state),
                )}
              />
              <span className="flex-1 truncate">{conn.name}</span>
              {active && <Check className="h-4 w-4 text-primary" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        {/* 主机配置入口（HD-P3c：原侧边栏「服务端」菜单项迁入——主机
            管理归属切换器语境，常驻保证无连接时可达） */}
        <DropdownMenuItem onClick={() => navigate("/module/ai/server")}>
          <Settings2 className="mr-2 h-4 w-4" />
          <span className="flex-1">{t("layout:hostSwitcher.manage")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
