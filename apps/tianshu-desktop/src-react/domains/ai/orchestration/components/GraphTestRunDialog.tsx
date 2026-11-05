// src-react/domains/ai/orchestration/components/GraphTestRunDialog.tsx
/** 试运行弹窗(spec §5 手动触发)：inputSchema 变量表单 + workspace
 * 下拉(共享 ["workspaces"] 缓存)→ GraphApi.runTest 触发即返回；编辑器传
 * 当前草稿 draftJson（试改后的图），列表页传库内已存 graphJson；错误映射
 * GRAPH_ALREADY_RUNNING/WORKSPACE_NOT_FOUND/兜底 failed。
 * typed 输入（切片 D）：fields（parseInputSchema 归一）按类型分流控件——
 * number 用 type=number、enum 用 Select、boolean 用 Switch、date 用日期
 * 控件（均项目既有组件零新依赖），default 预填；required 缺值禁跑（入口
 * 侧 runTest 归一双保险）。legacy variables（纯名称）按 string 字段兜底。
 * json（2026-11-05）：多行文本域编辑紧凑 JSON 文本，required 判满须可
 * parse 为容器（标量/非法禁跑），提交 parse 为容器原生值上送。
 * onStarted（触发成功即切历史）：runTest 成功后随关弹窗回调——列表页
 * 据此直接弹运行历史（running 徽标 + 收尾事件自动刷新，供结果查看）；
 * 编辑器调用点不传，行为不变 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Play } from "lucide-react";
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
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import { GraphApi } from "../api/orchestration.api";
import {
  parseInputSchema,
  type GraphInputValue,
  type NormalizedInputField,
} from "../api/graph.schema";

/** default 预填（date 的 "today" 魔法值在此展开为当天，入口归一兜底同值）；
 *  json 容器 default 预填为紧凑 JSON 文本（表单态文本、提交时 parse） */
function initialFieldValue(field: NormalizedInputField): GraphInputValue {
  if (field.default !== undefined) {
    if (field.type === "json") {
      return field.default !== null && typeof field.default === "object"
        ? JSON.stringify(field.default)
        : "";
    }
    return field.default === "today" && field.type === "date"
      ? new Date().toISOString().slice(0, 10)
      : field.default;
  }
  return field.type === "boolean" ? false : "";
}

/** json 文本 parse 为容器（fieldFilled 判满与提交 parse 同源）；标量
 * JSON 文本（number/boolean/null）与非法文本均返回 null——与入口归一
 * 的容器互斥语义一致 */
function parseJsonContainer(
  text: string,
): Record<string, unknown> | unknown[] | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown> | unknown[])
      : null;
  } catch {
    return null;
  }
}

/** 字段是否有值（required 判满用）：boolean 恒有值；number 接受原生数值
 * 或可载数字串；json 须为可 parse 为容器的文本；其余非空串即可 */
function fieldFilled(field: NormalizedInputField, value: GraphInputValue) {
  if (field.type === "boolean") {
    return true;
  }
  if (field.type === "number") {
    return (
      typeof value === "number" ||
      (typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value)))
    );
  }
  if (field.type === "json") {
    return typeof value === "string" && parseJsonContainer(value) !== null;
  }
  return String(value).trim() !== "";
}

