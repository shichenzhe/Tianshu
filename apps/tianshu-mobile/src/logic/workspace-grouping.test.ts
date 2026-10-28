import { describe, expect, it } from "vitest";

import { groupSessionsByWorkspace } from "./workspace-grouping";

/** 列表行子集（分组只消费 workspaceId，其余字段略） */
const row = (id: number, workspaceId?: number | null) =>
  ({ id, workspaceId }) as unknown as Parameters<
    typeof groupSessionsByWorkspace
  >[0][number];

describe("groupSessionsByWorkspace（MB-T2，对齐桌面 HD-A2 语义）", () => {
  it("按 workspaceId 归组、组序随 id 升序、组内保持原序", () => {
    const groups = groupSessionsByWorkspace(
      [row(1, 2), row(2, 1), row(3, 2), row(4, 1)],
      [
        { id: 1, name: "空间一" },
        { id: 2, name: "空间二" },
      ],
      "未归属",
    );
    expect(groups.map((g) => g.title)).toEqual(["空间一", "空间二"]);
    expect(groups[0].data.map((r) => r.id)).toEqual([2, 4]);
    expect(groups[1].data.map((r) => r.id)).toEqual([1, 3]);
  });

  it("未匹配任何空间的会话进兜底组（列表窗口期防御）且沉底", () => {
    const groups = groupSessionsByWorkspace(
      [row(1, 99), row(2, 1), row(3, null)],
      [{ id: 1, name: "空间一" }],
      "未归属会话",
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].title).toBe("空间一");
    expect(groups[1].title).toBe("未归属会话");
    expect(groups[1].data.map((r) => r.id)).toEqual([1, 3]);
  });

  it("空会话表 → 空组集（不产生空组）；workspaces 为空全进兜底", () => {
    expect(groupSessionsByWorkspace([], [{ id: 1, name: "a" }], "x")).toEqual(
      [],
    );
    const fallbackOnly = groupSessionsByWorkspace([row(1, 5)], [], "兜底");
    expect(fallbackOnly).toHaveLength(1);
    expect(fallbackOnly[0].title).toBe("兜底");
  });

  it("空空间（无会话匹配）不出组——组只在有数据时出现", () => {
    const groups = groupSessionsByWorkspace(
      [row(1, 1)],
      [
        { id: 1, name: "有会话" },
        { id: 2, name: "空空间" },
      ],
      "x",
    );
    expect(groups.map((g) => g.title)).toEqual(["有会话"]);
  });
});
