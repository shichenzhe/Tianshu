// src-react/domains/ai/orchestration/components/GraphTestRunDialog.tsx
/** 试运行弹窗(spec §5 手动触发)：inputSchema 变量必填表单 + workspace
 * 下拉(共享 ["workspaces"] 缓存)→ GraphApi.runTest 触发即返回；编辑器传
 * 当前草稿 draftJson（试改后的图），列表页传库内已存 graphJson；错误映射
 * GRAPH_ALREADY_RUNNING/WORKSPACE_NOT_FOUND/兜底 failed。
 * onStarted（触发成功即切历史）：runTest 成功后随关弹窗回调——列表页
 * 据此直接弹运行历史（running 徽标 + 收尾事件自动刷新，供结果查看）；
 * 编辑器调用点不传，行为不变 */
import { useEffect, useState } from "react";
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
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import { GraphApi } from "../api/orchestration.api";

export default function GraphTestRunDialog({
  graphId,
  draftJson,
  variables,
  open,
  onOpenChange,
  onStarted,
}: {
  graphId: number;
  draftJson: string;
  variables: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 触发成功回调（列表页切运行历史弹窗用；缺席不影响既有行为） */
  onStarted?: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  // 每次打开重置表单;workspace 下拉缺省选第一个
  useEffect(() => {
    if (open) {
      setValues({});
      setWorkspaceId(null);
    }
  }, [open]);
  useEffect(() => {
    if (workspaceId === null && workspaces.length > 0) {
      setWorkspaceId(workspaces[0].id);
    }
  }, [workspaces, workspaceId]);

  const allFilled =
    workspaceId !== null &&
    variables.every((key) => (values[key] ?? "").trim() !== "");

  async function handleRun() {
    if (!allFilled || workspaceId === null) {
      return;
    }
    const inputs = Object.fromEntries(
      variables.map((key) => [key, (values[key] ?? "").trim()]),
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
        {variables.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("chat:orchestration.testRun.noVariables")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              {t("chat:orchestration.testRun.variables")}
            </p>
            {variables.map((key) => (
              <div key={key} className="flex flex-col gap-1">
                <Label className="text-xs">{key}</Label>
                <Input
                  className="h-8"
                  value={values[key] ?? ""}
                  onChange={(e) =>
                    setValues((current) => ({
                      ...current,
                      [key]: e.target.value,
                    }))
                  }
                />
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
