// @vitest-environment jsdom
/**
 * TerminalTab 重挂回放（切会话空白修复回归）：重挂按负载续连经
 * terminal:replay 回放——ack 前实时数据丢弃（防重复）、ack 后直写；
 * replay reject / exit 事件 → 退出态；dispose 守卫迟到 resolve 不写；
 * 首建路径统一走 replay（顺带覆盖 create-banner 竞态）。
 * xterm/fit mock 收集实例断言 write 序列；@/lib/ipc 事件总线 mock，
 * replay 返回手动 deferred 精确控 ack 时机；TerminalApi 不单独 mock
 * （真实薄封装 + mocked invoke，顺带覆盖接线）。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

/** xterm 实例收集（write/open/dispose/onData 断言口） */
const terms = vi.hoisted(
  () =>
    [] as Array<{
      write: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }>,
);
// class 形式（vi.fn().mockImplementation 传箭头函数不可 new）
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn(() => () => {});
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    constructor() {
      terms.push(this as unknown as (typeof terms)[number]);
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    dispose = vi.fn();
  },
}));

/** IPC 事件总线 + replay deferred 队列（精确控 ack 时机） */
const ipcBus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    listeners,
    replayDeferreds: [] as Array<{
      resolve: (text: string) => void;
      reject: (error: unknown) => void;
    }>,
    emit: (channel: string, ...args: unknown[]) => {
      for (const fn of listeners.get(channel) ?? []) fn({}, ...args);
    },
  };
});
vi.mock("@/lib/ipc", () => ({
  on: (channel: string, fn: (...args: unknown[]) => void) => {
    if (!ipcBus.listeners.has(channel)) {
      ipcBus.listeners.set(channel, new Set());
    }
    ipcBus.listeners.get(channel)!.add(fn);
    return () => {
      ipcBus.listeners.get(channel)?.delete(fn);
    };
  },
  invoke: (channel: string) => {
    if (channel === "terminal:create") return Promise.resolve("tid-new");
    if (channel === "terminal:probe") return Promise.resolve(true);
    if (channel === "terminal:replay") {
      return new Promise<string>((resolve, reject) => {
        ipcBus.replayDeferreds.push({ resolve, reject });
      });
    }
    return Promise.resolve(undefined);
  },
  send: vi.fn(),
}));

import TerminalTab from "../../src-react/domains/ai/chat/components/detail-panel/TerminalTab";
import {
  useDetailPanelStore,
  type DetailTab,
} from "../../src-react/domains/ai/chat/store/detail-panel.store";

const S1 = 401;

function seedTerminalTab(terminalId?: string): DetailTab {
  const { openTab, syncTab } = useDetailPanelStore.getState();
  const id = openTab(S1, "terminal", "终端");
  if (terminalId) syncTab(S1, id, { terminalId });
  return useDetailPanelStore.getStateOf(S1).tabs.find((t) => t.id === id)!;
}

/** 当前挂起的 replay deferred（每次挂载各 enqueue 一个） */
const pendingReplay = () => ipcBus.replayDeferreds.at(-1)!;

beforeEach(() => {
  useDetailPanelStore.setState({ panels: {} });
  ipcBus.listeners.clear();
  ipcBus.replayDeferreds.length = 0;
  terms.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("TerminalTab 重挂回放", () => {
  it("重挂续连：ack 前实时数据丢弃，快照写入后实时流直写（无重复）", async () => {
    const tab = seedTerminalTab("tid-live");
    render(<TerminalTab sessionId={S1} tab={tab} isActive={true} cwd="/tmp" />);
    expect(terms).toHaveLength(1);
    // replay 未决：此窗口到达的实时数据已含于快照（IPC FIFO）→ 丢弃
    act(() => ipcBus.emit("terminal:data:tid-live", "stale-in-snapshot"));
    expect(terms[0].write).not.toHaveBeenCalled();
    await act(async () => {
      pendingReplay().resolve("回放快照$ ");
    });
    expect(terms[0].write).toHaveBeenCalledTimes(1);
    expect(terms[0].write).toHaveBeenCalledWith("回放快照$ ");
    // ack 后实时流直写
    act(() => ipcBus.emit("terminal:data:tid-live", "新输出"));
    expect(terms[0].write).toHaveBeenLastCalledWith("新输出");
    expect(terms[0].write).toHaveBeenCalledTimes(2);
  });

  it("replay reject（pty 已销毁）→ 退出态 UI，不写 xterm", async () => {
    const tab = seedTerminalTab("tid-gone");
    render(<TerminalTab sessionId={S1} tab={tab} isActive={true} cwd="/tmp" />);
    await act(async () => {
      pendingReplay().reject(new Error("terminal not found"));
    });
    expect(screen.getByText("chat:detailPanel.terminalExited")).toBeTruthy();
    expect(terms[0].write).not.toHaveBeenCalled();
  });

  it("replay 未决时 exit 事件 → 退出态；迟到 resolve 不写（disposed 守卫）", async () => {
    const tab = seedTerminalTab("tid-exit");
    render(<TerminalTab sessionId={S1} tab={tab} isActive={true} cwd="/tmp" />);
    act(() => ipcBus.emit("terminal:exit:tid-exit", "0"));
    expect(screen.getByText("chat:detailPanel.terminalExited")).toBeTruthy();
    expect(terms[0].dispose).toHaveBeenCalledTimes(1);
    // 迟到的 replay 应答不写已 dispose 实例、不炸（unhandled rejection）
    await act(async () => {
      pendingReplay().resolve("late-snapshot");
    });
    expect(terms[0].write).not.toHaveBeenCalled();
  });

  it("首建路径：create 回写负载后统一走 replay 回放", async () => {
    const tab = seedTerminalTab();
    render(<TerminalTab sessionId={S1} tab={tab} isActive={true} cwd="/tmp" />);
    // create → setTerminalId → xterm effect → replay 入队（两层异步）
    await vi.waitFor(() =>
      expect(ipcBus.replayDeferreds.length).toBeGreaterThan(0),
    );
    await act(async () => {
      pendingReplay().resolve("banner$ ");
    });
    expect(
      useDetailPanelStore.getStateOf(S1).tabs.find((t) => t.id === tab.id)
        ?.terminalId,
    ).toBe("tid-new");
    expect(terms[0].write).toHaveBeenCalledWith("banner$ ");
  });

  it("卸载：dispose + 解绑监听；迟到 resolve 不写", async () => {
    const tab = seedTerminalTab("tid-unmount");
    const { unmount } = render(
      <TerminalTab sessionId={S1} tab={tab} isActive={true} cwd="/tmp" />,
    );
    unmount();
    expect(terms[0].dispose).toHaveBeenCalledTimes(1);
    act(() => ipcBus.emit("terminal:data:tid-unmount", "after-unmount"));
    await act(async () => {
      pendingReplay().resolve("late");
    });
    expect(terms[0].write).not.toHaveBeenCalled();
  });
});
