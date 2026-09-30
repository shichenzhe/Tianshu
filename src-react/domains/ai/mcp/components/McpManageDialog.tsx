/**
 * MCP 服务管理弹窗：列表态（已安装表格 + 空态插画）/ 编辑态（JSON 编辑器）。
 * 打开带 initialTemplate（市场 + 入口）直入编辑态并合入模板；
 * 保存流：parseMcpConfig 前端校验（错误码 → i18n）→ sync → invalidate 回列表态。
 * 行内启停/重连/删除迁自原 McpSettingsView；编辑统一走 JSON 编辑器（无行内编辑）
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  ExternalLink,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import McpServerApi, {
  type McpServerRecord,
  type McpServerState,
  type McpServerStatus,
} from "../../api/mcp.api";
import { mapIpcError } from "../../chat/lib/error-message";
import {
  mergeTemplate,
  parseMcpConfig,
  recordsToJsonText,
  type McpServerJsonEntry,
  type McpServerSyncEntry,
} from "../lib/mcp-json";
import JsonConfigEditor from "./JsonConfigEditor";

const SERVERS_KEY = ["mcpServers"] as const;
const STATUSES_KEY = ["mcp-statuses"] as const;
const STATUS_POLL_MS = 3000;

/** 错误码 → i18n key（mcp-json 抛 "<CODE>:<detail>"） */
const ERROR_KEYS: Record<string, string> = {
  MCP_JSON_PARSE: "ai:mcp.market.errParse",
  MCP_JSON_STRUCTURE: "ai:mcp.market.errStructure",
  MCP_NAME_INVALID: "ai:mcp.market.errName",
  MCP_ENTRY_TRANSPORT: "ai:mcp.market.errTransport",
  MCP_ARGS_INVALID: "ai:mcp.market.errArgs",
  MCP_ENV_INVALID: "ai:mcp.market.errEnv",
  MCP_HEADERS_INVALID: "ai:mcp.market.errHeaders",
};

const STATE_CLASS: Record<McpServerState, string> = {
  connected: "text-primary",
  error: "text-destructive",
  connecting: "text-muted-foreground",
  disabled: "text-muted-foreground",
};

interface McpManageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 市场 + 入口携带的模板（打开即编辑态合入） */
  initialTemplate?: Record<string, McpServerJsonEntry>;
}

