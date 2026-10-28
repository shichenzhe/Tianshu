import { describe, expect, it } from "vitest";

import { ENDPOINTS } from "@tianshu/protocol";

describe("@tianshu/protocol（npm file: symlink，node 侧消费）", () => {
  it("ENDPOINTS.session.approve 契约值不变", () => {
    expect(ENDPOINTS.session.approve).toBe("session/approve");
  });
});
