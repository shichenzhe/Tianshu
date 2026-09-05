import { describe, expect, it } from "vitest";
import { PermissionStore } from "../../electron/domains/ai/agent/permission-mode";

describe("PermissionStore", () => {
  it("未设置的会话缺省返回 default", () => {
    const store = new PermissionStore();
    expect(store.get(1)).toBe("default");
  });

  it("set 后 get 返回新值（覆盖）", () => {
    const store = new PermissionStore();
    store.set(1, "full");
    expect(store.get(1)).toBe("full");
    store.set(1, "default");
    expect(store.get(1)).toBe("default");
  });

  it("会话间互不影响（隔离）", () => {
    const store = new PermissionStore();
    store.set(1, "full");
    expect(store.get(1)).toBe("full");
    expect(store.get(2)).toBe("default");
  });
});
