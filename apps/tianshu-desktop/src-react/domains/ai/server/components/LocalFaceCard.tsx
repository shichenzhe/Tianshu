/**
 * 本机被控面设置卡（spec §13 项 1）：左栏本地无头端卡下方——启用开关
 * （关→停服务面+relay 客户端；开→按配置起+无 token 自动生成）、端口、
 * host（主进程只认 127.0.0.1/0.0.0.0，选单两档；非回环行内警告）、
 * token（打码显示+复制+重新生成）、relay 配置（url+token，留空=纯直连）、
 * 端到端加密区（E2E-T2：模式 auto/required/off 选单 + 指纹/公钥显示复制
 * ——指纹带外交给控制端防中间人；中继连接时显示会话加密状态点）。
 * 保存语义：字段变更即保存（输入 blur 提交/选单切换即存，5s 轮询不覆盖
 * 用户未提交的草稿——与配置一致的字段才回填）；端口/host 热重载（主进程
 * ensureServerFace 对不一致先停后起），无重启提示。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, KeyRound } from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import ServerApi, {
  type FaceE2eMode,
  type FaceStatus,
  type FaceUpdate,
} from "../api/server.api";

const FACE_STATUS_QUERY_KEY = ["server", "faceStatus"] as const;

/** 表单草稿（端口以文本暂存，提交时校验转数） */
interface FaceDraft {
  portText: string;
  host: string;
  relayUrl: string;
  relayToken: string;
}

/** 回环 host（警告豁免口径；主进程现形只放行 127.0.0.1/0.0.0.0） */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host);
}

