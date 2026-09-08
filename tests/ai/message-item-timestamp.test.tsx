// @vitest-environment jsdom
/**
 * MessageItem 悬浮时间戳测试（jsdom + testing-library，Date 假时钟钉住参照
 * 时钟，格式档位判定不随运行日期漂移）：
 * - assistant 非流式：时间戳常驻操作行最右（模型标识之后），显隐交由
 *   opacity-0 → group-hover:opacity-100 150ms 淡入淡出类契约；无模型标识
 *   仍在行尾显示
 * - hover 重算：参照时钟跨天后再次移入，格式换档（与 user 同机制）
 * - streaming：不渲染时间戳（移入后也不显示）
 * - user 侧不回归：共用 HoverTimestamp，悬浮才挂载，格式/样式与 assistant
 *   一致
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { MessageRecord } from "../../src-react/domains/ai/api/session.api";
import { serializeBlocks } from "../../src-react/domains/ai/chat/model/blocks";
import MessageItem from "../../src-react/domains/ai/chat/components/MessageItem";

// i18n mock：与 message-item-edit.test.tsx 同套（t 直接返回 key）；此外
// i18n.language 固定 zh-CN，时间戳格式断言口径确定（assistant 操作行的时间
// 戳常驻渲染，i18n 会被立即读取，不能省略）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
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
// ModelApi mock：操作行模型标识免 IPC 解析，用于断言时间戳位于其右侧
vi.mock("../../src-react/domains/ai/api/model.api", () => ({
  ModelApi: {
    listAll: () =>
      Promise.resolve([
        { id: 7, providerId: 1, modelId: "demo-model", enabled: true },
      ]),
  },
}));

/** 本地时区某时刻的 ISO 串（模拟后端落库 createdAt，与 message-time.test.ts 一致） */
function isoOf(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

/** 构造 assistant 消息（正文单个 text 块；overrides 覆盖 modelId/createdAt 等） */
function assistantMessage(
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    id: 201,
    sessionId: 1,
    role: "assistant",
    blocks: serializeBlocks([{ type: "text", text: "AI 回复正文" }]),
    createdAt: isoOf(2026, 9, 8, 9, 5),
    ...overrides,
  };
}

/** 渲染单条 MessageItem（包 QueryClientProvider），返回根节点（group 容器） */
function renderItem(message: MessageRecord, streaming = false) {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageItem message={message} streaming={streaming} />
    </QueryClientProvider>,
  );
  return container.firstElementChild as HTMLElement;
}

// 参照时钟固定为本地 2026-09-08 18:00（与消息 09:05 同日 → 当天档 HH:mm），
// 仅伪造 Date，定时器保持真实避免干扰 react-query/RTL 内部调度
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 8, 18, 0), toFake: ["Date"] });
});

// vitest 未开 globals，RTL 自动清理不生效，显式清理并还原真实时钟
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MessageItem assistant 悬浮时间戳", () => {
  it("非流式：常驻操作行最右（模型标识之后），淡入淡出交由 group-hover 类契约", async () => {
    renderItem(assistantMessage({ modelId: 7 }));
    // 模型标识经 react-query 异步解析，等其出现后再断言时间戳位置
    expect(await screen.findByText("demo-model")).toBeTruthy();
    const timestamp = screen.getByText("09:05");
    // 显隐契约：默认 opacity-0、悬浮显出、150ms 过渡；纯展示不可点击/选中
    const expectedClasses = [
      "text-xs",
      "text-muted-foreground",
      "select-none",
      "pointer-events-none",
      "opacity-0",
      "group-hover:opacity-100",
      "transition-opacity",
      "duration-150",
      "ml-2",
    ];
    for (const cls of expectedClasses) {
      expect(timestamp.className).toContain(cls);
    }
    // 最右：操作行（时间戳父级）最后一个节点即时间戳
    expect(timestamp.parentElement?.lastElementChild).toBe(timestamp);
  });

  it("无模型标识：时间戳仍在行尾显示", () => {
    renderItem(assistantMessage());
    expect(screen.queryByText("demo-model")).toBeNull();
    const timestamp = screen.getByText("09:05");
    expect(timestamp.parentElement?.lastElementChild).toBe(timestamp);
  });

  it("hover 重算：参照时钟跨天后再次移入，格式换档为同年不同日", () => {
    const group = renderItem(assistantMessage());
    expect(screen.getByText("09:05")).toBeTruthy();
    // 参照时钟推进一天，移入触发重渲染、formatMessageTime 按当前时钟重算
    vi.setSystemTime(new Date(2026, 8, 9, 8, 0));
    fireEvent.mouseEnter(group);
    expect(screen.getByText("9月8日 09:05")).toBeTruthy();
    expect(screen.queryByText("09:05")).toBeNull();
  });

  it("streaming：不渲染时间戳（移入后也不显示）", () => {
    const group = renderItem(assistantMessage(), true);
    expect(screen.queryByText("09:05")).toBeNull();
    fireEvent.mouseEnter(group);
    expect(screen.queryByText("09:05")).toBeNull();
  });
});

describe("MessageItem user 悬浮时间戳（共用 HoverTimestamp 不回归）", () => {
  it("悬浮才挂载/移出即卸载，格式与样式与 assistant 一致（无 ml-2）", () => {
    const message: MessageRecord = {
      id: 101,
      sessionId: 1,
      role: "user",
      blocks: serializeBlocks([{ type: "text", text: "用户消息" }]),
      createdAt: isoOf(2026, 9, 8, 9, 5),
    };
    const group = renderItem(message);
    // 未悬浮不挂载（user 悬浮时按需计算）
    expect(screen.queryByText("09:05")).toBeNull();
    fireEvent.mouseEnter(group);
    const timestamp = screen.getByText("09:05");
    expect(timestamp.className).toContain("group-hover:opacity-100");
    expect(timestamp.className).toContain("duration-150");
    expect(timestamp.className).not.toContain("ml-2");
    fireEvent.mouseLeave(group);
    expect(screen.queryByText("09:05")).toBeNull();
  });
});
