// src-react/domains/ai/orchestration/components/NodePropertiesPanel.tsx
/**
 * 选中驱动属性面板（spec §3）三分支：图级（未选中/选中物已失效——图名称/
 * 描述；输入变量编辑已迁 start 节点字段区，回写 inputSchema 由编辑器层
 * 收口）、节点（顶栏 id Badge + kind 切换 + 删除钮；
 * id 锁定语义同原结构化卡片：保存过的 id 不可改，编辑期失焦提交并同步边
 * 引用）、边（selectedId 即 toCanvas 稳定串 `${from}->${to}:${label}`，
 * edgeIdToRef 反解 + 与 graph.edges 比对还原；from/to 只读，源为 branch
 * 节点时条件下拉 ⊆ 其 branchOptions +「无条件」清空项）。字段表单复用
 * GraphNodeEditor 的 LlmNodeFields/CodeNodeFields/Field/StringListInput，
 * 状态源唯一（GraphEditorView 持有 GraphJson）。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";

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
import {
  branchOptionsOf,
  type GraphEdge,
  type GraphJson,
  type GraphNode,
} from "../api/graph.schema";
import { edgeIdToRef } from "../lib/graph-canvas-model";
import {
  NODE_ID_PATTERN,
  type GraphNodePatch,
  type NodeKind,
} from "../lib/graph-editor-model";
import { nodeFieldsOf, Field } from "./GraphNodeEditor";

export interface NodePropertiesPanelProps {
  graph: GraphJson;
  /** 图级分支的名称/描述受控值（GraphJson 外的独立草稿态） */
  name: string;
  description: string;
  /** 节点 id 或边稳定 id；null = 图级 */
  selectedId: string | null;
  onPatchNode: (nodeId: string, patch: GraphNodePatch) => void;
  onSwitchKind: (nodeId: string, kind: NodeKind) => void;
  onRenameNode: (nodeId: string, nextId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  /** 条件改写：undefined = 清除（无条件边） */
  onPatchEdgeCondition: (edgeId: string, value: string | undefined) => void;
  onGraphMeta: (patch: { name?: string; description?: string }) => void;
  idLocked: (nodeId: string) => boolean;
}

/** 边稳定串 ⇄ GraphJson 边匹配（label ⇔ condition.value，缺省空串） */
export function edgeRefMatches(
  edge: GraphEdge,
  ref: { from: string; to: string; label?: string },
): boolean {
  return (
    edge.from === ref.from &&
    edge.to === ref.to &&
    (edge.condition?.value ?? "") === (ref.label ?? "")
  );
}

/** 条件下拉的「无条件」哨兵值（Radix Select 不接受空串 value） */
const NO_CONDITION = "__none__";

export default function NodePropertiesPanel({
  graph,
  name,
  description,
  selectedId,
  onPatchNode,
  onSwitchKind,
  onRenameNode,
  onRemoveNode,
  onRemoveEdge,
  onPatchEdgeCondition,
  onGraphMeta,
  idLocked,
}: NodePropertiesPanelProps) {
  const node = graph.nodes.find((item) => item.id === selectedId);
  const edge =
    node || !selectedId
      ? undefined
      : graph.edges.find((item) =>
          edgeRefMatches(item, edgeIdToRef(selectedId)),
        );

  return (
    <div className="flex flex-col gap-3 p-3">
      {node ? (
        <NodeBranch
          node={node}
          graph={graph}
          idLocked={idLocked(node.id)}
          onPatch={(patch) => onPatchNode(node.id, patch)}
          onSwitchKind={(kind) => onSwitchKind(node.id, kind)}
          onRename={(nextId) => onRenameNode(node.id, nextId)}
          onRemove={() => onRemoveNode(node.id)}
        />
      ) : edge && selectedId ? (
        <EdgeBranch
          edge={edge}
          graph={graph}
          onPatchCondition={(value) => onPatchEdgeCondition(selectedId, value)}
          onRemove={() => onRemoveEdge(selectedId)}
        />
      ) : (
        <GraphBranch
          name={name}
          description={description}
          onGraphMeta={onGraphMeta}
        />
      )}
    </div>
  );
}

/** 图级分支：名称/描述 Input（输入变量编辑在 start 节点字段区，回写
 *  inputSchema 由编辑器层收口） */
