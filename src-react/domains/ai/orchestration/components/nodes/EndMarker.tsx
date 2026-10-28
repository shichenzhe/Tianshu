// src-react/domains/ai/orchestration/components/nodes/EndMarker.tsx
/**
 * END 虚拟节点（spec §2）：画布右缘终点标记，仅 target handle 可连线入；
 * 不可拖/不可删由 GraphCanvas 组装 node 时置 draggable/deletable=false
 * （END_NODE_ID 判定），本组件只负责外观。
 */
import { Handle, Position, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";

export type EndMarkerNode = Node<Record<string, never>, "end">;

export default function EndMarker() {
  const { t } = useTranslation(["chat"]);
  return (
    <div className="rounded-full border border-dashed border-border bg-card px-4 py-2 text-xs text-muted-foreground">
      <Handle type="target" position={Position.Left} id="target" />
      {t("chat:orchestration.editor.endNode")}
    </div>
  );
}
