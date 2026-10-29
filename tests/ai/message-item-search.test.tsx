// @vitest-environment jsdom
/**
 * MessageItem 搜索态接线测试（markdown 源位置追踪批 spec §2 导航面）：
 * - assistant 跨块命中 data-hit-index 全局序与块序一致（hitBase 接续）
 * - user 气泡位置级命中换算余文坐标（文件引用前缀不高亮）
 * - 伪工具调用折叠条无 mark；未搜索态不渲染 mark
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN" },
    }),
  };
});

import MessageItem from "../../src-react/domains/ai/chat/components/MessageItem";
import type { MessageRecord } from "../../src-react/domains/ai/api/session.api";
import { useSessionSearchStore } from "../../src-react/domains/ai/store/session-search.store";
import type { BlockHit } from "../../src-react/domains/ai/chat/lib/hit-positions";

function renderItem(element: ReactElement) {
  return render(
    createElement(QueryClientProvider, { client: new QueryClient() }, element),
  );
}

function assistantMessage(blocks: unknown[]): MessageRecord {
  return {
    id: 1,
    sessionId: 1,
    role: "assistant",
    blocks: JSON.stringify(blocks),
    createdAt: "",
  } as MessageRecord;
}

const markIndices = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("mark[data-hit-index]")).map((mark) =>
    mark.getAttribute("data-hit-index"),
  );

beforeEach(() => {
  useSessionSearchStore.getState().reset();
});

afterEach(cleanup);

describe("MessageItem 搜索态接线（位置级命中）", () => {
  it("assistant 跨块命中：data-hit-index 全局序按块序编排", () => {
    useSessionSearchStore.setState({ open: true, query: "命中词" });
    const message = assistantMessage([
      { type: "text", text: "甲 命中词 乙 命中词" },
      { type: "text", text: "丙 命中词" },
    ]);
    const searchHits: BlockHit[] = [
      { blockIdx: 0, start: 2, length: 3 },
      { blockIdx: 0, start: 8, length: 3 },
      { blockIdx: 1, start: 2, length: 3 },
    ];
    const { container } = renderItem(
      createElement(MessageItem, { message, hitOffset: 0, searchHits }),
    );
    expect(markIndices(container)).toEqual(["0", "1", "2"]);
  });

  it("hitOffset 基序号下发：后续消息接续全局序", () => {
    useSessionSearchStore.setState({ open: true, query: "命中词" });
    const message = assistantMessage([
      { type: "text", text: "甲 命中词" },
      { type: "text", text: "乙 命中词" },
    ]);
    const searchHits: BlockHit[] = [
      { blockIdx: 0, start: 2, length: 3 },
      { blockIdx: 1, start: 2, length: 3 },
    ];
    const { container } = renderItem(
      createElement(MessageItem, { message, hitOffset: 5, searchHits }),
    );
    expect(markIndices(container)).toEqual(["5", "6"]);
  });

  it("user 气泡：命中换算余文坐标，文件引用前缀不高亮", () => {
    useSessionSearchStore.setState({ open: true, query: "命中词" });
    const refPrefix =
      "[引用文件 src/a.ts]（请用 read 工具读取该文件后处理）";
    const message = {
      ...assistantMessage([]),
      role: "user",
      blocks: JSON.stringify([
        { type: "text", text: `${refPrefix}\n\n问题 命中词 是什么` },
      ]),
    } as MessageRecord;
    const searchHits: BlockHit[] = [
      { blockIdx: 0, start: refPrefix.length + 5, length: 3 },
    ];
    const { container } = renderItem(
      createElement(MessageItem, { message, hitOffset: 0, searchHits }),
    );
    const marks = container.querySelectorAll("mark[data-hit-index]");
    expect(markIndices(container)).toEqual(["0"]);
    expect(marks[0].textContent).toBe("命中词");
    // 前缀引用段拆出渲染文件卡片（无 mark 落点——命中已随前缀剔除）
    expect(container.textContent).not.toContain("[引用文件");
  });

  it("伪工具调用条不渲染正文 mark（折叠条替代渲染）", () => {
    useSessionSearchStore.setState({ open: true, query: "tool_call" });
    const message = assistantMessage([
      {
        type: "text",
        text: "<tool_call>fn()</tool_call>\n<tool_call>fn()</tool_call>",
      },
    ]);
    const { container } = renderItem(
      createElement(MessageItem, { message, hitOffset: 0, searchHits: [] }),
    );
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });

  it("未搜索态（query 空）不渲染 mark——即使 searchHits 传入", () => {
    const message = assistantMessage([{ type: "text", text: "甲 命中词" }]);
    const searchHits: BlockHit[] = [{ blockIdx: 0, start: 2, length: 3 }];
    const { container } = renderItem(
      createElement(MessageItem, { message, hitOffset: 0, searchHits }),
    );
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });
});
