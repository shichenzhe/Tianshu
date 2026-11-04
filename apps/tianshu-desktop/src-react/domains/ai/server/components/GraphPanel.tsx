/**
 * 编排图遥控面板（GA-T8）：无头端 graph/query 列表（名称/节点数/run 状态
 * 徽标）+ 触发试运行（graph/run 202 受理回 {runId} → 行内转运行中）+
 * 中止（graph/runAbort 携 runId）。
 * run 状态为客户端投影：九端点无 run 查询面——初值 idle，受理即 running，
 * graph.run.updated 事件流式更新（payload.graphId 定位行；触发不在途的
 * 图收到的事件同样生效——重开面板/他人触发均可追上状态流）；server.connected
 * 重连复位 idle（断流期间终局事件已失，无从补查，宁可复位不卡运行中）。
 * 不做编辑器——图定义的创建与编辑在无头端本地完成，控制端只遥控。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Copy,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Webhook,
  Workflow,
} from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import GraphApi, {
  onRemoteGraphEvent,
  type GraphRunState,
  type RemoteGraphRecord,
  type RemoteWebhookConfig,
  type RemoteWebhookManage,
} from "../api/graph.api";
import { describeError } from "../lib/describe-error";

const GRAPH_PAGE_SIZE = 50;

export const GRAPHS_QUERY_KEY = (connId: string) =>
  ["server", "graphs", connId] as const;

/** run 展示态（客户端投影，见头注释） */
interface GraphRunEntry {
  runId: number;
  state: GraphRunState;
}

/** 状态徽标形态：运行中主题色实底、成功主题色描边、失败/中止破坏色 */
const STATE_BADGE: Record<GraphRunState, string> = {
  idle: "",
  queued: "",
  running: "",
  succeeded: "border-primary/30 text-primary",
  failed: "",
  aborted: "",
};

function stateBadgeVariant(
  state: GraphRunState,
): "secondary" | "default" | "destructive" | "outline" {
  if (state === "running") return "default";
  if (state === "succeeded") return "outline";
  if (state === "failed" || state === "aborted") return "destructive";
  return "secondary";
}

export interface GraphPanelProps {
  connId: string;
}

/**
 * webhook 配置 Popover（WH 消费端批）：打开惰性拉 status——未启出 enable
 * 表单（四配置全可缺省）；已启出 URL 回显（相对路径+复制，控制端自行拼
 * 主机地址——WH 批适配点 6）与关闭/重开换 token（服务端语义：重开旧
 * token 立即失效，按钮旁明示防误触断掉外部集成）。
 */
