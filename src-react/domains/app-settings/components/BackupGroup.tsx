/**
 * 备份组（spec 2026-10-27 §4 + 2026-10-28 多用户扩展）：目标主机（仅直连）
 * 选择 + 立即备份（可选备注）+ backup:progress 四相进度条 + 备份列表
 * （恢复/删除，均二次确认 AlertDialog；admin 视角行内 owner 徽标）+ 邀请码
 * 申领小节（未配 backupToken、或 list 判定既有凭据已失效〔被踢除等，
 * 终审 I3〕的连接显示——成功自动回填，连接状态即时刷新）
 * + admin 管理小节（viewer.kind==='admin'：邀请码生成/列表/复制/撤销 +
 * 已申领设备列表/踢除；admin 判定来自 backup:list 的 viewer 身份）。
 * 恢复确认文案含「自动保留保护副本」与「重启后生效」；成功后不自动
 * relaunch——重启横条 + 按钮触发 backup:relaunch（用户手动确认，防丢上
 * 下文）。连接下拉数据复用 server 域连接列表 IPC。
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import {
  BACKUP_ADMIN_OWNER,
  type BackupClientRecord,
  type BackupInviteRecord,
  type BackupListResult,
  type BackupMeta,
  type BackupViewer,
} from "@tianshu/protocol";

import ServerApi, {
  type ConnectionView,
} from "@/domains/ai/server/api/server.api";
import type { BackupProgressPayload } from "../../../../electron/domains/backup/ipc";
import { invoke, on } from "@/lib/ipc";
import { formatBytes } from "../model/storage-display";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** 四相文案 key（phase → i18n） */
const PHASE_KEYS: Record<BackupProgressPayload["phase"], string> = {
  packing: "settings:backupPhasePacking",
  uploading: "settings:backupPhaseUploading",
  downloading: "settings:backupPhaseDownloading",
  restoring: "settings:backupPhaseRestoring",
};

/** 主进程错误消息直显（含连接校验等业务错，保信息量） */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** backup:list 失败是否指向备份凭据失效（终审 I3）：主进程 BackupClient
 *  透传的错面含 HTTP 401 或「备份 token」（BackupGuard 拒文案）即判死
 *  凭据（admin 踢除后 backupToken 即此形态） */
function isTokenRejection(e: unknown): boolean {
  const msg = errorMessage(e);
  return msg.includes("HTTP 401") || msg.includes("备份 token");
}

