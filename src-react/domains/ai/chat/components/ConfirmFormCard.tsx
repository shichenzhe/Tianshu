/**
 * 工作流确认卡（confirm_form 工具块渲染，切片 B 2026-10-29）：执行态
 * 可编辑表单 + 确认/取消（确认以编辑后参数触发执行，经 agent:confirmRespond
 * 决议主进程挂起的工具 execute）；落定态展示回执（output），失败/被拒
 * 展示原因。sessionId 缺省（历史重放等场景）只读展示不可操作。
 */
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ClipboardCheck, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ChatApi from "../../api/chat.api";
import type { ConfirmFormPanelItem } from "../lib/group-blocks";

function ConfirmFormCardBody({
  item,
  sessionId,
}: {
  item: ConfirmFormPanelItem;
  sessionId?: number;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(item.fields.map((field) => [field.key, field.value])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [settled, setSettled] = useState<
    "confirmed" | "cancelled" | "failed" | null
  >(null);

  const running = item.state === "running";
  const interactive = running && sessionId !== undefined && settled === null;

  const respond = async (
    decision:
      | { action: "confirm"; values: Record<string, string> }
      | { action: "cancel" },
    outcome: "confirmed" | "cancelled" | "failed",
  ) => {
    if (!interactive || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await ChatApi.confirmFormRespond(sessionId!, decision);
      setSettled(outcome === "failed" ? "failed" : outcome);
    } catch {
      // IPC 失败（会话已换/进程重启等）：落定失败态，提示走消息流确认
      setSettled("failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirm = () =>
    respond({ action: "confirm", values }, "confirmed");
  const handleCancel = () => respond({ action: "cancel" }, "cancelled");

  // 落定态：块终态（done/error/denied）或本卡已决议——统一展示回执与状态
  const done = !running;
  const cancelled =
    settled === "cancelled" ||
    (done && (item.output ?? "").includes("用户已取消"));
  const failed = settled === "failed" || item.state === "error";

  return (
    <div
      data-testid="confirm-form-card"
      className="my-2 overflow-hidden rounded-lg border border-border/50"
    >
      {/* 标题栏：确认图标 + 标题 + 目标工作流名 */}
      <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <ClipboardCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="shrink-0">
          {item.title || t("chat:confirmForm.defaultTitle")}
        </span>
        <span className="shrink-0">·</span>
        <span className="truncate font-medium text-foreground/80">
          {item.workflowName || `#${item.workflowId}`}
        </span>
      </div>

      {/* 参数表单（落定态只读展示终值） */}
      <div className="flex flex-col divide-y divide-border/50">
        {item.fields.length === 0 ? (
          <p className="px-3 py-3 text-center text-xs text-muted-foreground">
            {t("chat:confirmForm.empty")}
          </p>
        ) : (
          item.fields.map((field) => (
            <div key={field.key} className="grid gap-1 px-3 py-2">
              <Label
                htmlFor={`cf-${item.toolCallId}-${field.key}`}
                className="text-xs font-normal text-muted-foreground"
              >
                {field.label}
                {field.hint ? (
                  <span className="ml-1 text-muted-foreground/70">
                    {field.hint}
                  </span>
                ) : null}
              </Label>
              <Input
                id={`cf-${item.toolCallId}-${field.key}`}
                value={values[field.key] ?? ""}
                disabled={!interactive}
                onChange={(e) =>
                  setValues((prev) => ({
                    ...prev,
                    [field.key]: e.target.value,
                  }))
                }
                className="h-8 text-sm"
              />
            </div>
          ))
        )}
      </div>

      {/* 操作行（执行态）或回执行（落定态） */}
      {interactive ? (
        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => void handleCancel()}
            className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            {t("common:cancel")}
          </Button>
          <Button
            size="sm"
            disabled={submitting || item.fields.length === 0}
            onClick={() => void handleConfirm()}
            className="gap-1.5"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t("chat:confirmForm.confirm")}
          </Button>
        </div>
      ) : (
        <div className="flex items-start gap-1.5 border-t border-border/50 px-3 py-2 text-xs">
          {failed ? (
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          ) : (
            <CheckCircle2
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                cancelled ? "text-muted-foreground" : "text-primary"
              }`}
            />
          )}
          <span className="min-w-0 break-words text-muted-foreground">
            {failed
              ? (item.output ?? t("chat:confirmForm.error"))
              : cancelled
                ? t("chat:confirmForm.cancelled")
                : (item.output ?? t("chat:confirmForm.doneFallback"))}
          </span>
        </div>
      )}
    </div>
  );
}

const ConfirmFormCard = memo(ConfirmFormCardBody);
export default ConfirmFormCard;
