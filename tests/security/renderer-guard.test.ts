import { beforeEach, describe, expect, it, vi } from "vitest";

// electron mock 照 delete-file-tool.test.ts 先例：async 实现避免
// shell.openExternal(...).catch 在 undefined 上抛错；renderer-guard 只
// import { session, shell }，覆盖这两个命名空间即可。vi.hoisted 使
// openExternal 在被提升的 vi.mock 工厂执行前初始化
const openExternal = vi.hoisted(() => vi.fn(async (url: string) => void url));
vi.mock("electron", () => ({
  shell: { openExternal },
  session: { defaultSession: { webRequest: { onBeforeRequest: vi.fn() } } },
}));
// network-gate 传递依赖 Log（→ electron，终审 S2）；本文件 electron mock 无
// app.getPath，故直接 mock Log（照 settings.service.test 先例）
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));
vi.mock(
  "../../electron/domains/security/network-gate",
  async (importOriginal) => {
    const orig =
      await importOriginal<
        typeof import("../../electron/domains/security/network-gate")
      >();
    return { ...orig, getNetworkGate: vi.fn() };
  },
);

import { getNetworkGate } from "../../electron/domains/security/network-gate";
import {
  handleWindowOpen,
  shouldAllowNavigation,
} from "../../electron/domains/security/renderer-guard";
import type { NetworkGate } from "../../electron/domains/security/network-gate";

function mockGate(
  judgeUrl: (
    u: string,
  ) => { ok: true } | { ok: false; host: string; rule: string },
) {
  const blockedAudit = vi.fn();
  vi.mocked(getNetworkGate).mockReturnValue({
    judgeUrl,
    blockedAudit,
  } as unknown as NetworkGate);
  return blockedAudit;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleWindowOpen（SP5 裁定 3：恒拒内开窗）", () => {
  it("放行域 → external 并调 openExternal", () => {
    const blocked = mockGate(() => ({ ok: true }));
    expect(handleWindowOpen("https://ok.com")).toBe("external");
    expect(openExternal).toHaveBeenCalledWith("https://ok.com");
    expect(blocked).not.toHaveBeenCalled();
  });
  it("deny 域 → deny + 审计 source=renderer", () => {
    const blocked = mockGate(() => ({
      ok: false,
      host: "evil.com",
      rule: "deny",
    }));
    expect(handleWindowOpen("https://evil.com")).toBe("deny");
    expect(openExternal).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith("evil.com", "deny", "renderer");
  });
  it("门未装（null）→ external（旁路但不开内窗）", () => {
    vi.mocked(getNetworkGate).mockReturnValue(null);
    expect(handleWindowOpen("https://any.com")).toBe("external");
  });
});

describe("shouldAllowNavigation", () => {
  it("仅 file:// 与 dev server 放行；http(s) 远程一律拒", () => {
    expect(shouldAllowNavigation("file:///app/index.html", undefined)).toBe(
      true,
    );
    expect(
      shouldAllowNavigation("http://localhost:5173/x", "http://localhost:5173"),
    ).toBe(true);
    expect(shouldAllowNavigation("https://evil.com", undefined)).toBe(false);
    expect(shouldAllowNavigation("http://localhost:5173/x", undefined)).toBe(
      false,
    );
  });
  it("fix round 1：origin 精确比较——无尾斜杠时前缀同形域/userinfo 伪装即原绕过面", () => {
    expect(
      shouldAllowNavigation(
        "http://localhost:5173.evil.com/x",
        "http://localhost:5173",
      ),
    ).toBe(false);
    expect(
      shouldAllowNavigation(
        "http://localhost:5173@evil.com/",
        "http://localhost:5173",
      ),
    ).toBe(false);
  });
  it("fix round 1：origin 精确比较——带尾斜杠的 review 用例同样拒", () => {
    expect(
      shouldAllowNavigation(
        "http://localhost:5173.evil.com/x",
        "http://localhost:5173/",
      ),
    ).toBe(false);
    expect(
      shouldAllowNavigation("http://5173@evil.com/", "http://localhost:5173/"),
    ).toBe(false);
  });
  it("fix round 1：devServerOrigin 带不带尾斜杠等价（消除隐式不变量）", () => {
    expect(
      shouldAllowNavigation(
        "http://localhost:5173/x",
        "http://localhost:5173/",
      ),
    ).toBe(true);
  });
  it("fix round 1：非法 URL fail-closed 返回 false", () => {
    expect(shouldAllowNavigation("not a url", "http://localhost:5173")).toBe(
      false,
    );
    expect(shouldAllowNavigation("", "http://localhost:5173")).toBe(false);
  });
});
