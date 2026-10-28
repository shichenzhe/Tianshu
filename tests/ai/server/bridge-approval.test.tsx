// @vitest-environment jsdom
// TB-T2 桥审批卡（spec §4.2）：server:bridgeApproval 事件 → 审批卡（工具名/
// 参数摘要/允许/拒绝）→ server:bridgeDecision INVOKE → 卡收起（执行在主进程
// bridge-executor 收敛）；resolved=false（超时先收敛/他端竞速）→ stale 态锁
// 按键；其余错误 toast 不锁可重试。mock @/lib/ipc（on 捕获监听器/invoke）。
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
const listeners = new Map<
  string,
  (event: unknown, ...args: unknown[]) => void
>();

vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ) => {
    listeners.set(channel, listener);
    return () => listeners.delete(channel);
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// @/lib/utils 经 i18n/index 链入 initReactI18next——保留 actual 只覆写
// useTranslation（remote-approval-banner.test.tsx 同款）
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN" },
    }),
  };
});

import BridgeApprovalCard from "../../../src-react/domains/ai/server/components/BridgeApprovalCard";

const CLICK_PAYLOAD = {
  requestId: "req-1",
  sessionId: 9,
  tool: "browser_click",
  args: { idx: 3 },
};

function pushEvent(payload: unknown): void {
  const listener = listeners.get("server:bridgeApproval");
  if (!listener) throw new Error("server:bridgeApproval 未订阅");
  act(() => listener(undefined, payload));
}

beforeEach(() => {
  cleanup();
  listeners.clear();
  invoke.mockReset();
});

describe("BridgeApprovalCard（事件 → 卡 → decision 链）", () => {
  it("挂载即订阅；事件到达渲染工具名与参数摘要", () => {
    render(<BridgeApprovalCard />);
    expect(listeners.has("server:bridgeApproval")).toBe(true);
    expect(screen.queryByTestId("bridge-approval-card")).toBeNull();
    pushEvent(CLICK_PAYLOAD);
    expect(screen.getByTestId("bridge-approval-card")).toBeTruthy();
    expect(screen.getByText("browser_click")).toBeTruthy();
    // 参数摘要：args JSON 文本化（idx 序号）
    expect(screen.getByText('{"idx":3}')).toBeTruthy();
  });

  it("允许 → invoke server:bridgeDecision {approved:true}，resolved 后卡收起", async () => {
    invoke.mockResolvedValue(true);
    render(<BridgeApprovalCard />);
    pushEvent(CLICK_PAYLOAD);
    fireEvent.click(screen.getByTestId("bridge-approve"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("server:bridgeDecision", {
        requestId: "req-1",
        approved: true,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("bridge-approval-card")).toBeNull(),
    );
  });

  it("拒绝 → approved:false；主进程收敛为 denied by user（不执行）", async () => {
    invoke.mockResolvedValue(true);
    render(<BridgeApprovalCard />);
    pushEvent({
      ...CLICK_PAYLOAD,
      requestId: "req-2",
      tool: "browser_type",
      args: { idx: 1, text: "hi" },
    });
    fireEvent.click(screen.getByTestId("bridge-reject"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("server:bridgeDecision", {
        requestId: "req-2",
        approved: false,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("bridge-approval-card")).toBeNull(),
    );
  });

  it("resolved=false（超时先收敛/他端竞速）→ stale 态：锁按键，可手动收起", async () => {
    invoke.mockResolvedValue(false);
    render(<BridgeApprovalCard />);
    pushEvent(CLICK_PAYLOAD);
    fireEvent.click(screen.getByTestId("bridge-approve"));
    expect(await screen.findByTestId("bridge-approval-stale")).toBeTruthy();
    // stale 态收起两键（重试无意义——requestId 已被消费）
    expect(screen.queryByTestId("bridge-approve")).toBeNull();
    expect(screen.queryByTestId("bridge-reject")).toBeNull();
    fireEvent.click(screen.getByTestId("bridge-approval-dismiss"));
    expect(screen.queryByTestId("bridge-approval-card")).toBeNull();
  });

  it("invoke 抛错 → toast 报错不锁，可重试", async () => {
    invoke
      .mockRejectedValueOnce(new Error("通道异常"))
      .mockResolvedValueOnce(true);
    render(<BridgeApprovalCard />);
    pushEvent(CLICK_PAYLOAD);
    fireEvent.click(screen.getByTestId("bridge-approve"));
    const { toast } = await import("sonner");
    await waitFor(() =>
      expect(
        vi
          .mocked(toast.error)
          .mock.calls.some((c) =>
            String(c[0]).includes("ai:server.bridge.failed"),
          ),
      ).toBe(true),
    );
    // 按键未锁：重试成功 → 卡收起
    expect(screen.getByTestId("bridge-approve")).toBeTruthy();
    fireEvent.click(screen.getByTestId("bridge-approve"));
    await waitFor(() =>
      expect(screen.queryByTestId("bridge-approval-card")).toBeNull(),
    );
  });

  it("畸形载荷忽略（requestId/tool 非字符串不渲染卡）", () => {
    render(<BridgeApprovalCard />);
    pushEvent({ requestId: 42, tool: "browser_click", args: {} });
    pushEvent(undefined);
    expect(screen.queryByTestId("bridge-approval-card")).toBeNull();
  });

  it("图执行发起（sessionId:null）的审批照常渲染（去会话化回归钉）", () => {
    render(<BridgeApprovalCard />);
    pushEvent({ ...CLICK_PAYLOAD, requestId: "req-graph", sessionId: null });
    expect(screen.getByTestId("bridge-approval-card")).toBeTruthy();
    expect(screen.getByText("browser_click")).toBeTruthy();
  });

  it("sessionId 缺键/undefined 仍拒（形状复核强度不随可空放宽）", () => {
    render(<BridgeApprovalCard />);
    const { sessionId: _drop, ...noSessionId } = CLICK_PAYLOAD;
    pushEvent(noSessionId);
    pushEvent({
      ...CLICK_PAYLOAD,
      requestId: "req-undef",
      sessionId: undefined,
    });
    expect(screen.queryByTestId("bridge-approval-card")).toBeNull();
  });

  it("卸载退订（重复挂载不重复应答）", () => {
    const { unmount } = render(<BridgeApprovalCard />);
    unmount();
    expect(listeners.has("server:bridgeApproval")).toBe(false);
  });
});
