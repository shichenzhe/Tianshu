// src-react/domains/ai/orchestration/views/GraphEditorView.tsx
/**
 * 编排图编辑器（spec §3-§4，Task 3 画布改造）：画布（默认主模式——
 * GraphCanvas + 右侧选中驱动 NodePropertiesPanel）⇄ JSON 源码双模式双向
 * 同步，两模式共用校验出口（validateGraph/validateRaw → 摘要行默认收起
 * 的校验清单，保存被拦时 toast + 自动展开；带节点定位的错误条目点击 →
 * setCenter 定位 + 选中）；保存 = 校验通过且
 * 相对基线有变更——new 走 create 后 replace 到 graphs/:id，既有图 update
 * 携 version 乐观锁（VERSION_CONFLICT → 提示并失效重拉）；模板经
 * location.state.graphTemplate 预填（modelId 0 占位，编辑器不校验模型
 * 归属，用户自行换）；保存过的节点 id 锁定（重命名牵连边引用）。
 * Task 14：顶栏加「试运行」（inputSchema 变量表单 + workspace 下拉）与
 * 「运行历史」（分页 + 行展开节点轨迹）两弹窗——均仅已保存图可用。
 */
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ChevronsRight,
  Copy,
  FlaskConical,
  History,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  Redo2,
  Save,
  Settings2,
  Undo2,
  Webhook,
  Wand2,
  Download,
} from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";

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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { on } from "@/lib/ipc";
import { usePageHeader } from "@/components/layout/page-header.store";
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import {
  normalizeGraph,
  validateGraph,
  type GraphIssue,
  type GraphJson,
  type GraphNode,
} from "../api/graph.schema";
import {
  GraphApi,
  NODE_STATUS_EVENT,
  type GraphRecord,
  type GraphTemplate,
} from "../api/orchestration.api";
import GraphCanvas from "../components/GraphCanvas";
import GraphJsonEditor from "../components/GraphJsonEditor";
import GraphRunHistoryDialog from "../components/GraphRunHistoryDialog";
import GraphTestRunDialog from "../components/GraphTestRunDialog";
import HighlightTextarea from "../components/HighlightTextarea";
import { GraphHasStartContext } from "../components/AddNodeMenu";
import NodePropertiesPanel, {
  edgeRefMatches,
} from "../components/NodePropertiesPanel";
import {
  applyPositions,
  autoLayout,
  connectEdge,
  edgeIdToRef,
  END_NODE_ID,
  layoutOf,
} from "../lib/graph-canvas-model";
import {
  canonicalJson,
  dedupeUniqueEntry,
  draftChanged,
  emptyGraph,
  localizeGraphIssue,
  newCodeNode,
  newConditionNode,
  newIntentNode,
  newDelayNode,
  newVectorizeNode,
  newVectorSearchNode,
  newDatabaseNode,
  newExcelReadNode,
  newExcelWriteNode,
  newCsvReadNode,
  newCsvWriteNode,
  newVariableNode,
  newAggregateNode,
  newEmailNode,
  newMergeNode,
  newDocExtractNode,
  newFileReadNode,
  newFileWriteNode,
  newHttpNode,
  newImageGenNode,
  newIterateNode,
  newLibrarySearchNode,
  newJsonParseNode,
  newJsonStringifyNode,
  newNode,
  newNotifyNode,
  newStartNode,
  newSubflowNode,
  nextNodeId,
  parseOrKeep,
  patchStartVariables,
  readTemplatePrefill,
  removeNode as removeNodeFromGraph,
  renameNode,
  serializeGraph,
  switchNodeKind,
  templateGraph,
  validateRaw,
  type DraftSnapshot,
  type EditorMode,
  type GraphNodePatch,
  type NodeKind,
  type SnapshotStorage,
} from "../lib/graph-editor-model";
import { useGraphs } from "./GraphListView";

const GRAPHS_BASE = "/module/ai/graphs";
const MODES: EditorMode[] = ["canvas", "json"];

/** sessionStorage 容错取用（隐私/受限上下文访问即抛时退化为 undefined，
 * 预填退化为只读路由 state 的旧行为） */
function safeSessionStorage(): SnapshotStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** 校验问题 → 可定位节点 id：params.nodeId（danglingEdge/
 * branchOptionsRequired/conditionNotBranchable 等）须真实存在才可定位；
 * code:"schema" 经 params.path 首段 nodes.<i> 反解（i18n 清单渲染零改动） */
function issueNodeId(issue: GraphIssue, graph: GraphJson): string | null {
  const byParam = issue.params?.nodeId;
  if (
    typeof byParam === "string" &&
    graph.nodes.some((node) => node.id === byParam)
  ) {
    return byParam;
  }
  const path = issue.params?.path;
  if (typeof path === "string") {
    const matched = /^nodes\.(\d+)\./.exec(path);
    const node = matched ? graph.nodes[Number(matched[1])] : undefined;
    if (node) {
      return node.id;
    }
  }
  return null;
}

