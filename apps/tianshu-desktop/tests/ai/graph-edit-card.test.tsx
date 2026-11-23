// @vitest-environment jsdom
// 图 AI 消息级回执卡片单测：解析→校验→自动应用→回执/失败态
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => key + JSON.stringify(opts ?? {}),
    i18n: { language: "zh" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import {
  canUndoReceipt,
  default as GraphEditCard,
  extractTextOfMessage,
} from "@/domains/ai/orchestration/components/GraphEditCard";
import {
  emptyGraph,
  newCodeNode,
  serializeGraph,
} from "@/domains/ai/orchestration/lib/graph-editor-model";
import type { MessageRecord } from "@/domains/ai/api/session.api";

const validNode = { ...newCodeNode("code-1"), name: "代码", script: "echo hi" };

// 补齐占位节点为合法图（emptyGraph 的 node-1 name/modelId/prompt 为空）
function validGraph() {
  const g = emptyGraph();
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === "node-1"
        ? { ...n, name: "首节点", modelId: 1, prompt: "你好" }
        : n,
    ),
  };
}

function assistantMessage(text: string): MessageRecord {
  return {
    id: 1,
    sessionId: 1,
    role: "assistant",
    blocks: JSON.stringify([{ type: "text", text }]),
    createdAt: "2026-11-17T00:00:00Z",
  };
}

function opsMessage(ops: unknown[]): MessageRecord {
  const block = "```json\n" + JSON.stringify({ ops }) + "\n```";
  return assistantMessage(`已修改：\n${block}`);
}

describe("extractTextOfMessage", () => {
  it("拼接 text 块并忽略其他块", () => {
    const blocks = JSON.stringify([
      { type: "thinking", text: "想" },
      { type: "text", text: "第一" },
      { type: "tool_call", text: "工具" },
      { type: "text", text: "第二" },
    ]);
    expect(extractTextOfMessage(blocks)).toBe("第一\n第二");
  });

  it("blocks 非法 JSON 返回空串", () => {
    expect(extractTextOfMessage("{oops")).toBe("");
  });
});

describe("canUndoReceipt", () => {
  it("应用后画布未被再改时可撤销，再改后不可", () => {
    const json = serializeGraph(validGraph());
    expect(canUndoReceipt(json, json)).toBe(true);
    expect(canUndoReceipt(json, serializeGraph(emptyGraph()))).toBe(false);
  });
});

