/**
 * 工作流确认卡（confirm_form 工具块渲染，切片 B P1 / 切片 D4 类型控件）：
 * 执行态可编辑表单 + 确认/取消（确认以编辑后参数触发执行，经
 * agent:confirmRespond 决议主进程挂起的工具 execute）；落定态展示回执
 * （output），失败/被拒展示原因。sessionId 缺省（历史重放等场景）只读
 * 展示不可操作。字段带 type/enumValues（照抄 list_workflows 输入说明）
 * 时按类型出控件：number 数值框 / enum 下拉 / boolean 开关 / date 日期
 * ——enum 手输错别字从根上消掉；确认值 typed 上送（入口归一兜底）。
 */
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ClipboardCheck, Loader2, XCircle } from "lucide-react";

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
import { Switch } from "@/components/ui/switch";
import ChatApi from "../../api/chat.api";
import type {
  ConfirmFormField,
  ConfirmFormPanelItem,
} from "../lib/group-blocks";

function ConfirmFormCardBody({
  item,
  sessionId,
}: {
  item: ConfirmFormPanelItem;
  sessionId?: number;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [values, setValues] = useState<
    Record<string, string | number | boolean>
  >(() =>
    Object.fromEntries(
      item.fields.map((field) => [
        field.key,
        field.type === "boolean" ? field.value === "true" : field.value,
      ]),
    ),
  );
  const [submitting, setSubmitting] = useState(false);
  const [settled, setSettled] = useState<
    "confirmed" | "cancelled" | "failed" | null
  >(null);

  const running = item.state === "running";
  const interactive = running && sessionId !== undefined && settled === null;

  const respond = async (
    decision:
      | { action: "confirm"; values: Record<string, string | number | boolean> }
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

  /** 单字段控件（按类型分流；无 type 按 string 文本框——渐进期兜底） */
  const fieldControl = (field: ConfirmFormField) => {
    const value = values[field.key] ?? "";
    const setValue = (next: string | number | boolean) =>
      setValues((prev) => ({ ...prev, [field.key]: next }));
    if (field.type === "enum" && field.enumValues?.length) {
      return (
        <Select
          value={String(value)}
          onValueChange={setValue}
          disabled={!interactive}
        >
          <SelectTrigger
            id={`cf-${item.toolCallId}-${field.key}`}
            className="h-8 w-full text-sm"
            disabled={!interactive}
          >
            <SelectValue placeholder={t("chat:confirmForm.selectValue")} />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            {field.enumValues.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    if (field.type === "boolean") {
      const checked = value === true || value === "true";
      return (
        <div className="flex items-center gap-2 py-1">
          <Switch
            id={`cf-${item.toolCallId}-${field.key}`}
            checked={checked}
            disabled={!interactive}
            onCheckedChange={setValue}
          />
          <span className="text-xs text-muted-foreground">
            {checked ? t("common:enabled") : t("common:disabled")}
          </span>
        </div>
      );
    }
    const inputType =
      field.type === "number"
        ? "number"
        : field.type === "date"
          ? "date"
          : "text";
    return (
      <Input
        id={`cf-${item.toolCallId}-${field.key}`}
        type={inputType}
        value={String(value)}
        disabled={!interactive}
        onChange={(e) =>
          setValue(
            field.type === "number"
              ? e.target.value === ""
                ? ""
                : Number(e.target.value)
              : e.target.value,
          )
        }
        className="h-8 text-sm"
      />
    );
  };

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
              {fieldControl(field)}
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
