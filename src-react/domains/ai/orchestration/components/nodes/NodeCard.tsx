// src-react/domains/ai/orchestration/components/nodes/NodeCard.tsx
/**
 * 画布节点卡片（spec §2）：类型徽标（AI=Sparkles 语义色/Code=Terminal）+
 * 入口 Badge + 名称 + 摘要（按 kind：模型名/方法+URL/语言/路径/标题/
 * 子图号/检索词）与 branch 选项 chips。handles：target 左侧单个；
 * source 右侧——branch 节点按 branchOptions 逐项一个 handle（id
 * `branch:<value>`）沿卡片高度均分并旁标小标签，普通节点单 `plain`。
 */
import { useQuery } from "@tanstack/react-query";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Bell,
  Braces,
  Database,
  DatabaseZap,
  FileSpreadsheet,
  GitMerge,
  FileText,
  Compass,
  Play,
  Table,
  Variable,
  Sigma,
  Mail,
  GitBranch,
  ImageIcon,
  FilePen,
  Hourglass,
  ScanText,
  Globe,
  Library,
  Repeat,
  Sparkles,
  Terminal,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import ModelApi, { modelDisplayName } from "@/domains/ai/api/model.api";
import ProviderApi, {
  type ProviderRecord,
} from "@/domains/ai/api/provider.api";
import type { CanvasNode } from "../../lib/graph-canvas-model";

export type CardNode = Node<{ canvas: CanvasNode }, "card">;

export default function NodeCard({ data, selected }: NodeProps<CardNode>) {
  const { t } = useTranslation(["chat"]);
  const node = data.canvas;
  const { data: models = [] } = useQuery({
    queryKey: ["models", "all"],
    queryFn: () => ModelApi.listAll(),
  });
  const { data: providers = [] } = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const model = models.find((m) => m.id === node.modelId);
  const branches = node.branchOptions ?? [];

  return (
    // relative 锚定 handle 定位（Handle/分支包装层均 absolute）；
    // start 入口视觉：emerald 描边与普通节点区分（选中态优先主题色）
    <div
      className={`relative w-[220px] rounded-lg border bg-card p-2 shadow-sm ${
        selected
          ? "border-primary ring-1 ring-primary/40"
          : node.kind === "start"
            ? "border-emerald-300 dark:border-emerald-800"
            : "border-border"
      }`}
    >
      <Handle type="target" position={Position.Left} id="target" />
      <div className="flex items-center gap-1.5">
        <KindIcon kind={node.kind} />
        <span className="truncate text-xs font-medium text-foreground">
          {node.name}
        </span>
        {node.isEntry && (
          <Badge
            variant="outline"
            className="ml-auto shrink-0 px-1 py-0 text-[10px] leading-tight"
          >
            {t("chat:orchestration.editor.entryBadge")}
          </Badge>
        )}
      </div>
      <KindSummary node={node} model={model} providers={providers} />
      {/* 分支选项 chips（llm/code 均可 branch，与 kind 无关） */}
      {branches.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {branches.map((value) => (
            <span
              key={value}
              className="rounded bg-primary-subtle px-1 text-[10px] text-primary"
            >
              {value}
            </span>
          ))}
        </div>
      )}
      {branches.length > 0
        ? branches.map((value, index) => (
            // wrapper 仅定位；pointer-events-none 收窄到旁侧标签——handle
            // 保持自身可交互（连线拖拽），标签不拦截画布点击
            <div
              key={value}
              className="absolute right-0 -translate-y-1/2"
              style={{
                top: `${Math.round(((index + 1) / (branches.length + 1)) * 100)}%`,
              }}
            >
              <Handle
                type="source"
                position={Position.Right}
                id={`branch:${value}`}
              />
              <span className="pointer-events-none absolute left-full top-1/2 ml-1 -translate-y-1/2 whitespace-nowrap rounded bg-primary-subtle px-1 text-[10px] text-primary">
                {value}
              </span>
            </div>
          ))
        : null}
      {branches.length === 0 && (
        <Handle type="source" position={Position.Right} id="plain" />
      )}
    </div>
  );
}

/** kind → 标题行图标（模型/检索类主题色、本地类灰） */
function KindIcon({ kind }: { kind: CanvasNode["kind"] }) {
  const className = "h-3.5 w-3.5 shrink-0";
  switch (kind) {
    case "start":
      return <Play className={`${className} text-primary`} />;
    case "llm":
      return <Sparkles className={`${className} text-primary`} />;
    case "http":
      return <Globe className={`${className} text-primary`} />;
    case "fileRead":
      return <FileText className={`${className} text-muted-foreground`} />;
    case "notify":
      return <Bell className={`${className} text-muted-foreground`} />;
    case "subflow":
      return <Workflow className={`${className} text-primary`} />;
    case "iterate":
      return <Repeat className={`${className} text-primary`} />;
    case "librarySearch":
      return <Library className={`${className} text-primary`} />;
    case "jsonParse":
    case "jsonStringify":
      return <Braces className={`${className} text-primary`} />;
    case "condition":
      return <GitBranch className={`${className} text-primary`} />;
    case "intent":
      return <Compass className={`${className} text-primary`} />;
    case "fileWrite":
      return <FilePen className={`${className} text-muted-foreground`} />;
    case "docExtract":
      return <ScanText className={`${className} text-primary`} />;
    case "imageGen":
      return <ImageIcon className={`${className} text-primary`} />;
    case "delay":
      return <Hourglass className={`${className} text-muted-foreground`} />;
    case "vectorize":
      return <DatabaseZap className={`${className} text-primary`} />;
    case "vectorSearch":
      return <Database className={`${className} text-primary`} />;
    case "database":
      return <Database className={`${className} text-primary`} />;
    case "excelRead":
    case "csvRead":
    case "csvWrite":
      return <Table className={`${className} text-primary`} />;
    case "variable":
      return <Variable className={`${className} text-primary`} />;
    case "aggregate":
      return <Sigma className={`${className} text-primary`} />;
    case "email":
      return <Mail className={`${className} text-muted-foreground`} />;
    case "excelWrite":
      return <FileSpreadsheet className={`${className} text-primary`} />;
    case "merge":
      return <GitMerge className={`${className} text-primary`} />;
    default:
      return <Terminal className={`${className} text-muted-foreground`} />;
  }
}

