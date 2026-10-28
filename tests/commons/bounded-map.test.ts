// tests/commons/bounded-map.test.ts
/** 有界 Map：FIFO 逐出、get/set/has/size 语义与 Map 对齐 */
import { describe, expect, it } from "vitest";
import { createBoundedMap } from "../../electron/commons/bounded-map";

describe("createBoundedMap", () => {
  it("未超上限：get/set/has/size 语义与 Map 一致", () => {
    const map = createBoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1);
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(false);
    expect(map.size).toBe(2);
  });

  it("超上限：按插入序逐出最旧，最新保留", () => {
    const map = createBoundedMap<number, string>(2);
    map.set(1, "一");
    map.set(2, "二");
    map.set(3, "三");
    expect(map.size).toBe(2);
    expect(map.has(1)).toBe(false);
    expect(map.get(2)).toBe("二");
    expect(map.get(3)).toBe("三");
  });

  it("重复 set 已有键：不刷新插入序（仍按首次插入逐出）", () => {
    const map = createBoundedMap<number, string>(2);
    map.set(1, "一");
    map.set(2, "二");
    map.set(1, "一改");
    map.set(3, "三");
    expect(map.has(1)).toBe(false);
    expect(map.get(3)).toBe("三");
    expect(map.size).toBe(2);
  });
});