export default function GraphEditorView() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";
  const graphId = isNew ? 0 : Number(id);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { t } = useTranslation(["chat"]);
  const { data: graphs = [], isLoading } = useGraphs();
  const record: GraphRecord | undefined = isNew
    ? undefined
    : graphs.find((item) => item.id === graphId);
  // 模板预填一次性捕获：StrictMode 双挂载下预填消费 effect 已 replace
  // 清掉路由 state，重挂载的 useState 初始化器须靠 sessionStorage 快照
  // 兜底（readTemplatePrefill 内处理），否则「从模板新建却是空图」
  const [template] = useState<GraphTemplate | undefined>(() =>
    isNew
      ? readTemplatePrefill(location.state, safeSessionStorage())
      : undefined,
  );

  const [mode, setMode] = useState<EditorMode>("canvas");
  const [name, setName] = useState(template ? t(template.titleI18nKey) : "");
  const [description, setDescription] = useState("");
  const [graph, setGraph] = useState<GraphJson>(() =>
    template ? templateGraph(template.graphJson) : emptyGraph(),
  );
  // ── 撤销/重做（结构操作历史） ─────────────────────────────────
  // ref 存栈（graph 变化触发重渲染，按钮禁用态读取即时正确）；命名/
  // 描述等元数据不入栈（Coze 同为节点操作粒度）；装载/保存重置
  const pastRef = useRef<GraphJson[]>([]);
  const futureRef = useRef<GraphJson[]>([]);
  const HISTORY_LIMIT = 50;

  /** 结构操作统一收口：旧图入 past、清 future（resolved 与当前相同则
   * 不产生历史——拖拽防抖回写同值时不污染栈） */
  function commitGraph(updater: (current: GraphJson) => GraphJson) {
    setGraph((current) => {
      const next = updater(current);
      if (next === current) {
        return current;
      }
      pastRef.current = [...pastRef.current, current].slice(-HISTORY_LIMIT);
      futureRef.current = [];
      return next;
    });
  }

  /** 基线重置（装载/保存成功）：图替换且清空历史 */
  function resetGraph(next: GraphJson) {
    pastRef.current = [];
    futureRef.current = [];
    setGraph(next);
  }

  function undoGraph() {
    const past = pastRef.current;
    const prev = past.at(-1);
    if (!prev) {
      return;
    }
    pastRef.current = past.slice(0, -1);
    futureRef.current = [graph, ...futureRef.current].slice(0, HISTORY_LIMIT);
    setGraph(prev);
  }

  function redoGraph() {
    const future = futureRef.current;
    const next = future[0];
    if (!next) {
      return;
    }
    futureRef.current = future.slice(1);
    pastRef.current = [...pastRef.current, graph].slice(-HISTORY_LIMIT);
    setGraph(next);
  }

  // 快捷键：输入框/文本域焦点时不拦截（保留浏览器原生输入撤销）
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "z"
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const inTextField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (inTextField) {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) {
        redoGraph();
      } else {
        undoGraph();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  const [jsonRaw, setJsonRaw] = useState("");
  const [baseline, setBaseline] = useState<DraftSnapshot>({
    name: "",
    description: "",
    graphJson: "",
  });
  const [saving, setSaving] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 校验清单默认收起（常驻红字清单占画布空间）；保存被拦时自动展开
  const [issuesOpen, setIssuesOpen] = useState(false);

  // 画布选中物：节点 id 或边稳定串（toCanvas 的 `${from}->${to}:${label}`）
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 属性面板三态：浮动（默认）/平铺/收缩——白底浮动卡片不占画布布局，
  // 收缩后仅右缘把手常驻
  const [panelState, setPanelState] = useState<"float" | "full" | "collapsed">(
    "float",
  );
  // ── 运行实时高亮：executor 逐节点推状态，按图过滤 ──
  const [nodeStatus, setNodeStatus] = useState<Record<string, string>>({});
  const runningNodeIds = useMemo(
    () =>
      Object.entries(nodeStatus)
        .filter(([, status]) => status === "running")
        .map(([nodeId]) => nodeId),
    [nodeStatus],
  );
  useEffect(() => {
    if (isNew) {
      return;
    }
    return on(NODE_STATUS_EVENT, (_event, payload) => {
      const status = payload as {
        graphId: number;
        nodeId: string;
        status: string;
      };
      if (status.graphId !== graphId) {
        return;
      }
      setNodeStatus((current) => ({
        ...current,
        [status.nodeId]: status.status,
      }));
    });
  }, [graphId, isNew]);

  // 单节点测试弹窗（选中节点时顶栏按钮可用）
  const [nodeTestOpen, setNodeTestOpen] = useState(false);
  // 入站 webhook：状态查询 + 开关 + URL 展示（仅已保存图）
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookBusy, setWebhookBusy] = useState(false);
  // 配置弹窗草稿：响应模板 / 状态码 / 异步 job / 图级完全访问（开启时
  // 随 enable 一起保存；fullAccess 授权本图代码/写节点在 webhook 触发
  // 下放行执行——webhook 无任务载体，授权挂注册上）
  const [webhookConfigOpen, setWebhookConfigOpen] = useState(false);
  const [webhookTemplate, setWebhookTemplate] = useState("");
  const [webhookStatusCode, setWebhookStatusCode] = useState(200);
  const [webhookAsync, setWebhookAsync] = useState(false);
  const [webhookFullAccess, setWebhookFullAccess] = useState(false);
  useEffect(() => {
    if (isNew) {
      return;
    }
    let cancelled = false;
    void GraphApi.webhookStatus(graphId).then((status) => {
      if (!cancelled) {
        setWebhookEnabled(status.enabled);
        setWebhookUrl(status.url);
        setWebhookTemplate(status.responseTemplate ?? "");
        setWebhookStatusCode(status.statusCode ?? 200);
        setWebhookAsync(status.async === true);
        setWebhookFullAccess(status.fullAccess === true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [graphId, isNew]);

  /** 已开启时改配置：重注册（新 token）保存并刷新 URL */
  async function saveWebhookConfig() {
    if (webhookBusy) {
      return;
    }
    setWebhookBusy(true);
    try {
      const url = await GraphApi.webhookEnable(graphId, {
        responseTemplate: webhookTemplate,
        statusCode: webhookStatusCode,
        async: webhookAsync,
        fullAccess: webhookFullAccess,
      });
      setWebhookUrl(url);
      toast.success(t("chat:orchestration.webhook.saved"));
    } catch (e) {
      toast.error(
        t("chat:orchestration.loadFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setWebhookBusy(false);
    }
  }

  async function toggleWebhook() {
    if (webhookBusy) {
      return;
    }
    setWebhookBusy(true);
    try {
      if (webhookEnabled) {
        await GraphApi.webhookDisable(graphId);
        setWebhookEnabled(false);
        setWebhookUrl("");
        toast.success(t("chat:orchestration.webhook.disabled"));
      } else {
        const url = await GraphApi.webhookEnable(graphId, {
          responseTemplate: webhookTemplate,
          statusCode: webhookStatusCode,
          async: webhookAsync,
          fullAccess: webhookFullAccess,
        });
        setWebhookEnabled(true);
        setWebhookUrl(url);
        toast.success(t("chat:orchestration.webhook.enabled"));
      }
    } catch (e) {
      toast.error(
        t("chat:orchestration.loadFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setWebhookBusy(false);
    }
  }
  // 选中节点（供单节点测试按钮与弹窗；END 虚拟节点不在 graph.nodes 内）
  const selectedNode = selectedId
    ? graph.nodes.find((node) => node.id === selectedId)
    : undefined;
  // 错误定位请求（seq 计数：同节点重复点击也驱动下方 effect 重跑）
  const [focusRequest, setFocusRequest] = useState<{
    nodeId: string | null;
    seq: number;
  }>({ nodeId: null, seq: 0 });
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);

  // 装载布局：有 position 用之，缺失经 autoLayout 补（不落 graphJson，
  // 拖动经 onMove/保存时才随序列化落库）
  const layouts = useMemo(() => layoutOf(graph), [graph]);

  // 错误定位：GraphCanvas 的定位 effect deps 只看 focusNodeId 单值，同节点
  // 重复点击经「先清后置」二段变化重触发 setCenter（C2 遗留 minor 的
  // 视图侧绕法，seq 计数保证本 effect 每次点击必跑）
  useEffect(() => {
    if (!focusRequest.nodeId) {
      return;
    }
    setFocusNodeId(null);
    const restore = setTimeout(() => setFocusNodeId(focusRequest.nodeId), 0);
    return () => clearTimeout(restore);
  }, [focusRequest]);

  // 试运行变量取当前草稿 inputSchema（画布/JSON 双模式统一出口，
  // currentJson 之后 memo）——试的是改后的图，变量表单同步草稿

  // 既有图装载：以 id:version 为装载键（create 后列表带回新行 / 冲突重拉
  // 皆视为新基线），防止重复装载抹掉用户后续编辑
  const initKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (isNew || !record) {
      return;
    }
    const initKey = `${record.id}:${record.version}`;
    if (initKeyRef.current === initKey) {
      return;
    }
    initKeyRef.current = initKey;
    // 存量图自愈：AI 技能早期落库的图可能缺 start 节点/末节点断头
    // （画布「开始/END」连线缺失），装载时归一补齐显示；baseline
    // 同步补以免误报未保存
    const healed = normalizeGraph(
      parseOrKeep(record.graphJson).parsed ?? emptyGraph(),
    );
    resetGraph(healed);
    setName(record.name);
    setDescription(record.description ?? "");
    setBaseline({
      name: record.name,
      description: record.description ?? "",
      graphJson: canonicalJson(JSON.stringify(healed)),
    });
  }, [record, isNew]);

  // 模板预填一次性消费：replace 清掉路由 state（刷新/后退不重复预填，
  // 先例 AutomationView 的 libraryPrefill）
  useEffect(() => {
    if (template) {
      navigate(location.pathname, { replace: true });
    }
  }, [template, location.pathname, navigate]);

  // 运行深链一次性消费（任务运行历史「查看运行」跳转）：开运行历史
  // 弹窗并定位该 run；replace 清掉路由 state 防刷新/后退重弹
  const focusRunId = (location.state as { focusRunId?: number } | null)
    ?.focusRunId;
  const [deepLinkRunId, setDeepLinkRunId] = useState<number | null>(null);
  useEffect(() => {
    if (focusRunId != null) {
      setDeepLinkRunId(focusRunId);
      setHistoryOpen(true);
      navigate(location.pathname, { replace: true });
    }
  }, [focusRunId, location.pathname, navigate]);

  // 两模式共用校验出口：名称必填 + 图校验（JSON 模式校验源码串）；
  // 图校验问题为结构化错误码，经 localizeGraphIssue 按 code 查本地化文案，
  // 可定位节点的问题保留 nodeId（错误条目点击 → 画布定位 + 选中）
  const issueItems = useMemo(() => {
    const items: { text: string; nodeId: string | null }[] = [];
    if (name.trim() === "") {
      items.push({
        text: t("chat:orchestration.editor.nameRequired"),
        nodeId: null,
      });
    }
    if (mode === "canvas") {
      const result = validateGraph(graph);
      if (!result.ok) {
        items.push(
          // >1 start 的 uniqueEntry/duplicateStartNode 双报去重（保留后者）
          ...dedupeUniqueEntry(result.issues).map((issue) => ({
            text: localizeGraphIssue(issue, t),
            nodeId: issueNodeId(issue, graph),
          })),
        );
      }
    } else {
      const result = validateRaw(jsonRaw);
      if (!result.ok) {
        if (result.issues.length > 0) {
          items.push(
            ...dedupeUniqueEntry(result.issues).map((issue) => ({
              text: localizeGraphIssue(issue, t),
              nodeId: null, // JSON 模式画布不可见，无定位意义
            })),
          );
        } else {
          items.push({
            text: t("chat:orchestration.editor.jsonInvalid"),
            nodeId: null,
          });
        }
      }
    }
    return items;
  }, [mode, graph, jsonRaw, name, t]);

  // 全图 parse/serialize 收敛进单个 memo（M10）：JSON 模式每击键约 3 次
  // 全图解析 + 2 次 zod + 2 次 pretty-stringify，画布模式下名称输入/选中
  // 等无关重渲染也会全图序列化——几十节点即现输入迟滞
  const { jsonParseable, currentJson } = useMemo(() => {
    return {
      jsonParseable:
        mode === "json" ? parseOrKeep(jsonRaw).parsed !== null : true,
      currentJson:
        mode === "canvas" ? serializeGraph(graph) : canonicalJson(jsonRaw),
    };
  }, [mode, graph, jsonRaw]);

  const testVariables = useMemo(() => {
    const parsed = parseOrKeep(currentJson).parsed;
    return parsed ? Object.keys(parsed.inputSchema) : [];
  }, [currentJson]);

  // 保存钮不看校验问题（有问题时点保存 → toast + 展开清单提示），仅
  // 保存中/无变更禁用
  const canSave =
    !saving &&
    draftChanged({ name, description, graphJson: currentJson }, baseline);

  // 基线节点 id 集合：保存过的节点 id 锁定（新节点首次保存前可改）
  const baselineNodeIds = useMemo(() => {
    const parsed = parseOrKeep(baseline.graphJson).parsed;
    return new Set(parsed ? parsed.nodes.map((node) => node.id) : []);
  }, [baseline]);

  const headerTitle = isNew
    ? name.trim() || t("chat:orchestration.editor.titleNew")
    : (record?.name ?? "");
  const headerReady = isNew || (!isLoading && record !== undefined);
  usePageHeader(
    headerReady
      ? {
          leading: (
            <IconTooltip label={t("chat:orchestration.editor.backToList")}>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t("chat:orchestration.editor.backToList")}
                onClick={() => navigate(GRAPHS_BASE)}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </IconTooltip>
          ),
          title: (
            <h2 className="truncate text-sm font-semibold text-foreground">
              {headerTitle}
            </h2>
          ),
        }
      : null,
  );

  function switchMode(next: EditorMode) {
    if (next === mode) {
      return;
    }
    if (next === "json") {
      setJsonRaw(serializeGraph(graph));
      setMode("json");
      return;
    }
    const { parsed } = parseOrKeep(jsonRaw);
    if (!parsed) {
      return; // 切换钮已禁用，双保险
    }
    commitGraph(() => parsed);
    setMode("canvas");
  }

  function patchNode(nodeId: string, patch: GraphNodePatch) {
    commitGraph((current) => {
      // start 变量分流：节点 variables 与 inputSchema 同一次提交同步写
      //（StartNodeFields 的回写口；名称等其余字段照常走宽松补丁）
      const target = current.nodes.find((node) => node.id === nodeId);
      if (target?.kind === "start" && patch.variables !== undefined) {
        return patchStartVariables(current, patch.variables);
      }
      return {
        ...current,
        // 宽松补丁语义（交集形态单字段透传），kind 分流由 switchNodeKind 专口
        nodes: current.nodes.map((node) =>
          node.id === nodeId ? ({ ...node, ...patch } as typeof node) : node,
        ),
      };
    });
  }

  function switchNodeKindOf(nodeId: string, kind: NodeKind) {
    commitGraph((current) => switchNodeKind(current, nodeId, kind));
  }

  function patchGraphMeta(patch: { name?: string; description?: string }) {
    if (patch.name !== undefined) {
      setName(patch.name);
    }
    if (patch.description !== undefined) {
      setDescription(patch.description);
    }
  }

  /** 改节点 id：同步边引用；选中跟随新 id（面板/画布高亮不断链） */
  function handleRenameNode(nodeId: string, nextId: string) {
    commitGraph((current) => renameNode(current, nodeId, nextId));
    setSelectedId((current) => (current === nodeId ? nextId : current));
  }

  /** 画布拖拽落点回写（GraphCanvas 已 300ms 防抖批量上抛） */
  function applyMove(positions: Record<string, { x: number; y: number }>) {
    commitGraph((current) => applyPositions(current, positions));
  }

  /** 自动整理布局：拓扑分层重排全部节点并清 END 落点（进撤销栈） */
  function handleAutoLayout() {
    commitGraph((current) => {
      const laid = autoLayout(current);
      return {
        ...current,
        endPosition: undefined,
        nodes: current.nodes.map((node) => ({
          ...node,
          position: laid[node.id] ?? node.position!,
        })),
      };
    });
  }

  /** 连线：connectEdge 对自环/完全重复边返回 null → toast 提示（静默
   * 忽略会被当成「拖了没反应」） */
  function handleConnect(conn: {
    source: string;
    sourceHandle: string;
    target: string;
  }) {
    const next = connectEdge(graph, conn);
    if (next === null) {
      toast.info(t("chat:orchestration.editor.edgeDuplicate"));
      return;
    }
    commitGraph(() => next);
  }

  /** 导出当前草稿为自包含 JSON（主进程另存对话框；取消静默） */
  async function handleExport() {
    try {
      const saved = await GraphApi.exportWorkflow({
        name: name.trim() || t("chat:orchestration.editor.titleNew"),
        description,
        graphJson: serializeGraph(graph),
      });
      if (saved) {
        toast.success(t("chat:orchestration.exported", { path: saved }));
      }
    } catch (e) {
      toast.error(
        t("chat:orchestration.exportFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  /** 新建节点：现有布局右下角偏移落点（视口不可知），并自动选中 */
  function handleAddNode(kind: NodeKind, at?: { x: number; y: number }) {
    const nodeId = nextNodeId(graph.nodes);
    const FACTORY: Record<NodeKind, (id: string) => GraphNode> = {
      start: newStartNode,
      llm: newNode,
      code: newCodeNode,
      http: newHttpNode,
      fileRead: newFileReadNode,
      notify: newNotifyNode,
      subflow: newSubflowNode,
      iterate: newIterateNode,
      librarySearch: newLibrarySearchNode,
      jsonParse: newJsonParseNode,
      jsonStringify: newJsonStringifyNode,
      condition: newConditionNode,
      intent: newIntentNode,
      fileWrite: newFileWriteNode,
      docExtract: newDocExtractNode,
      imageGen: newImageGenNode,
      delay: newDelayNode,
      vectorize: newVectorizeNode,
      vectorSearch: newVectorSearchNode,
      database: newDatabaseNode,
      excelRead: newExcelReadNode,
      excelWrite: newExcelWriteNode,
      csvRead: newCsvReadNode,
      csvWrite: newCsvWriteNode,
      variable: newVariableNode,
      aggregate: newAggregateNode,
      email: newEmailNode,
      merge: newMergeNode,
    };
    commitGraph((current) => {
      const base = FACTORY[kind](nodeId);
      const existing = layoutOf(current);
      const xs = Object.values(existing).map((point) => point.x);
      const ys = Object.values(existing).map((point) => point.y);
      return {
        ...current,
        nodes: [
          ...current.nodes,
          {
            ...base,
            position: at ?? {
              x: Math.max(0, ...xs) + 60,
              y: Math.max(0, ...ys) + 60,
            },
          },
        ],
      };
    });
    setSelectedId(nodeId);
  }

  function handleRemoveNode(nodeId: string) {
    commitGraph((current) => removeNodeFromGraph(current, nodeId));
    setSelectedId((current) => (current === nodeId ? null : current));
  }

  /** 删边：边 id（toCanvas 稳定串）反解后按 from/to/label 匹配过滤 */
  function removeEdgeById(edgeId: string) {
    const ref = edgeIdToRef(edgeId);
    commitGraph((current) => ({
      ...current,
      edges: current.edges.filter((edge) => !edgeRefMatches(edge, ref)),
    }));
    setSelectedId((current) => (current === edgeId ? null : current));
  }

  /** 条件改写：显式重建边对象（undefined 时彻底摘除 condition 键）。
   * connectEdge 同款 dup 判定（同 from+to+条件值且非本边）静默跳过——防
   * 画布重复稳定串 id；选中跟随新稳定串（to 为 END 用虚拟节点形态，与
   * toCanvas 一致），面板不落回图级 */
  function patchEdgeCondition(edgeId: string, value: string | undefined) {
    const ref = edgeIdToRef(edgeId);
    const dup = graph.edges.some(
      (edge) =>
        edge.from === ref.from &&
        edge.to === ref.to &&
        (edge.condition?.value ?? "") === (value ?? "") &&
        !edgeRefMatches(edge, ref),
    );
    if (dup) return;
    commitGraph((current) => ({
      ...current,
      edges: current.edges.map((edge) =>
        edgeRefMatches(edge, ref)
          ? {
              from: edge.from,
              to: edge.to,
              ...(value === undefined
                ? {}
                : { condition: { type: "branch" as const, value } }),
            }
          : edge,
      ),
    }));
    setSelectedId(
      `${ref.from}->${ref.to === "END" ? END_NODE_ID : ref.to}:${value ?? ""}`,
    );
  }

  /** 错误条目点击 → 定位节点（setCenter 经 GraphCanvas）+ 选中 */
  function focusIssueNode(nodeId: string) {
    setSelectedId(nodeId);
    setFocusRequest((current) => ({ nodeId, seq: current.seq + 1 }));
  }

  async function handleSave() {
    if (!canSave) {
      return;
    }
    // 校验不通过不落库：toast 提示并展开清单（可定位条目）供逐项处理
    if (issueItems.length > 0) {
      setIssuesOpen(true);
      toast.error(
        t("chat:orchestration.editor.saveBlocked", {
          count: issueItems.length,
        }),
      );
      return;
    }
    const params = {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      graphJson: currentJson,
    };
    setSaving(true);
    try {
      const saved = isNew
        ? await GraphApi.create(params)
        : await GraphApi.update(graphId, {
            ...params,
            version: record?.version ?? 0,
          });
      toast.success(t("chat:orchestration.editor.saved"));
      setName(saved.name);
      setDescription(saved.description ?? "");
      setBaseline({
        name: saved.name,
        description: saved.description ?? "",
        graphJson: canonicalJson(saved.graphJson),
      });
      if (mode === "json") {
        setJsonRaw(canonicalJson(saved.graphJson));
      } else {
        resetGraph(parseOrKeep(saved.graphJson).parsed ?? graph);
      }
      // 先失效并等列表重拉完成再导航：navigate 切到 graphs/:id 时若缓存
      // 尚无新行，会以「缓存数据 + isLoading=false」命中 notFound 错误态
      // 闪烁；重拉到位后 record 即刻就绪
      await queryClient.invalidateQueries({ queryKey: ["orchestration"] });
      if (isNew) {
        navigate(`${GRAPHS_BASE}/${saved.id}`, { replace: true });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("VERSION_CONFLICT")) {
        toast.error(t("chat:orchestration.editor.versionConflict"));
        await queryClient.invalidateQueries({ queryKey: ["orchestration"] });
      } else {
        toast.error(t("chat:orchestration.loadFailed", { message }));
      }
    } finally {
      setSaving(false);
    }
  }

  if (!isNew && isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isNew && !record) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">
          {t("chat:orchestration.editor.notFound")}
        </p>
        <Button
          size="sm"
          className="h-7 px-3"
          onClick={() => navigate(GRAPHS_BASE)}
        >
          {t("chat:orchestration.editor.back")}
        </Button>
      </div>
    );
  }

  return (
    // h-full 同 AutomationView/ChatView 口径：父级 AiLayout 非 flex 容器，
    // flex-1 不生效会使高度塌为内容高度（全屏时画布下方留白）
    <div className="flex h-full flex-col overflow-hidden">
      {/* 工具行：薄行 + 底部分隔线（按钮与画布拉开层次；返回/标题已迁
          TopBar 中段，此行不再留大顶部留白） */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5">
        <div className="flex flex-col gap-0.5">
          <div className="inline-flex w-fit items-center rounded-lg border border-border/50 bg-primary-subtle/30 p-0.5 text-sm">
            {MODES.map((item) => (
              <button
                key={item}
                type="button"
                disabled={item === "canvas" && !jsonParseable}
                className={`flex items-center rounded-md px-3 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  mode === item
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-primary"
                }`}
                onClick={() => switchMode(item)}
              >
                {t(
                  item === "canvas"
                    ? "chat:orchestration.editor.modeCanvas"
                    : "chat:orchestration.editor.modeJson",
                )}
              </button>
            ))}
          </div>
          {!jsonParseable && (
            <p className="text-xs text-destructive">
              {t("chat:orchestration.editor.jsonSwitchBlocked")}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* 撤销/重做（结构操作历史，快捷键 Cmd/Ctrl+Z） */}
          <IconTooltip label={`${t("chat:orchestration.editor.undo")} (⌘Z)`}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t("chat:orchestration.editor.undo")}
              disabled={pastRef.current.length === 0}
              onClick={undoGraph}
            >
              <Undo2 className="h-4 w-4" />
            </Button>
          </IconTooltip>
          <IconTooltip label={`${t("chat:orchestration.editor.redo")} (⇧⌘Z)`}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t("chat:orchestration.editor.redo")}
              disabled={futureRef.current.length === 0}
              onClick={redoGraph}
            >
              <Redo2 className="h-4 w-4" />
            </Button>
          </IconTooltip>
          {/* 自动整理布局（拓扑分层重排，进撤销栈） */}
          {mode === "canvas" && (
            <IconTooltip label={t("chat:orchestration.editor.autoLayout")}>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t("chat:orchestration.editor.autoLayout")}
                onClick={handleAutoLayout}
              >
                <Wand2 className="h-4 w-4" />
              </Button>
            </IconTooltip>
          )}
          {/* 导出当前草稿为 JSON（所见即所得，未保存改动一并导出） */}
          <IconTooltip label={t("chat:orchestration.exportAction")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t("chat:orchestration.exportAction")}
              onClick={() => void handleExport()}
            >
              <Download className="h-4 w-4" />
            </Button>
          </IconTooltip>
        </div>
        <div className="flex items-center gap-2">
          {/* 入站 webhook：仅已保存图；开启后外部系统 POST 触发 */}
          {!isNew && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      variant={webhookEnabled ? "default" : "outline"}
                      size="sm"
                      className="h-7 gap-1 px-3"
                      disabled={webhookBusy}
                      onClick={() => void toggleWebhook()}
                    >
                      <Webhook className="h-4 w-4" />
                      {webhookEnabled
                        ? t("chat:orchestration.webhook.on")
                        : t("chat:orchestration.webhook.off")}
                    </Button>
                    {webhookEnabled && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-3 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                        disabled={webhookBusy}
                        onClick={() => setWebhookConfigOpen(true)}
                      >
                        <Settings2 className="h-4 w-4" />
                        {t("chat:orchestration.webhook.config")}
                      </Button>
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {webhookEnabled
                    ? webhookUrl
                    : t("chat:orchestration.webhook.tooltipOff")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {/* 单节点测试：选中节点可用（占位符表单 → 轻量单跑，不落 run） */}
          {mode === "canvas" && selectedNode && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              onClick={() => setNodeTestOpen(true)}
            >
              <FlaskConical className="h-4 w-4" />
              {t("chat:orchestration.editor.testNode")}
            </Button>
          )}
          {/* 试运行 isNew 仍禁用：未保存图无 id，运行记录无法归属；
              已有图点开即试当前草稿（校验问题先拦，不打断即改即试） */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-3 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                    disabled={isNew}
                    onClick={() => {
                      if (issueItems.length > 0) {
                        setIssuesOpen(true);
                        toast.error(
                          t("chat:orchestration.testRun.blockedByIssues", {
                            count: issueItems.length,
                          }),
                        );
                        return;
                      }
                      setTestOpen(true);
                    }}
                  >
                    <Play className="h-4 w-4" />
                    {t("chat:orchestration.testRun.button")}
                  </Button>
                </span>
              </TooltipTrigger>
              {isNew && (
                <TooltipContent side="bottom">
                  {t("chat:orchestration.testRun.saveFirst")}
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            disabled={isNew}
            onClick={() => setHistoryOpen(true)}
          >
            <History className="h-4 w-4" />
            {t("chat:orchestration.runs.title")}
          </Button>
          <Button
            size="sm"
            className="h-7 px-3"
            disabled={!canSave}
            onClick={() => void handleSave()}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t("chat:orchestration.editor.save")}
          </Button>
        </div>
      </div>

      {issueItems.length > 0 && (
        <div className="mx-3 mt-2">
          {/* 摘要行：默认收起不占画布空间，点击展开清单 */}
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
            onClick={() => setIssuesOpen((open) => !open)}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {t("chat:orchestration.editor.issuesSummary", {
              count: issueItems.length,
            })}
            {issuesOpen ? (
              <ChevronUp className="ml-auto h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0" />
            )}
          </button>
          {issuesOpen && (
            <div className="mt-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2">
              <p className="mb-1 text-xs font-medium text-destructive">
                {t("chat:orchestration.editor.issuesTitle")}
              </p>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-destructive">
                {issueItems.map((item, index) => {
                  const nodeId = item.nodeId;
                  return (
                    // key 含序号：两条同形悬空边会渲染相同文案（重复键）
                    <li key={`${index}-${item.text}`}>
                      {nodeId ? (
                        <button
                          type="button"
                          className="text-left underline-offset-2 hover:underline"
                          onClick={() => focusIssueNode(nodeId)}
                        >
                          {item.text}
                        </button>
                      ) : (
                        item.text
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {mode === "canvas" ? (
        <div className="relative flex min-h-0 flex-1">
          <div className="min-h-0 flex-1">
            {/* start 菜单项唯一性禁用依据：AddNodeMenu 深藏 GraphCanvas
                Panel 内，prop 穿透需改本任务范围外的 GraphCanvas，走
                轻量 context 由本视图（graph 状态源）注入 */}
            <GraphHasStartContext.Provider
              value={graph.nodes.some((node) => node.kind === "start")}
            >
              <GraphCanvas
                graph={graph}
                layouts={layouts}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMove={applyMove}
                onConnect={handleConnect}
                onAddNode={handleAddNode}
                onAddNodeAt={(kind, position) => handleAddNode(kind, position)}
                onRemoveNode={handleRemoveNode}
                onRemoveEdge={removeEdgeById}
                focusNodeId={focusNodeId}
                runningNodeIds={runningNodeIds}
              />
            </GraphHasStartContext.Provider>
          </div>
          {panelState === "collapsed" ? (
            <IconTooltip
              label={t("chat:orchestration.editor.panelExpand")}
              side="left"
            >
              <button
                type="button"
                aria-label={t("chat:orchestration.editor.panelExpand")}
                className="absolute right-0 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-1.5 rounded-l-lg border border-r-0 border-border/50 bg-white py-3 pl-1.5 pr-1 text-muted-foreground shadow-lg transition-colors hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
                onClick={() => setPanelState("float")}
              >
                <Settings2 className="h-4 w-4" />
                <span className="text-xs [writing-mode:vertical-rl]">
                  {t("chat:orchestration.editor.panelSettings")}
                </span>
              </button>
            </IconTooltip>
          ) : (
            <div
              data-panel-state={panelState}
              className={
                panelState === "full"
                  ? "absolute inset-4 z-20 flex flex-col rounded-lg border border-border/50 bg-white shadow-lg"
                  : "absolute inset-y-4 right-4 z-20 flex w-[440px] max-w-[55vw] flex-col rounded-lg border border-border/50 bg-white shadow-lg"
              }
            >
              <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Settings2 className="h-3.5 w-3.5 text-primary" />
                  {t("chat:orchestration.editor.panelSettings")}
                </span>
                <div className="flex items-center gap-0.5">
                  {panelState === "float" && (
                    <IconTooltip
                      label={t("chat:orchestration.editor.panelTile")}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        aria-label={t("chat:orchestration.editor.panelTile")}
                        onClick={() => setPanelState("full")}
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                    </IconTooltip>
                  )}
                  {panelState === "full" && (
                    <IconTooltip
                      label={t("chat:orchestration.editor.panelFloat")}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        aria-label={t("chat:orchestration.editor.panelFloat")}
                        onClick={() => setPanelState("float")}
                      >
                        <Minimize2 className="h-4 w-4" />
                      </Button>
                    </IconTooltip>
                  )}
                  <IconTooltip
                    label={t("chat:orchestration.editor.panelCollapse")}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-primary"
                      aria-label={t("chat:orchestration.editor.panelCollapse")}
                      onClick={() => setPanelState("collapsed")}
                    >
                      <ChevronsRight className="h-4 w-4" />
                    </Button>
                  </IconTooltip>
                </div>
              </div>
              <div className="@container min-h-0 flex-1 overflow-y-auto">
                <NodePropertiesPanel
                  graph={graph}
                  name={name}
                  description={description}
                  selectedId={selectedId}
                  onPatchNode={patchNode}
                  onSwitchKind={switchNodeKindOf}
                  onRenameNode={handleRenameNode}
                  onRemoveNode={handleRemoveNode}
                  onRemoveEdge={removeEdgeById}
                  onPatchEdgeCondition={patchEdgeCondition}
                  onGraphMeta={patchGraphMeta}
                  idLocked={(nodeId) => baselineNodeIds.has(nodeId)}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col p-3 pt-2">
          <GraphJsonEditor value={jsonRaw} onChange={setJsonRaw} />
        </div>
      )}

      {!isNew && (
        <>
          <GraphTestRunDialog
            graphId={graphId}
            draftJson={currentJson}
            variables={testVariables}
            open={testOpen}
            onOpenChange={setTestOpen}
          />
          <GraphRunHistoryDialog
            graphId={graphId}
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            focusRunId={deepLinkRunId ?? undefined}
          />
        </>
      )}
      {!isNew && webhookConfigOpen && (
        <WebhookConfigDialog
          url={webhookUrl}
          template={webhookTemplate}
          statusCode={webhookStatusCode}
          asyncMode={webhookAsync}
          fullAccess={webhookFullAccess}
          busy={webhookBusy}
          onTemplate={setWebhookTemplate}
          onStatusCode={setWebhookStatusCode}
          onAsync={setWebhookAsync}
          onFullAccess={setWebhookFullAccess}
          onSave={() => void saveWebhookConfig()}
          onOpenChange={setWebhookConfigOpen}
        />
      )}
      {mode === "canvas" && selectedNode && (
        <NodeTestDialog
          node={selectedNode}
          open={nodeTestOpen}
          onOpenChange={setNodeTestOpen}
        />
      )}
    </div>
  );
}

/** 从节点任意字符串字段提取占位符（{{input.x}} / {{nodes.y.output}}），
 * 返回去重变量名列表（input.x 原样、nodes.y.output 原样作表单标签） */
function collectNodePlaceholders(node: GraphNode): string[] {
  const seen = new Set<string>();
  const text = JSON.stringify(node);
  const re = /\{\{(input\.[A-Za-z0-9_]+|nodes\.[a-z0-9-]+\.output)\}\}/g;
  for (const matched of text.matchAll(re)) {
    seen.add(matched[1]);
  }
  return [...seen];
}

/** 单节点测试弹窗（Coze 式）：占位符表单（input.* / nodes.*.output 值由
 * 用户填）+ workspace 下拉 → GraphApi.testNode 轻量单跑；输出/错误内联
 * 展示（不落 run 记录，消息落在「单节点测试」临时会话） */
function NodeTestDialog({
  node,
  open,
  onOpenChange,
}: {
  node: GraphNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; output: string }
    | { ok: false; code: string; message: string }
    | null
  >(null);
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });
  const placeholders = useMemo(() => collectNodePlaceholders(node), [node]);

  useEffect(() => {
    if (open) {
      setValues({});
      setResult(null);
    }
  }, [open]);
  useEffect(() => {
    if (workspaceId === null && workspaces.length > 0) {
      setWorkspaceId(workspaces[0].id);
    }
  }, [workspaces, workspaceId]);

  const allFilled =
    workspaceId !== null &&
    placeholders.every((key) => (values[key] ?? "").trim() !== "");

  async function handleRun() {
    if (!allFilled || workspaceId === null) {
      return;
    }
    const inputs: Record<string, string> = {};
    const nodes: Record<string, { output: string }> = {};
    for (const [key, value] of Object.entries(values)) {
      const inputMatch = /^input\.(.+)$/.exec(key);
      const nodeMatch = /^nodes\.([a-z0-9-]+)\.output$/.exec(key);
      if (inputMatch) {
        inputs[inputMatch[1]] = value.trim();
      } else if (nodeMatch) {
        nodes[nodeMatch[1]] = { output: value };
      }
    }
    setRunning(true);
    setResult(null);
    try {
      const outcome = await GraphApi.testNode(node, inputs, nodes, workspaceId);
      setResult(outcome);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setResult({ ok: false, code: "UNKNOWN", message });
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl rounded-lg border border-border/50 shadow-lg">
        <DialogHeader>
          <DialogTitle>
            {t("chat:orchestration.editor.testNodeTitle", {
              name: node.name || node.id,
            })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          {placeholders.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("chat:orchestration.editor.testNodeNoVars")}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">
                {t("chat:orchestration.editor.testNodeVars")}
              </p>
              {placeholders.map((key) => (
                <div key={key} className="flex flex-col gap-1">
                  <Label className="font-mono text-xs">{key}</Label>
                  <Input
                    className="h-8 font-mono text-xs"
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
          {result && (
            <div className="flex flex-col gap-1 rounded-lg border border-border/50 p-2">
              <p className="text-xs font-medium text-muted-foreground">
                {result.ok
                  ? t("chat:orchestration.editor.testNodeOutput")
                  : t("chat:orchestration.editor.testNodeError")}
              </p>
              {result.ok ? (
                <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                  {result.output}
                </pre>
              ) : (
                <p className="font-mono text-xs text-destructive">
                  {result.code}: {result.message}
                </p>
              )}
            </div>
          )}
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
            {t("chat:orchestration.editor.testNodeRun")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** webhook 配置弹窗：响应模板（{{nodes.x.output}}/{{input.y}} 渲染，空 =
 * 默认 {status, output} JSON）/ 状态码 / 异步 job / 图级完全访问；保存 =
 * 重注册（新 token） */
function WebhookConfigDialog({
  url,
  template,
  statusCode,
  asyncMode,
  fullAccess,
  busy,
  onTemplate,
  onStatusCode,
  onAsync,
  onFullAccess,
  onSave,
  onOpenChange,
}: {
  url: string;
  template: string;
  statusCode: number;
  asyncMode: boolean;
  fullAccess: boolean;
  busy: boolean;
  onTemplate: (next: string) => void;
  onStatusCode: (next: number) => void;
  onAsync: (next: boolean) => void;
  onFullAccess: (next: boolean) => void;
  onSave: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl rounded-lg border border-border/50 shadow-lg">
        <DialogHeader>
          <DialogTitle>
            {t("chat:orchestration.webhook.configTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border/50 p-2">
            <span className="shrink-0 text-xs text-muted-foreground">URL</span>
            <code className="min-w-0 w-0 flex-1 truncate font-mono text-xs text-foreground">
              {url}
            </code>
            <IconTooltip label={t("common:copy")}>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 hover:bg-primary-subtle hover:text-primary"
                aria-label={t("common:copy")}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(url)
                    .then(() =>
                      toast.success(t("chat:orchestration.webhook.copied")),
                    )
                    .catch(() =>
                      toast.error(t("chat:orchestration.webhook.copyFailed")),
                    );
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </IconTooltip>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">
              {t("chat:orchestration.webhook.statusCode")}
            </Label>
            <Input
              className="h-8 w-24"
              type="number"
              min={100}
              max={599}
              value={statusCode}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isInteger(value) && value >= 100 && value <= 599) {
                  onStatusCode(value);
                }
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">
              {t("chat:orchestration.webhook.responseTemplate")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("chat:orchestration.webhook.templateHint")}
            </p>
            <HighlightTextarea
              value={template}
              onChange={onTemplate}
              language="prompt"
              height={120}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={asyncMode} onCheckedChange={onAsync} />
            <span className="text-xs text-muted-foreground">
              {t("chat:orchestration.webhook.asyncHint")}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={fullAccess} onCheckedChange={onFullAccess} />
            <span className="text-xs text-muted-foreground">
              {t("chat:orchestration.webhook.fullAccessHint")}
            </span>
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
            disabled={busy}
            onClick={() => {
              onSave();
              onOpenChange(false);
            }}
          >
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
