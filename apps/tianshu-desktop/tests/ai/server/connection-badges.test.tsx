// @vitest-environment jsdom
// 连接行警示徽标（批3B，design §5 项7/9）：直连 http 非局域网 → 明文
// 直连警示徽标（复用 relay E2E plaintext 徽标视觉语言）；被控端协议版本
// 低于控制端基线 → 「建议升级」徽标；局域网 http / 版本达标 / 老被控端
// 未上报（undefined）均不出徽标。
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PROTOCOL_VERSION } from "@tianshu/protocol";

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
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  on: () => () => {},
}));

const serverApi = vi.hoisted(() => ({ listConnections: vi.fn() }));
vi.mock("../../../src-react/domains/ai/server/api/server.api", () => ({
  default: serverApi,
  requestRemote: vi.fn(),
  LOCAL_CONNECTION_ID: "local",
  newConnectionId: vi.fn(() => "conn-x"),
  on: () => () => {},
  onRemoteChunk: () => () => {},
  onRemoteEvent: () => () => {},
}));

import ConnectionList from "../../../src-react/domains/ai/server/components/ConnectionList";

const conn = (over: Record<string, unknown>) => ({
  id: "c0",
  name: "n",
  mode: "direct",
  state: "connected",
  capabilities: ["chat"],
  baseUrl: "http://192.168.1.5:8410",
  ...over,
});

function renderList(connections: Array<Record<string, unknown>>) {
  serverApi.listConnections.mockResolvedValue({
    activeConnId: null,
    connections,
  });
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ConnectionList selectedConnId={null} onSelect={() => {}} variant="page" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("直连明文警示徽标", () => {
  it("http 公网地址：出徽标；局域网/https/relay 不出", async () => {
    renderList([
      conn({ id: "pub", baseUrl: "http://8.8.8.8:3000" }),
      conn({ id: "lan", baseUrl: "http://192.168.1.5:8410" }),
      conn({ id: "tls", baseUrl: "https://example.com:8410" }),
      conn({ id: "rly", mode: "relay", relayUrl: "ws://127.0.0.1:1/ws" }),
    ]);

    expect(
      await screen.findByTestId("connection-plain-http-pub"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("connection-plain-http-lan"),
    ).toBeNull();
    expect(
      screen.queryByTestId("connection-plain-http-tls"),
    ).toBeNull();
    expect(
      screen.queryByTestId("connection-plain-http-rly"),
    ).toBeNull();
  });
});

describe("协议版本「建议升级」徽标", () => {
  it("低于基线出徽标；达标/高于/未上报（老被控端）不出", async () => {
    renderList([
      conn({ id: "old", protocolVersion: PROTOCOL_VERSION - 1 }),
      conn({ id: "fit", protocolVersion: PROTOCOL_VERSION }),
      conn({ id: "new", protocolVersion: PROTOCOL_VERSION + 1 }),
      conn({ id: "legacy" }),
    ]);

    expect(
      await screen.findByTestId("connection-protocol-outdated-old"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("connection-protocol-outdated-fit"),
    ).toBeNull();
    expect(
      screen.queryByTestId("connection-protocol-outdated-new"),
    ).toBeNull();
    expect(
      screen.queryByTestId("connection-protocol-outdated-legacy"),
    ).toBeNull();
  });
});
