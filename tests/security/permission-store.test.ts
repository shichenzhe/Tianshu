/** PermissionStore.listFull（SP6 系统授权卡数据源，spec §4.1） */
import { describe, expect, it } from "vitest";
import { PermissionStore } from "../../electron/domains/ai/agent/permission-mode";

describe("PermissionStore.listFull", () => {
  it("只列 full 会话；set 回 default 后不再列出", () => {
    const store = new PermissionStore();
    store.set(1, "full");
    store.set(2, "default");
    store.set(3, "full");
    expect(store.listFull()).toEqual([1, 3]);
    store.set(1, "default");
    expect(store.listFull()).toEqual([3]);
  });
});