function WebhookPopover({
  graph,
  connId,
}: {
  graph: RemoteGraphRecord;
  connId: string;
}) {
  const { t } = useTranslation(["ai", "common"]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RemoteWebhookManage | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setCopied] = useState(false);
  // enable 表单态（缺省值与服务端口径一致）
  const [template, setTemplate] = useState("");
  const [statusCode, setStatusCode] = useState("200");
  const [asyncMode, setAsyncMode] = useState(false);
  const [fullAccess, setFullAccess] = useState(false);

  useEffect(() => {
    if (!open || status !== null) return;
    let cancelled = false;
    setLoading(true);
    GraphApi.webhookStatus(graph.id, connId)
      .then((res) => {
        if (!cancelled) setStatus(res);
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(
            t("ai:server.graph.webhook.statusFailed", {
              message: describeError(e),
            }),
          );
          setOpen(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // status 拉取只在首次打开（后续操作就地更新本地态；依赖留空有意）
  }, [open]);

  const submitEnable = async (config?: RemoteWebhookConfig) => {
    setBusy(true);
    try {
      const res = await GraphApi.webhookEnable(graph.id, connId, {
        responseTemplate: template.trim() === "" ? undefined : template,
        statusCode: statusCode.trim() === "" ? undefined : Number(statusCode),
        async: asyncMode,
        fullAccess,
        ...config,
      });
      setStatus(res);
    } catch (e) {
      toast.error(
        t("ai:server.graph.webhook.enableFailed", {
          message: describeError(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    try {
      setStatus(await GraphApi.webhookDisable(graph.id, connId));
    } catch (e) {
      toast.error(
        t("ai:server.graph.webhook.disableFailed", {
          message: describeError(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!status?.url) return;
    try {
      await navigator.clipboard.writeText(status.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("common:copyFailed"));
    }
  };

  const enabled = status?.enabled === true;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <IconTooltip label={t("ai:server.graph.webhook.title")}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            data-testid={`graph-webhook-${graph.id}`}
            className={`h-7 w-7 ${enabled ? "text-primary" : "text-muted-foreground"}`}
            aria-label={t("ai:server.graph.webhook.title")}
          >
            <Webhook className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent
        align="end"
        data-testid={`graph-webhook-popover-${graph.id}`}
        className="w-80 rounded-lg border border-border/50 shadow-lg"
      >
        {loading || status === null ? (
          <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common:loading")}
          </div>
        ) : enabled ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("ai:server.graph.webhook.url")}
              </Label>
              <div className="flex items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded bg-primary-subtle px-2 py-1 text-xs text-foreground">
                  {status.url}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 shrink-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  aria-label={t("ai:server.graph.webhook.copy")}
                  onClick={() => void handleCopy()}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground/80">
                {t("ai:server.graph.webhook.urlHint")}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-1.5 text-xs text-muted-foreground">
              <span>
                {t("ai:server.graph.webhook.statusCode")}:{" "}
                {status.statusCode ?? 200}
              </span>
              <span>
                {t("ai:server.graph.webhook.async")}:{" "}
                {status.async ? t("common:yes") : t("common:no")}
              </span>
              <span className="col-span-2">
                {t("ai:server.graph.webhook.fullAccess")}:{" "}
                {status.fullAccess
                  ? t("ai:server.graph.webhook.fullAccessOn")
                  : t("ai:server.graph.webhook.fullAccessOff")}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid={`graph-webhook-rotate-${graph.id}`}
                disabled={busy}
                className="h-7 px-2 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                onClick={() =>
                  void submitEnable({
                    responseTemplate:
                      status.responseTemplate === ""
                        ? undefined
                        : status.responseTemplate,
                    statusCode: status.statusCode,
                    async: status.async,
                    fullAccess: status.fullAccess,
                  })
                }
              >
                {t("ai:server.graph.webhook.rotate")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-testid={`graph-webhook-disable-${graph.id}`}
                disabled={busy}
                className="h-7 px-2 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                onClick={() => void handleDisable()}
              >
                {t("ai:server.graph.webhook.disableAction")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground/80">
              {t("ai:server.graph.webhook.rotateHint")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs" htmlFor={`wh-template-${graph.id}`}>
                {t("ai:server.graph.webhook.template")}
              </Label>
              <Input
                id={`wh-template-${graph.id}`}
                data-testid={`graph-webhook-template-${graph.id}`}
                value={template}
                placeholder="{{nodes.x.output}} / {{input.y}}"
                onChange={(e) => setTemplate(e.target.value)}
                className="h-7 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs" htmlFor={`wh-status-${graph.id}`}>
                {t("ai:server.graph.webhook.statusCode")}
              </Label>
              <Input
                id={`wh-status-${graph.id}`}
                data-testid={`graph-webhook-statuscode-${graph.id}`}
                value={statusCode}
                inputMode="numeric"
                onChange={(e) => setStatusCode(e.target.value)}
                className="h-7 w-20 text-xs"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <Label className="text-xs">
                  {t("ai:server.graph.webhook.async")}
                </Label>
                <span className="text-xs text-muted-foreground/80">
                  {t("ai:server.graph.webhook.asyncHint")}
                </span>
              </div>
              <Switch
                checked={asyncMode}
                onCheckedChange={setAsyncMode}
                aria-label={t("ai:server.graph.webhook.async")}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <Label className="text-xs">
                  {t("ai:server.graph.webhook.fullAccess")}
                </Label>
                <span className="text-xs text-muted-foreground/80">
                  {t("ai:server.graph.webhook.fullAccessHint")}
                </span>
              </div>
              <Switch
                checked={fullAccess}
                onCheckedChange={setFullAccess}
                aria-label={t("ai:server.graph.webhook.fullAccess")}
              />
            </div>
            <Button
              size="sm"
              data-testid={`graph-webhook-enable-${graph.id}`}
              disabled={busy}
              className="h-7 px-2 text-xs"
              onClick={() => void submitEnable()}
            >
              {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {t("ai:server.graph.webhook.enableAction")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default function GraphPanel({ connId }: GraphPanelProps) {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const [runs, setRuns] = useState<Record<number, GraphRunEntry>>({});

  const graphsQuery = useQuery({
    queryKey: GRAPHS_QUERY_KEY(connId),
    queryFn: () =>
      GraphApi.graphList({ page: 1, pageSize: GRAPH_PAGE_SIZE }, connId),
    retry: false,
  });
  const graphs = graphsQuery.data?.records ?? [];

  // 连接级合并事件（server:event:<connId>）：graph.run.updated 行内状态流
  // + server.connected 重连复位/重拉（spec §13 项 2 同款刷新语义）；
  // automation.changed 是任务级信号——对本面板仅作为无关事件忽略（run 投影
  // 不得被它抹掉：终态徽标保持、运行中态不翻转——GA-T8 审查修 1）
  useEffect(() => {
    const off = onRemoteGraphEvent(connId, (event) => {
      if (event.type === "graph.run.updated") {
        const { graphId, runId, state } = event.payload;
        setRuns((prev) => ({ ...prev, [graphId]: { runId, state } }));
        return;
      }
      if (event.type !== "server.connected") return;
      setRuns({});
      void queryClient.invalidateQueries({
        queryKey: GRAPHS_QUERY_KEY(connId),
      });
    });
    return off;
  }, [connId, queryClient]);

  const handleRun = async (graph: RemoteGraphRecord) => {
    try {
      const { runId } = await GraphApi.graphRun(graph.id, connId);
      setRuns((prev) => ({ ...prev, [graph.id]: { runId, state: "running" } }));
    } catch (e) {
      toast.error(
        t("ai:server.graph.runFailed", { message: describeError(e) }),
      );
    }
  };

  const handleAbort = async (graph: RemoteGraphRecord) => {
    const entry = runs[graph.id];
    if (!entry) return;
    try {
      await GraphApi.graphRunAbort(entry.runId, connId);
    } catch (e) {
      toast.error(
        t("ai:server.graph.abortFailed", { message: describeError(e) }),
      );
    }
  };

  return (
    <section
      data-testid="graph-panel"
      className="rounded-lg border border-border/50"
    >
      <div className="flex h-10 items-center justify-between border-b border-border/50 px-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Workflow className="h-4 w-4 text-primary" />
          {t("ai:server.graph.title")}
        </span>
        <IconTooltip label={t("ai:server.graph.refresh")}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("ai:server.graph.refresh")}
            onClick={() => void graphsQuery.refetch()}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${graphsQuery.isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </IconTooltip>
      </div>
      <div className="p-2">
        {graphsQuery.isPending ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common:loading")}
          </div>
        ) : graphsQuery.isError ? (
          <div className="flex flex-col items-center gap-2 py-6">
            <p className="text-sm text-destructive">
              {t("ai:server.graph.loadFailed")}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              onClick={() => void graphsQuery.refetch()}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {t("common:reset")}
            </Button>
          </div>
        ) : graphs.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t("ai:server.graph.empty")}
            </p>
            <p className="text-xs text-muted-foreground/80">
              {t("ai:server.graph.emptyTip")}
            </p>
          </div>
        ) : (
          graphs.map((graph) => {
            const entry = runs[graph.id];
            const state: GraphRunState = entry?.state ?? "idle";
            const inFlight = state === "running" || state === "queued";
            return (
              <div
                key={graph.id}
                data-testid={`graph-row-${graph.id}`}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-2 text-sm text-foreground"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{graph.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t("ai:server.graph.nodes", { count: graph.nodeCount })}
                    {entry && (
                      <span className="ml-1.5 select-none">#{entry.runId}</span>
                    )}
                  </p>
                </div>
                <Badge
                  data-testid={`graph-state-${graph.id}`}
                  variant={stateBadgeVariant(state)}
                  className={STATE_BADGE[state]}
                >
                  {t(`ai:server.graph.runState.${state}`)}
                </Badge>
                <WebhookPopover graph={graph} connId={connId} />
                {inFlight ? (
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`graph-abort-${graph.id}`}
                    className="h-7 px-2 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                    onClick={() => void handleAbort(graph)}
                  >
                    <Square className="mr-1 h-3 w-3" />
                    {t("ai:server.graph.abort")}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`graph-run-${graph.id}`}
                    className="h-7 px-2 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                    onClick={() => void handleRun(graph)}
                  >
                    <Play className="mr-1 h-3 w-3" />
                    {t("ai:server.graph.run")}
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
