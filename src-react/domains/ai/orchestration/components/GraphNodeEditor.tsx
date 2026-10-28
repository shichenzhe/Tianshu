// src-react/domains/ai/orchestration/components/GraphNodeEditor.tsx
/**
 * 结构化模式节点卡片（spec §7）：id（保存后锁定，编辑期失焦提交并同步边
 * 引用）/name/modelId（模型下拉，数据源同 TaskModelPicker：providers +
 * models/all）/systemPrompt/prompt（模板变量提示）/temperature/tools
 * （开关 + 白名单标签输入 + maxSteps）/outputMode（branch 时分支选项标签
 * 编辑）。另导出 StringListInput 标签式字符串列表输入（工具白名单/分支
 * 选项/输入变量三处共用，DRY）。
 */
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useParams } from "react-router-dom";
import {
  Loader2,
  Maximize2,
  Paperclip,
  Sparkles,
  Trash2,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";

import { Badge } from "@/components/ui/badge";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ProviderApi } from "@/domains/ai/api/provider.api";
import ModelApi, {
  modelDisplayName,
  type ModelType,
} from "@/domains/ai/api/model.api";
import { GraphApi } from "../api/orchestration.api";
import {
  type CodeNode,
  type DatabaseNode,
  type ExcelReadNode,
  type ExcelWriteNode,
  type CsvReadNode,
  type CsvWriteNode,
  type VariableNode,
  type AggregateNode,
  type EmailNode,
  type VariableTransform,
  type AggregateOp,
  type MergeNode,
  type ConditionBranch,
  type ConditionNode,
  type IntentNode,
  type DelayNode,
  type DocExtractNode,
  type FileWriteNode,
  type ImageGenNode,
  type FileReadNode,
  type GraphNode,
  type HttpKV,
  type HttpNode,
  type IterateNode,
  type JsonParseNode,
  type JsonStringifyNode,
  type LibrarySearchNode,
  type LlmNode,
  type NotifyNode,
  type StartNode,
  type SubflowNode,
  type VectorSearchNode,
  type VectorizeNode,
} from "../api/graph.schema";
import { CODE_NODE_EXAMPLES } from "../lib/code-node-examples";
import {
  NODE_ID_PATTERN,
  suggestHttpBodyType,
  timeoutSecToMs,
  type GraphNodePatch,
  type NodeKind,
} from "../lib/graph-editor-model";
import HighlightTextarea from "./HighlightTextarea";
import LargeEditorDialog from "./LargeEditorDialog";

export interface StringListInputProps {
  values: string[];
  placeholder: string;
  /** 与占位符按序一一对应的列表（如 dbParams）须允许重复值 */
  allowDuplicates?: boolean;
  onChange: (next: string[]) => void;
}

/** 标签式字符串列表输入：回车/逗号提交，去空（默认去重，
 * allowDuplicates 时保留重复），chip 一键删除 */
