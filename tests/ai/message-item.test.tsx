// @vitest-environment jsdom
/**
 * M8 性能回归：MessageItem 支持结构化 blocks 直传（parsedBlocks）——
 * 流式 liveMessage 不再走 serializeBlocks→parseBlocks 的全量 JSON 往返
 * （30ms flush 节奏下每秒约 33 次 stringify+parse，长答案尾段累计
 * O(n²)，见性能审查报告 M8）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

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

const base = {
  id: 1,
  sessionId: 1,
  role: "assistant",
  // 故意放非 JSON：若误走 parseBlocks 路径会得到空 blocks（无法渲染正文）
  blocks: "!!!非 JSON!!!",
  createdAt: "",
} as MessageRecord;

describe("MessageItem 结构化 blocks 直传（M8）", () => {
  afterEach(cleanup);

  it("parsedBlocks 提供时跳过 JSON 解析直接渲染正文", () => {
    const { container } = render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(MessageItem, {
          message: base,
          parsedBlocks: [{ type: "text", text: "直传的流式内容" }] as never,
        }),
      ),
    );
    expect(container.textContent).toContain("直传的流式内容");
  });

  it("无 parsedBlocks 时维持原 JSON 解析路径（历史消息）", () => {
    const history = {
      ...base,
      blocks: JSON.stringify([{ type: "text", text: "历史消息内容" }]),
    } as MessageRecord;
    const { container } = render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(MessageItem, { message: history }),
      ),
    );
    expect(container.textContent).toContain("历史消息内容");
  });
});

describe("MessageItem assistant 头像列", () => {
  afterEach(cleanup);

  const history = {
    ...base,
    blocks: JSON.stringify([{ type: "text", text: "回复内容" }]),
  } as MessageRecord;

  it("assistantIcon 传入时渲染专家 emoji 头像", () => {
    const { container } = render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(MessageItem, {
          message: history,
          assistantIcon: "🧭",
        }),
      ),
    );
    expect(container.textContent).toContain("🧭");
  });

  it("无 icon 时渲染默认 Logo（不含 emoji，内容仍在）", () => {
    const { container } = render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(MessageItem, { message: history }),
      ),
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent).toContain("回复内容");
  });
});
