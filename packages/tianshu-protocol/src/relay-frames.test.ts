import { describe, expect, it } from "vitest";

import { RELAY_CLOSE_CODES } from "./relay-frames";

// relay 多租户三校验点的语义化关闭码（spec §4.2）——wire 契约值钉死，
// relay/被控端断开与控制端分支提示共同消费，改值即破协议
describe("RELAY_CLOSE_CODES", () => {
  it("三校验点 close code 取值固定", () => {
    expect(RELAY_CLOSE_CODES).toEqual({
      QUOTA_EXCEEDED: 4005,
      ID_CONFLICT: 4006,
      TENANT_FORBIDDEN: 4007,
    });
  });
});