export function StringListInput({
  values,
  placeholder,
  allowDuplicates = false,
  onChange,
}: StringListInputProps) {
  const [draft, setDraft] = useState("");

  function commit() {
    const added = draft
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    const next = [...values];
    for (const item of added) {
      if (allowDuplicates || !next.includes(item)) {
        next.push(item);
      }
    }
    setDraft("");
    if (next.length !== values.length) {
      onChange(next);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((value) => (
        <span
          key={value}
          className="inline-flex items-center gap-1 rounded-md bg-primary-subtle px-1.5 py-0.5 text-xs text-primary"
        >
          {value}
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onChange(values.filter((item) => item !== value))}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Input
        className="h-7 w-40"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}

/** 键值对行编辑（HTTP 头/查询参数）：两列输入 + 行删除 + 追加行；
 * key 空行提交时由调用方/校验拦截 */
export function KeyValueInput({
  entries,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  entries: HttpKV[];
  onChange: (next: HttpKV[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const { t } = useTranslation(["chat"]);
  function patch(index: number, part: Partial<HttpKV>) {
    onChange(
      entries.map((entry, i) => (i === index ? { ...entry, ...part } : entry)),
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {entries.map((entry, index) => (
        <div key={index} className="flex items-center gap-1">
          <Input
            className="h-7 flex-1 font-mono text-xs"
            placeholder={keyPlaceholder}
            value={entry.key}
            onChange={(e) => patch(index, { key: e.target.value })}
          />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            :
          </span>
          <Input
            className="h-7 flex-1 font-mono text-xs"
            placeholder={valuePlaceholder}
            value={entry.value}
            onChange={(e) => patch(index, { value: e.target.value })}
          />
          <button
            type="button"
            aria-label={t("chat:orchestration.editor.kvRemove")}
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(entries.filter((_, i) => i !== index))}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-fit gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        onClick={() => onChange([...entries, { key: "", value: "" }])}
      >
        {t("chat:orchestration.editor.kvAdd")}
      </Button>
    </div>
  );
}

/** 提示词/脚本工具行按钮共用样式 */
const TOOLBAR_BUTTON_CLASS =
  "h-6 gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary";

/** 提示词 AI 润色预览：原文/润色文左右对照，采用即回填（取消不动草稿） */
function PromptPolishDialog({
  open,
  onOpenChange,
  original,
  polished,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  original: string;
  polished: string;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl rounded-lg border border-border/50 shadow-lg">
        <DialogHeader>
          <DialogTitle>
            {t("chat:orchestration.editor.polishTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto">
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t("chat:orchestration.editor.polishOriginal")}
            </p>
            <pre className="flex-1 whitespace-pre-wrap break-all rounded-lg bg-muted/40 p-2 font-mono text-xs text-foreground">
              {original}
            </pre>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-primary">
              {t("chat:orchestration.editor.polishPolished")}
            </p>
            <pre className="flex-1 whitespace-pre-wrap break-all rounded-lg bg-primary-subtle/40 p-2 font-mono text-xs text-foreground ring-1 ring-primary/30">
              {polished}
            </pre>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {t("common:cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onApply(polished);
              onOpenChange(false);
            }}
          >
            {t("chat:orchestration.editor.polishApply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 模型下拉：providers + models/all 数据源与 TaskModelPicker 同源；
 *  filterType 按模型类型过滤（默认 llm，向量节点须选 embedding） */
function ModelSelect({
  modelId,
  onSelect,
  filterType = "llm",
}: {
  modelId: number;
  onSelect: (modelId: number) => void;
  filterType?: ModelType;
}) {
  const { t } = useTranslation(["chat"]);
  const { data: providers = [] } = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const { data: models = [] } = useQuery({
    queryKey: ["models", "all"],
    queryFn: () => ModelApi.listAll(),
  });
  const enabled = models.filter(
    (model) => model.enabled && (model.type ?? "llm") === filterType,
  );
  const groups = providers
    .map((provider) => ({
      provider,
      models: enabled.filter((model) => model.providerId === provider.id),
    }))
    .filter((group) => group.models.length > 0);
  const current = enabled.find((model) => model.id === modelId);

  return (
    <div className="flex flex-col gap-1">
      <Select
        // 无选中传 ""（Radix 无匹配项 → 显示 placeholder），不可传
        // undefined——那会切成非受控：切节点后回读内部 state，显示残留
        // 的上个节点选择（看着选中了、实际 modelId 未赋值）
        value={current ? String(modelId) : ""}
        onValueChange={(value) => onSelect(Number(value))}
      >
        <SelectTrigger className="h-8 w-full">
          <SelectValue
            placeholder={t("chat:orchestration.editor.selectModel")}
          />
        </SelectTrigger>
        <SelectContent className="rounded-lg border border-border/50 shadow-lg">
          {groups.map((group) => (
            <SelectGroup key={group.provider.id}>
              <SelectLabel>{group.provider.name}</SelectLabel>
              {group.models.map((model) => (
                <SelectItem key={model.id} value={String(model.id)}>
                  {modelDisplayName(model)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {groups.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("chat:input.modelRequired")}
        </p>
      )}
    </div>
  );
}

/** 卡片内字段布局：标签 + 控件 + 可选提示（className 控栅格跨度）。
 * Task 3 起属性面板复用（GraphNodeEditor 卡壳退役进 T4） */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={
        className ? `flex flex-col gap-1 ${className}` : "flex flex-col gap-1"
      }
    >
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export interface GraphNodeEditorProps {
  node: GraphNode;
  /** 已保存过的节点 id 锁定（重命名牵连边引用与历史可读性） */
  idLocked: boolean;
  idTaken: (id: string) => boolean;
  onPatch: (patch: GraphNodePatch) => void;
  onRename: (nextId: string) => void;
  /** 节点类型切换（llm⇄code⇄http，专属字段按目标类型重建） */
  onSwitchKind: (kind: NodeKind) => void;
  onRemove: () => void;
}

export default function GraphNodeEditor({
  node,
  idLocked,
  idTaken,
  onPatch,
  onRename,
  onSwitchKind,
  onRemove,
}: GraphNodeEditorProps) {
  const { t } = useTranslation(["chat"]);
  const [idDraft, setIdDraft] = useState(node.id);
  useEffect(() => {
    setIdDraft(node.id);
  }, [node.id]);
  const idInvalid =
    idDraft !== node.id && (!NODE_ID_PATTERN.test(idDraft) || idTaken(idDraft));

  function commitId() {
    if (!idInvalid && idDraft !== node.id) {
      onRename(idDraft);
    } else {
      setIdDraft(node.id);
    }
  }

  return (
    <div className="rounded-lg border border-border/50 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant="secondary" className="font-mono">
          {node.id}
        </Badge>
        {/* start 不可切换为其它 kind（图级唯一入口，编辑变量而非转型） */}
        <Select
          value={node.kind}
          disabled={node.kind === "start"}
          onValueChange={(value) =>
            onSwitchKind(
              [
                "llm",
                "code",
                "http",
                "fileRead",
                "notify",
                "subflow",
                "iterate",
                "librarySearch",
                "jsonParse",
                "jsonStringify",
                "condition",
                "fileWrite",
                "docExtract",
                "imageGen",
                "delay",
                "vectorize",
                "vectorSearch",
                "database",
                "excelRead",
                "excelWrite",
                "merge",
              ].includes(value)
                ? (value as NodeKind)
                : "llm",
            )
          }
        >
          <SelectTrigger className="h-7 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="llm">
              {t("chat:orchestration.editor.kindLlm")}
            </SelectItem>
            <SelectItem value="code">
              {t("chat:orchestration.editor.kindCode")}
            </SelectItem>
            <SelectItem value="http">
              {t("chat:orchestration.editor.kindHttp")}
            </SelectItem>
            <SelectItem value="fileRead">
              {t("chat:orchestration.editor.kindFileRead")}
            </SelectItem>
            <SelectItem value="notify">
              {t("chat:orchestration.editor.kindNotify")}
            </SelectItem>
            <SelectItem value="subflow">
              {t("chat:orchestration.editor.kindSubflow")}
            </SelectItem>
            <SelectItem value="iterate">
              {t("chat:orchestration.editor.kindIterate")}
            </SelectItem>
            <SelectItem value="librarySearch">
              {t("chat:orchestration.editor.kindLibrarySearch")}
            </SelectItem>
            <SelectItem value="jsonParse">
              {t("chat:orchestration.editor.kindJsonParse")}
            </SelectItem>
            <SelectItem value="jsonStringify">
              {t("chat:orchestration.editor.kindJsonStringify")}
            </SelectItem>
            <SelectItem value="condition">
              {t("chat:orchestration.editor.kindCondition")}
            </SelectItem>
            <SelectItem value="fileWrite">
              {t("chat:orchestration.editor.kindFileWrite")}
            </SelectItem>
            <SelectItem value="docExtract">
              {t("chat:orchestration.editor.kindDocExtract")}
            </SelectItem>
            <SelectItem value="imageGen">
              {t("chat:orchestration.editor.kindImageGen")}
            </SelectItem>
            <SelectItem value="delay">
              {t("chat:orchestration.editor.kindDelay")}
            </SelectItem>
            <SelectItem value="vectorize">
              {t("chat:orchestration.editor.kindVectorize")}
            </SelectItem>
            <SelectItem value="vectorSearch">
              {t("chat:orchestration.editor.kindVectorSearch")}
            </SelectItem>
            <SelectItem value="database">
              {t("chat:orchestration.editor.kindDatabase")}
            </SelectItem>
            <SelectItem value="excelRead">
              {t("chat:orchestration.editor.kindExcelRead")}
            </SelectItem>
            <SelectItem value="excelWrite">
              {t("chat:orchestration.editor.kindExcelWrite")}
            </SelectItem>
            <SelectItem value="merge">
              {t("chat:orchestration.editor.kindMerge")}
            </SelectItem>
          </SelectContent>
        </Select>
        <IconTooltip label={t("chat:orchestration.editor.removeNode")}>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-7 w-7 text-muted-foreground hover:text-destructive"
            aria-label={t("chat:orchestration.editor.removeNode")}
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </IconTooltip>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Field
          label={t("chat:orchestration.editor.nodeId")}
          hint={t("chat:orchestration.editor.nodeIdHint")}
        >
          <Input
            className="h-8 font-mono text-xs"
            value={idDraft}
            disabled={idLocked}
            title={
              idLocked ? t("chat:orchestration.editor.nodeIdHint") : undefined
            }
            onChange={(e) => setIdDraft(e.target.value)}
            onBlur={commitId}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitId();
              }
            }}
          />
          {idInvalid && (
            <p className="text-xs text-destructive">
              {t("chat:orchestration.editor.nodeIdInvalid")}
            </p>
          )}
        </Field>
        <Field label={t("chat:orchestration.editor.nodeName")}>
          <Input
            className="h-8"
            value={node.name}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        </Field>
        {nodeFieldsOf(node, onPatch)}
      </div>
    </div>
  );
}

/** kind → 专属字段区（编辑器卡壳与属性面板两处共用分流）；
 *  inputSchemaKeys 供 start 字段初始值兜底（JSON 手改/AI 生成的图
 *  node.variables 为空时从 inputSchema 键回显） */
export function nodeFieldsOf(
  node: GraphNode,
  onPatch: (patch: GraphNodePatch) => void,
  inputSchemaKeys: string[] = [],
) {
  switch (node.kind) {
    case "llm":
      return <LlmNodeFields node={node} onPatch={onPatch} />;
    case "http":
      return <HttpNodeFields node={node} onPatch={onPatch} />;
    case "fileRead":
      return <FileReadNodeFields node={node} onPatch={onPatch} />;
    case "notify":
      return <NotifyNodeFields node={node} onPatch={onPatch} />;
    case "subflow":
      return <SubflowNodeFields node={node} onPatch={onPatch} />;
    case "iterate":
      return <IterateNodeFields node={node} onPatch={onPatch} />;
    case "librarySearch":
      return <LibrarySearchNodeFields node={node} onPatch={onPatch} />;
    case "jsonParse":
      return <JsonParseNodeFields node={node} onPatch={onPatch} />;
    case "jsonStringify":
      return <JsonStringifyNodeFields node={node} onPatch={onPatch} />;
    case "condition":
      return <ConditionNodeFields node={node} onPatch={onPatch} />;
    case "intent":
      return <IntentNodeFields node={node} onPatch={onPatch} />;
    case "fileWrite":
      return <FileWriteNodeFields node={node} onPatch={onPatch} />;
    case "docExtract":
      return <DocExtractNodeFields node={node} onPatch={onPatch} />;
    case "imageGen":
      return <ImageGenNodeFields node={node} onPatch={onPatch} />;
    case "delay":
      return <DelayNodeFields node={node} onPatch={onPatch} />;
    case "vectorize":
      return <VectorizeNodeFields node={node} onPatch={onPatch} />;
    case "vectorSearch":
      return <VectorSearchNodeFields node={node} onPatch={onPatch} />;
    case "database":
      return <DatabaseNodeFields node={node} onPatch={onPatch} />;
    case "excelRead":
      return <ExcelReadNodeFields node={node} onPatch={onPatch} />;
    case "excelWrite":
      return <ExcelWriteNodeFields node={node} onPatch={onPatch} />;
    case "csvRead":
      return <CsvReadNodeFields node={node} onPatch={onPatch} />;
    case "csvWrite":
      return <CsvWriteNodeFields node={node} onPatch={onPatch} />;
    case "variable":
      return <VariableNodeFields node={node} onPatch={onPatch} />;
    case "aggregate":
      return <AggregateNodeFields node={node} onPatch={onPatch} />;
    case "email":
      return <EmailNodeFields node={node} onPatch={onPatch} />;
    case "merge":
      return <MergeNodeFields node={node} onPatch={onPatch} />;
    case "start":
      return (
        <StartNodeFields
          node={node}
          inputSchemaKeys={inputSchemaKeys}
          onPatch={onPatch}
        />
      );
    default:
      return <CodeNodeFields node={node} onPatch={onPatch} />;
  }
}

/** llm 节点字段区（node 已窄化；Task 3 起属性面板复用） */
export function LlmNodeFields({
  node,
  onPatch,
}: {
  node: LlmNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const toolsEnabled = node.tools !== false;
  const whitelist = Array.isArray(node.tools) ? node.tools : [];
  const [promptLarge, setPromptLarge] = useState(false);
  const [polishOpen, setPolishOpen] = useState(false);
  const [polishedText, setPolishedText] = useState("");
  const [polishing, setPolishing] = useState(false);

  /** AI 润色：用当前节点所选模型改写，预览对照后采用（{{}} 占位由后端
   * 指令约束保留）；未选模型/空提示词就地提示 */
  async function handlePolish() {
    if (node.modelId <= 0) {
      toast.info(t("chat:orchestration.editor.polishNoModel"));
      return;
    }
    if (node.prompt.trim() === "") {
      toast.info(t("chat:orchestration.editor.polishEmpty"));
      return;
    }
    setPolishing(true);
    try {
      const text = await GraphApi.polishPrompt(node.modelId, node.prompt);
      setPolishedText(text);
      setPolishOpen(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t("chat:orchestration.editor.polishFailed", { message }));
    } finally {
      setPolishing(false);
    }
  }

  function patchTemperature(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onPatch({ temperature: undefined });
      return;
    }
    const value = Number(trimmed);
    if (!Number.isNaN(value)) {
      onPatch({ temperature: value });
    }
  }

  function patchMaxSteps(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onPatch({ maxSteps: undefined });
      return;
    }
    const value = Number(trimmed);
    if (Number.isInteger(value)) {
      onPatch({ maxSteps: value });
    }
  }

  return (
    <>
      <Field label={t("chat:orchestration.editor.model")}>
        <ModelSelect
          modelId={node.modelId}
          onSelect={(modelId) => onPatch({ modelId })}
        />
      </Field>
      {/* 输出模式：分支模式为存量图兼容（新路由入口见 condition/intent
          节点），仅暴露文本；branch 值的存量节点仍正常执行与编辑 */}
      <Field label={t("chat:orchestration.editor.outputMode")}>
        <Select
          value={node.outputMode}
          onValueChange={(value) =>
            onPatch({ outputMode: value === "branch" ? "branch" : "text" })
          }
        >
          <SelectTrigger className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="text">
              {t("chat:orchestration.editor.outputModeText")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("chat:orchestration.editor.prompt")}
        hint={t("chat:orchestration.editor.promptHint")}
        className="col-span-full"
      >
        <div className="flex justify-end gap-1">
          <Button
            variant="outline"
            size="sm"
            className={TOOLBAR_BUTTON_CLASS}
            disabled={polishing}
            onClick={() => void handlePolish()}
          >
            {polishing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {t("chat:orchestration.editor.polishButton")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={TOOLBAR_BUTTON_CLASS}
            onClick={() => setPromptLarge(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            {t("chat:orchestration.editor.enlarge")}
          </Button>
        </div>
        <HighlightTextarea
          value={node.prompt}
          onChange={(next) => onPatch({ prompt: next })}
          language="prompt"
          height={72}
        />
      </Field>
      <LargeEditorDialog
        open={promptLarge}
        onOpenChange={setPromptLarge}
        title={t("chat:orchestration.editor.prompt")}
        value={node.prompt}
        onChange={(next) => onPatch({ prompt: next })}
        language="prompt"
      />
      <PromptPolishDialog
        open={polishOpen}
        onOpenChange={setPolishOpen}
        original={node.prompt}
        polished={polishedText}
        onApply={(text) => onPatch({ prompt: text })}
      />
      <Field
        label={t("chat:orchestration.editor.systemPrompt")}
        className="col-span-full"
      >
        <Textarea
          className="min-h-[72px] rounded-lg border-border/50 text-sm"
          value={node.systemPrompt ?? ""}
          onChange={(e) =>
            onPatch({
              systemPrompt: e.target.value === "" ? undefined : e.target.value,
            })
          }
        />
      </Field>
      <Field label={t("chat:orchestration.editor.temperature")}>
        <Input
          className="h-8"
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={node.temperature ?? ""}
          onChange={(e) => patchTemperature(e.target.value)}
        />
      </Field>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">
          {t("chat:orchestration.editor.tools")}
        </Label>
        <div className="flex h-8 items-center gap-2">
          <Switch
            checked={toolsEnabled}
            onCheckedChange={(on) => onPatch({ tools: on ? true : false })}
          />
          <span className="text-xs text-muted-foreground">
            {t("chat:orchestration.editor.toolsHint")}
          </span>
        </div>
      </div>
      {toolsEnabled && (
        <Field
          label={t("chat:orchestration.editor.whitelist")}
          hint={t("chat:orchestration.editor.whitelistHint")}
          className="col-span-full"
        >
          <StringListInput
            values={whitelist}
            placeholder={t("chat:orchestration.editor.whitelistPlaceholder")}
            onChange={(next) =>
              onPatch({ tools: next.length > 0 ? next : true })
            }
          />
        </Field>
      )}
      {toolsEnabled && (
        <Field label={t("chat:orchestration.editor.maxSteps")}>
          <Input
            className="h-8"
            type="number"
            min={1}
            max={50}
            step={1}
            value={node.maxSteps ?? ""}
            onChange={(e) => patchMaxSteps(e.target.value)}
          />
        </Field>
      )}
      {node.outputMode === "branch" && (
        <Field
          label={t("chat:orchestration.editor.branchOptions")}
          className="col-span-full"
        >
          <StringListInput
            values={node.branchOptions ?? []}
            placeholder={t("chat:orchestration.editor.branchPlaceholder")}
            onChange={(next) =>
              onPatch({
                branchOptions: next.length > 0 ? next : undefined,
              })
            }
          />
        </Field>
      )}
      {/* 异常处理（对照 Coze）：超时/重试/异常处理方式 */}
      <Field
        label={t("chat:orchestration.editor.llmTimeoutSec")}
        hint={t("chat:orchestration.editor.llmTimeoutHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={3600}
          step={1}
          value={Math.round((node.timeoutMs ?? 180_000) / 1000)}
          onChange={(e) => {
            const trimmed = e.target.value.trim();
            if (trimmed === "") {
              onPatch({ timeoutMs: 180_000 });
              return;
            }
            const sec = Number(trimmed);
            if (Number.isFinite(sec) && sec > 0) {
              onPatch({ timeoutMs: Math.round(sec * 1000) });
            }
          }}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.llmRetries")}
        hint={t("chat:orchestration.editor.llmRetriesHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={0}
          max={5}
          step={1}
          value={node.retries ?? 0}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 0 && value <= 5) {
              onPatch({ retries: value });
            }
          }}
        />
      </Field>
      <Field label={t("chat:orchestration.editor.onError")}>
        <Select
          value={node.onError ?? "abort"}
          onValueChange={(value) =>
            onPatch({
              onError: value === "defaultValue" ? "defaultValue" : "abort",
            })
          }
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="abort">
              {t("chat:orchestration.editor.onErrorAbort")}
            </SelectItem>
            <SelectItem value="defaultValue">
              {t("chat:orchestration.editor.onErrorDefault")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {node.onError === "defaultValue" && (
        <Field
          label={t("chat:orchestration.editor.errorOutput")}
          hint={t("chat:orchestration.editor.errorOutputHint")}
          className="col-span-full"
        >
          <Textarea
            className="min-h-[72px] rounded-lg border-border/50 text-sm"
            value={node.errorOutput ?? ""}
            onChange={(e) =>
              onPatch({
                errorOutput: e.target.value === "" ? undefined : e.target.value,
              })
            }
          />
        </Field>
      )}
    </>
  );
}

/** 代码节点字段区：语言/脚本/超时（秒呈现，存毫秒；上限 24h 可调；
 * Task 3 起属性面板复用） */
export function CodeNodeFields({
  node,
  onPatch,
}: {
  node: CodeNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const [scriptLarge, setScriptLarge] = useState(false);

  function patchTimeoutSec(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onPatch({ timeoutMs: 30_000 });
      return;
    }
    const sec = Number(trimmed);
    if (Number.isFinite(sec) && sec > 0) {
      onPatch({ timeoutMs: Math.round(sec * 1000) });
    }
  }

  return (
    <>
      <Field label={t("chat:orchestration.editor.language")}>
        <Select
          value={node.language}
          onValueChange={(value) =>
            onPatch({
              language:
                value === "nodejs" || value === "python" ? value : "bash",
            })
          }
        >
          <SelectTrigger className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="bash">Bash</SelectItem>
            <SelectItem value="nodejs">Node.js</SelectItem>
            <SelectItem value="python">Python 3</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("chat:orchestration.editor.timeoutSec")}
        hint={t("chat:orchestration.editor.timeoutHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={86400}
          step={1}
          value={Math.round((node.timeoutMs ?? 30_000) / 1000)}
          onChange={(e) => patchTimeoutSec(e.target.value)}
        />
      </Field>
      {/* 同 llm：分支模式存量兼容，新路由入口见 condition/intent 节点 */}
      <Field label={t("chat:orchestration.editor.outputMode")}>
        <Select
          value={node.outputMode ?? "text"}
          onValueChange={(value) =>
            onPatch({ outputMode: value === "branch" ? "branch" : "text" })
          }
        >
          <SelectTrigger className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="text">
              {t("chat:orchestration.editor.outputModeText")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {node.outputMode === "branch" && (
        <Field
          label={t("chat:orchestration.editor.branchOptions")}
          hint={t("chat:orchestration.editor.codeBranchHint")}
          className="col-span-full"
        >
          <StringListInput
            values={node.branchOptions ?? []}
            placeholder={t("chat:orchestration.editor.branchPlaceholder")}
            onChange={(next) =>
              onPatch({
                branchOptions: next.length > 0 ? next : undefined,
              })
            }
          />
        </Field>
      )}
      <Field
        label={t("chat:orchestration.editor.script")}
        hint={t("chat:orchestration.editor.scriptHint")}
        className="col-span-full"
      >
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="outline"
            size="sm"
            className={TOOLBAR_BUTTON_CLASS}
            disabled={node.script.trim() !== ""}
            title={
              node.script.trim() !== ""
                ? t("chat:orchestration.editor.insertExampleBlocked")
                : undefined
            }
            onClick={() =>
              onPatch({ script: CODE_NODE_EXAMPLES[node.language] })
            }
          >
            {t("chat:orchestration.editor.insertExample")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={TOOLBAR_BUTTON_CLASS}
            onClick={() => setScriptLarge(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            {t("chat:orchestration.editor.enlarge")}
          </Button>
        </div>
        <HighlightTextarea
          value={node.script}
          onChange={(next) => onPatch({ script: next })}
          language={node.language}
          height={160}
        />
      </Field>
      <LargeEditorDialog
        open={scriptLarge}
        onOpenChange={setScriptLarge}
        title={t("chat:orchestration.editor.script")}
        value={node.script}
        onChange={(next) => onPatch({ script: next })}
        language={node.language}
      />
      <Field
        label={t("chat:orchestration.editor.retriesLabel")}
        hint={t("chat:orchestration.editor.codeRetriesHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={0}
          max={5}
          step={1}
          value={node.retries ?? 0}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 0 && value <= 5) {
              onPatch({ retries: value });
            }
          }}
        />
      </Field>
    </>
  );
}

/** HTTP 节点字段区（参照 Coze HTTP 节点）：方法/URL/请求头/查询参数/
 * Body 类型与内容/超时；url/头值/参数值/body 均支持 {{}} 模板占位符 */
export function HttpNodeFields({
  node,
  onPatch,
}: {
  node: HttpNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const [bodyLarge, setBodyLarge] = useState(false);

  /** binary 请求体文件选择：系统对话框选文件 → 后端固化拷贝到应用数据
   * 目录并返回拷贝路径（源文件后续变动不影响执行）；取消不动；手输
   * 路径仍为引用模式（执行时读原路径） */
  async function handlePickFile() {
    try {
      const picked = await GraphApi.pickBinaryFile();
      if (picked) {
        onPatch({ body: picked });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("HTTP_BINARY_TOO_LARGE")) {
        toast.error(t("chat:orchestration.editor.pickFileTooLarge"));
      } else {
        toast.error(t("chat:orchestration.editor.pickFileFailed", { message }));
      }
    }
  }

  const bodyHint =
    node.bodyType === "form"
      ? t("chat:orchestration.editor.httpFormHint")
      : node.bodyType === "binary"
        ? t("chat:orchestration.editor.httpBinaryHint")
        : t("chat:orchestration.editor.httpBodyHint");

  return (
    <>
      <Field label={t("chat:orchestration.editor.httpMethod")}>
        <Select
          value={node.method}
          onValueChange={(value) => {
            const method = value as HttpNode["method"];
            // 带体方法 + Body 类型仍为「无」→ 联动切 json，请求体输入区
            // 随方法出现（否则选了 POST 也找不到填 body 的地方）
            const bodyType = suggestHttpBodyType(method, node.bodyType);
            onPatch({
              method,
              ...(bodyType !== node.bodyType ? { bodyType } : {}),
            });
          }}
        >
          <SelectTrigger className="h-8 w-full font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map(
              (method) => (
                <SelectItem
                  key={method}
                  value={method}
                  className="font-mono text-xs"
                >
                  {method}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("chat:orchestration.editor.httpUrl")}
        hint={t("chat:orchestration.editor.httpUrlHint")}
        className="col-span-full"
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="https://api.example.com/users/{{input.id}}"
          value={node.url}
          onChange={(e) => onPatch({ url: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.httpAuth")}
        hint={t("chat:orchestration.editor.httpAuthHint")}
      >
        <Select
          value={node.auth.type}
          onValueChange={(value) =>
            onPatch({
              auth:
                value === "basic"
                  ? { type: "basic", user: "", password: "" }
                  : value === "bearer"
                    ? { type: "bearer", token: "" }
                    : value === "header"
                      ? { type: "header", name: "", value: "" }
                      : value === "acs3"
                        ? {
                            type: "acs3",
                            accessKeyId: "",
                            accessKeySecret: "",
                            headerPrefix: "x-acs-",
                            algorithm: "ACS3-HMAC-SHA256",
                          }
                        : { type: "none" },
            })
          }
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="none">
              {t("chat:orchestration.editor.authNone")}
            </SelectItem>
            <SelectItem value="basic">
              {t("chat:orchestration.editor.authBasic")}
            </SelectItem>
            <SelectItem value="bearer">
              {t("chat:orchestration.editor.authBearer")}
            </SelectItem>
            <SelectItem value="header">
              {t("chat:orchestration.editor.authHeader")}
            </SelectItem>
            <SelectItem value="acs3">
              {t("chat:orchestration.editor.authAcs3")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("chat:orchestration.editor.httpRetries")}
        hint={t("chat:orchestration.editor.httpRetriesHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={0}
          max={5}
          step={1}
          value={node.retries ?? 0}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 0 && value <= 5) {
              onPatch({ retries: value });
            }
          }}
        />
      </Field>
      {node.auth.type === "basic" && (
        <Field
          label={t("chat:orchestration.editor.authUser")}
          className="col-span-full"
        >
          <div className="flex items-center gap-1">
            <Input
              className="h-8 font-mono text-xs"
              placeholder="user"
              value={node.auth.user}
              onChange={(e) => {
                // 回调闭包不保持 JSX 条件的判别窄化，须重窄化后构造
                if (node.auth.type === "basic") {
                  onPatch({ auth: { ...node.auth, user: e.target.value } });
                }
              }}
            />
            <Input
              className="h-8 font-mono text-xs"
              placeholder="password"
              type="password"
              value={node.auth.password}
              onChange={(e) => {
                if (node.auth.type === "basic") {
                  onPatch({ auth: { ...node.auth, password: e.target.value } });
                }
              }}
            />
          </div>
        </Field>
      )}
      {node.auth.type === "bearer" && (
        <Field
          label={t("chat:orchestration.editor.authToken")}
          className="col-span-full"
        >
          <Input
            className="h-8 font-mono text-xs"
            placeholder="{{input.apiKey}}"
            value={node.auth.token}
            onChange={(e) => {
              if (node.auth.type === "bearer") {
                onPatch({ auth: { ...node.auth, token: e.target.value } });
              }
            }}
          />
        </Field>
      )}
      {node.auth.type === "acs3" && (
        <>
          <Field label={t("chat:orchestration.editor.acs3KeyId")}>
            <Input
              className="h-8 font-mono text-xs"
              placeholder="LTAI{{input.suffix}}"
              value={node.auth.accessKeyId}
              onChange={(e) => {
                if (node.auth.type === "acs3") {
                  onPatch({
                    auth: { ...node.auth, accessKeyId: e.target.value },
                  });
                }
              }}
            />
          </Field>
          <Field label={t("chat:orchestration.editor.acs3Secret")}>
            <Input
              className="h-8 font-mono text-xs"
              placeholder="{{input.secret}}"
              type="password"
              value={node.auth.accessKeySecret}
              onChange={(e) => {
                if (node.auth.type === "acs3") {
                  onPatch({
                    auth: { ...node.auth, accessKeySecret: e.target.value },
                  });
                }
              }}
            />
          </Field>
          <Field
            label={t("chat:orchestration.editor.acs3HeaderPrefix")}
            hint={t("chat:orchestration.editor.acs3Hint")}
            className="col-span-full"
          >
            <Input
              className="h-8 font-mono text-xs"
              placeholder="x-acs-"
              value={node.auth.headerPrefix}
              onChange={(e) => {
                if (node.auth.type === "acs3") {
                  onPatch({
                    auth: { ...node.auth, headerPrefix: e.target.value },
                  });
                }
              }}
            />
          </Field>
          <Field
            label={t("chat:orchestration.editor.acs3Algorithm")}
            className="col-span-full"
          >
            <Input
              className="h-8 font-mono text-xs"
              placeholder="ACS3-HMAC-SHA256"
              value={node.auth.algorithm}
              onChange={(e) => {
                if (node.auth.type === "acs3") {
                  onPatch({
                    auth: { ...node.auth, algorithm: e.target.value },
                  });
                }
              }}
            />
          </Field>
        </>
      )}
      {node.auth.type === "header" && (
        <Field
          label={t("chat:orchestration.editor.authHeaderKv")}
          className="col-span-full"
        >
          <div className="flex items-center gap-1">
            <Input
              className="h-8 flex-1 font-mono text-xs"
              placeholder="X-Api-Key"
              value={node.auth.name}
              onChange={(e) => {
                if (node.auth.type === "header") {
                  onPatch({ auth: { ...node.auth, name: e.target.value } });
                }
              }}
            />
            <Input
              className="h-8 flex-1 font-mono text-xs"
              placeholder="{{input.key}}"
              value={node.auth.value}
              onChange={(e) => {
                if (node.auth.type === "header") {
                  onPatch({ auth: { ...node.auth, value: e.target.value } });
                }
              }}
            />
          </div>
        </Field>
      )}
      <Field
        label={t("chat:orchestration.editor.timeoutSec")}
        hint={t("chat:orchestration.editor.httpTimeoutHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={600}
          step={1}
          value={Math.round((node.timeoutMs ?? 120_000) / 1000)}
          onChange={(e) =>
            onPatch({ timeoutMs: timeoutSecToMs(e.target.value, 120_000) })
          }
        />
      </Field>
      <Field label={t("chat:orchestration.editor.httpBodyType")}>
        <Select
          value={node.bodyType}
          onValueChange={(value) =>
            onPatch({
              bodyType: value as HttpNode["bodyType"],
            })
          }
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="none">
              {t("chat:orchestration.editor.bodyNone")}
            </SelectItem>
            <SelectItem value="json">JSON</SelectItem>
            <SelectItem value="text">
              {t("chat:orchestration.editor.bodyText")}
            </SelectItem>
            <SelectItem value="form">
              {t("chat:orchestration.editor.bodyForm")}
            </SelectItem>
            <SelectItem value="binary">
              {t("chat:orchestration.editor.bodyBinary")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("chat:orchestration.editor.httpHeaders")}
        className="col-span-full"
      >
        <KeyValueInput
          entries={node.headers}
          onChange={(next) => onPatch({ headers: next })}
          keyPlaceholder="Authorization"
          valuePlaceholder="Bearer {{input.token}}"
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.httpQuery")}
        className="col-span-full"
      >
        <KeyValueInput
          entries={node.query}
          onChange={(next) => onPatch({ query: next })}
          keyPlaceholder="page"
          valuePlaceholder="{{input.page}}"
        />
      </Field>
      {node.bodyType === "binary" ? (
        <Field
          label={t("chat:orchestration.editor.httpBody")}
          hint={bodyHint}
          className="col-span-full"
        >
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1 px-2 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
              onClick={() => void handlePickFile()}
            >
              <Paperclip className="h-3.5 w-3.5" />
              {t("chat:orchestration.editor.pickFile")}
            </Button>
            <Input
              className="h-8 flex-1 font-mono text-xs"
              placeholder={t("chat:orchestration.editor.httpBinaryPlaceholder")}
              value={node.body ?? ""}
              onChange={(e) =>
                onPatch({
                  body: e.target.value === "" ? undefined : e.target.value,
                })
              }
            />
          </div>
        </Field>
      ) : node.bodyType !== "none" ? (
        <Field
          label={t("chat:orchestration.editor.httpBody")}
          hint={bodyHint}
          className="col-span-full"
        >
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className={TOOLBAR_BUTTON_CLASS}
              onClick={() => setBodyLarge(true)}
            >
              <Maximize2 className="h-3.5 w-3.5" />
              {t("chat:orchestration.editor.enlarge")}
            </Button>
          </div>
          <HighlightTextarea
            value={node.body ?? ""}
            onChange={(next) =>
              onPatch({ body: next === "" ? undefined : next })
            }
            language="prompt"
            height={96}
          />
        </Field>
      ) : null}
      {node.bodyType !== "none" && node.bodyType !== "binary" && (
        <LargeEditorDialog
          open={bodyLarge}
          onOpenChange={setBodyLarge}
          title={t("chat:orchestration.editor.httpBody")}
          value={node.body ?? ""}
          onChange={(next) => onPatch({ body: next === "" ? undefined : next })}
          language="prompt"
        />
      )}
    </>
  );
}

/** 子工作流选择下拉：全部已保存工作流（排除当前编辑图自身防直接
 * 自引用；间接循环由执行期 subflowStack 拦截） */
function SubflowGraphSelect({
  graphId,
  onSelect,
}: {
  graphId: number;
  onSelect: (graphId: number) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const params = useParams<{ id: string }>();
  const currentId = params.id && params.id !== "new" ? Number(params.id) : 0;
  const { data: graphs = [] } = useQuery({
    queryKey: ["orchestration", "graphs"],
    queryFn: () => GraphApi.list(),
  });
  const candidates = graphs.filter((graph) => graph.id !== currentId);
  return (
    <div className="flex flex-col gap-1">
      <Select
        value={graphId > 0 ? String(graphId) : ""}
        onValueChange={(value) => onSelect(Number(value))}
      >
        <SelectTrigger className="h-8 w-full text-xs">
          <SelectValue
            placeholder={t("chat:orchestration.editor.subflowPlaceholder")}
          />
        </SelectTrigger>
        <SelectContent className="rounded-lg border border-border/50 shadow-lg">
          {candidates.map((graph) => (
            <SelectItem key={graph.id} value={String(graph.id)}>
              #{graph.id} {graph.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {candidates.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("chat:orchestration.editor.subflowNoCandidates")}
        </p>
      )}
    </div>
  );
}

/** 文件读取节点字段区：路径（限工作空间内） */
export function FileReadNodeFields({
  node,
  onPatch,
}: {
  node: FileReadNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.fileReadPath")}
        hint={t("chat:orchestration.editor.fileReadHint")}
        className="col-span-full"
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="docs/report.md"
          value={node.path}
          onChange={(e) => onPatch({ path: e.target.value })}
        />
      </Field>
    </>
  );
}

/** 通知节点字段区：标题/正文（支持 {{}} 占位符），发系统桌面通知 */
export function NotifyNodeFields({
  node,
  onPatch,
}: {
  node: NotifyNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.notifyTitle")}
        hint={t("chat:orchestration.editor.notifyHint")}
        className="col-span-full"
      >
        <Input
          className="h-8"
          placeholder="{{date}} 日报已生成"
          value={node.title}
          onChange={(e) => onPatch({ title: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.notifyBody")}
        className="col-span-full"
      >
        <Textarea
          className="min-h-[64px] rounded-lg border-border/50 text-sm"
          placeholder="详见 {{nodes.report.output}}"
          value={node.body ?? ""}
          onChange={(e) =>
            onPatch({
              body: e.target.value === "" ? undefined : e.target.value,
            })
          }
        />
      </Field>
      <Field label={t("chat:orchestration.editor.webhookProvider")}>
        <Select
          value={node.webhookProvider ?? "none"}
          onValueChange={(value) =>
            onPatch({
              webhookProvider: value as NotifyNode["webhookProvider"],
            })
          }
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="none">
              {t("chat:orchestration.editor.webhookNone")}
            </SelectItem>
            <SelectItem value="feishu">飞书</SelectItem>
            <SelectItem value="dingtalk">钉钉</SelectItem>
            <SelectItem value="wecom">企业微信</SelectItem>
            <SelectItem value="custom">
              {t("chat:orchestration.editor.webhookCustom")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {(node.webhookProvider ?? "none") !== "none" && (
        <Field
          label={t("chat:orchestration.editor.webhookUrl")}
          hint={t("chat:orchestration.editor.webhookHint")}
          className="col-span-full"
        >
          <Input
            className="h-8 font-mono text-xs"
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            value={node.webhookUrl}
            onChange={(e) => onPatch({ webhookUrl: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}

/** 子工作流节点字段区：选图 + 变量映射（key=子图输入变量名） */
export function SubflowNodeFields({
  node,
  onPatch,
}: {
  node: SubflowNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.subflowGraph")}
        hint={t("chat:orchestration.editor.subflowHint")}
        className="col-span-full"
      >
        <SubflowGraphSelect
          graphId={node.graphId}
          onSelect={(graphId) => onPatch({ graphId })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.subflowInputs")}
        hint={t("chat:orchestration.editor.subflowInputsHint")}
        className="col-span-full"
      >
        <KeyValueInput
          entries={node.inputs}
          onChange={(next) => onPatch({ inputs: next })}
          keyPlaceholder="topic"
          valuePlaceholder="{{input.topic}}"
        />
      </Field>
      <Field label={t("chat:orchestration.editor.subflowAsync")}>
        <div className="flex h-8 items-center gap-2">
          <Switch
            checked={node.async}
            onCheckedChange={(on) => onPatch({ async: on })}
          />
          <span className="text-xs text-muted-foreground">
            {t("chat:orchestration.editor.subflowAsyncHint")}
          </span>
        </div>
      </Field>
    </>
  );
}

/** 条件算子组（条件分支/循环终止条件共用）：文案 key condOp.<op>，
 * isEmpty/notEmpty 无需比较值 */
type ConditionOperatorKind = ConditionBranch["conditions"][number]["operator"];
const CONDITION_OPERATORS: ConditionOperatorKind[] = [
  "eq",
  "neq",
  "contains",
  "notContains",
  "isEmpty",
  "notEmpty",
  "gt",
  "gte",
  "lt",
  "lte",
  "regex",
];
const CONDITION_NEED_VALUE = new Set<ConditionOperatorKind>([
  "eq",
  "neq",
  "contains",
  "notContains",
  "gt",
  "gte",
  "lt",
  "lte",
  "regex",
]);
const condOpKey = (op: ConditionOperatorKind) =>
  `chat:orchestration.editor.condOp.${op}`;

/** 循环节点字段区（Coze 式分区）：循环设置（类型 + 列表/次数/终止条件）→
 * 子工作流 → 中间变量（承接变量）→ 高级设置（默认折叠）→ 输出说明 */
export function IterateNodeFields({
  node,
  onPatch,
}: {
  node: IterateNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const patchCondition = (
    next: Partial<NonNullable<IterateNode["breakCondition"]>>,
  ) => {
    onPatch({
      breakCondition: {
        ...(node.breakCondition ?? { source: "", operator: "eq" }),
        ...next,
      },
    });
  };
  const breakCond = node.breakCondition ?? {
    source: "",
    operator: "eq" as ConditionOperatorKind,
  };
  const [sourceLarge, setSourceLarge] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const loopMode = node.loopMode ?? "array";
  return (
    <>
      <p className="col-span-full mt-1 text-xs font-medium text-muted-foreground">
        {t("chat:orchestration.editor.iterateSectionLoop")}
      </p>
      <Field
        label={t("chat:orchestration.editor.iterateMode")}
        hint={t("chat:orchestration.editor.iterateModeHint")}
        className="col-span-full"
      >
        <Select
          value={loopMode}
          onValueChange={(value) =>
            onPatch({
              loopMode:
                value === "count" || value === "while" ? value : "array",
            })
          }
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="array">
              {t("chat:orchestration.editor.iterateModeArray")}
            </SelectItem>
            <SelectItem value="count">
              {t("chat:orchestration.editor.iterateModeCount")}
            </SelectItem>
            <SelectItem value="while">
              {t("chat:orchestration.editor.iterateModeWhile")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {loopMode === "count" ? (
        <Field
          label={t("chat:orchestration.editor.iterateCount")}
          hint={t("chat:orchestration.editor.iterateCountHint")}
          className="col-span-full"
        >
          <Input
            className="h-8"
            placeholder="{{input.times}}"
            value={node.countSource ?? ""}
            onChange={(e) => onPatch({ countSource: e.target.value })}
          />
        </Field>
      ) : loopMode === "while" ? (
        <Field
          label={t("chat:orchestration.editor.iterateBreak")}
          hint={t("chat:orchestration.editor.iterateBreakHint")}
          className="col-span-full"
        >
          <div className="flex items-center gap-1.5">
            <Input
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              placeholder="{{nodes.loop.output}}"
              aria-label={t("chat:orchestration.editor.iterateBreakSource")}
              value={breakCond.source}
              onChange={(e) => patchCondition({ source: e.target.value })}
            />
            <Select
              value={breakCond.operator}
              onValueChange={(value) =>
                patchCondition({
                  operator: (CONDITION_OPERATORS as string[]).includes(value)
                    ? (value as ConditionOperatorKind)
                    : "eq",
                })
              }
            >
              <SelectTrigger className="h-8 w-[7.5rem] shrink-0 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-lg border border-border/50 shadow-lg">
                {CONDITION_OPERATORS.map((op) => (
                  <SelectItem key={op} value={op} className="text-xs">
                    {t(condOpKey(op))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {CONDITION_NEED_VALUE.has(breakCond.operator) && (
              <Input
                className="h-8 w-28 shrink-0 font-mono text-xs"
                aria-label={t("chat:orchestration.editor.iterateBreakValue")}
                value={breakCond.value ?? ""}
                onChange={(e) => patchCondition({ value: e.target.value })}
              />
            )}
          </div>
        </Field>
      ) : (
        <Field
          label={t("chat:orchestration.editor.iterateItems")}
          hint={t("chat:orchestration.editor.iterateItemsHint")}
          className="col-span-full"
        >
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className={TOOLBAR_BUTTON_CLASS}
              onClick={() => setSourceLarge(true)}
            >
              <Maximize2 className="h-3.5 w-3.5" />
              {t("chat:orchestration.editor.enlarge")}
            </Button>
          </div>
          <HighlightTextarea
            value={node.itemsSource}
            onChange={(next) => onPatch({ itemsSource: next })}
            language="prompt"
            height={72}
          />
        </Field>
      )}

      <p className="col-span-full mt-1 text-xs font-medium text-muted-foreground">
        {t("chat:orchestration.editor.iterateSectionSubflow")}
      </p>
      <Field
        label={t("chat:orchestration.editor.subflowGraph")}
        className="col-span-full"
      >
        <SubflowGraphSelect
          graphId={node.graphId}
          onSelect={(graphId) => onPatch({ graphId })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.iterateVariable")}
        hint={t("chat:orchestration.editor.iterateVariableHint")}
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="item"
          value={node.itemVariable}
          onChange={(e) => onPatch({ itemVariable: e.target.value })}
        />
      </Field>

      <p className="col-span-full mt-1 text-xs font-medium text-muted-foreground">
        {t("chat:orchestration.editor.iterateSectionCarry")}
      </p>
      <Field
        label={t("chat:orchestration.editor.iterateCarryVariable")}
        hint={t("chat:orchestration.editor.iterateCarryVariableHint")}
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="lastOutput"
          value={node.carryVariable ?? ""}
          onChange={(e) => onPatch({ carryVariable: e.target.value })}
        />
      </Field>
      <Field label={t("chat:orchestration.editor.iterateCarryInitial")}>
        <Input
          className="h-8"
          value={node.carryInitial ?? ""}
          onChange={(e) => onPatch({ carryInitial: e.target.value })}
        />
      </Field>

      <div className="col-span-full">
        <button
          type="button"
          aria-expanded={advancedOpen}
          className="flex w-full items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {advancedOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          {t("chat:orchestration.editor.iterateSectionAdvanced")}
        </button>
        {advancedOpen && (
          <div className="mt-2 grid grid-cols-1 gap-x-3 gap-y-2 @[400px]:grid-cols-2">
            <Field
              label={t("chat:orchestration.editor.iterateMaxItems")}
              hint={t("chat:orchestration.editor.iterateMaxItemsHint")}
            >
              <Input
                className="h-8"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={node.maxItems}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 1000) {
                    onPatch({ maxItems: value });
                  }
                }}
              />
            </Field>
            <Field
              label={t("chat:orchestration.editor.iterateConcurrency")}
              hint={t("chat:orchestration.editor.iterateConcurrencyHint")}
            >
              <Input
                className="h-8"
                type="number"
                min={1}
                max={5}
                step={1}
                value={node.concurrency ?? 1}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 5) {
                    onPatch({ concurrency: value });
                  }
                }}
              />
            </Field>
            <Field label={t("chat:orchestration.editor.iterateOnError")}>
              <Select
                value={node.onItemError ?? "abort"}
                onValueChange={(value) =>
                  onPatch({
                    onItemError: value === "continue" ? "continue" : "abort",
                  })
                }
              >
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-lg border border-border/50 shadow-lg">
                  <SelectItem value="abort">
                    {t("chat:orchestration.editor.iterateOnErrorAbort")}
                  </SelectItem>
                  <SelectItem value="continue">
                    {t("chat:orchestration.editor.iterateOnErrorContinue")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        )}
      </div>

      <div className="col-span-full rounded-lg bg-muted/40 p-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t("chat:orchestration.editor.iterateOutputTitle")}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("chat:orchestration.editor.iterateOutputHint")}
        </p>
      </div>

      <LargeEditorDialog
        open={sourceLarge}
        onOpenChange={setSourceLarge}
        title={t("chat:orchestration.editor.iterateItems")}
        value={node.itemsSource}
        onChange={(next) => onPatch({ itemsSource: next })}
        language="prompt"
      />
    </>
  );
}

/** 资料库检索节点字段区：关键词（空格分词 AND）+ 命中段数上限 */
export function LibrarySearchNodeFields({
  node,
  onPatch,
}: {
  node: LibrarySearchNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.libraryQuery")}
        hint={t("chat:orchestration.editor.libraryQueryHint")}
        className="col-span-full"
      >
        <Input
          className="h-8"
          placeholder="{{input.topic}} 要点"
          value={node.keywords}
          onChange={(e) => onPatch({ keywords: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.libraryMaxResults")}
        hint={t("chat:orchestration.editor.libraryMaxResultsHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={20}
          step={1}
          value={node.maxResults}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= 20) {
              onPatch({ maxResults: value });
            }
          }}
        />
      </Field>
    </>
  );
}

/** JSON 反序列化节点字段区：来源表达式 + 点路径提取 + 数组逐行展开 */
export function JsonParseNodeFields({
  node,
  onPatch,
}: {
  node: JsonParseNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.jsonSource")}
        hint={t("chat:orchestration.editor.jsonParseHint")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.source}
          onChange={(next) => onPatch({ source: next })}
          language="prompt"
          height={72}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.jsonPath")}
        hint={t("chat:orchestration.editor.jsonPathHint")}
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="data.items[0].name"
          value={node.path ?? ""}
          onChange={(e) =>
            onPatch({
              path: e.target.value === "" ? undefined : e.target.value,
            })
          }
        />
      </Field>
      <Field label={t("chat:orchestration.editor.jsonArrayLines")}>
        <div className="flex h-8 items-center gap-2">
          <Switch
            checked={node.arrayLines}
            onCheckedChange={(on) => onPatch({ arrayLines: on })}
          />
          <span className="text-xs text-muted-foreground">
            {t("chat:orchestration.editor.jsonArrayLinesHint")}
          </span>
        </div>
      </Field>
    </>
  );
}

/** JSON 序列化节点字段区：来源表达式（合法 JSON 规范化/文本转义字面量） */
export function JsonStringifyNodeFields({
  node,
  onPatch,
}: {
  node: JsonStringifyNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.jsonSource")}
        hint={t("chat:orchestration.editor.jsonStringifyHint")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.source}
          onChange={(next) => onPatch({ source: next })}
          language="prompt"
          height={72}
        />
      </Field>
    </>
  );
}

/** 意图识别节点字段区（Coze Intent 式）：模型 + 识别内容 + 意图清单
 * （名称=分支输出通道，描述辅助模型分类）+ 兜底意图（从清单选） */
export function IntentNodeFields({
  node,
  onPatch,
}: {
  node: IntentNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);

  function patchIntent(
    index: number,
    part: Partial<IntentNode["intents"][number]>,
  ) {
    onPatch({
      intents: node.intents.map((intent, i) =>
        i === index ? { ...intent, ...part } : intent,
      ),
    });
  }

  return (
    <>
      <Field label={t("chat:orchestration.editor.model")}>
        <ModelSelect
          modelId={node.modelId}
          onSelect={(modelId) => onPatch({ modelId })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.intentQuery")}
        hint={t("chat:orchestration.editor.intentQueryHint")}
        className="col-span-full"
      >
        <Input
          className="h-8"
          placeholder="{{input.query}}"
          value={node.querySource}
          onChange={(e) => onPatch({ querySource: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.intentList")}
        hint={t("chat:orchestration.editor.intentListHint")}
        className="col-span-full"
      >
        <div className="flex flex-col gap-1.5">
          {node.intents.map((intent, index) => (
            <div key={index} className="flex items-center gap-1">
              <Input
                className="h-7 w-36 shrink-0 font-mono text-xs"
                placeholder={t("chat:orchestration.editor.intentName")}
                value={intent.name}
                onChange={(e) => patchIntent(index, { name: e.target.value })}
              />
              <Input
                className="h-7 min-w-0 flex-1 text-xs"
                placeholder={t("chat:orchestration.editor.intentDesc")}
                value={intent.description}
                onChange={(e) =>
                  patchIntent(index, { description: e.target.value })
                }
              />
              <button
                type="button"
                aria-label={t("chat:orchestration.editor.kvRemove")}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() =>
                  onPatch({
                    intents: node.intents.filter((_, i) => i !== index),
                  })
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-fit gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            onClick={() =>
              onPatch({
                intents: [...node.intents, { name: "", description: "" }],
              })
            }
          >
            {t("chat:orchestration.editor.intentAdd")}
          </Button>
        </div>
      </Field>
      <Field
        label={t("chat:orchestration.editor.intentFallback")}
        hint={t("chat:orchestration.editor.intentFallbackHint")}
        className="col-span-full"
      >
        <Select
          value={node.fallback ?? "__none__"}
          onValueChange={(value) =>
            onPatch({ fallback: value === "__none__" ? undefined : value })
          }
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="__none__">
              {t("chat:orchestration.editor.intentFallbackNone")}
            </SelectItem>
            {node.intents
              .filter((intent) => intent.name.trim() !== "")
              .map((intent) => (
                <SelectItem key={intent.name} value={intent.name}>
                  {intent.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("chat:orchestration.editor.timeoutSec")}
        hint={t("chat:orchestration.editor.intentTimeoutHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={86400}
          step={1}
          value={Math.round((node.timeoutMs ?? 60_000) / 1000)}
          onChange={(e) =>
            onPatch({ timeoutMs: timeoutSecToMs(e.target.value, 60_000) })
          }
        />
      </Field>
    </>
  );
}

/** 条件分支节点字段区（Coze Choice 式）：分支列表（名称 + 条件行
 * 「来源/运算符/值」AND 组合）+ 兜底分支名。分支名即画布输出通道 */
export function ConditionNodeFields({
  node,
  onPatch,
}: {
  node: ConditionNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);

  function patchBranch(index: number, next: ConditionBranch) {
    onPatch({
      branches: node.branches.map((b, i) => (i === index ? next : b)),
    });
  }

  return (
    <>
      <Field
        label={t("chat:orchestration.editor.condBranches")}
        hint={t("chat:orchestration.editor.condHint")}
        className="col-span-full"
      >
        <div className="flex flex-col gap-2">
          {node.branches.map((branch, branchIndex) => (
            <div
              key={branchIndex}
              className="flex flex-col gap-1.5 rounded-lg border border-border/50 p-2"
            >
              <div className="flex items-center gap-1">
                <Input
                  className="h-7 flex-1 text-xs"
                  value={branch.name}
                  onChange={(e) =>
                    patchBranch(branchIndex, {
                      ...branch,
                      name: e.target.value,
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={t("chat:orchestration.editor.condRemoveBranch")}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    onPatch({
                      branches: node.branches.filter(
                        (_, i) => i !== branchIndex,
                      ),
                    })
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {branch.conditions.map((cond, condIndex) => (
                <div key={condIndex} className="flex items-center gap-1">
                  <Input
                    className="h-7 flex-[2] font-mono text-xs"
                    placeholder="{{nodes.x.output}}"
                    value={cond.source}
                    onChange={(e) =>
                      patchBranch(branchIndex, {
                        ...branch,
                        conditions: branch.conditions.map((c, i) =>
                          i === condIndex
                            ? { ...c, source: e.target.value }
                            : c,
                        ),
                      })
                    }
                  />
                  <Select
                    value={cond.operator}
                    onValueChange={(value) =>
                      patchBranch(branchIndex, {
                        ...branch,
                        conditions: branch.conditions.map((c, i) =>
                          i === condIndex
                            ? {
                                ...c,
                                operator:
                                  value as ConditionBranch["conditions"][number]["operator"],
                              }
                            : c,
                        ),
                      })
                    }
                  >
                    <SelectTrigger className="h-7 w-[110px] shrink-0 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-lg border border-border/50 shadow-lg">
                      {CONDITION_OPERATORS.map((op) => (
                        <SelectItem key={op} value={op} className="text-xs">
                          {t(condOpKey(op))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {CONDITION_NEED_VALUE.has(cond.operator) ? (
                    <Input
                      className="h-7 flex-[2] font-mono text-xs"
                      placeholder="{{input.threshold}}"
                      value={cond.value ?? ""}
                      onChange={(e) =>
                        patchBranch(branchIndex, {
                          ...branch,
                          conditions: branch.conditions.map((c, i) =>
                            i === condIndex
                              ? {
                                  ...c,
                                  value:
                                    e.target.value === ""
                                      ? undefined
                                      : e.target.value,
                                }
                              : c,
                          ),
                        })
                      }
                    />
                  ) : null}
                  <button
                    type="button"
                    aria-label={t("chat:orchestration.editor.condRemoveCond")}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      patchBranch(branchIndex, {
                        ...branch,
                        conditions: branch.conditions.filter(
                          (_, i) => i !== condIndex,
                        ),
                      })
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="h-6 w-fit gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
                onClick={() =>
                  patchBranch(branchIndex, {
                    ...branch,
                    conditions: [
                      ...branch.conditions,
                      { source: "", operator: "notEmpty", value: undefined },
                    ],
                  })
                }
              >
                {t("chat:orchestration.editor.condAddCond")}
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-fit gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            onClick={() =>
              onPatch({
                branches: [
                  ...node.branches,
                  { name: `分支${node.branches.length + 1}`, conditions: [] },
                ],
              })
            }
          >
            {t("chat:orchestration.editor.condAddBranch")}
          </Button>
        </div>
      </Field>
      <Field
        label={t("chat:orchestration.editor.condFallback")}
        hint={t("chat:orchestration.editor.condFallbackHint")}
        className="col-span-full"
      >
        <Input
          className="h-8 text-xs"
          placeholder="其他"
          value={node.fallback ?? ""}
          onChange={(e) =>
            onPatch({
              fallback: e.target.value === "" ? undefined : e.target.value,
            })
          }
        />
      </Field>
    </>
  );
}

/** 文件写入节点字段区：路径 + 追加/覆盖 + 内容（{{}} 占位） */
export function FileWriteNodeFields({
  node,
  onPatch,
}: {
  node: FileWriteNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.fileWritePath")}
        hint={t("chat:orchestration.editor.fileWriteHint")}
        className="col-span-full"
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="docs/日报-{{date}}.md"
          value={node.path}
          onChange={(e) => onPatch({ path: e.target.value })}
        />
      </Field>
      <Field label={t("chat:orchestration.editor.fileWriteMode")}>
        <Select
          value={node.mode}
          onValueChange={(value) =>
            onPatch({ mode: value === "overwrite" ? "overwrite" : "append" })
          }
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="append">
              {t("chat:orchestration.editor.fileWriteAppend")}
            </SelectItem>
            <SelectItem value="overwrite">
              {t("chat:orchestration.editor.fileWriteOverwrite")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("chat:orchestration.editor.fileWriteContent")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.content}
          onChange={(next) => onPatch({ content: next })}
          language="prompt"
          height={96}
        />
      </Field>
    </>
  );
}

/** 文档提取节点字段区：路径 + 截断上限 */
export function DocExtractNodeFields({
  node,
  onPatch,
}: {
  node: DocExtractNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.docExtractPath")}
        hint={t("chat:orchestration.editor.docExtractHint")}
        className="col-span-full"
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="docs/report.pdf"
          value={node.path}
          onChange={(e) => onPatch({ path: e.target.value })}
        />
      </Field>
      <Field label={t("chat:orchestration.editor.docExtractMaxChars")}>
        <Input
          className="h-8"
          type="number"
          min={1000}
          max={512000}
          step={1000}
          value={node.maxChars}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 1000 && value <= 512000) {
              onPatch({ maxChars: value });
            }
          }}
        />
      </Field>
    </>
  );
}

/** ComfyUI 服务商选择（过滤 type=comfyui；空集引导去设置页添加）。
 * props 收 ImageGenNode 宽类型（编辑期 providerId 尚未选定，optional
 * 字段直读） */
function ComfyProviderSelect({
  node,
  onPatch,
}: {
  node: ImageGenNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const { data: providers = [] } = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const comfy = providers.filter((p) => p.type === "comfyui" && p.enabled);
  const current = comfy.find((p) => p.id === node.providerId);
  return (
    <Field
      label={t("chat:orchestration.editor.comfyProvider")}
      className="col-span-full"
    >
      <div className="flex flex-col gap-1">
        <Select
          value={current ? String(node.providerId) : ""}
          onValueChange={(value) => onPatch({ providerId: Number(value) })}
        >
          <SelectTrigger className="h-8 w-full">
            <SelectValue
              placeholder={t("chat:orchestration.editor.comfyProvider")}
            />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            {comfy.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {comfy.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("chat:orchestration.editor.comfyNoProvider")}
          </p>
        )}
      </div>
    </Field>
  );
}

/** 图像生成节点字段区：协议切换（openai 兼容/ComfyUI）+ 尺寸 + 提示词
 * （openai 形模型下拉复用 llm 的 ModelSelect；comfyui 形为服务商 +
 * workflow JSON + 随机种子）。分支判定读 protocol 而非 isComfyUIImageGen
 * ——后者要求 providerId/workflowJson 已配齐，刚切协议时 providerId 未
 * 选，守卫 false 会把 comfyui 形打回 openai 分支（永远选不了服务商） */
export function ImageGenNodeFields({
  node,
  onPatch,
}: {
  node: ImageGenNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const comfy = node.protocol === "comfyui";
  return (
    <>
      <Field label={t("chat:orchestration.editor.imageProtocol")}>
        <Select
          value={comfy ? "comfyui" : "openai"}
          onValueChange={(value) =>
            onPatch(
              value === "comfyui"
                ? {
                    protocol: "comfyui",
                    modelId: undefined,
                    providerId: undefined,
                    workflowJson: "",
                  }
                : {
                    protocol: "openai",
                    modelId: 0,
                    providerId: undefined,
                    workflowJson: undefined,
                  },
            )
          }
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="openai">
              {t("chat:orchestration.editor.imageProtocolOpenai")}
            </SelectItem>
            <SelectItem value="comfyui">ComfyUI</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {comfy ? (
        <>
          <ComfyProviderSelect node={node} onPatch={onPatch} />
          <Field
            label={t("chat:orchestration.editor.comfyWorkflow")}
            hint={t("chat:orchestration.editor.comfyWorkflowHint")}
            className="col-span-full"
          >
            <HighlightTextarea
              value={node.workflowJson ?? ""}
              onChange={(next) => onPatch({ workflowJson: next })}
              language="prompt"
              height={200}
            />
          </Field>
          <Field label={t("chat:orchestration.editor.comfyRandomSeed")}>
            <Switch
              checked={node.randomizeSeed}
              onCheckedChange={(v) => onPatch({ randomizeSeed: v })}
            />
          </Field>
        </>
      ) : (
        <Field label={t("chat:orchestration.editor.model")}>
          <ModelSelect
            modelId={node.modelId ?? 0}
            onSelect={(modelId) => onPatch({ modelId })}
          />
        </Field>
      )}
      <Field label={t("chat:orchestration.editor.imageSize")}>
        <Select
          value={node.size}
          onValueChange={(value) => onPatch({ size: value })}
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            {["1024x1024", "1024x1792", "1792x1024", "512x512"].map((size) => (
              <SelectItem key={size} value={size} className="font-mono text-xs">
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("chat:orchestration.editor.imagePrompt")}
        hint={t("chat:orchestration.editor.imagePromptHint")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.prompt}
          onChange={(next) => onPatch({ prompt: next })}
          language="prompt"
          height={72}
        />
      </Field>
    </>
  );
}

/** 延时节点字段区：秒数 */
export function DelayNodeFields({
  node,
  onPatch,
}: {
  node: DelayNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.delaySeconds")}
        hint={t("chat:orchestration.editor.delayHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={600}
          step={1}
          value={node.seconds}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= 600) {
              onPatch({ seconds: value });
            }
          }}
        />
      </Field>
    </>
  );
}

/** 开始节点字段区：变量列表（回写 inputSchema 由编辑器层 patchNode 分流
 *  收口，节点与图同一提交同步）；字段初始值从 inputSchema 键兜底
 *  （JSON 手改/AI 生成的图 node.variables 为空时保持一致回显） */
export function StartNodeFields({
  node,
  inputSchemaKeys,
  onPatch,
}: {
  node: StartNode;
  inputSchemaKeys: string[];
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const values = node.variables.length > 0 ? node.variables : inputSchemaKeys;
  return (
    <Field
      label={t("chat:orchestration.editor.variablesLabel")}
      hint={t("chat:orchestration.editor.variablesHint")}
      className="col-span-full"
    >
      <StringListInput
        values={values}
        placeholder={t("chat:orchestration.editor.variablePlaceholder")}
        onChange={(variables) => onPatch({ variables })}
      />
    </Field>
  );
}

/** 向量化入库节点字段区：集合/条目名 + 文本（占位符）+ Embedding 模型 +
 * 超时（秒呈现）+ 分块参数（模型下拉复用，用户须选 Embedding 类模型） */
export function VectorizeNodeFields({
  node,
  onPatch,
}: {
  node: VectorizeNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field label={t("chat:orchestration.editor.vectorCollection")}>
        <Input
          className="h-8 text-xs"
          placeholder="knowledge"
          value={node.collection}
          onChange={(e) => onPatch({ collection: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.vectorSourceName")}
        hint={t("chat:orchestration.editor.vectorHint")}
      >
        <Input
          className="h-8 text-xs"
          placeholder="{{input.file}} 或手册-A"
          value={node.sourceName}
          onChange={(e) => onPatch({ sourceName: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.vectorModel")}
        hint={t("chat:orchestration.editor.vectorModelHint")}
        className="col-span-full"
      >
        <ModelSelect
          modelId={node.modelId}
          onSelect={(modelId) => onPatch({ modelId })}
          filterType="embedding"
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.timeoutSec")}
        hint={t("chat:orchestration.editor.vectorTimeoutHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={600}
          step={1}
          value={Math.round((node.timeoutMs ?? 120_000) / 1000)}
          onChange={(e) =>
            onPatch({ timeoutMs: timeoutSecToMs(e.target.value, 120_000) })
          }
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.vectorText")}
        hint={t("chat:orchestration.editor.vectorTextHint")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.text}
          onChange={(next) => onPatch({ text: next })}
          language="prompt"
          height={72}
        />
      </Field>
      <Field label={t("chat:orchestration.editor.vectorChunkSize")}>
        <Input
          className="h-8"
          type="number"
          min={100}
          max={4000}
          step={50}
          value={node.chunkSize}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 100 && value <= 4000) {
              onPatch({ chunkSize: value });
            }
          }}
        />
      </Field>
      <Field label={t("chat:orchestration.editor.vectorChunkOverlap")}>
        <Input
          className="h-8"
          type="number"
          min={0}
          max={500}
          step={10}
          value={node.chunkOverlap}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 0 && value <= 500) {
              onPatch({ chunkOverlap: value });
            }
          }}
        />
      </Field>
    </>
  );
}

/** 语义检索节点字段区：集合（空=全部）+ 检索词 + 模型 + 超时 + topK */
export function VectorSearchNodeFields({
  node,
  onPatch,
}: {
  node: VectorSearchNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.vectorCollection")}
        hint={t("chat:orchestration.editor.vectorSearchHint")}
      >
        <Input
          className="h-8 text-xs"
          placeholder={t("chat:orchestration.editor.vectorAllCollections")}
          value={node.collection}
          onChange={(e) => onPatch({ collection: e.target.value })}
        />
      </Field>
      <Field label={t("chat:orchestration.editor.vectorTopK")}>
        <Input
          className="h-8"
          type="number"
          min={1}
          max={20}
          step={1}
          value={node.topK}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= 20) {
              onPatch({ topK: value });
            }
          }}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.vectorModel")}
        hint={t("chat:orchestration.editor.vectorModelHint")}
        className="col-span-full"
      >
        <ModelSelect
          modelId={node.modelId}
          onSelect={(modelId) => onPatch({ modelId })}
          filterType="embedding"
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.timeoutSec")}
        hint={t("chat:orchestration.editor.vectorTimeoutHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={600}
          step={1}
          value={Math.round((node.timeoutMs ?? 120_000) / 1000)}
          onChange={(e) =>
            onPatch({ timeoutMs: timeoutSecToMs(e.target.value, 120_000) })
          }
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.vectorQuery")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.searchQuery}
          onChange={(next) => onPatch({ searchQuery: next })}
          language="prompt"
          height={72}
        />
      </Field>
    </>
  );
}

/** 数据库节点字段区：引擎下拉（SQLite 显路径 / C/S 四家显连接）+ SQL
 * 高亮框 + 参数化列表；端口随引擎切换默认值 */
export function DatabaseNodeFields({
  node,
  onPatch,
}: {
  node: DatabaseNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const DEFAULT_PORTS: Record<string, number> = {
    postgres: 5432,
    mysql: 3306,
    oracle: 1521,
    sqlserver: 1433,
  };
  return (
    <>
      <Field label={t("chat:orchestration.editor.dbEngine")}>
        <Select
          value={node.engine}
          onValueChange={(value) => {
            const engine = value as DatabaseNode["engine"];
            onPatch({
              engine,
              ...(DEFAULT_PORTS[engine] ? { port: DEFAULT_PORTS[engine] } : {}),
            });
          }}
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            {["sqlite", "postgres", "mysql", "oracle", "sqlserver"].map(
              (engine) => (
                <SelectItem key={engine} value={engine} className="text-xs">
                  {t(`chat:orchestration.editor.dbEngineName.${engine}`)}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </Field>
      {node.engine === "sqlite" ? (
        <Field
          label={t("chat:orchestration.editor.dbSqlitePath")}
          hint={t("chat:orchestration.editor.dbSqliteHint")}
          className="col-span-full"
        >
          <Input
            className="h-8 font-mono text-xs"
            placeholder="data/app.db"
            value={node.sqlitePath}
            onChange={(e) => onPatch({ sqlitePath: e.target.value })}
          />
        </Field>
      ) : (
        <>
          <Field label={t("chat:orchestration.editor.dbHost")}>
            <Input
              className="h-8 font-mono text-xs"
              placeholder="{{input.dbHost}}"
              value={node.host}
              onChange={(e) => onPatch({ host: e.target.value })}
            />
          </Field>
          <Field label={t("chat:orchestration.editor.dbPort")}>
            <Input
              className="h-8"
              type="number"
              min={1}
              max={65535}
              value={node.port}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 65535) {
                  onPatch({ port: value });
                }
              }}
            />
          </Field>
          <Field label={t("chat:orchestration.editor.dbName")}>
            <Input
              className="h-8 font-mono text-xs"
              value={node.database}
              onChange={(e) => onPatch({ database: e.target.value })}
            />
          </Field>
          <Field label={t("chat:orchestration.editor.dbUser")}>
            <Input
              className="h-8 font-mono text-xs"
              value={node.username}
              onChange={(e) => onPatch({ username: e.target.value })}
            />
          </Field>
          <Field
            label={t("chat:orchestration.editor.dbPassword")}
            className="col-span-full"
          >
            <Input
              className="h-8 font-mono text-xs"
              type="password"
              placeholder="{{input.dbPassword}}"
              value={node.password}
              onChange={(e) => onPatch({ password: e.target.value })}
            />
          </Field>
        </>
      )}
      <Field
        label={t("chat:orchestration.editor.dbSql")}
        hint={t("chat:orchestration.editor.dbSqlHint")}
        className="col-span-full"
      >
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className={TOOLBAR_BUTTON_CLASS}
            onClick={() => {
              onPatch({
                sql:
                  node.engine === "sqlite"
                    ? "SELECT * FROM users WHERE id = ?"
                    : node.engine === "postgres"
                      ? "SELECT * FROM users WHERE id = $1"
                      : node.engine === "oracle"
                        ? "SELECT * FROM users WHERE id = :1"
                        : "SELECT * FROM users WHERE id = @param",
              });
            }}
          >
            {t("chat:orchestration.editor.dbSqlExample")}
          </Button>
        </div>
        <HighlightTextarea
          value={node.sql}
          onChange={(next) => onPatch({ sql: next })}
          language="prompt"
          height={96}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.dbParams")}
        hint={t("chat:orchestration.editor.dbParamsHint")}
        className="col-span-full"
      >
        <StringListInput
          values={node.params}
          placeholder="{{input.userId}}"
          allowDuplicates
          onChange={(next) => onPatch({ params: next })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.dbMaxRows")}
        hint={t("chat:orchestration.editor.dbMaxRowsHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={100000}
          step={100}
          value={node.maxRows}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= 100000) {
              onPatch({ maxRows: value });
            }
          }}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.dbBatchSource")}
        hint={t("chat:orchestration.editor.dbBatchHint")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.batchSource}
          onChange={(next) => onPatch({ batchSource: next })}
          language="prompt"
          height={72}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.retriesLabel")}
        hint={t("chat:orchestration.editor.dbRetriesHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={0}
          max={5}
          step={1}
          value={node.retries ?? 0}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 0 && value <= 5) {
              onPatch({ retries: value });
            }
          }}
        />
      </Field>
    </>
  );
}

/** Excel 读取节点字段区：文件路径 + sheet 名 */
export function ExcelReadNodeFields({
  node,
  onPatch,
}: {
  node: ExcelReadNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.excelPath")}
        hint={t("chat:orchestration.editor.excelReadHint")}
        className="col-span-full"
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="data/订单.xlsx"
          value={node.path}
          onChange={(e) => onPatch({ path: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.excelSheet")}
        className="col-span-full"
      >
        <Input
          className="h-8 text-xs"
          placeholder={t("chat:orchestration.editor.excelFirstSheet")}
          value={node.sheet}
          onChange={(e) =>
            onPatch({ sheet: e.target.value === "" ? "" : e.target.value })
          }
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.rowsLimitLabel")}
        hint={t("chat:orchestration.editor.excelMaxRowsHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={100000}
          step={100}
          value={node.maxRows ?? 1000}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= 100000) {
              onPatch({ maxRows: value });
            }
          }}
        />
      </Field>
    </>
  );
}

/** Excel 写入节点字段区：文件路径 + sheet 名 + 行数据（JSON 数组） */
export function ExcelWriteNodeFields({
  node,
  onPatch,
}: {
  node: ExcelWriteNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.excelPath")}
        hint={t("chat:orchestration.editor.excelWriteHint")}
        className="col-span-full"
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="out/报表-{{date}}.xlsx"
          value={node.path}
          onChange={(e) => onPatch({ path: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.excelSheet")}
        className="col-span-full"
      >
        <Input
          className="h-8 text-xs"
          value={node.sheet}
          onChange={(e) => onPatch({ sheet: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.excelRows")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.rowsSource}
          onChange={(next) => onPatch({ rowsSource: next })}
          language="prompt"
          height={96}
        />
      </Field>
    </>
  );
}

/** CSV 读取字段区：路径（限工作空间）+ 分隔符 + 行数上限（熔断） */
export function CsvReadNodeFields({
  node,
  onPatch,
}: {
  node: CsvReadNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.csvPath")}
        hint={t("chat:orchestration.editor.csvReadHint")}
        className="col-span-full"
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="data/订单.csv"
          value={node.path}
          onChange={(e) => onPatch({ path: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.csvDelimiter")}
        hint={t("chat:orchestration.editor.csvDelimiterHint")}
      >
        <Select
          value={node.delimiter}
          onValueChange={(value) =>
            onPatch({
              delimiter:
                value === "semicolon" || value === "tab" ? value : "comma",
            })
          }
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
            <SelectItem value="comma">
              {t("chat:orchestration.editor.csvDelimiterComma")}
            </SelectItem>
            <SelectItem value="semicolon">
              {t("chat:orchestration.editor.csvDelimiterSemicolon")}
            </SelectItem>
            <SelectItem value="tab">
              {t("chat:orchestration.editor.csvDelimiterTab")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("chat:orchestration.editor.csvMaxRows")}
        hint={t("chat:orchestration.editor.csvMaxRowsHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={100000}
          step={100}
          value={node.maxRows}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= 100000) {
              onPatch({ maxRows: value });
            }
          }}
        />
      </Field>
    </>
  );
}

/** CSV 写入字段区：路径 + 行数据（JSON 数组，{{}} 占位，excelWrite 同款） */
export function CsvWriteNodeFields({
  node,
  onPatch,
}: {
  node: CsvWriteNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.csvPath")}
        hint={t("chat:orchestration.editor.csvWriteHint")}
        className="col-span-full"
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="out/报表-{{date}}.csv"
          value={node.path}
          onChange={(e) => onPatch({ path: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.csvRows")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.rowsSource}
          onChange={(next) => onPatch({ rowsSource: next })}
          language="prompt"
          height={96}
        />
      </Field>
    </>
  );
}

/** 变量节点字段区：多变量赋值行（变量名 + 来源 + 顺序操作链），操作行
 * = 类型下拉 + 参数输入（replace/slice/default/append 带参） */
export function VariableNodeFields({
  node,
  onPatch,
}: {
  node: VariableNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const OP_TYPES: VariableTransform["type"][] = [
    "trim",
    "upper",
    "lower",
    "replace",
    "slice",
    "default",
    "append",
    "toNumber",
    "now",
    "dateAdd",
    "dateFormat",
  ];

  function patchAssignment(
    index: number,
    part: Partial<VariableNode["assignments"][number]>,
  ) {
    onPatch({
      assignments: node.assignments.map((item, i) =>
        i === index ? { ...item, ...part } : item,
      ),
    });
  }
  function patchOp(
    assignmentIndex: number,
    opIndex: number,
    next: VariableTransform,
  ) {
    patchAssignment(assignmentIndex, {
      ops: node.assignments[assignmentIndex].ops.map((op, i) =>
        i === opIndex ? next : op,
      ),
    });
  }

  return (
    <>
      <Field
        label={t("chat:orchestration.editor.varAssignments")}
        hint={t("chat:orchestration.editor.varAssignmentsHint")}
        className="col-span-full"
      >
        <div className="flex flex-col gap-2">
          {node.assignments.map((assignment, index) => (
            <div key={index} className="rounded-lg border border-border/50 p-2">
              <div className="flex items-center gap-1">
                <Input
                  className="h-7 w-28 shrink-0 font-mono text-xs"
                  placeholder={t("chat:orchestration.editor.varName")}
                  value={assignment.name}
                  onChange={(e) =>
                    patchAssignment(index, { name: e.target.value })
                  }
                />
                <Input
                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                  placeholder="{{input.x}}"
                  value={assignment.source}
                  onChange={(e) =>
                    patchAssignment(index, { source: e.target.value })
                  }
                />
                <button
                  type="button"
                  aria-label={t("chat:orchestration.editor.kvRemove")}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    onPatch({
                      assignments: node.assignments.filter(
                        (_, i) => i !== index,
                      ),
                    })
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-1.5 flex flex-col gap-1 pl-1">
                {assignment.ops.map((op, opIndex) => (
                  <div key={opIndex} className="flex items-center gap-1">
                    <Select
                      value={op.type}
                      onValueChange={(value) =>
                        patchOp(index, opIndex, {
                          type: value as VariableTransform["type"],
                        } as VariableTransform)
                      }
                    >
                      <SelectTrigger className="h-7 w-[7.5rem] shrink-0 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="rounded-lg border border-border/50 shadow-lg">
                        {OP_TYPES.map((type) => (
                          <SelectItem
                            key={type}
                            value={type}
                            className="text-xs"
                          >
                            {t(`chat:orchestration.editor.varOp.${type}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {op.type === "replace" && (
                      <>
                        <Input
                          className="h-7 w-24 font-mono text-xs"
                          placeholder={t("chat:orchestration.editor.varOpFind")}
                          value={op.find}
                          onChange={(e) =>
                            patchOp(index, opIndex, {
                              ...op,
                              find: e.target.value,
                            })
                          }
                        />
                        <Input
                          className="h-7 min-w-0 flex-1 font-mono text-xs"
                          placeholder={t(
                            "chat:orchestration.editor.varOpReplacement",
                          )}
                          value={op.replacement}
                          onChange={(e) =>
                            patchOp(index, opIndex, {
                              ...op,
                              replacement: e.target.value,
                            })
                          }
                        />
                      </>
                    )}
                    {op.type === "slice" && (
                      <>
                        <Input
                          className="h-7 w-16 text-xs"
                          type="number"
                          min={0}
                          value={op.start}
                          onChange={(e) =>
                            patchOp(index, opIndex, {
                              ...op,
                              start: Number(e.target.value) || 0,
                            })
                          }
                        />
                        <Input
                          className="h-7 w-16 text-xs"
                          type="number"
                          min={0}
                          placeholder="end"
                          value={op.end ?? ""}
                          onChange={(e) =>
                            patchOp(index, opIndex, {
                              ...op,
                              end:
                                e.target.value === ""
                                  ? undefined
                                  : Number(e.target.value),
                            })
                          }
                        />
                      </>
                    )}
                    {op.type === "dateFormat" && (
                      <Input
                        className="h-7 min-w-0 flex-1 font-mono text-xs"
                        placeholder="yyyy-MM-dd"
                        value={op.format}
                        onChange={(e) =>
                          patchOp(index, opIndex, {
                            ...op,
                            format: e.target.value,
                          })
                        }
                      />
                    )}
                    {op.type === "dateAdd" && (
                      <>
                        <Input
                          className="h-7 w-16 text-xs"
                          type="number"
                          value={op.amount}
                          onChange={(e) =>
                            patchOp(index, opIndex, {
                              ...op,
                              amount: Number(e.target.value) || 0,
                            })
                          }
                        />
                        <Select
                          value={op.unit}
                          onValueChange={(value) =>
                            patchOp(index, opIndex, {
                              ...op,
                              unit: value as typeof op.unit,
                            })
                          }
                        >
                          <SelectTrigger className="h-7 w-[6.5rem] shrink-0 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="rounded-lg border border-border/50 shadow-lg">
                            {(
                              ["minutes", "hours", "days", "months"] as const
                            ).map((unit) => (
                              <SelectItem
                                key={unit}
                                value={unit}
                                className="text-xs"
                              >
                                {t(
                                  `chat:orchestration.editor.varDateUnit.${unit}`,
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </>
                    )}
                    {(op.type === "default" || op.type === "append") && (
                      <Input
                        className="h-7 min-w-0 flex-1 text-xs"
                        value={op.type === "default" ? op.value : op.text}
                        onChange={(e) =>
                          patchOp(index, opIndex, {
                            ...op,
                            ...(op.type === "default"
                              ? { value: e.target.value }
                              : { text: e.target.value }),
                          } as VariableTransform)
                        }
                      />
                    )}
                    <button
                      type="button"
                      aria-label={t("chat:orchestration.editor.kvRemove")}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        patchAssignment(index, {
                          ops: assignment.ops.filter((_, i) => i !== opIndex),
                        })
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-fit gap-1 px-2 text-xs text-muted-foreground hover:text-primary"
                  onClick={() =>
                    patchAssignment(index, {
                      ops: [...assignment.ops, { type: "trim" }],
                    })
                  }
                >
                  {t("chat:orchestration.editor.varOpAdd")}
                </Button>
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-fit gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            onClick={() =>
              onPatch({
                assignments: [
                  ...node.assignments,
                  { name: "", source: "", ops: [] },
                ],
              })
            }
          >
            {t("chat:orchestration.editor.varAdd")}
          </Button>
        </div>
      </Field>
    </>
  );
}

/** 聚合统计字段区：来源 + 操作行（类型下拉 + 数值字段名可选） */
export function AggregateNodeFields({
  node,
  onPatch,
}: {
  node: AggregateNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const NEED_FIELD: Record<string, "required" | "optional"> = {
    sum: "required",
    avg: "required",
    min: "required",
    max: "required",
    groupByCount: "required",
    distinctCount: "optional",
  };

  function patchOp(index: number, next: Partial<AggregateOp>) {
    onPatch({
      ops: node.ops.map((op, i) =>
        i === index ? ({ ...op, ...next } as AggregateOp) : op,
      ),
    });
  }

  return (
    <>
      <Field
        label={t("chat:orchestration.editor.aggSource")}
        hint={t("chat:orchestration.editor.aggSourceHint")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.source}
          onChange={(next) => onPatch({ source: next })}
          language="prompt"
          height={72}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.aggOps")}
        hint={t("chat:orchestration.editor.aggOpsHint")}
        className="col-span-full"
      >
        <div className="flex flex-col gap-1.5">
          {node.ops.map((op, index) => (
            <div key={index} className="flex items-center gap-1">
              <Select
                value={op.type}
                onValueChange={(value) =>
                  patchOp(index, { type: value as AggregateOp["type"] })
                }
              >
                <SelectTrigger className="h-7 w-[8.5rem] shrink-0 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-lg border border-border/50 shadow-lg">
                  {[
                    "count",
                    "sum",
                    "avg",
                    "min",
                    "max",
                    "distinctCount",
                    "groupByCount",
                  ].map((type) => (
                    <SelectItem key={type} value={type} className="text-xs">
                      {t(`chat:orchestration.editor.aggOp.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {NEED_FIELD[op.type] && (
                <Input
                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                  placeholder={
                    NEED_FIELD[op.type] === "required"
                      ? t("chat:orchestration.editor.aggField")
                      : t("chat:orchestration.editor.aggFieldOptional")
                  }
                  value={"field" in op ? (op.field ?? "") : ""}
                  onChange={(e) =>
                    patchOp(index, { field: e.target.value || undefined })
                  }
                />
              )}
              <button
                type="button"
                aria-label={t("chat:orchestration.editor.kvRemove")}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() =>
                  onPatch({ ops: node.ops.filter((_, i) => i !== index) })
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-fit gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            onClick={() => onPatch({ ops: [...node.ops, { type: "count" }] })}
          >
            {t("chat:orchestration.editor.aggOpAdd")}
          </Button>
        </div>
      </Field>
    </>
  );
}

/** 邮件字段区：SMTP 连接（host/port/SSL/账号）+ 发件内容（from/to/
 * subject/body，{{}} 占位） */
export function EmailNodeFields({
  node,
  onPatch,
}: {
  node: EmailNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.emailHost")}
        className="col-span-full"
      >
        <Input
          className="h-8 font-mono text-xs"
          placeholder="smtp.example.com"
          value={node.host}
          onChange={(e) => onPatch({ host: e.target.value })}
        />
      </Field>
      <Field label={t("chat:orchestration.editor.emailPort")}>
        <Input
          className="h-8"
          type="number"
          min={1}
          max={65535}
          value={node.port}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= 65535) {
              onPatch({ port: value });
            }
          }}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.emailSecure")}
        hint={t("chat:orchestration.editor.emailSecureHint")}
      >
        <div className="flex h-8 items-center gap-2">
          <Switch
            checked={node.secure}
            onCheckedChange={(on) => onPatch({ secure: on })}
          />
          <span className="text-xs text-muted-foreground">
            {node.secure ? "SSL (465)" : "STARTTLS (587)"}
          </span>
        </div>
      </Field>
      <Field label={t("chat:orchestration.editor.emailUsername")}>
        <Input
          className="h-8"
          value={node.username}
          onChange={(e) => onPatch({ username: e.target.value })}
        />
      </Field>
      <Field label={t("chat:orchestration.editor.emailPassword")}>
        <Input
          className="h-8"
          type="password"
          placeholder="{{input.smtpPass}}"
          value={node.password}
          onChange={(e) => onPatch({ password: e.target.value })}
        />
      </Field>
      <Field label={t("chat:orchestration.editor.emailFrom")}>
        <Input
          className="h-8"
          placeholder="bot@example.com"
          value={node.from}
          onChange={(e) => onPatch({ from: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.emailTo")}
        hint={t("chat:orchestration.editor.emailToHint")}
        className="col-span-full"
      >
        <Input
          className="h-8"
          placeholder="a@x.com, {{input.cc}}"
          value={node.to}
          onChange={(e) => onPatch({ to: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.emailSubject")}
        className="col-span-full"
      >
        <Input
          className="h-8"
          placeholder="日报 {{date}}"
          value={node.subject}
          onChange={(e) => onPatch({ subject: e.target.value })}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.emailBody")}
        hint={t("chat:orchestration.editor.emailBodyHint")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.body}
          onChange={(next) => onPatch({ body: next })}
          language="prompt"
          height={96}
        />
      </Field>
      <Field
        label={t("chat:orchestration.editor.retriesLabel")}
        hint={t("chat:orchestration.editor.emailRetriesHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={0}
          max={5}
          step={1}
          value={node.retries ?? 0}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isInteger(value) && value >= 0 && value <= 5) {
              onPatch({ retries: value });
            }
          }}
        />
      </Field>
    </>
  );
}

/** 聚合节点字段区：模板（多上游 {{nodes.*.output}} 拼合） */
export function MergeNodeFields({
  node,
  onPatch,
}: {
  node: MergeNode;
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.mergeTemplate")}
        hint={t("chat:orchestration.editor.mergeHint")}
        className="col-span-full"
      >
        <HighlightTextarea
          value={node.template}
          onChange={(next) => onPatch({ template: next })}
          language="prompt"
          height={96}
        />
      </Field>
    </>
  );
}
