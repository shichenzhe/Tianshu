/**
 * 顶栏主机切换器（HD-T4，spec §2.1/§3；HD-P3c 常驻化）：单 UI 多主机——
 * 切换当前数据源主机（本机 / 远程主机）。菜单底部「主机配置」入口
 * （原侧边栏「服务端」菜单项迁入，无连接时也常驻保证可达）。
 * 切换即连（2026-11-10）：非 connected 连接不再禁用——点击即 activate
 * 建链（server:connectionActivate，持久化 activeConnId + fire-and-forget），
 * 渲染层轮询等 connected 再切换（原「先连上才能切」要求移除；失败/
 * 超时 toast 提示去主机配置检查）。切换副作用（缓存清空/搜索与流式
 * 缓冲复位/caps 回填）见 data-source/switch-host.ts。
 * HD-P2c 随壳承接：远程主机重连（server.connected）时会话/消息缓存
 * 失效重取（原 RemoteSessionPanel 侧订阅随壳退役）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Loader2,
  Monitor,
  Server,
  Settings2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

/** 切换即连等待参数：轮询间隔与放弃上限 */
const ACTIVATE_POLL_MS = 800;
const ACTIVATE_TIMEOUT_MS = 20_000;

interface HostSwitcherProps {
  /** 紧凑形态（侧栏 Logo 行位）：主机名收紧截断（max-w-16）——行宽 w-64
   *  有限，把截断压力留在主机名侧（品牌名 shrink-0 恒完整）；顶栏位
   *  维持默认 max-w-28。两种形态下名称被截断时均可冒泡看全称 */
  compact?: boolean;
}

export default function HostSwitcher({ compact = false }: HostSwitcherProps) {
  const { t } = useTranslation(["layout"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeHost = useHostStore((s) => s.activeHost);
  /** 切换即连：等待建链的连接 id（轮询 effect 消费；null=无等待） */
  const [pendingConnId, setPendingConnId] = useState<string | null>(null);
  const pendingSinceRef = useRef(0);

  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: () => ServerApi.listConnections(),
    refetchInterval: pendingConnId ? ACTIVATE_POLL_MS : 5_000,
  });
  const connections = connectionsQuery.data?.connections ?? [];

  const doSwitch = useCallback(
    (next: ActiveHost) => {
      // 批3B：不再 clear() 全清——切前 kick 活动查询（data 置空必达
      // re-render 让观察者跳新主机缓存项；旧条目刷新锁定旧主机、其余缓存
      // 原样保留=回切秒开——时序语义详见 switch-host 头注释）
      void switchToHost(next, {
        kickQueries: () => void queryClient.resetQueries({ type: "active" }),
      });
    },
    [queryClient],
  );

  /** 切换即连主入口：connected 直切；其余先 activate 建链，轮询等
   *  connected 再切（失败/超时 toast——原「禁用不可点」语义移除） */
  const pickConnection = (conn: { id: string; state: string }) => {
    if (conn.state === "connected") {
      doSwitch({ kind: "remote", connId: conn.id });
      return;
    }
    setPendingConnId(conn.id);
    pendingSinceRef.current = Date.now();
    toast.info(t("layout:hostSwitcher.connecting"));
    ServerApi.activateConnection(conn.id).catch((e) => {
      // activate 同步拒绝（连接不存在等）——终止等待
      setPendingConnId(null);
      toast.error(t("layout:hostSwitcher.connectFailed"));
      console.error("activateConnection failed", e);
    });
  };

  // 等待建链：轮询数据里盯该连接 state（refetchInterval 已加速）——
  // connected 即切；invalid-token 立即失败；超时放弃
  useEffect(() => {
    if (!pendingConnId) return;
    const conn = connections.find((c) => c.id === pendingConnId);
    if (!conn) return; // 数据未到（首次拉取中）——等下轮
    if (conn.state === "connected") {
      const id = pendingConnId;
      setPendingConnId(null);
      doSwitch({ kind: "remote", connId: id });
      return;
    }
    if (
      conn.state === "invalid-token" ||
      Date.now() - pendingSinceRef.current > ACTIVATE_TIMEOUT_MS
    ) {
      setPendingConnId(null);
      toast.error(
        conn.state === "invalid-token"
          ? t("layout:hostSwitcher.connectFailed")
          : t("layout:hostSwitcher.connectTimeout"),
      );
      return;
    }
    // connecting/reconnecting/idle——继续等（transport 重连兜底）
  }, [connections, pendingConnId, t, doSwitch]);

  // 组件卸载清等待（防切页后迟到的 doSwitch）
  useEffect(() => () => setPendingConnId(null), []);

  // 重连全量刷新（spec §13 项 2，HD-P2c 随壳承接）：远程主机重连时
  // 失效会话/消息缓存重取（断流漏事件不卡流式态）；本地主机不订阅。
  // 批③（2026-11-01）：workspace/project 变更列表级刷新信号——远端被他端
  // （移动端/另一控制端）写入时侧栏分组树即时失效
  useEffect(() => {
    if (activeHost.kind !== "remote") return;
    return onRemoteEvent(activeHost.connId, (event) => {
      if (event.type === "server.connected") {
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({ queryKey: ["messages"] });
      } else if (event.type === "workspace.changed") {
        void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      } else if (event.type === "project.changed") {
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
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
      {/* 冒泡全称（Logo 行挪位批）：主机名被截断时悬停/聚焦可看全名——
          Tooltip 包在 DropdownMenuTrigger 外层（IconTooltip asChild 铁律）；
          自带 Provider（侧栏 Logo 行无外层 Provider 语境） */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
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
                <span
                  className={cn("truncate", compact ? "max-w-16" : "max-w-28")}
                >
                  {activeName}
                </span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{activeName}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
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
          const pending = pendingConnId === conn.id;
          return (
            <DropdownMenuItem
              key={conn.id}
              disabled={pending}
              onClick={() => pickConnection(conn)}
            >
              {pending ? (
                <Loader2 className="mr-2 h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <span
                  className={cn(
                    "mr-2 h-2 w-2 shrink-0 rounded-full",
                    stateDotClass(conn.state),
                  )}
                />
              )}
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
