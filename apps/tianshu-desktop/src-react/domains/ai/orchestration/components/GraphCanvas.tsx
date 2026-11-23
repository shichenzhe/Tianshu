// src-react/domains/ai/orchestration/components/GraphCanvas.tsx
/**
 * React Flow 画布（spec §2）：GraphJson+layouts 经 toCanvas 受控渲染
 * nodes/edges（END 虚拟节点 id=END_NODE_ID，不删不拖）；连线 onConnect
 * （sourceHandle 缺省 "plain"）；拖拽落点收集 300ms 防抖批量 onMove（受控
 * 流叠加本地镜像实时 applyNodeChanges，拖拽跟手不卡 300ms）；
 * 点击节点/边 → onSelect、点画布空白 → onSelect(null)；Delete 键走 RF
 * 默认删除转发 onRemoveNode/onRemoveEdge（边 id 即 toCanvas 稳定串，
 * 消费方经 edgeIdToRef 反解）；focusNodeId 变化 setCenter 定位 + 选中
 * （错误定位）。深交互（拖拽/连线手势）不做 jsdom 深测（spec §7）。
 * 只读运行模式（Task 3，readOnly）：禁拖/禁连/禁删/隐藏新增、回调不
 * 外抛，保留缩放/MiniMap/点击选择/focusNodeId；nodeStates 叠加末次
 * 运行状态进节点 data.runState。编辑器调用处缺省不传——零行为变化。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";

import AddNodeMenu from "./AddNodeMenu";
import type { GraphJson } from "../api/graph.schema";
import type { NodeKind } from "../lib/graph-editor-model";
import {
  END_NODE_ID,
  toCanvas,
  type CanvasNode,
} from "../lib/graph-canvas-model";
import NodeCard, { type CardNode, type NodeRunState } from "./nodes/NodeCard";
import EndMarker, { type EndMarkerNode } from "./nodes/EndMarker";

export interface GraphCanvasProps {
  graph: GraphJson;
  layouts: Record<string, { x: number; y: number }>;
  /** 节点或边 id（边 id 即 toCanvas 的稳定串） */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 拖拽落点（300ms 防抖批量） */
  onMove: (positions: Record<string, { x: number; y: number }>) => void;
  onConnect: (conn: {
    source: string;
    sourceHandle: string;
    target: string;
  }) => void;
  onAddNode: (kind: NodeKind) => void;
  /** 拖拽入画布：指定落点添加（screenToFlowPosition 后的流坐标） */
  onAddNodeAt: (kind: NodeKind, position: { x: number; y: number }) => void;
  onRemoveNode: (nodeId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  /** 错误定位：setCenter + 选中高亮 */
  focusNodeId?: string | null;
  /** 运行中节点（试运行实时高亮，描边脉冲） */
  runningNodeIds?: string[];
  /** 只读运行模式（Task 3 运行拓扑）：禁拖/禁连/禁删/隐藏新增，回调
   * 不外抛；保留缩放/MiniMap/点击选择/focusNodeId 定位。编辑器调用处
   * 缺省不传——零行为变化 */
  readOnly?: boolean;
  /** 运行状态叠加（readOnly 拓扑）：nodeId → 末次状态/耗时（映射进
   * 节点 data.runState，由 NodeCard 渲染描边与徽标） */
  nodeStates?: Map<string, NodeRunState>;
}

type FlowNode = CardNode | EndMarkerNode;

/** 模块级常量：RF 要求 nodeTypes 引用稳定（否则 002 报错+节点全量重挂载） */
const nodeTypes = { card: NodeCard, end: EndMarker } satisfies NodeTypes;

/** 卡片节点 data：canvas 模型 + 可选运行状态叠加（只读运行拓扑） */
function buildCardData(
  node: CanvasNode,
  nodeStates?: Map<string, NodeRunState>,
): CardNode["data"] {
  const runState = nodeStates?.get(node.id);
  return { canvas: node, ...(runState ? { runState } : {}) };
}

const MOVE_DEBOUNCE_MS = 300;
const CARD_WIDTH = 220;
const CARD_HEIGHT_FALLBACK = 80;
/** MiniMap 语义色（函数引用稳定，避免破坏 memo） */
const minimapNodeColor = () => "var(--color-secondary)";
const minimapNodeStrokeColor = () => "var(--color-border)";

