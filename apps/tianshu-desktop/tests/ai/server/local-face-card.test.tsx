// @vitest-environment jsdom
// T20（spec §13 项 1）「本机被控面」设置卡：
// - 卡片渲染：status 快照驱动字段回填 + token 打码 + relay 字段
// - 启用开关：点击走 serverFace:setEnabled，载荷携全量表单（enabled +
//   port/host/relayUrl/relayToken；服务端按 key 合并）
// - host 警告：切 0.0.0.0 出现行内警告，回 127.0.0.1 消失
// - 端口校验：非法值 blur 不发 invoke + toast 报错并回落配置值
// - relay 字段 blur 提交；重新生成 token 载荷携 regenerateToken
// mock @/lib/ipc（invoke/on）与 react-i18next（t 回退 key，断言锚
// data-testid 与 key 文本，不锚翻译文案），骨架先例 console-view.test.tsx
import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";

// Radix Select 在 jsdom 的最小桩（先例 console-view.test.tsx）
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
  // 复制令牌按钮（jsdom 无原生 clipboard）
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: () => () => {},
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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

import { toast } from "sonner";
import LocalFaceCard from "../../../src-react/domains/ai/server/components/LocalFaceCard";

const TOKEN = "0123456789abcdef0123456789abcdef";

const FACE_BASE = {
  enabled: false,
  running: false,
  port: 18411,
  host: "127.0.0.1",
  token: "",
  relayUrl: "",
  relayToken: "",
  relayConnected: false,
  instanceId: "face-1",
};

/** setEnabled 侧最新快照（mock 状态推进） */
let face = { ...FACE_BASE };

function stubInvoke(): void {
  invoke.mockImplementation((channel: string) => {
    if (channel === "serverFace:status") return face;
    if (channel === "serverFace:setEnabled") return face;
    throw new Error(`未 mock 的通道：${channel}`);
  });
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocalFaceCard />
    </QueryClientProvider>,
  );
}

/** 等待 status 快照回填完成（端口输入出现配置值=字段可用） */
async function awaitLoaded(port = "18411"): Promise<void> {
  await waitFor(() =>
    expect((screen.getByTestId("face-port") as HTMLInputElement).value).toBe(
      port,
    ),
  );
}

/** Radix Select 选项切换：mouse pointerDown 展开 + click 选中 */
async function selectOption(trigger: HTMLElement, optionName: string) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

beforeEach(() => {
  cleanup();
  invoke.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(navigator.clipboard.writeText).mockClear();
  face = { ...FACE_BASE };
  stubInvoke();
});
describe("LocalFaceCard 渲染与回显", () => {
  it("status 快照回填字段；token 打码不含完整值；relay 字段渲染", async () => {
    face = {
      ...FACE_BASE,
      token: TOKEN,
      relayUrl: "ws://127.0.0.1:18412/ws",
      relayToken: "rt",
    };
    renderCard();
    await awaitLoaded();
    expect((screen.getByTestId("face-port") as HTMLInputElement).value).toBe(
      "18411",
    );
    expect(
      (screen.getByTestId("face-relay-url") as HTMLInputElement).value,
    ).toBe("ws://127.0.0.1:18412/ws");
    expect(
      (screen.getByTestId("face-relay-token") as HTMLInputElement).value,
    ).toBe("rt");
    const tokenText = screen.getByTestId("face-token-value").textContent ?? "";
    expect(tokenText).toContain("0123");
    expect(tokenText).toContain("cdef");
    expect(tokenText).not.toContain(TOKEN);
    // 未启用：状态已停止、host 回环无警告
    expect(screen.getByTestId("face-state").textContent).toContain(
      "ai:server.face.state.stopped",
    );
    expect(screen.queryByTestId("face-host-warning")).toBeNull();
  });

  it("running 态：状态回显运行中+端口；relay 配置时显示中继状态", async () => {
    face = {
      ...FACE_BASE,
      enabled: true,
      running: true,
      token: TOKEN,
      relayUrl: "ws://127.0.0.1:18412/ws",
      relayToken: "rt",
      relayConnected: true,
    };
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("face-state").textContent).toContain("18411"),
    );
    expect(screen.getByTestId("face-state").textContent).toContain(
      "ai:server.face.state.running",
    );
    expect(screen.getByTestId("face-relay-state").textContent).toContain(
      "ai:server.face.relayConnected",
    );
  });
});

