// @vitest-environment jsdom
// MessageItem 消息级插槽（renderExtra）单测：传则渲染在气泡下方，不传零变化
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/domains/ai/api/model.api", () => ({
  ModelApi: { listAll: async () => [] },
  modelDisplayName: (m: { name?: string; modelId: string }) =>
    m.name || m.modelId,
}));
vi.mock("@/domains/ai/chat/components/MarkdownView", () => ({
  default: ({ text }: { text: string }) => <div data-testid="md">{text}</div>,
}));
vi.mock("@/domains/ai/chat/components/ThinkingPanel", () => ({
  default: () => null,
}));

import MessageItem from "@/domains/ai/chat/components/MessageItem";
import type { MessageRecord } from "@/domains/ai/api/session.api";

const message: MessageRecord = {
  id: 1,
  sessionId: 1,
  role: "assistant",
  blocks: JSON.stringify([{ type: "text", text: "hi" }]),
  createdAt: "2026-11-17T00:00:00Z",
};

function renderItem(extra?: (m: MessageRecord) => React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MessageItem message={message} renderExtra={extra} />
    </QueryClientProvider>,
  );
}

describe("MessageItem renderExtra", () => {
  it("传入插槽时渲染在消息下方", () => {
    renderItem(() => <div data-testid="extra">X</div>);
    expect(screen.getByTestId("extra").textContent).toBe("X");
  });

  it("不传插槽时无额外节点（零行为变化）", () => {
    renderItem();
    expect(screen.queryByTestId("extra")).toBeNull();
  });
});