describe("GraphEditCard", () => {
  function renderCard(
    message: MessageRecord,
    handlers: {
      onApplyOps?: (ops: never[]) => void;
      onApplyFull?: (json: unknown) => void;
      onUndo?: () => void;
    } = {},
  ) {
    return render(
      <GraphEditCard
        message={message}
        graphJson={serializeGraph(validGraph())}
        autoApplyAfter={0}
        onApplyOps={handlers.onApplyOps ?? (() => {})}
        onApplyFull={handlers.onApplyFull ?? (() => {})}
        onUndo={handlers.onUndo ?? (() => {})}
      />,
    );
  }

  it("历史消息（早于本次会话起点）不自动应用且不渲染卡片", () => {
    const onApplyOps = vi.fn();
    const msg = opsMessage([{ op: "addNode", node: validNode }]);
    msg.createdAt = "2026-11-01T00:00:00.000Z";
    render(
      <GraphEditCard
        message={msg}
        graphJson={serializeGraph(validGraph())}
        autoApplyAfter={Date.now()}
        onApplyOps={onApplyOps as (ops: never[]) => void}
        onApplyFull={() => {}}
        onUndo={() => {}}
      />,
    );
    expect(onApplyOps).not.toHaveBeenCalled();
    expect(screen.queryByTestId("graph-edit-card")).toBeNull();
  });

  it("重挂载同一历史消息仍不重复应用（模块级守卫）", () => {
    const onApplyOps = vi.fn();
    const msg = opsMessage([{ op: "addNode", node: validNode }]);
    msg.createdAt = "2026-11-01T00:00:00.000Z";
    const props = {
      message: msg,
      graphJson: serializeGraph(validGraph()),
      autoApplyAfter: Date.now(),
      onApplyOps: onApplyOps as (ops: never[]) => void,
      onApplyFull: () => {},
      onUndo: () => {},
    };
    const first = render(<GraphEditCard {...props} />);
    first.unmount();
    render(<GraphEditCard {...props} />);
    expect(onApplyOps).not.toHaveBeenCalled();
  });

  it("合法变更单自动应用一次并显示回执", () => {
    const onApplyOps = vi.fn();
    // 孤节点会触发 uniqueEntry 语义问题——新增节点需带连线
    const msg = opsMessage([
      { op: "addNode", node: validNode },
      { op: "addEdge", edge: { from: "node-1", to: "code-1" } },
    ]);
    const { rerender } = renderCard(msg, {
      onApplyOps: onApplyOps as (ops: never[]) => void,
    });
    expect(onApplyOps).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("graph-edit-card").textContent).toContain(
      "chat:orchestration.editor.ai.receiptApplied",
    );
    expect(screen.getByTestId("graph-edit-card").textContent).toContain(
      "code-1",
    );
    // 重复渲染不重复应用
    rerender(
      <GraphEditCard
        message={msg}
        graphJson={serializeGraph(validGraph())}
        autoApplyAfter={0}
        onApplyOps={onApplyOps as (ops: never[]) => void}
        onApplyFull={() => {}}
        onUndo={() => {}}
      />,
    );
    expect(onApplyOps).toHaveBeenCalledTimes(1);
  });

  it("校验失败不应用，卡片列出问题", () => {
    const onApplyOps = vi.fn();
    // 第二个 start 节点 → duplicateStartNode 语义问题
    const startNode = validGraph().nodes.find((n) => n.kind === "start")!;
    renderCard(opsMessage([{ op: "addNode", node: startNode }]), {
      onApplyOps: onApplyOps as (ops: never[]) => void,
    });
    expect(onApplyOps).not.toHaveBeenCalled();
    const card = screen.getByTestId("graph-edit-card").textContent ?? "";
    expect(card).toContain("chat:orchestration.editor.ai.receiptFailed");
  });

  it("新建图占位草稿未过 schema 时，合法全量替换仍可应用", () => {
    const onApplyFull = vi.fn();
    const full = "```json\n" + serializeGraph(validGraph()) + "\n```";
    render(
      <GraphEditCard
        message={assistantMessage(full)}
        graphJson={serializeGraph(emptyGraph())}
        autoApplyAfter={0}
        onApplyOps={() => {}}
        onApplyFull={onApplyFull as (json: unknown) => void}
        onUndo={() => {}}
      />,
    );
    expect(onApplyFull).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("graph-edit-card").textContent).toContain(
      "chat:orchestration.editor.ai.receiptApplied",
    );
  });

  it("操作前置失败（节点不存在）显示本地化错误码，不裸抛中文串", () => {
    const onApplyOps = vi.fn();
    renderCard(
      opsMessage([{ op: "updateNode", id: "ghost", patch: { name: "x" } }]),
      { onApplyOps: onApplyOps as (ops: never[]) => void },
    );
    expect(onApplyOps).not.toHaveBeenCalled();
    const card = screen.getByTestId("graph-edit-card").textContent ?? "";
    expect(card).toContain("chat:orchestration.editor.ai.errNodeMissing");
    expect(card).not.toContain("节点不存在");
  });

  it("应用成功出成功 toast（卡片之外的统一反馈）", () => {
    const msg = opsMessage([
      { op: "addNode", node: validNode },
      { op: "addEdge", edge: { from: "node-1", to: "code-1" } },
    ]);
    renderCard(msg);
    expect(toastMock.success).toHaveBeenCalledWith(
      "chat:orchestration.editor.ai.applyOk{}",
    );
  });

  it("无可提取内容时返回 null", () => {
    const { container } = renderCard(assistantMessage("纯问答无代码块"));
    expect(container.firstChild).toBeNull();
  });
});
