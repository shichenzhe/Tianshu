// @vitest-environment jsdom
/**
 * H5 性能回归：会话内搜索输入防抖——本地即时上屏，store 查询延迟提交。
 * store.query 是 MessageList 全量重扫的触发器（逐消息 parseBlocks 的
 * JSON.parse + 全文匹配），逐击键直写会让长会话每次按键做一轮
 * O(N 消息) 重扫并联动全列表重渲染（见性能审查报告 H5）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

import SessionSearchBox from "../../src-react/domains/ai/layout/components/SessionSearchBox";
import { useSessionSearchStore } from "../../src-react/domains/ai/store/session-search.store";

const renderBox = () =>
  render(
    <MemoryRouter initialEntries={["/chat?session=1"]}>
      <SessionSearchBox />
    </MemoryRouter>,
  );

const inputOf = (container: HTMLElement) =>
  container.querySelector("input") as HTMLInputElement;

describe("会话内搜索框防抖（H5）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    act(() => {
      useSessionSearchStore.getState().reset();
      useSessionSearchStore.getState().setOpen(true);
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("击键即时上屏，store 查询在停顿后才提交", () => {
    const { container } = renderBox();
    const input = inputOf(container);
    fireEvent.change(input, { target: { value: "abc" } });
    // 即时上屏：受控源为本地 state，输入不滞后
    expect(input.value).toBe("abc");
    // 防抖窗口内 store 未被写入（旧实现逐击键直写 → 此处失败）
    expect(useSessionSearchStore.getState().query).toBe("");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(useSessionSearchStore.getState().query).toBe("abc");
  });

  it("收起再展开：本地输入框随 store 清空复原为空", () => {
    const { container } = renderBox();
    const input = inputOf(container);
    fireEvent.change(input, { target: { value: "abc" } });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // store 侧收起（X 按钮同效：setOpen(false) 连带清空 query）；拆两次
    // act 对应真实两次交互——同一 act 内 true→false→true 会被批处理成
    // open 净不变，清空 effect 不执行
    act(() => {
      useSessionSearchStore.getState().setOpen(false);
    });
    act(() => {
      useSessionSearchStore.getState().setOpen(true);
    });
    expect(inputOf(container).value).toBe("");
  });
});
