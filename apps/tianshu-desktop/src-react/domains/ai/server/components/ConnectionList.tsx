/**
 * 连接列表（HD-P3e 双形态）：panel=双栏侧挂（h-full+内部滚动，编排
 * 遥控场景）；page=居中平铺（自然高文档流，页面自滚——无外层卡/无
 * 内部滚动条）。连接行置顶（运行态状态点/选中高亮/编辑/删除常显；
 * relay 行附 E2E 承载徽标——E2E-T3），本机被控面设置卡随后。
 * 本地无头端启停卡已删（HD-P3e：单 UI 本地主机直达后单机分体场景
 * 退役——localStart 通道保留经 IPC/脚本可达）。
 * 运行态变化来自注册表（server:event 不含连接级事件），5s 轮询兜底刷新。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  HardDriveDownload,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Lock,
  ShieldAlert,
  ShieldOff,
} from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import ServerApi, {
  type ConnectionConfig,
  type ConnectionE2eState,
  type ConnectionRuntimeState,
  type ConnectionView,
} from "../api/server.api";
import { ConnectionDialog, CONNECTIONS_QUERY_KEY } from "./ConnectionDialog";

/** 状态点配色（主题变量；connected 主题色/连通，invalid-token 破坏色） */
const STATE_DOT: Record<ConnectionRuntimeState, string> = {
  connected: "bg-primary",
  connecting: "bg-primary/50 animate-pulse",
  reconnecting: "bg-primary/50 animate-pulse",
  "invalid-token": "bg-destructive",
  idle: "bg-muted-foreground/40",
  closed: "bg-muted-foreground/70",
};

/** E2E 徽标文案 key（E2E-T3/T4）：已加密 ✓ / 未加密 ⚠ / 指纹不匹配红 /
 * required 拒降级断开红。unsupported 仅作 Record 完形（渲染侧过滤，不留
 * 可达路径） */
const E2E_LABEL_KEY: Record<ConnectionE2eState, string> = {
  encrypted: "ai:server.e2e.encrypted",
  plaintext: "ai:server.e2e.plaintext",
  "mitm-suspect": "ai:server.e2e.mitmSuspect",
  "required-failed": "ai:server.e2e.requiredFailed",
  unsupported: "ai:server.e2e.plaintext",
};

const E2E_BADGE_CLASS: Record<ConnectionE2eState, string> = {
  encrypted: "text-primary",
  plaintext: "text-orange-500",
  "mitm-suspect": "text-destructive",
  "required-failed": "text-destructive",
  unsupported: "text-muted-foreground",
};

function E2eBadgeIcon({ state }: { state: ConnectionE2eState }) {
  const className = "h-3 w-3 shrink-0";
  if (state === "encrypted") return <Lock className={className} />;
  if (state === "mitm-suspect") return <ShieldAlert className={className} />;
  if (state === "required-failed") return <ShieldOff className={className} />;
  return <TriangleAlert className={className} />;
}

/** 连接行 E2E 承载徽标（仅 relay 模式且有三态值渲染——direct 信任模型内
 * 不适用，unsupported 不出徽标） */
function ConnectionE2eBadge({ connection }: { connection: ConnectionView }) {
  const { t } = useTranslation("ai");
  if (
    connection.mode !== "relay" ||
    !connection.e2e ||
    connection.e2e === "unsupported"
  ) {
    return null;
  }
  const label = t(E2E_LABEL_KEY[connection.e2e]);
  return (
    <span
      data-testid={`connection-e2e-${connection.id}`}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-[10px] select-none",
        E2E_BADGE_CLASS[connection.e2e],
      )}
    >
      <E2eBadgeIcon state={connection.e2e} />
      {label}
    </span>
  );
}

export interface ConnectionListProps {
  selectedConnId: string | null;
  onSelect: (id: string) => void;
  /** 布局外置（HD-P3d）：双栏侧挂（w-72+border-r）或平铺，由调用处给定 */
  className?: string;
  /** 形态（HD-P3e）：panel=固定高内部滚动（双栏侧挂）；page=自然高
   *  文档流（居中平铺——页面自滚，无内部滚动条） */
  variant?: "panel" | "page";
}