export default function GraphTestRunDialog({
  graphId,
  draftJson,
  variables,
  fields,
  open,
  onOpenChange,
  onStarted,
}: {
  graphId: number;
  draftJson: string;
  /** legacy 纯名称清单（按 string 字段兜底；fields 缺席时生效） */
  variables?: string[];
  /** typed 字段清单（parseInputSchema 归一产物；与 variables 二选一） */
  fields?: NormalizedInputField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 触发成功回调（列表页切运行历史弹窗用；缺席不影响既有行为） */
  onStarted?: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });
  const resolved: NormalizedInputField[] = useMemo(
    () =>
      fields ??
      parseInputSchema(
        Object.fromEntries((variables ?? []).map((key) => [key, "string"])),
      ),
    [fields, variables],
  );
  const [values, setValues] = useState<Record<string, GraphInputValue>>({});
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  // 每次打开重置表单（default 预填）；workspace 下拉缺省选第一个
  useEffect(() => {
    if (open) {
      setValues(
        Object.fromEntries(resolved.map((f) => [f.key, initialFieldValue(f)])),
      );
      setWorkspaceId(null);
    }
  }, [open, resolved]);
  useEffect(() => {
    if (workspaceId === null && workspaces.length > 0) {
      setWorkspaceId(workspaces[0].id);
    }
  }, [workspaces, workspaceId]);

  const allFilled =
    workspaceId !== null &&
    resolved.every((f) => !f.required || fieldFilled(f, values[f.key] ?? ""));

  async function handleRun() {
    if (!allFilled || workspaceId === null) {
      return;
    }
    // required 有值的字段上行（optional 空串不上送——入口 default 兜底）；
    // json 表单文本 parse 为容器原生值上送（fieldFilled 已保证可 parse，
    // parse 失败透传原文由入口归一结构化回喂——双保险）
    const inputs = Object.fromEntries(
      resolved
        .filter((f) => fieldFilled(f, values[f.key] ?? ""))
        .map((f) => {
          if (f.type === "json") {
            const text = String(values[f.key] ?? "");
            const parsed = parseJsonContainer(text);
            return [f.key, parsed ?? text];
          }
          return [f.key, values[f.key]];
        }),
    );
    setRunning(true);
    try {
      await GraphApi.runTest(graphId, inputs, workspaceId, draftJson);
      toast.success(t("chat:orchestration.testRun.started"));
      onOpenChange(false);
      onStarted?.();
      await queryClient.invalidateQueries({ queryKey: ["orchestration"] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("GRAPH_ALREADY_RUNNING")) {
        toast.error(t("chat:orchestration.testRun.alreadyRunning"));
      } else if (message.includes("WORKSPACE_NOT_FOUND")) {
        toast.error(t("chat:orchestration.testRun.workspaceMissing"));
      } else {
        toast.error(t("chat:orchestration.testRun.failed", { message }));
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>{t("chat:orchestration.testRun.title")}</DialogTitle>
        </DialogHeader>
        {resolved.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("chat:orchestration.testRun.noVariables")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              {t("chat:orchestration.testRun.variables")}
            </p>
            {resolved.map((field) => (
              <div key={field.key} className="flex flex-col gap-1">
                <Label className="text-xs">
                  {field.key}
                  {field.required ? " *" : ""}
                  {field.description ? `（${field.description}）` : ""}
                </Label>
                {field.type === "json" ? (
                  <div className="flex flex-col gap-1">
                    <Textarea
                      className="min-h-20 font-mono text-xs"
                      placeholder='{"key": "value"}'
                      value={String(values[field.key] ?? "")}
                      onChange={(e) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: e.target.value,
                        }))
                      }
                    />
                    {String(values[field.key] ?? "").trim() !== "" &&
                      parseJsonContainer(String(values[field.key])) ===
                        null && (
                        <span className="text-xs text-destructive">
                          {t("chat:orchestration.testRun.invalidJson")}
                        </span>
                      )}
                  </div>
                ) : field.type === "enum" ? (
                  <Select
                    value={String(values[field.key] ?? "")}
                    onValueChange={(value) =>
                      setValues((current) => ({
                        ...current,
                        [field.key]: value,
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue
                        placeholder={t(
                          "chat:orchestration.testRun.selectValue",
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent className="rounded-lg border border-border/50 shadow-lg">
                      {(field.enumValues ?? []).map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : field.type === "boolean" ? (
                  <div className="flex items-center gap-2 py-1">
                    <Switch
                      checked={values[field.key] === true}
                      onCheckedChange={(checked) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: checked,
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">
                      {values[field.key] === true
                        ? t("common:enabled")
                        : t("common:disabled")}
                    </span>
                  </div>
                ) : (
                  <Input
                    className="h-8"
                    type={
                      field.type === "number"
                        ? "number"
                        : field.type === "date"
                          ? "date"
                          : "text"
                    }
                    value={String(values[field.key] ?? "")}
                    onChange={(e) =>
                      setValues((current) => ({
                        ...current,
                        [field.key]:
                          field.type === "number"
                            ? e.target.value === ""
                              ? ""
                              : Number(e.target.value)
                            : e.target.value,
                      }))
                    }
                  />
                )}
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label className="text-xs">
            {t("chat:orchestration.testRun.workspace")}
          </Label>
          <Select
            value={workspaceId === null ? "" : String(workspaceId)}
            onValueChange={(value) => setWorkspaceId(Number(value))}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue
                placeholder={t("chat:orchestration.testRun.selectWorkspace")}
              />
            </SelectTrigger>
            <SelectContent className="rounded-lg border border-border/50 shadow-lg">
              {workspaces.map((ws) => (
                <SelectItem key={ws.id} value={String(ws.id)}>
                  {ws.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            className="h-7 px-3"
            disabled={!allFilled || running}
            onClick={() => void handleRun()}
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {t("chat:orchestration.testRun.button")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