function GraphBranch({
  name,
  description,
  onGraphMeta,
}: {
  name: string;
  description: string;
  onGraphMeta: NodePropertiesPanelProps["onGraphMeta"];
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <section className="grid grid-cols-1 gap-x-3 gap-y-3 @[400px]:grid-cols-2 @[720px]:grid-cols-3">
      <p className="col-span-full text-xs font-medium text-muted-foreground">
        {t("chat:orchestration.editor.panelGraphTitle")}
      </p>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">
          {t("chat:orchestration.editor.nameLabel")}
        </Label>
        <Input
          className="h-8"
          value={name}
          placeholder={t("chat:orchestration.editor.namePlaceholder")}
          onChange={(e) => onGraphMeta({ name: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">
          {t("chat:orchestration.editor.descriptionLabel")}
        </Label>
        <Input
          className="h-8"
          value={description}
          placeholder={t("chat:orchestration.editor.descriptionPlaceholder")}
          onChange={(e) => onGraphMeta({ description: e.target.value })}
        />
      </div>
    </section>
  );
}

/** 节点分支：顶栏 id Badge + kind 切换 + 删除钮；id（锁定语义同结构化
 * 卡片）/名称 + llm/code 分流字段（GraphNodeEditor 复用） */
function NodeBranch({
  node,
  graph,
  idLocked,
  onPatch,
  onSwitchKind,
  onRename,
  onRemove,
}: {
  node: GraphNode;
  graph: GraphJson;
  idLocked: boolean;
  onPatch: (patch: GraphNodePatch) => void;
  onSwitchKind: (kind: NodeKind) => void;
  onRename: (nextId: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const [idDraft, setIdDraft] = useState(node.id);
  useEffect(() => {
    setIdDraft(node.id);
  }, [node.id]);
  const idInvalid =
    idDraft !== node.id &&
    (!NODE_ID_PATTERN.test(idDraft) ||
      graph.nodes.some((item) => item.id === idDraft));

  function commitId() {
    if (!idInvalid && idDraft !== node.id) {
      onRename(idDraft);
    } else {
      setIdDraft(node.id);
    }
  }

  return (
    <section className="grid grid-cols-1 gap-x-3 gap-y-2 @[400px]:grid-cols-2 @[720px]:grid-cols-3 @[1040px]:grid-cols-4">
      <div className="col-span-full flex items-center gap-2">
        <Badge variant="secondary" className="font-mono">
          {node.id}
        </Badge>
        {/* start 不可切换为其它 kind（图级唯一入口，编辑变量而非转型；
            选项表本就不含 start——不可从其它 kind 切成 start */}
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
                "csvRead",
                "csvWrite",
                "variable",
                "aggregate",
                "email",
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
            <SelectItem value="intent">
              {t("chat:orchestration.editor.kindIntent")}
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
            <SelectItem value="csvRead">
              {t("chat:orchestration.editor.kindCsvRead")}
            </SelectItem>
            <SelectItem value="csvWrite">
              {t("chat:orchestration.editor.kindCsvWrite")}
            </SelectItem>
            <SelectItem value="variable">
              {t("chat:orchestration.editor.kindVariable")}
            </SelectItem>
            <SelectItem value="aggregate">
              {t("chat:orchestration.editor.kindAggregate")}
            </SelectItem>
            <SelectItem value="email">
              {t("chat:orchestration.editor.kindEmail")}
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
      {nodeFieldsOf(node, onPatch, Object.keys(graph.inputSchema))}
    </section>
  );
}

/** 边分支：from/to 只读；源为 branch 节点时条件下拉（含「无条件」清空
 * 项），非 branch 源只读「无条件」；删除边。当前条件值不在选项内（校验
 * 问题态）仍可见可改（追加为末项） */
function EdgeBranch({
  edge,
  graph,
  onPatchCondition,
  onRemove,
}: {
  edge: GraphEdge;
  graph: GraphJson;
  onPatchCondition: (value: string | undefined) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const source = graph.nodes.find((item) => item.id === edge.from);
  // 分支源统一出口（condition/intent/llm·code branch——与画布条件边、
  // validateGraph 同规），非分支源只读「无条件」
  const options = source ? (branchOptionsOf(source) ?? []) : [];
  const current = edge.condition?.value;
  const choices =
    current && !options.includes(current) ? [...options, current] : options;

  return (
    <section className="flex flex-col gap-3">
      <p className="text-xs font-medium text-muted-foreground">
        {t("chat:orchestration.editor.panelEdge")}
      </p>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">
          {t("chat:orchestration.editor.edgeFrom")}
        </Label>
        <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
          {edge.from}
        </code>
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">
          {t("chat:orchestration.editor.edgeTo")}
        </Label>
        <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
          {edge.to}
        </code>
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">
          {t("chat:orchestration.editor.edgeCondition")}
        </Label>
        {options.length > 0 ? (
          <Select
            value={current ?? NO_CONDITION}
            onValueChange={(value) =>
              onPatchCondition(value === NO_CONDITION ? undefined : value)
            }
          >
            <SelectTrigger className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-lg border border-border/50 shadow-lg">
              <SelectItem value={NO_CONDITION}>
                {t("chat:orchestration.editor.noCondition")}
              </SelectItem>
              {choices.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("chat:orchestration.editor.noCondition")}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-fit px-2 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" />
        {t("chat:orchestration.editor.removeEdge")}
      </Button>
    </section>
  );
}