/** kind → 摘要区（第二行）：按 kind 取专属摘要字段 */
function KindSummary({
  node,
  model,
  providers,
}: {
  node: CanvasNode;
  model?: { name?: string; modelId: string };
  providers: ProviderRecord[];
}) {
  const { t } = useTranslation(["chat"]);
  const dim = "truncate text-[10px] text-muted-foreground";
  const dimEmpty = "truncate text-[10px] text-muted-foreground/60";
  switch (node.kind) {
    case "llm":
      return (
        <div className="mt-1 flex flex-col gap-1">
          <span className={model ? dim : dimEmpty}>
            {model
              ? modelDisplayName(model)
              : t("chat:orchestration.editor.selectModel")}
          </span>
        </div>
      );
    case "http":
      return (
        <div className="mt-1 flex flex-col gap-0.5">
          <span className="font-mono text-[10px] font-medium uppercase text-primary">
            {node.method}
          </span>
          <span className={node.url ? dim : dimEmpty}>
            {node.url || t("chat:orchestration.editor.httpUrlEmpty")}
          </span>
        </div>
      );
    case "code":
      return (
        <div className="mt-1">
          <span className="font-mono text-[10px] uppercase text-muted-foreground">
            {node.language}
          </span>
        </div>
      );
    case "fileRead":
      return (
        <div className="mt-1">
          <span className={node.path ? dim : dimEmpty}>
            {node.path || t("chat:orchestration.editor.fileReadPathEmpty")}
          </span>
        </div>
      );
    case "notify":
      return (
        <div className="mt-1">
          <span className={node.title ? dim : dimEmpty}>
            {node.title || t("chat:orchestration.editor.notifyTitleEmpty")}
          </span>
        </div>
      );
    case "subflow":
    case "iterate":
      return (
        <div className="mt-1">
          <span className={node.graphId ? dim : dimEmpty}>
            {node.graphId
              ? `#${node.graphId}`
              : t("chat:orchestration.editor.subflowEmpty")}
          </span>
        </div>
      );
    case "librarySearch":
      return (
        <div className="mt-1">
          <span className={node.keywords ? dim : dimEmpty}>
            {node.keywords || t("chat:orchestration.editor.libraryQueryEmpty")}
          </span>
        </div>
      );
    case "jsonParse":
    case "jsonStringify":
      return (
        <div className="mt-1">
          <span className={node.source ? dim : dimEmpty}>
            {node.source || t("chat:orchestration.editor.jsonSourceEmpty")}
          </span>
        </div>
      );
    case "condition":
      // 分支名 chips 由通用 branchOptions 渲染（含兜底名），此处只标注数量
      return (
        <div className="mt-1">
          <span className={dim}>
            {t("chat:orchestration.editor.condBranchCount", {
              count: node.branchOptions?.length ?? 0,
            })}
          </span>
        </div>
      );
    case "fileWrite":
      return (
        <div className="mt-1">
          <span className={node.path ? dim : dimEmpty}>
            {node.path || t("chat:orchestration.editor.fileWritePathEmpty")}
          </span>
        </div>
      );
    case "docExtract":
      return (
        <div className="mt-1">
          <span className={node.path ? dim : dimEmpty}>
            {node.path || t("chat:orchestration.editor.docExtractPathEmpty")}
          </span>
        </div>
      );
    case "imageGen":
      // comfyui 态摘要直显服务商名（未绑定/已删显引导文案）；openai 态沿模型显示名
      if (node.protocol === "comfyui") {
        const provider = providers.find((p) => p.id === node.providerId);
        return (
          <div className="mt-1">
            <span className={provider ? dim : dimEmpty}>
              {provider
                ? `${provider.name} · ComfyUI`
                : t("chat:orchestration.editor.comfyNoProvider")}
            </span>
          </div>
        );
      }
      return (
        <div className="mt-1">
          <span className={model ? dim : dimEmpty}>
            {model
              ? modelDisplayName(model)
              : t("chat:orchestration.editor.selectModel")}
          </span>
        </div>
      );
    case "delay":
      return (
        <div className="mt-1">
          <span className={dim}>{node.seconds}s</span>
        </div>
      );
    case "vectorize":
    case "vectorSearch":
      return (
        <div className="mt-1">
          <span className={node.collection ? dim : dimEmpty}>
            {node.collection ||
              t("chat:orchestration.editor.vectorAllCollections")}
          </span>
        </div>
      );
  }
}
