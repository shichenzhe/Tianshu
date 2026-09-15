/**
 * MCP 服务编辑对话框（创建/编辑）：transport 切换 stdio/http 两组字段，
 * JSON 字段提交前校验（非法 → toast），编辑态走 update-diff 差量（清空 → null）
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import McpServerApi, {
  type McpServerRecord,
  type McpTransport,
} from "../../api/mcp.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { diffOptionalString } from "../../lib/update-diff";

const SERVERS_KEY = ["mcpServers"] as const;
const STATUSES_KEY = ["mcp-statuses"] as const;

interface McpServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: McpServerRecord;
}

/** JSON 文本字段：空白合法（可选），非空必须能 parse */
function isValidJson(raw: string): boolean {
  if (!raw.trim()) {
    return true;
  }
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

export default function McpServerDialog({
  open,
  onOpenChange,
  editing,
}: McpServerDialogProps) {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setTransport(editing?.transport ?? "stdio");
      setCommand(editing?.command ?? "");
      setArgs(editing?.args ?? "");
      setEnv(editing?.env ?? "");
      setUrl(editing?.url ?? "");
      setHeaders(editing?.headers ?? "");
      setEnabled(editing?.enabled ?? true);
    }
  }, [open, editing]);

  // 切换 transport 时清空另一组字段：编辑态经 diff 传 null 真正清掉旧传输的残留列
  const handleTransportChange = (next: McpTransport) => {
    setTransport(next);
    if (next === "http") {
      setCommand("");
      setArgs("");
      setEnv("");
    } else {
      setUrl("");
      setHeaders("");
    }
  };

  const handleSubmit = async () => {
    if (!name.trim() || submitting) {
      return;
    }
    // 连续下划线会与 mcp__<server>__<tool> 前缀命名空间冲突（unregister 按前缀清理）
    if (name.includes("__")) {
      toast.error(t("ai:mcp.invalidName"));
      return;
    }
    if (transport === "stdio" && !command.trim()) {
      return;
    }
    if (transport === "http" && !url.trim()) {
      return;
    }
    const jsonFields = transport === "stdio" ? [args, env] : [headers];
    if (jsonFields.some((raw) => !isValidJson(raw))) {
      toast.error(t("ai:mcp.invalidJson"));
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        // 编辑态差量提交：可空字段清除时传 null（undefined 会被 Prisma 跳过，旧值残留）
        await McpServerApi.update({
          id: editing.id,
          name: name.trim(),
          transport,
          enabled,
          command: diffOptionalString(command, editing.command),
          args: diffOptionalString(args, editing.args),
          env: diffOptionalString(env, editing.env),
          url: diffOptionalString(url, editing.url),
          headers: diffOptionalString(headers, editing.headers),
        });
      } else {
        await McpServerApi.create({
          name: name.trim(),
          transport,
          enabled,
          ...(transport === "stdio"
            ? {
                command: command.trim() || undefined,
                args: args.trim() || undefined,
                env: env.trim() || undefined,
              }
            : {
                url: url.trim() || undefined,
                headers: headers.trim() || undefined,
              }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: SERVERS_KEY });
      await queryClient.invalidateQueries({ queryKey: STATUSES_KEY });
      onOpenChange(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? editing.name : t("ai:mcp.add")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("ai:mcp.name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:mcp.transport")}</Label>
            <Select
              value={transport}
              onValueChange={(v) => handleTransportChange(v as McpTransport)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                <SelectItem value="stdio">{t("ai:mcp.stdio")}</SelectItem>
                <SelectItem value="http">{t("ai:mcp.http")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {transport === "stdio" ? (
            <>
              <div className="space-y-1.5">
                <Label>{t("ai:mcp.command")}</Label>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("ai:mcp.args")}</Label>
                <Textarea
                  rows={2}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder={t("ai:mcp.argsPlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("ai:mcp.env")}</Label>
                <Textarea
                  rows={2}
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                  placeholder={t("ai:mcp.envPlaceholder")}
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>{t("ai:mcp.url")}</Label>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>{t("ai:mcp.headers")}</Label>
                <Textarea
                  rows={2}
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                  placeholder={t("ai:mcp.headersPlaceholder")}
                />
              </div>
            </>
          )}
          <div className="flex items-center gap-2">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t("ai:mcp.enabled")}
            />
            <Label>{t("ai:mcp.enabled")}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={submitting}>
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