export default function BackupGroup() {
  const { t } = useTranslation(["settings", "common"]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [selectedConnId, setSelectedConnId] = useState("");
  const [backups, setBackups] = useState<BackupMeta[] | null>(null);
  /** 查看者身份（backup:list 回传；admin 才渲染管理小节与 owner 徽标） */
  const [viewer, setViewer] = useState<BackupViewer | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"create" | "restore" | null>(null);
  const [progress, setProgress] = useState<BackupProgressPayload | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupMeta | null>(null);
  const [relaunchPending, setRelaunchPending] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // 申领表单（未配 backupToken 的连接显示；成功即自动回填并刷新连接态）
  const [inviteCode, setInviteCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [claiming, setClaiming] = useState(false);
  /** 既有 backupToken 已失效（list 401/备份 token 错——被踢除等，终审
   *  I3）：放宽申领小节显隐让重新申领可达，成功后自动覆盖回填 */
  const [tokenInvalid, setTokenInvalid] = useState(false);
  // 管理面板（admin）：邀请码与已申领设备（null=未装载）
  const [invites, setInvites] = useState<BackupInviteRecord[] | null>(null);
  const [inviteCount, setInviteCount] = useState("1");
  const [inviteNote, setInviteNote] = useState("");
  const [generating, setGenerating] = useState(false);
  const [clients, setClients] = useState<BackupClientRecord[] | null>(null);

  /** 连接列表载入/刷新：只取 direct（备份不开放 relay——spec §1 裁定）；
   *  选中保持不变（初载才按活动连接/首个 direct 默认选中） */
  const loadConnections = useCallback(async (): Promise<void> => {
    const result = await ServerApi.listConnections();
    const direct = result.connections.filter((c) => c.mode === "direct");
    setConnections(direct);
    setSelectedConnId(
      (prev) =>
        prev ||
        direct.find((c) => c.id === result.activeConnId)?.id ||
        direct[0]?.id ||
        "",
    );
  }, []);

  // 初始载入连接列表
  useEffect(() => {
    let active = true;
    loadConnections()
      .catch(() => {
        if (active) toast.error(t("settings:error.loadFailed"));
      })
      .finally(() => {
        if (active) setConnectionsLoading(false);
      });
    return () => {
      active = false;
    };
    // 初载一次性（依赖留空有意）
  }, []);

  // progress 事件订阅（四相字节进度；卸载即退订）
  useEffect(
    () =>
      on("backup:progress", (_event, payload) => {
        setProgress(payload as BackupProgressPayload);
      }),
    [],
  );

  const refreshBackups = useCallback(async (connId: string) => {
    try {
      const result = await invoke<BackupListResult>("backup:list", connId);
      setBackups(result.backups);
      setViewer(result.viewer);
      setTokenInvalid(false);
    } catch (e) {
      // 被踢除设备恢复路径（终审 I3）：backupToken 成死凭据时只 toast 会
      // 把申领入口锁死（小节原按「已配 backupToken」隐藏）——置失效旗标
      // 放宽小节显隐，重新申领将自动覆盖回填
      if (isTokenRejection(e)) setTokenInvalid(true);
      toast.error(errorMessage(e));
    }
  }, []);

  // 备份列表随连接切换重拉（viewer/tokenInvalid 一并复位——admin 小节按
  // 新连接身份收敛；失效旗标由本次 list 结果重新判定）
  useEffect(() => {
    setBackups(null);
    setViewer(null);
    setTokenInvalid(false);
    if (selectedConnId) void refreshBackups(selectedConnId);
  }, [selectedConnId, refreshBackups]);

  /** 选中连接（申领小节显隐判定——未配 backupToken 才显示） */
  const selectedConn = connections.find((c) => c.id === selectedConnId);
  const isAdmin = viewer?.kind === "admin";

  /** 邀请码申领：成功后 backupToken 已由主进程自动写回连接——刷新连接态
   *  （申领小节随之隐藏）并重拉列表（viewer 身份可能已变） */
  const claimInvite = async () => {
    if (!selectedConnId || claiming) return;
    setClaiming(true);
    try {
      await invoke(
        "backup:claim",
        selectedConnId,
        inviteCode.trim(),
        deviceName.trim(),
      );
      toast.success(t("settings:backupClaimSuccess"));
      setInviteCode("");
      setDeviceName("");
      await loadConnections().catch(() =>
        toast.error(t("settings:error.loadFailed")),
      );
      await refreshBackups(selectedConnId);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setClaiming(false);
    }
  };

  // 管理面板数据：admin 视角随连接装载（非 admin/未选连接即清空）
  useEffect(() => {
    if (!isAdmin || !selectedConnId) {
      setInvites(null);
      setClients(null);
      return;
    }
    let active = true;
    Promise.all([
      invoke<BackupInviteRecord[]>("backup:invites:list", selectedConnId),
      invoke<BackupClientRecord[]>("backup:clients:list", selectedConnId),
    ])
      .then(([inviteRows, clientRows]) => {
        if (!active) return;
        setInvites(inviteRows);
        setClients(clientRows);
      })
      .catch((e) => {
        if (!active) return;
        setInvites([]);
        setClients([]);
        toast.error(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [isAdmin, selectedConnId]);

  /** 批量生成邀请码（1-50；count 非法值收敛为 1）→ 刷新邀请码列表 */
  const generateInvites = async () => {
    if (!selectedConnId || generating) return;
    const count = Math.min(50, Math.max(1, Number(inviteCount) || 1));
    setGenerating(true);
    try {
      const created = await invoke<BackupInviteRecord[]>(
        "backup:invites:create",
        selectedConnId,
        count,
        inviteNote.trim() || undefined,
      );
      toast.success(
        t("settings:backupInviteGeneratedToast", { count: created.length }),
      );
      setInviteNote("");
      setInvites(
        await invoke<BackupInviteRecord[]>(
          "backup:invites:list",
          selectedConnId,
        ),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  const copyInviteCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t("settings:backupInviteCopied"));
    } catch {
      toast.error(t("settings:backupInviteCopyFailed"));
    }
  };

  const revokeInvite = async (code: string) => {
    if (!selectedConnId) return;
    try {
      await invoke("backup:invites:delete", selectedConnId, code);
      setInvites(
        await invoke<BackupInviteRecord[]>(
          "backup:invites:list",
          selectedConnId,
        ),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const kickClient = async (clientId: string) => {
    if (!selectedConnId) return;
    try {
      await invoke("backup:clients:delete", selectedConnId, clientId);
      setClients(
        await invoke<BackupClientRecord[]>(
          "backup:clients:list",
          selectedConnId,
        ),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  /** 立即备份：可选备注随行；完成 toast + 刷新列表 */
  const createBackup = async () => {
    if (!selectedConnId || busy) return;
    setBusy("create");
    setProgress({ phase: "packing", current: 0, total: 0 });
    try {
      await invoke("backup:create", selectedConnId, note.trim() || undefined);
      toast.success(t("settings:backupCreatedToast"));
      setNote("");
      await refreshBackups(selectedConnId);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  /** 恢复确认执行：成功置重启横条（不自动重启——用户手动确认） */
  const confirmRestore = async () => {
    const target = restoreTarget;
    if (!target || !selectedConnId || busy) return;
    setBusy("restore");
    setProgress({ phase: "downloading", current: 0, total: 0 });
    try {
      // 第三参传选中行 meta.sha256（主进程下载后对拍，免回查 list）
      await invoke("backup:restore", selectedConnId, target.id, target.sha256);
      setRelaunchPending(true);
      toast.success(t("settings:backupRelaunching"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
      setProgress(null);
      setRestoreTarget(null);
    }
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target || !selectedConnId) return;
    try {
      await invoke("backup:delete", selectedConnId, target.id);
      await refreshBackups(selectedConnId);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleteTarget(null);
    }
  };

  const relaunch = () => {
    setRestarting(true);
    invoke("backup:relaunch").catch(() => {
      setRestarting(false);
      toast.error(t("settings:storage.relaunchFailed"));
    });
  };

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : null;

  return (
    <>
      {/* 目标主机 + 立即备份 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm font-normal">
              {t("settings:backupTargetHost")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings:backupDesc")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={selectedConnId}
              onValueChange={setSelectedConnId}
              disabled={connections.length === 0 || busy !== null}
            >
              <SelectTrigger
                className="h-8 w-44 font-normal"
                aria-label={t("settings:backupTargetHost")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-lg border-border/50 shadow-lg">
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={!selectedConnId || busy !== null}
              onClick={() => void createBackup()}
            >
              {busy === "create" && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {t("settings:backupNow")}
            </Button>
          </div>
        </div>
        {!connectionsLoading && connections.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("settings:backupOnlyDirect")}
          </p>
        )}
        <Input
          className="h-8 font-normal"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("settings:backupNote")}
          aria-label={t("settings:backupNote")}
          disabled={busy !== null}
        />
        {/* 四相进度：total 未知时仅相位 + spinner，已知时百分比条 */}
        {busy && progress && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                {percent === null && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {t(PHASE_KEYS[progress.phase])}
              </span>
              <span aria-label={t("settings:backupProgress")}>
                {percent === null ? "" : `${percent}%`}
              </span>
            </div>
            {percent !== null && (
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}
          </div>
        )}
        {relaunchPending && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-primary/20 bg-primary-subtle p-3">
            <p className="text-xs text-muted-foreground">
              {t("settings:backupRelaunching")}
            </p>
            <Button size="sm" disabled={restarting} onClick={relaunch}>
              {restarting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              {t("settings:storage.relaunchNow")}
            </Button>
          </div>
        )}
      </div>

      {/* 邀请码申领（多用户批）：未配 backupToken、或既有凭据已被判失效
          （list 401/备份 token 错——被踢除后恢复路径，终审 I3）的连接显示
          ——成功后 clientToken 已自动写回连接，本小节随之隐藏 */}
      {!connectionsLoading &&
        selectedConn &&
        (!selectedConn.backupToken || tokenInvalid) && (
          <div className="space-y-2">
            {tokenInvalid && (
              <p className="text-xs text-destructive">
                {t("settings:backupClaimStaleHint")}
              </p>
            )}
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-sm font-normal">
                  {t("settings:backupClaimTitle")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings:backupClaimDesc")}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                disabled={claiming || !inviteCode.trim() || !deviceName.trim()}
                onClick={() => void claimInvite()}
              >
                {claiming && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("settings:backupClaimAction")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-56 font-mono"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder={t("settings:backupClaimInviteCodePlaceholder")}
                aria-label={t("settings:backupClaimInviteCodeLabel")}
                disabled={claiming}
              />
              <Input
                className="h-8 w-44 font-normal"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder={t("settings:backupClaimDeviceNamePlaceholder")}
                aria-label={t("settings:backupClaimDeviceNameLabel")}
                disabled={claiming}
              />
            </div>
          </div>
        )}

      {/* 备份列表：时间/版本/大小/note + 恢复/删除（admin 视角行内 owner 徽标） */}
      <div className="space-y-2">
        {backups === null || connectionsLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("common:loading")}
          </div>
        ) : backups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("settings:backupListEmpty")}
          </p>
        ) : (
          backups.map((backup) => (
            <div
              key={backup.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-border/50 px-3 py-2"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm">
                  {new Date(backup.createdAt).toLocaleString()} · v
                  {backup.appVersion} · {formatBytes(backup.fileSize)}
                </p>
                <div className="flex min-w-0 items-center gap-2">
                  {backup.note && (
                    <p className="truncate text-xs text-muted-foreground">
                      {backup.note}
                    </p>
                  )}
                  {isAdmin && (
                    <Badge
                      variant="outline"
                      className="shrink-0 font-mono text-[10px] font-normal"
                    >
                      {backup.owner === BACKUP_ADMIN_OWNER
                        ? t("settings:backupOwnerAdmin")
                        : backup.owner}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  disabled={busy !== null}
                  onClick={() => setRestoreTarget(backup)}
                >
                  {t("settings:backupRestore")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  disabled={busy !== null}
                  onClick={() => setDeleteTarget(backup)}
                >
                  {t("settings:backupDelete")}
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 管理面板（多用户批）：viewer.kind==='admin' 才渲染——邀请码生成/
          列表（复制/撤销）+ 已申领设备（踢除）；操作后即时重拉对应列表 */}
      {isAdmin && (
        <div className="space-y-3">
          <div className="space-y-0.5">
            <Label className="text-sm font-normal">
              {t("settings:backupAdminTitle")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings:backupAdminDesc")}
            </p>
          </div>
          {/* 邀请码：生成（数量+备注）+ 列表（码/状态/复制/撤销） */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-xs font-medium text-muted-foreground">
                {t("settings:backupInvitesTitle")}
              </p>
              <div className="flex items-center gap-2">
                <Input
                  className="h-8 w-16 text-right font-normal"
                  type="number"
                  min={1}
                  max={50}
                  value={inviteCount}
                  onChange={(e) => setInviteCount(e.target.value)}
                  aria-label={t("settings:backupInviteCountLabel")}
                  disabled={generating}
                />
                <Input
                  className="h-8 w-40 font-normal"
                  value={inviteNote}
                  onChange={(e) => setInviteNote(e.target.value)}
                  placeholder={t("settings:backupInviteNotePlaceholder")}
                  aria-label={t("settings:backupInviteNoteLabel")}
                  disabled={generating}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  disabled={generating}
                  onClick={() => void generateInvites()}
                >
                  {generating && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("settings:backupInviteGenerate")}
                </Button>
              </div>
            </div>
            {invites === null ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("common:loading")}
              </div>
            ) : invites.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("settings:backupInviteEmpty")}
              </p>
            ) : (
              invites.map((invite) => (
                <div
                  key={invite.code}
                  className="flex items-center justify-between gap-4 rounded-lg border border-border/50 px-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate font-mono text-sm">
                      {invite.code}
                      {invite.note && (
                        <span className="ml-2 font-sans text-xs text-muted-foreground">
                          {invite.note}
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {invite.usedAt
                        ? t("settings:backupInviteUsedBy", {
                            device: invite.usedBy ?? "?",
                          })
                        : t("settings:backupInviteUnused")}
                      {" · "}
                      {new Date(invite.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                      onClick={() => void copyInviteCode(invite.code)}
                    >
                      {t("settings:backupInviteCopy")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                      onClick={() => void revokeInvite(invite.code)}
                    >
                      {t("settings:backupInviteRevoke")}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
          {/* 已申领设备：clientId/申领时间/备注 + 踢除 */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t("settings:backupClientsTitle")}
            </p>
            {clients === null ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("common:loading")}
              </div>
            ) : clients.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("settings:backupClientEmpty")}
              </p>
            ) : (
              clients.map((client) => (
                <div
                  key={client.clientId}
                  className="flex items-center justify-between gap-4 rounded-lg border border-border/50 px-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate font-mono text-sm">
                      {client.clientId}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {new Date(client.createdAt).toLocaleString()}
                      {client.invitedNote && ` · ${client.invitedNote}`}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                    onClick={() => void kickClient(client.clientId)}
                  >
                    {t("settings:backupClientKick")}
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 恢复二次确认（自动保留保护副本 + 重启后生效） */}
      <AlertDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
      >
        <AlertDialogContent className="rounded-lg border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:backupRestoreConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:backupRestoreConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "restore"}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRestore()}>
              {t("settings:backupRestore")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除二次确认 */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="rounded-lg border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings:backupDelete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:backupDeleteConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmDelete()}
              className="bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"
            >
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
