// @vitest-environment jsdom
// TOFU 指纹核对卡（P0-1，design/security §6 P0-1 + multi-host §5 项5）：
// - direct 连接不渲染；relay 常显当前指纹（协商值优先，钉扎值次之）
// - pending-confirm：mitm-suspect 同款 destructive 警示 + 连接名 + 16hex
//   指纹 + 「核对后确认」动作（server:connectionConfirmFingerprint 通道 +
//   连接清单失效重取）
// - encrypted + confirmedAt：静默卡显示指纹与确认时间，无确认按钮
// - mitm-suspect：期望 vs 实际指纹对照（重配指引），无确认按钮
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.releasePointerCapture = () => {};
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    // 插值 mock：携带 options 时把值拼在 key 后（断言锚真实值——连接名/
    // 确认时间等插值内容可见）
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        options
          ? `${key}::${Object.values(options).map(String).join("|")}`
          : key,
    }),
  };
});

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: () => () => {},
}));

import E2eFingerprintCard from "../../../src-react/domains/ai/server/components/E2eFingerprintCard";
import type { ConnectionView } from "../../../src-react/domains/ai/server/api/server.api";

function conn(over: Record<string, unknown>): ConnectionView {
  return {
    id: "c1",
    name: "机房中继",
    mode: "relay",
    relayUrl: "ws://127.0.0.1:18412/ws",
    relayToken: "rt",
    connectionId: "inst-1",
    state: "connected",
    capabilities: ["chat"],
    ...over,
  } as ConnectionView;
}

function renderCard(connection: ConnectionView) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <E2eFingerprintCard connection={connection} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({
    activeConnId: null,
    connections: [],
  });
});
afterEach(cleanup);

describe("E2eFingerprintCard：TOFU 指纹核对卡", () => {
  it("direct 连接不渲染（信任模型内无指纹面）", () => {
    const { container } = renderCard(
      conn({ mode: "direct", baseUrl: "http://127.0.0.1:3000" }),
    );
    expect(container.innerHTML).toBe("");
  });

  it("pending-confirm：警示卡显示连接名 + 协商指纹 + 确认动作走确认通道", async () => {
    renderCard(
      conn({
        e2e: "pending-confirm",
        e2eFingerprint: "0123456789abcdef",
      }),
    );
    // mitm-suspect 同款警示语义（destructive）
    expect(screen.getByTestId("fingerprint-card-pending")).toBeTruthy();
    // 连接名经插值呈现（核对仪式锚定到具体连接）
    expect(
      screen.getByText(/ai:server\.fingerprint\.pendingName/).textContent,
    ).toContain("机房中继");
    expect(screen.getByTestId("fingerprint-current").textContent).toBe(
      "0123456789abcdef",
    );
    fireEvent.click(screen.getByTestId("fingerprint-confirm"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "server:connectionConfirmFingerprint",
        "c1",
      ),
    );
  });

  it("encrypted + confirmedAt：常显指纹与确认时间，无确认按钮", () => {
    renderCard(
      conn({
        e2e: "encrypted",
        e2eFingerprint: "0123456789abcdef",
        fingerprint: "0123456789abcdef",
        confirmedAt: "2026-11-05T08:00:00.000Z",
      }),
    );
    expect(screen.queryByTestId("fingerprint-card-pending")).toBeNull();
    expect(screen.getByTestId("fingerprint-current").textContent).toBe(
      "0123456789abcdef",
    );
    // 确认时间文案在场（i18n key 锚 + 插值时间）
    expect(screen.getByTestId("fingerprint-confirmed-at").textContent).toContain(
      "2026",
    );
    expect(screen.queryByTestId("fingerprint-confirm")).toBeNull();
  });

  it("mitm-suspect：期望 vs 实际指纹对照，无确认按钮（重配而非确认）", () => {
    renderCard(
      conn({
        e2e: "mitm-suspect",
        e2eFingerprint: "fedcba9876543210",
        fingerprint: "0123456789abcdef",
      }),
    );
    expect(screen.getByTestId("fingerprint-expected").textContent).toBe(
      "0123456789abcdef",
    );
    expect(screen.getByTestId("fingerprint-actual").textContent).toBe(
      "fedcba9876543210",
    );
    expect(screen.queryByTestId("fingerprint-confirm")).toBeNull();
  });

  it("未协商（idle/未连接）：显示钉扎指纹或缺省占位，不出确认按钮", () => {
    renderCard(conn({ fingerprint: "0123456789abcdef" }));
    expect(screen.getByTestId("fingerprint-current").textContent).toBe(
      "0123456789abcdef",
    );
    expect(screen.queryByTestId("fingerprint-confirm")).toBeNull();
  });
});