describe("LocalFaceCard 启停与配置提交", () => {
  it("启用开关：点击走 serverFace:setEnabled，载荷携 enabled+全量表单", async () => {
    face = { ...FACE_BASE, token: TOKEN, relayToken: "rt" };
    renderCard();
    await awaitLoaded();
    fireEvent.click(screen.getByTestId("face-switch"));
    await waitFor(() => {
      const call = invoke.mock.calls.find(
        (c) => c[0] === "serverFace:setEnabled",
      );
      expect(call).toBeTruthy();
      const [, payload] = call as [string, Record<string, unknown>];
      expect(payload).toEqual({
        enabled: true,
        port: 18411,
        host: "127.0.0.1",
        relayUrl: "",
        relayToken: "rt",
      });
    });
  });

  it("端口非法（0）：blur 不发 invoke + toast 报错", async () => {
    renderCard();
    await awaitLoaded();
    fireEvent.change(screen.getByTestId("face-port"), {
      target: { value: "0" },
    });
    fireEvent.blur(screen.getByTestId("face-port"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("ai:server.face.portInvalid"),
    );
    expect(
      invoke.mock.calls.some((c) => c[0] === "serverFace:setEnabled"),
    ).toBe(false);
  });

  it("端口合法变更：blur 提交携新端口", async () => {
    renderCard();
    await awaitLoaded();
    fireEvent.change(screen.getByTestId("face-port"), {
      target: { value: "20000" },
    });
    fireEvent.blur(screen.getByTestId("face-port"));
    await waitFor(() => {
      const call = invoke.mock.calls.find(
        (c) => c[0] === "serverFace:setEnabled",
      );
      expect(call).toBeTruthy();
      expect((call as [string, Record<string, unknown>])[1].port).toBe(20000);
    });
  });

  it("host 切 0.0.0.0：行内警告出现并随提交携带；切回回环消失", async () => {
    renderCard();
    await awaitLoaded();
    await selectOption(
      screen.getByTestId("face-host"),
      "ai:server.face.hostAll",
    );
    await waitFor(() =>
      expect(screen.getByTestId("face-host-warning").textContent).toContain(
        "ai:server.face.hostWarning",
      ),
    );
    await waitFor(() => {
      const call = invoke.mock.calls.find(
        (c) => c[0] === "serverFace:setEnabled",
      );
      expect(call).toBeTruthy();
      expect((call as [string, Record<string, unknown>])[1].host).toBe(
        "0.0.0.0",
      );
    });
    await selectOption(
      screen.getByTestId("face-host"),
      "ai:server.face.hostLoopback",
    );
    await waitFor(() =>
      expect(screen.queryByTestId("face-host-warning")).toBeNull(),
    );
  });

  it("relay 地址非法：blur 拒提交；合法变更提交携 relayUrl", async () => {
    renderCard();
    await awaitLoaded();
    fireEvent.change(screen.getByTestId("face-relay-url"), {
      target: { value: "http://not-ws" },
    });
    fireEvent.blur(screen.getByTestId("face-relay-url"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "ai:server.connection.errors.relayUrlInvalid",
      ),
    );
    expect(
      invoke.mock.calls.some((c) => c[0] === "serverFace:setEnabled"),
    ).toBe(false);
    fireEvent.change(screen.getByTestId("face-relay-url"), {
      target: { value: "ws://127.0.0.1:18412/ws" },
    });
    fireEvent.blur(screen.getByTestId("face-relay-url"));
    await waitFor(() => {
      const call = invoke.mock.calls.find(
        (c) => c[0] === "serverFace:setEnabled",
      );
      expect(call).toBeTruthy();
      expect((call as [string, Record<string, unknown>])[1].relayUrl).toBe(
        "ws://127.0.0.1:18412/ws",
      );
    });
  });

  it("重新生成令牌：载荷携 regenerateToken: true", async () => {
    face = { ...FACE_BASE, token: TOKEN };
    renderCard();
    await awaitLoaded();
    fireEvent.click(screen.getByTestId("face-token-regenerate"));
    await waitFor(() => {
      const call = invoke.mock.calls.find(
        (c) => c[0] === "serverFace:setEnabled",
      );
      expect(call).toBeTruthy();
      const [, payload] = call as [string, Record<string, unknown>];
      expect(payload.regenerateToken).toBe(true);
      expect(payload.enabled).toBe(false);
    });
  });

  it("复制令牌：写剪贴板携完整 token", async () => {
    face = { ...FACE_BASE, token: TOKEN };
    renderCard();
    await awaitLoaded();
    fireEvent.click(screen.getByTestId("face-token-copy"));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(TOKEN),
    );
    expect(toast.success).toHaveBeenCalledWith("ai:server.face.tokenCopied");
  });
});
