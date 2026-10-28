/**
 * session-search store 位置级升级测试（markdown 源位置追踪批）：
 * - setHits 回填命中集合并派生 totalHits（同引用不触发刷新）
 * - navigate 循环导航语义保持（delta ±1 取模环绕）
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useSessionSearchStore } from "../../src-react/domains/ai/store/session-search.store";

beforeEach(() => {
  useSessionSearchStore.getState().reset();
});

describe("setHits 位置级命中回填", () => {
  it("回填集合并派生 totalHits", () => {
    const hits = [
      { messageIdx: 0, blockIdx: 0, start: 2, length: 3 },
      { messageIdx: 1, blockIdx: 2, start: 5, length: 3 },
    ];
    useSessionSearchStore.getState().setHits(hits);
    const state = useSessionSearchStore.getState();
    expect(state.hits).toEqual(hits);
    expect(state.totalHits).toBe(2);
  });

  it("同引用不触发刷新（MessageList useMemo 稳定引用守卫）", () => {
    const hits = [{ messageIdx: 0, blockIdx: 0, start: 0, length: 1 }];
    useSessionSearchStore.getState().setHits(hits);
    let emissions = 0;
    const unsubscribe = useSessionSearchStore.subscribe(() => {
      emissions += 1;
    });
    useSessionSearchStore.getState().setHits(hits);
    unsubscribe();
    expect(emissions).toBe(0);
  });

  it("新集合重置 totalHits；空集合归零", () => {
    useSessionSearchStore
      .getState()
      .setHits([{ messageIdx: 0, blockIdx: 0, start: 0, length: 1 }]);
    useSessionSearchStore.getState().setHits([]);
    expect(useSessionSearchStore.getState().totalHits).toBe(0);
  });
});

describe("navigate 循环导航语义保持", () => {
  it("totalHits<=0 时不变", () => {
    useSessionSearchStore.getState().navigate(1);
    expect(useSessionSearchStore.getState().activeIndex).toBe(0);
  });

  it("到底环绕（末条下一条回第一条）", () => {
    useSessionSearchStore.getState().setHits(
      [0, 1, 2].map((messageIdx) => ({
        messageIdx,
        blockIdx: 0,
        start: 0,
        length: 1,
      })),
    );
    const { navigate } = useSessionSearchStore.getState();
    navigate(1);
    navigate(1);
    expect(useSessionSearchStore.getState().activeIndex).toBe(2);
    navigate(1);
    expect(useSessionSearchStore.getState().activeIndex).toBe(0);
    navigate(-1);
    expect(useSessionSearchStore.getState().activeIndex).toBe(2);
  });

  it("setQuery 后序号复位第一条", () => {
    useSessionSearchStore.getState().setHits(
      [0, 1].map((messageIdx) => ({
        messageIdx,
        blockIdx: 0,
        start: 0,
        length: 1,
      })),
    );
    useSessionSearchStore.getState().navigate(1);
    useSessionSearchStore.getState().setQuery("新词");
    expect(useSessionSearchStore.getState().activeIndex).toBe(0);
  });
});