export default function McpManageDialog({
  open,
  onOpenChange,
  initialTemplate,
}: McpManageDialogProps) {
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
      query.state.data?.some((s) => s.state === "connecting")
        ? STATUS_POLL_MS
        : false,
  });

  const servers = serversQuery.data ?? [];
  const [mode, setMode] = useState<"list" | "edit">("list");
  const [jsonText, setJsonText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<McpServerRecord | null>(null);

  // 打开时按入口决定初始态：带模板直入编辑态并合入；否则列表态
  useEffect(() => {
    if (!open) {
      return;
    }
    const base = recordsToJsonText(servers);
    setJsonText(initialTemplate ? mergeTemplate(base, initialTemplate) : base);
    setInvalid(false);
    setSearch("");
    setMode(initialTemplate ? "edit" : "list");
    // servers 为异步数据，打开时可能尚未就绪——就绪后重算初始文本（仅编辑态且未改动前）
    // 简化：以打开瞬间为准，编辑态文本由用户主导；列表态数据照常刷新
  }, [open, initialTemplate]);

  const statusById = new Map(
    (statusesQuery.data ?? []).map((status) => [status.id, status]),
  );
  const visibleServers = servers.filter((s) =>
    s.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: SERVERS_KEY });
    await queryClient.invalidateQueries({ queryKey: STATUSES_KEY });
  };

  const syncErrorMessage = (e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    const idx = raw.indexOf(":");
    const key = ERROR_KEYS[idx > 0 ? raw.slice(0, idx) : ""];
    return key ? t(key, { value: raw.slice(idx + 1) }) : mapIpcError(e);
  };

  const handleSave = async () => {
    if (saving) {
      return;
    }
    let entries: Record<string, McpServerSyncEntry>;
    try {
      entries = parseMcpConfig(jsonText);
    } catch (e) {
      setInvalid(true);
      toast.error(syncErrorMessage(e));
      return;
    }
    setInvalid(false);
    setSaving(true);
    try {
      const result = await McpServerApi.sync(entries);
      await invalidate();
      toast.success(
        t("ai:mcp.market.syncSaved", {
          created: result.created,
          updated: result.updated,
          deleted: result.deleted,
        }),
      );
      setMode("list");
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (server: McpServerRecord, enabled: boolean) => {
    try {
      await McpServerApi.setEnabled(server.id, enabled);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleReconnect = async (server: McpServerRecord) => {
    try {
      await McpServerApi.reconnect(server.id);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleDelete = async () => {
    if (!deleting) {
      return;
    }
    try {
      await McpServerApi.delete(deleting.id);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden border border-border/50 rounded-lg shadow-lg p-0 sm:max-w-2xl">
        {mode === "list" ? (
          <ListPane
            servers={visibleServers}
            statusById={statusById}
            search={search}
            onSearch={setSearch}
            loading={serversQuery.isPending}
            onConfigure={() => setMode("edit")}
            onToggle={handleToggle}
            onReconnect={handleReconnect}
            onDelete={setDeleting}
            t={t}
          />
        ) : (
          <EditPane
            jsonText={jsonText}
            invalid={invalid}
            saving={saving}
            onChange={(v) => setJsonText(v)}
            onBack={() => setMode("list")}
            onSave={handleSave}
            t={t}
          />
        )}
      </DialogContent>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("ai:mcp.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `${deleting.name} · ${t("ai:mcp.deleteConfirmDesc")}`
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
    </Dialog>
  );
}

function ListPane({
  servers,
  statusById,
  search,
  onSearch,
  loading,
  onConfigure,
  onToggle,
  onReconnect,
  onDelete,
  t,
}: {
  servers: McpServerRecord[];
  statusById: Map<number, McpServerStatus>;
  search: string;
  onSearch: (v: string) => void;
  loading: boolean;
  onConfigure: () => void;
  onToggle: (server: McpServerRecord, enabled: boolean) => void;
  onReconnect: (server: McpServerRecord) => void;
  onDelete: (server: McpServerRecord) => void;
  t: TFunction;
}) {
  return (
    <>
      <DialogHeader className="border-b border-border/50 p-5 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-base">
              {t("ai:mcp.manage.title")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              {t("ai:mcp.manage.subtitle")}
            </DialogDescription>
          </div>
          <Button size="sm" onClick={onConfigure}>
            <Plus className="mr-1 h-4 w-4" />
            {t("ai:mcp.manage.configure")}
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {/* type="search"：role 为 searchbox（编辑器 textarea 是弹窗内唯一
              textbox），列表/编辑态切换时按 textbox 角色即可判定编辑器去留 */}
          <Input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={t("ai:mcp.manage.searchPlaceholder")}
            className="h-8 flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            onClick={() => void McpServerApi.openHub()}
          >
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            {t("ai:mcp.market.hub")}
          </Button>
        </div>
      </DialogHeader>
      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {t("common:loading")}
          </p>
        ) : servers.length === 0 ? (
          <EmptyPane onConfigure={onConfigure} t={t} />
        ) : (
          <div className="space-y-2">
            {servers.map((server) => (
              <ServerRow
                key={server.id}
                server={server}
                status={statusById.get(server.id)}
                onToggle={onToggle}
                onReconnect={onReconnect}
                onDelete={onDelete}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function EmptyPane({
  onConfigure,
  t,
}: {
  onConfigure: () => void;
  t: TFunction;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-14 text-center">
      <Server
        className="h-12 w-12 text-muted-foreground/40"
        strokeWidth={1.5}
      />
      <div>
        <p className="text-sm font-medium">{t("ai:mcp.manage.empty")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("ai:mcp.manage.emptyTip")}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        onClick={onConfigure}
      >
        {t("ai:mcp.manage.configure")}
      </Button>
    </div>
  );
}

function ServerRow({
  server,
  status,
  onToggle,
  onReconnect,
  onDelete,
  t,
}: {
  server: McpServerRecord;
  status?: McpServerStatus;
  onToggle: (server: McpServerRecord, enabled: boolean) => void;
  onReconnect: (server: McpServerRecord) => void;
  onDelete: (server: McpServerRecord) => void;
  t: TFunction;
}) {
  return (
    <div className="bg-card flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{server.name}</span>
          <Badge variant="secondary">{t(`ai:mcp.${server.transport}`)}</Badge>
        </div>
        {status ? (
          <span
            className={`text-xs ${STATE_CLASS[status.state]}`}
            title={status.error}
          >
            {t(`ai:mcp.status.${status.state}`)} · {status.toolCount}{" "}
            {t("ai:mcp.tools")}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {server.enabled ? "—" : t("ai:mcp.status.disabled")}
          </span>
        )}
      </div>
      <Switch
        checked={server.enabled}
        onCheckedChange={(enabled) => onToggle(server, enabled)}
        aria-label={t("ai:mcp.enabled")}
      />
      {server.enabled && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-primary"
          onClick={() => onReconnect(server)}
          aria-label={t("ai:mcp.reconnect")}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-destructive"
        onClick={() => onDelete(server)}
        aria-label={t("common:delete")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function EditPane({
  jsonText,
  invalid,
  saving,
  onChange,
  onBack,
  onSave,
  t,
}: {
  jsonText: string;
  invalid: boolean;
  saving: boolean;
  onChange: (v: string) => void;
  onBack: () => void;
  onSave: () => void;
  t: TFunction;
}) {
  return (
    <>
      <DialogHeader className="border-b border-border/50 p-5 pb-4">
        <div className="flex items-center justify-between gap-4">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 hover:bg-primary-subtle hover:text-primary"
            onClick={onBack}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("ai:mcp.manage.backToList")}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onBack}
            >
              {t("common:cancel")}
            </Button>
            <Button
              size="sm"
              className="h-8"
              disabled={saving}
              onClick={onSave}
            >
              {t("ai:mcp.manage.save")}
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("ai:mcp.market.jsonSyncNote")}
        </p>
      </DialogHeader>
      <div className="flex-1 overflow-y-auto p-5">
        <JsonConfigEditor
          value={jsonText}
          onChange={onChange}
          invalid={invalid}
        />
      </div>
    </>
  );
}
