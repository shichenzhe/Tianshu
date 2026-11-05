/**
 * TOFU 指纹核对卡（P0-1，design/security §6 P0-1 + multi-host §5 项5）：
 * relay 连接的指纹信任决策面——把「静默信任首连」升级为「可审计的信任
 * 决策」（Signal safety number 人工核对仪式同构）。
 * - 常显当前指纹：协商值（e2eFingerprint——当前连接实际核对到的被控端
 *   指纹）优先，回落钉扎值（fingerprint）；确认时间（confirmedAt）随附
 * - pending-confirm（TOFU 首连）：mitm-suspect 同款 destructive 警示 +
 *   连接名 + 16hex 指纹 + 「核对后确认」动作（通信可用——会话已加密，
 *   但指纹未经带外核对，不视为已信任）
 * - mitm-suspect：期望 vs 实际指纹对照 + 重配指引（不提供「确认实际值」
 *   动作——那会为中间人开门）
 * - direct 不渲染（信任模型内无指纹面）
 * 视觉语言复用 E2E 徽标/mitm 警示：destructive 状态色、border-border/50、
 * font-mono 指纹行（LocalFaceCard 同款）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Loader2, ShieldAlert, ShieldCheck, ShieldQuestionMark } from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import ServerApi, { type ConnectionView } from "../api/server.api";
import { CONNECTIONS_QUERY_KEY } from "./ConnectionDialog";

/** 指纹行（font-mono + 复制——LocalFaceCard 指纹显示同款视觉） */
function FingerprintValue({
  value,
  testId,
}: {
  value: string;
  testId: string;
}) {
  const { t } = useTranslation(["ai", "common"]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("ai:server.fingerprint.copied"));
    } catch {
      toast.error(t("ai:server.fingerprint.copyFailed"));
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        data-testid={testId}
        className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
      >
        {value}
      </span>
      <IconTooltip label={t("ai:server.fingerprint.copy")}>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          aria-label={t("ai:server.fingerprint.copy")}
          onClick={() => void copy()}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </IconTooltip>
    </div>
  );
}

export interface E2eFingerprintCardProps {
  connection: ConnectionView;
}

export default function E2eFingerprintCard({
  connection,
}: E2eFingerprintCardProps) {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  if (connection.mode !== "relay") return null;

  const pending = connection.e2e === "pending-confirm";
  const mitm = connection.e2e === "mitm-suspect";
  // 常显当前指纹：协商值（本次连接实际核对到的）优先，回落钉扎值
  const currentFingerprint = connection.e2eFingerprint ?? connection.fingerprint;

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await ServerApi.confirmFingerprint(connection.id);
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
      toast.success(t("ai:server.fingerprint.confirmOk"));
    } catch (e) {
      toast.error(
        t("ai:server.fingerprint.confirmError", {
          message: String(e instanceof Error ? e.message : e),
        }),
      );
    } finally {
      setConfirming(false);
    }
  };

  const confirmedAtText = connection.confirmedAt
    ? t("ai:server.fingerprint.confirmedAt", {
        time: new Date(connection.confirmedAt).toLocaleString(),
      })
    : null;

  return (
    <div
      data-testid="fingerprint-card"
      className={cn(
        "rounded-lg border p-3",
        pending || mitm
          ? "border-destructive/40 bg-destructive/5"
          : "border-border/50 bg-muted/30",
      )}
    >
      {pending ? (
        <div className="flex flex-col gap-2" data-testid="fingerprint-card-pending">
          <div className="flex items-start gap-1.5">
            <ShieldQuestionMark className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-destructive">
                {t("ai:server.fingerprint.pendingTitle")}
              </p>
              <p className="text-xs text-foreground">
                {t("ai:server.fingerprint.pendingName", {
                  name: connection.name,
                })}
              </p>
            </div>
          </div>
          <FingerprintValue
            value={connection.e2eFingerprint ?? ""}
            testId="fingerprint-current"
          />
          <p className="text-[10px] leading-relaxed text-muted-foreground/80">
            {t("ai:server.fingerprint.pendingHint")}
          </p>
          <Button
            size="sm"
            data-testid="fingerprint-confirm"
            className="h-7 self-start px-2 text-xs"
            disabled={confirming || !connection.e2eFingerprint}
            onClick={() => void handleConfirm()}
          >
            {confirming ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="mr-1 h-3.5 w-3.5" />
            )}
            {t("ai:server.fingerprint.confirm")}
          </Button>
        </div>
      ) : mitm ? (
        <div className="flex flex-col gap-2" data-testid="fingerprint-card-mitm">
          <div className="flex items-start gap-1.5">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="text-xs font-medium text-destructive">
              {t("ai:server.fingerprint.mitmTitle")}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground">
              {t("ai:server.fingerprint.expected")}
            </span>
            <FingerprintValue
              value={connection.fingerprint ?? ""}
              testId="fingerprint-expected"
            />
            <span className="text-[10px] text-muted-foreground">
              {t("ai:server.fingerprint.actual")}
            </span>
            <FingerprintValue
              value={connection.e2eFingerprint ?? ""}
              testId="fingerprint-actual"
            />
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground/80">
            {t("ai:server.fingerprint.mitmHint")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5" data-testid="fingerprint-card-info">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              {t("ai:server.fingerprint.title")}
            </span>
            {confirmedAtText && (
              <span
                data-testid="fingerprint-confirmed-at"
                className="truncate text-[10px] text-muted-foreground"
                title={confirmedAtText}
              >
                {confirmedAtText}
              </span>
            )}
          </div>
          {currentFingerprint ? (
            <FingerprintValue
              value={currentFingerprint}
              testId="fingerprint-current"
            />
          ) : (
            <p
              data-testid="fingerprint-current"
              className="truncate text-xs text-muted-foreground"
            >
              {t("ai:server.fingerprint.notNegotiated")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