/** 端口校验：1-65535 整数（0=随机端口为主进程测试语义，UI 不开放） */
function parsePort(text: string): number | null {
  const port = Number.parseInt(text.trim(), 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

/** status 快照 → 表单种子 */
function seedOf(status: FaceStatus): FaceDraft {
  return {
    portText: String(status.port),
    host: status.host,
    relayUrl: status.relayUrl,
    relayToken: status.relayToken,
  };
}

/** token 打码展示（首尾各 4 位；短值原样——不泄露也不误截） */
function maskToken(token: string): string {
  return token.length <= 8 ? token : `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** 行标签（input 上方小字） */
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="block text-[10px] text-muted-foreground select-none">
      {children}
    </span>
  );
}

export default function LocalFaceCard() {
  const { t } = useTranslation(["ai"]);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<FaceDraft | null>(null);
  const [committing, setCommitting] = useState(false);
  const lastSeed = useRef<FaceDraft | null>(null);

  const statusQuery = useQuery({
    queryKey: FACE_STATUS_QUERY_KEY,
    queryFn: () => ServerApi.faceStatus(),
    refetchInterval: 5_000,
  });
  const status = statusQuery.data;

  // 轮询回填：仅同步与配置一致的字段（用户改过的草稿不被 5s 轮询覆盖；
  // 已提交字段与服务端一致时顺带回填新值，如启用后端口回显）
  useEffect(() => {
    if (!status) return;
    const seed = seedOf(status);
    setDraft((prev) => {
      const stale = lastSeed.current;
      if (!prev || !stale) return { ...seed };
      return {
        portText:
          prev.portText !== stale.portText ? prev.portText : seed.portText,
        host: prev.host !== stale.host ? prev.host : seed.host,
        relayUrl:
          prev.relayUrl !== stale.relayUrl ? prev.relayUrl : seed.relayUrl,
        relayToken:
          prev.relayToken !== stale.relayToken
            ? prev.relayToken
            : seed.relayToken,
      };
    });
    lastSeed.current = seed;
  }, [status]);

  /** 全量表单提交（服务端按 key 合并；字段级变更/开关/重生成共用），
   * 成功回写缓存即回显；失败 toast 携原因 */
  const commit = useCallback(
    async (patch: Partial<FaceUpdate>, successKey?: string) => {
      if (!status || !draft) return;
      const port = parsePort(draft.portText);
      if (!port) {
        toast.error(t("ai:server.face.portInvalid"));
        return;
      }
      const relayUrl = draft.relayUrl.trim();
      if (relayUrl && !/^wss?:\/\//.test(relayUrl)) {
        toast.error(t("ai:server.connection.errors.relayUrlInvalid"));
        return;
      }
      setCommitting(true);
      try {
        const next = await ServerApi.faceSetEnabled({
          enabled: patch.enabled ?? status.enabled,
          port,
          // 选单切换等即时提交：patch 携最新值（draft 尚未重渲染）
          host: patch.host ?? draft.host,
          relayUrl,
          relayToken: draft.relayToken.trim(),
          ...(patch.e2e ? { e2e: patch.e2e } : {}),
          ...(patch.regenerateToken ? { regenerateToken: true } : {}),
        });
        queryClient.setQueryData(FACE_STATUS_QUERY_KEY, next);
        if (successKey) toast.success(t(successKey));
      } catch (e) {
        toast.error(
          t("ai:server.face.saveFailed", {
            message: String(e instanceof Error ? e.message : e),
          }),
        );
      } finally {
        setCommitting(false);
      }
    },
    [draft, queryClient, status, t],
  );

  /** blur 提交：与配置一致的字段跳过（避免焦点切换连发 IPC） */
  const commitIfChanged = useCallback(
    (field: keyof FaceDraft) => {
      const seed = lastSeed.current;
      if (!seed || !draft) return;
      if (draft[field].trim() === seed[field].trim()) return;
      void commit({}, "ai:server.face.saved");
    },
    [commit, draft],
  );

  const handleCopy = async () => {
    if (!status?.token) return;
    try {
      await navigator.clipboard.writeText(status.token);
      toast.success(t("ai:server.face.tokenCopied"));
    } catch {
      toast.error(t("ai:server.face.tokenCopyFailed"));
    }
  };

  /** E2E 指纹/公钥复制（带外传递通道：指纹交给控制端做防中间人核对） */
  const copyE2eValue = async (value: string | undefined, copiedKey: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t(copiedKey));
    } catch {
      toast.error(t("ai:server.face.e2e.copyFailed"));
    }
  };

  const running = status?.running ?? false;
  const enabled = status?.enabled ?? false;
  const busy = committing || statusQuery.isLoading || !draft;
  const hostWarning = draft ? !isLoopback(draft.host) : false;

  return (
    <div
      data-testid="face-card"
      className="rounded-lg border border-border/50 bg-muted/30 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {t("ai:server.face.title")}
        </span>
        <div className="flex items-center gap-2">
          <span
            data-testid="face-state"
            className={cn(
              "text-xs",
              running
                ? "text-primary"
                : enabled
                  ? "text-destructive"
                  : "text-muted-foreground",
            )}
          >
            {running
              ? `${t("ai:server.face.state.running")}:${status?.port}`
              : enabled
                ? t("ai:server.face.state.pending")
                : t("ai:server.face.state.stopped")}
          </span>
          <Switch
            data-testid="face-switch"
            checked={enabled}
            disabled={busy}
            aria-label={t("ai:server.face.enabled")}
            onCheckedChange={(next) =>
              void commit(
                { enabled: next },
                next
                  ? "ai:server.face.enabledToast"
                  : "ai:server.face.disabledToast",
              )
            }
          />
        </div>
      </div>

      <div className="mt-2 grid grid-cols-[1fr_1.4fr] gap-2">
        <div className="flex flex-col gap-1">
          <FieldLabel>{t("ai:server.face.port")}</FieldLabel>
          <Input
            data-testid="face-port"
            className="h-7 text-xs"
            inputMode="numeric"
            disabled={busy}
            value={draft?.portText ?? ""}
            onChange={(e) =>
              setDraft((prev) =>
                prev ? { ...prev, portText: e.target.value } : prev,
              )
            }
            onBlur={() => commitIfChanged("portText")}
          />
        </div>
        <div className="flex flex-col gap-1">
          <FieldLabel>{t("ai:server.face.host")}</FieldLabel>
          <Select
            value={draft?.host ?? "0.0.0.0"}
            disabled={busy}
            onValueChange={(host) => {
              setDraft((prev) => (prev ? { ...prev, host } : prev));
              void commit({ host }, "ai:server.face.saved");
            }}
          >
            <SelectTrigger
              data-testid="face-host"
              className="h-7 w-full text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-border/50 rounded-lg shadow-lg">
              <SelectItem value="127.0.0.1">
                {t("ai:server.face.hostLoopback")}
              </SelectItem>
              <SelectItem value="0.0.0.0">
                {t("ai:server.face.hostAll")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {hostWarning && (
        <p
          data-testid="face-host-warning"
          className="mt-1.5 text-xs leading-relaxed text-destructive"
        >
          {t("ai:server.face.hostWarning")}
        </p>
      )}

      <div className="mt-2 flex flex-col gap-1">
        <FieldLabel>{t("ai:server.face.token")}</FieldLabel>
        <div className="flex items-center gap-1">
          <span
            data-testid="face-token-value"
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
          >
            {status?.token
              ? maskToken(status.token)
              : t("ai:server.face.tokenEmpty")}
          </span>
          <IconTooltip label={t("ai:server.face.tokenCopy")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              aria-label={t("ai:server.face.tokenCopy")}
              data-testid="face-token-copy"
              disabled={!status?.token}
              onClick={() => void handleCopy()}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </IconTooltip>
          <IconTooltip label={t("ai:server.face.tokenRegenerate")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              aria-label={t("ai:server.face.tokenRegenerate")}
              data-testid="face-token-regenerate"
              disabled={busy}
              onClick={() =>
                void commit(
                  { regenerateToken: true },
                  "ai:server.face.tokenRegenerated",
                )
              }
            >
              <KeyRound className="h-3 w-3" />
            </Button>
          </IconTooltip>
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <FieldLabel>{t("ai:server.face.relayUrl")}</FieldLabel>
          {Boolean(status?.relayUrl) && (
            <span
              data-testid="face-relay-state"
              className={cn(
                "text-[10px]",
                status?.relayConnected
                  ? "text-primary"
                  : "text-muted-foreground",
              )}
            >
              {status?.relayConnected
                ? t("ai:server.face.relayConnected")
                : t("ai:server.face.relayDisconnected")}
            </span>
          )}
        </div>
        <Input
          data-testid="face-relay-url"
          className="h-7 text-xs"
          placeholder={t("ai:server.face.relayUrlPlaceholder")}
          disabled={busy}
          value={draft?.relayUrl ?? ""}
          onChange={(e) =>
            setDraft((prev) =>
              prev ? { ...prev, relayUrl: e.target.value } : prev,
            )
          }
          onBlur={() => commitIfChanged("relayUrl")}
        />
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <FieldLabel>{t("ai:server.face.relayToken")}</FieldLabel>
        <Input
          data-testid="face-relay-token"
          className="h-7 text-xs"
          type="password"
          disabled={busy}
          value={draft?.relayToken ?? ""}
          onChange={(e) =>
            setDraft((prev) =>
              prev ? { ...prev, relayToken: e.target.value } : prev,
            )
          }
          onBlur={() => commitIfChanged("relayToken")}
        />
        <p className="text-[10px] text-muted-foreground/80">
          {t("ai:server.face.relayPairHint")}
        </p>
      </div>

      {/* 端到端加密区（E2E-T2）：模式选择 + 指纹/公钥显示与复制（带外传递） */}
      <div className="mt-2 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <FieldLabel>{t("ai:server.face.e2e.mode")}</FieldLabel>
          {Boolean(status?.relayConnected) && (
            <span
              data-testid="face-e2e-active"
              className={cn(
                "text-[10px]",
                status?.e2eActive ? "text-primary" : "text-muted-foreground",
              )}
            >
              {status?.e2eActive
                ? t("ai:server.face.e2e.active")
                : t("ai:server.face.e2e.inactive")}
            </span>
          )}
        </div>
        <Select
          value={status?.e2eMode ?? "auto"}
          disabled={busy}
          onValueChange={(mode) =>
            void commit({ e2e: mode as FaceE2eMode }, "ai:server.face.saved")
          }
        >
          <SelectTrigger
            data-testid="face-e2e-mode"
            className="h-7 w-full text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border border-border/50 rounded-lg shadow-lg">
            <SelectItem value="auto">
              {t("ai:server.face.e2e.modeAuto")}
            </SelectItem>
            <SelectItem value="required">
              {t("ai:server.face.e2e.modeRequired")}
            </SelectItem>
            <SelectItem value="off">
              {t("ai:server.face.e2e.modeOff")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <FieldLabel>{t("ai:server.face.e2e.fingerprint")}</FieldLabel>
        <div className="flex items-center gap-1">
          <span
            data-testid="face-e2e-fingerprint"
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
          >
            {status?.e2eFingerprint || t("ai:server.face.e2e.keyEmpty")}
          </span>
          <IconTooltip label={t("ai:server.face.e2e.copyFingerprint")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              aria-label={t("ai:server.face.e2e.copyFingerprint")}
              data-testid="face-e2e-fingerprint-copy"
              disabled={!status?.e2eFingerprint}
              onClick={() =>
                void copyE2eValue(
                  status?.e2eFingerprint,
                  "ai:server.face.e2e.fingerprintCopied",
                )
              }
            >
              <Copy className="h-3 w-3" />
            </Button>
          </IconTooltip>
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <FieldLabel>{t("ai:server.face.e2e.publicKey")}</FieldLabel>
        <div className="flex items-center gap-1">
          <span
            data-testid="face-e2e-public-key"
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
          >
            {status?.e2ePublicKey
              ? maskToken(status.e2ePublicKey)
              : t("ai:server.face.e2e.keyEmpty")}
          </span>
          <IconTooltip label={t("ai:server.face.e2e.copyPublicKey")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              aria-label={t("ai:server.face.e2e.copyPublicKey")}
              data-testid="face-e2e-public-key-copy"
              disabled={!status?.e2ePublicKey}
              onClick={() =>
                void copyE2eValue(
                  status?.e2ePublicKey,
                  "ai:server.face.e2e.publicKeyCopied",
                )
              }
            >
              <Copy className="h-3 w-3" />
            </Button>
          </IconTooltip>
        </div>
        <p className="text-[10px] text-muted-foreground/80">
          {t("ai:server.face.e2e.hint")}
        </p>
      </div>
    </div>
  );
}