function CanvasFlow({
  graph,
  layouts,
  selectedId,
  onSelect,
  onMove,
  onConnect,
  onAddNode,
  onAddNodeAt,
  onRemoveNode,
  onRemoveEdge,
  focusNodeId,
  runningNodeIds,
  readOnly,
  nodeStates,
}: GraphCanvasProps) {
  const { setCenter, getInternalNode, screenToFlowPosition } =
    useReactFlow<FlowNode>();
  const canvas = useMemo(() => toCanvas(graph, layouts), [graph, layouts]);

  const nodes: FlowNode[] = useMemo(
    () =>
      canvas.nodes.map((n): FlowNode =>
        n.id === END_NODE_ID
          ? {
              id: n.id,
              type: "end",
              position: n.position,
              data: {},
              selected: n.id === selectedId,
              // END 可拖拽调布局（落点持久化 graphJson.endPosition），
              // 仍不可删（终点语义由边声明，删标记无意义）；只读运行
              // 模式下一并禁拖
              draggable: !readOnly,
              deletable: false,
            }
          : {
              id: n.id,
              type: "card",
              position: n.position,
              data: buildCardData(n, nodeStates),
              selected: n.id === selectedId,
              // 只读运行模式：节点不可拖不可删（「不可编辑」落地，
              // @xyflow/react 12.12 无 nodesEditable prop）
              ...(readOnly ? { draggable: false, deletable: false } : {}),
              // 试运行实时高亮（globals.css 的 node-running 描边脉冲）
              ...(runningNodeIds?.includes(n.id)
                ? { className: "node-running" }
                : {}),
            },
      ),
    [canvas, selectedId, runningNodeIds, readOnly, nodeStates],
  );

  const edges: Edge[] = useMemo(
    () =>
      canvas.edges.map((e) => {
        const selected = e.id === selectedId;
        // 默认色用 muted-foreground（border 色太浅，1px 线在画布上几乎
        // 不可见——用户看不到已连的线）；选中 primary + 加粗；markerEnd
        // 箭头随边状态同色（RF marker 颜色独立于 stroke，须同步指定）
        const stroke = selected
          ? "var(--color-primary)"
          : "var(--color-muted-foreground)";
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          // toCanvas 已按 branchOptions 锚定（缺省时 RF 取第一 handle 兜底）
          ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
          ...(e.label ? { label: e.label } : {}),
          labelStyle: { fontSize: 10 },
          animated: false,
          selected,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: stroke,
            width: 16,
            height: 16,
          },
          style: { stroke, strokeWidth: selected ? 2 : 1.5 },
        };
      }),
    [canvas, selectedId],
  );

  /** 受控流不自持 nodes 状态：position change 映射为 onMove 载荷（防抖
   * 300ms 批量上抛）；dimensions/select 类 change 不落 props——选中态经
   * selectedId 受控，删除经 onNodesDelete/onEdgesDelete。但纯受控下拖拽
   * 期间 props 不更新 → 节点视觉不动，故叠加本地镜像 liveNodes 实时
   * applyNodeChanges（跟手），props nodes 变化即弃镜像（flush 落库后
   * 位置已一致，重置无跳变） */
  const [liveNodes, setLiveNodes] = useState<FlowNode[] | null>(null);
  useEffect(() => {
    setLiveNodes(null);
  }, [nodes]);
  const renderNodes = liveNodes ?? nodes;
  const pendingMoves = useRef<Record<string, { x: number; y: number }>>({});
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMoveRef = useRef(onMove);
  useEffect(() => {
    onMoveRef.current = onMove;
  });

  function flushMoves() {
    moveTimer.current = null;
    const positions = pendingMoves.current;
    pendingMoves.current = {};
    if (Object.keys(positions).length > 0) onMoveRef.current(positions);
  }

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      let hasMove = false;
      for (const change of changes) {
        // 只读运行模式不收集落点（节点已禁拖，此处兜底不外抛）
        if (!readOnly && change.type === "position" && change.position) {
          pendingMoves.current[change.id] = change.position;
          hasMove = true;
        }
      }
      // 即时视觉反馈：changes 应用进镜像（含 position，拖拽跟手）
      setLiveNodes((current) => applyNodeChanges(changes, current ?? nodes));
      if (!hasMove) return;
      if (moveTimer.current !== null) clearTimeout(moveTimer.current);
      moveTimer.current = setTimeout(flushMoves, MOVE_DEBOUNCE_MS);
      // eslint 故意不含 flushMoves/nodes：函数声明每次渲染重建，闭包仅取
      // 稳定 ref；nodes 经 setLiveNodes 函数式更新避免依赖漂移
    },
    [nodes, readOnly],
  );

  /** 卸载兜底：模式切换等场景下未到期的落点不丢 */
  useEffect(() => {
    return () => {
      if (moveTimer.current !== null) {
        clearTimeout(moveTimer.current);
        flushMoves();
      }
    };
  }, []);

  const handleConnect = useCallback(
    (c: Connection) => {
      if (readOnly) return;
      if (c.source && c.target) {
        onConnect({
          source: c.source,
          sourceHandle: c.sourceHandle ?? "plain",
          target: c.target,
        });
      }
    },
    [onConnect, readOnly],
  );

  const handleNodeClick = useCallback<NodeMouseHandler<FlowNode>>(
    (_event, node) => onSelect(node.id),
    [onSelect],
  );
  const handleEdgeClick = useCallback<EdgeMouseHandler<Edge>>(
    (_event, edge) => onSelect(edge.id),
    [onSelect],
  );
  const handlePaneClick = useCallback(() => onSelect(null), [onSelect]);

  const handleNodesDelete = useCallback(
    (deleted: FlowNode[]) => {
      if (readOnly) return;
      for (const node of deleted) {
        if (node.id !== END_NODE_ID) onRemoveNode(node.id);
      }
    },
    [onRemoveNode, readOnly],
  );
  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (readOnly) return;
      for (const edge of deleted) onRemoveEdge(edge.id);
    },
    [onRemoveEdge, readOnly],
  );

  /** focusNodeId 变化：视口居中到节点中心并选中（仅随 focus 变化触发） */
  useEffect(() => {
    if (!focusNodeId) return;
    const target = canvas.nodes.find((n) => n.id === focusNodeId);
    if (!target) return;
    const measured = getInternalNode(focusNodeId)?.measured;
    const width = measured?.width ?? CARD_WIDTH;
    const height = measured?.height ?? CARD_HEIGHT_FALLBACK;
    setCenter(target.position.x + width / 2, target.position.y + height / 2, {
      zoom: 1.2,
    });
    onSelect(focusNodeId);
    // eslint 故意不含 canvas/onSelect 等：仅 focusNodeId 变化时定位一次
  }, [focusNodeId]);

  return (
    <ReactFlow<FlowNode>
      // 画布底色固定灰白（用户裁定：不随主题色/壁纸变化）。走 xyflow 官方
      // CSS 变量而非 bg-* 工具类——库默认样式 .react-flow{background-color:
      // var(--xy-background-color)} 与工具类同为单类选择器，按加载顺序
      // 决胜会被覆盖；变量通道必定生效
      style={{ "--xy-background-color": "#f5f5f5" } as CSSProperties}
      nodes={renderNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      // 只读运行模式不透传连线回调（画布禁连的双保险，配合
      // nodesConnectable=false；@xyflow/react 12.12 无 edgesConnectable
      // prop，连线能力由 nodesConnectable 一并关断）
      onConnect={readOnly ? undefined : handleConnect}
      onNodeClick={handleNodeClick}
      onEdgeClick={handleEdgeClick}
      onPaneClick={handlePaneClick}
      onNodesDelete={handleNodesDelete}
      onEdgesDelete={handleEdgesDelete}
      // 松手立即落库（不等防抖）：镜像与 props 尽快归一，切面板/保存不丢落点
      onNodeDragStop={flushMoves}
      // 连线松手吸附半径（默认 20，卡片较宽，稍放大降低连线难度）
      connectionRadius={30}
      deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
      nodesConnectable={readOnly ? false : undefined}
      // 拖拽节点入画布（AddNodeMenu 卡片 draggable）：drop 转流坐标落点
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (readOnly) return;
        const kind = event.dataTransfer.getData(
          "application/tianshu-node-kind",
        );
        if (!kind) {
          return;
        }
        const position = screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        onAddNodeAt(kind as NodeKind, position);
      }}
    >
      <Background gap={20} />
      <Controls />
      <MiniMap
        nodeColor={minimapNodeColor}
        nodeStrokeColor={minimapNodeStrokeColor}
      />
      {/* 添加节点：Coze 式「+」主按钮 + 分类搜索面板（旧三快捷钮+平铺
       * 下拉在 19 种节点下不可用）；只读运行模式隐藏 */}
      {!readOnly && (
        <Panel position="top-left">
          <AddNodeMenu onAddNode={onAddNode} />
        </Panel>
      )}
    </ReactFlow>
  );
}

/** useReactFlow 依赖 StoreContext：GraphCanvas 自身持 hook 须先包 Provider */
export default function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasFlow {...props} />
    </ReactFlowProvider>
  );
}
