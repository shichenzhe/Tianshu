/**
 * MCP 服务管理：服务器表格（传输/状态/工具数/启停/重连/编辑/删除）+ 编辑对话框
 * 状态列由 list 与 statuses 按 id join；statuses 缺失的行（从未连接）显示 — 或已停用
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Edit, Plus, RefreshCw, Trash2 } from "lucide-react";

import PageTitle from "@/components/layout/PageTitle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import McpServerApi, {
  type McpServerRecord,
  type McpServerState,
  type McpServerStatus,
} from "../../api/mcp.api";
import McpServerDialog from "../components/McpServerDialog";
import { mapIpcError } from "../../chat/lib/error-message";

const SERVERS_KEY = ["mcpServers"] as const;
const STATUSES_KEY = ["mcp-statuses"] as const;
/** 状态轮询间隔：仅存在 connecting 行时启用（新建为后台连接，靠轮询收敛到终态） */
const STATUS_POLL_MS = 3000;

/** 状态徽标配色：connected 主题色、error 危险色、connecting/disabled 弱化 */
const STATE_CLASS: Record<McpServerState, string> = {
  connected: "text-primary",
  error: "text-destructive",
  connecting: "text-muted-foreground",
  disabled: "text-muted-foreground",
};

export default function McpSettingsView() {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const serversQuery = useQuery({
    queryKey: SERVERS_KEY,
    queryFn: () => McpServerApi.list(),
  });
  const statusesQuery = useQuery({
    queryKey: STATUSES_KEY,
    queryFn: () => McpServerApi.statuses(),
    refetchInterval: (query) =>
      query.state.data?.some((status) => status.state === "connecting")
        ? STATUS_POLL_MS
        : false,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerRecord>();
  const [deletingServer, setDeletingServer] = useState<McpServerRecord | null>(
    null,
  );

  const servers = serversQuery.data ?? [];
  const statusById = new Map(
    (statusesQuery.data ?? []).map((status) => [status.id, status]),
  );

  const openCreate = () => {
    setEditingServer(undefined);
    setDialogOpen(true);
  };

  const openEdit = (server: McpServerRecord) => {
    setEditingServer(server);
    setDialogOpen(true);
  };

  const invalidateServerData = async () => {
    await queryClient.invalidateQueries({ queryKey: SERVERS_KEY });
    await queryClient.invalidateQueries({ queryKey: STATUSES_KEY });
  };

  const handleError = (e: unknown) => {
    toast.error(mapIpcError(e));
  };

  const toggleEnabled = async (server: McpServerRecord, enabled: boolean) => {
    try {
      await McpServerApi.setEnabled(server.id, enabled);
      await invalidateServerData();
    } catch (e) {
      handleError(e);
    }
  };

  const handleReconnect = async (server: McpServerRecord) => {
    try {
      await McpServerApi.reconnect(server.id);
      await invalidateServerData();
    } catch (e) {
      handleError(e);
    }
  };

  const handleDelete = async () => {
    if (!deletingServer) {
      return;
    }
    try {
      await McpServerApi.delete(deletingServer.id);
      await invalidateServerData();
    } catch (e) {
      handleError(e);
    } finally {
      setDeletingServer(null);
    }
  };

  return (
    <div className="p-6">
      <PageTitle title={t("ai:mcp.pageTitle")} />
      <p className="mb-4 text-sm text-muted-foreground">
        {t("ai:mcp.pageDesc")}
      </p>

      {serversQuery.isPending ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t("common:loading")}
        </p>
      ) : serversQuery.isError ? (
        <p className="py-16 text-center text-sm text-destructive">
          {serversQuery.error instanceof Error
            ? serversQuery.error.message
            : t("ai:errors.UNKNOWN")}
        </p>
      ) : servers.length === 0 ? (
        <Card className="border-border/50 rounded-lg shadow-sm">
          <CardHeader>
            <CardTitle>{t("ai:mcp.empty")}</CardTitle>
            <CardDescription>{t("ai:mcp.emptyTip")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              {t("ai:mcp.add")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="mb-4">
            <Button onClick={openCreate} size="sm">
              <Plus className="mr-1 h-4 w-4" />
              {t("ai:mcp.add")}
            </Button>
          </div>
          <div className="bg-card rounded-lg border border-border/50 shadow-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("ai:mcp.name")}</TableHead>
                  <TableHead className="w-32">
                    {t("ai:mcp.transport")}
                  </TableHead>
                  <TableHead className="w-28">
                    {t("ai:mcp.statusLabel")}
                  </TableHead>
                  <TableHead className="w-20 text-center">
                    {t("ai:mcp.tools")}
                  </TableHead>
                  <TableHead className="w-20 text-center">
                    {t("ai:mcp.enabled")}
                  </TableHead>
                  <TableHead className="w-56">
                    {t("common:operation")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servers.map((server) => (
                  <McpServerRow
                    key={server.id}
                    server={server}
                    status={statusById.get(server.id)}
                    onToggleEnabled={(enabled) =>
                      toggleEnabled(server, enabled)
                    }
                    onReconnect={() => handleReconnect(server)}
                    onEdit={() => openEdit(server)}
                    onDelete={() => setDeletingServer(server)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <McpServerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editingServer}
      />

      <AlertDialog
        open={deletingServer !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingServer(null);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("ai:mcp.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deletingServer
                ? `${deletingServer.name} · ${t("ai:mcp.deleteConfirmDesc")}`
                : t("ai:mcp.deleteConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface McpServerRowProps {
  server: McpServerRecord;
  status?: McpServerStatus;
  onToggleEnabled: (enabled: boolean) => void;
  onReconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function McpServerRow({
  server,
  status,
  onToggleEnabled,
  onReconnect,
  onEdit,
  onDelete,
}: McpServerRowProps) {
  const { t } = useTranslation(["ai", "common"]);

  return (
    <TableRow>
      <TableCell className="font-medium">{server.name}</TableCell>
      <TableCell>
        <Badge variant="secondary">{t(`ai:mcp.${server.transport}`)}</Badge>
      </TableCell>
      <TableCell>
        {status ? (
          <span
            className={`text-sm ${STATE_CLASS[status.state]}`}
            title={status.error}
          >
            {t(`ai:mcp.status.${status.state}`)}
          </span>
        ) : server.enabled ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("ai:mcp.status.disabled")}
          </span>
        )}
      </TableCell>
      <TableCell className="text-center text-muted-foreground">
        {status ? status.toolCount : "—"}
      </TableCell>
      <TableCell className="text-center">
        <Switch
          checked={server.enabled}
          onCheckedChange={onToggleEnabled}
          aria-label={t("ai:mcp.enabled")}
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          {server.enabled && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 hover:bg-primary-subtle hover:text-primary"
              onClick={onReconnect}
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              {t("ai:mcp.reconnect")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-primary"
            onClick={onEdit}
            aria-label={t("common:edit")}
          >
            <Edit className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-destructive"
            onClick={onDelete}
            aria-label={t("common:delete")}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