export default function ConnectionList({
  selectedConnId,
  onSelect,
  className,
  variant = "panel",
}: ConnectionListProps) {
  const { t } = useTranslation(["ai", "common", "chat"]);
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: () => ServerApi.listConnections(),
    refetchInterval: 5_000,
  });
  const connections = connectionsQuery.data?.connections ?? [];

  // 删除收尾：清单刷新后选中行已消失 → 仅当选中的正是被删行才回退首行
  // （或保持空）；删除非选中行不得拽走当前选中
  useEffect(() => {
    if (!deleting) return;
    if (!connections.some((c) => c.id === deleting)) {
      const wasSelected = deleting === selectedConnId;
      setDeleting(null);
      if (wasSelected && connections.length > 0) onSelect(connections[0].id);
    }
  }, [connections, deleting, onSelect, selectedConnId]);

  const handleDelete = async (connection: ConnectionView) => {
    setDeleting(connection.id);
    try {
      await ServerApi.deleteConnection(connection.id);
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
    } catch (e) {
      setDeleting(null);
      toast.error(String(e instanceof Error ? e.message : e));
    }
  };

  const flat = variant === "page";
  return (
    <div
      className={cn(flat ? "flex flex-col" : "flex h-full flex-col", className)}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-semibold text-foreground">
          {t("ai:server.connection.title")}
        </span>
        <div className="flex items-center gap-1">
          <IconTooltip label={t("ai:server.connection.refresh")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t("ai:server.connection.refresh")}
              onClick={() => void connectionsQuery.refetch()}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${connectionsQuery.isFetching ? "animate-spin" : ""}`}
              />
            </Button>
          </IconTooltip>
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            data-testid="add-connection"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("ai:server.connection.add")}
          </Button>
        </div>
      </div>

      {/* panel 态单滚动区：连接行置顶（进页面即见——2026-10-18 实测
          设置卡曾把列表挤出视口），设置卡随后滚动可达；page 态文档流
          自然铺开由页面自滚（HD-P3e） */}
      <div className={flat ? "pb-2" : "min-h-0 flex-1 overflow-y-auto pb-2"}>
        <div className="flex flex-col px-2">
          {connections.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
              <HardDriveDownload className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {t("ai:server.connection.empty")}
              </p>
              <p className="text-xs text-muted-foreground/80">
                {t("ai:server.connection.emptyTip")}
              </p>
            </div>
          ) : (
            connections.map((connection) => (
              <div
                key={connection.id}
                data-testid={`connection-${connection.id}`}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(connection.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    onSelect(connection.id);
                }}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
                  selectedConnId === connection.id
                    ? "bg-primary-subtle text-primary"
                    : "text-foreground hover:bg-primary-subtle hover:text-primary",
                )}
              >
                <span
                  data-testid={`connection-dot-${connection.id}`}
                  title={t(`ai:server.connection.state.${connection.state}`)}
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    STATE_DOT[connection.state],
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate">{connection.name}</span>
                    {connection.local && (
                      <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground select-none">
                        {t("ai:server.connection.localTag")}
                      </span>
                    )}
                    <ConnectionE2eBadge connection={connection} />
                  </div>
                  <span className="block truncate text-xs text-muted-foreground">
                    {connection.mode === "direct"
                      ? connection.baseUrl
                      : `${connection.relayUrl} → ${connection.connectionId}`}
                  </span>
                </div>
                {/* 编辑/删除常显（2026-10-18 实测 hover 才浮现可发现性差，
                  触控/新用户找不到入口），hover 仅做透明度强调 */}
                <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                  <IconTooltip label={t("ai:server.connection.edit")}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
                      aria-label={t("ai:server.connection.edit")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(connection);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </IconTooltip>
                  <IconTooltip label={t("ai:server.connection.delete")}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:bg-primary-subtle hover:text-destructive"
                      aria-label={t("ai:server.connection.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDelete(connection);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </IconTooltip>
                </div>
              </div>
            ))
          )}
        </div>
        {/* 本机被控面设置卡已迁设置面板「对外服务」页（与本机 webhook 入站
            同类归置）；此处不留占位——远程端连接遥控语义不变 */}
      </div>

      <ConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
        onSaved={(id) => onSelect(id)}
      />
    </div>
  );
}
