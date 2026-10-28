import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS } from "@tianshu/protocol";

const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
  activeConnId: "c1",
  transport: null as null | { request: ReturnType<typeof vi.fn> },
  useConnectionsStore: {
    getState: () => ({ activeConnId: connMock.activeConnId }),
    subscribe: () => () => {},
  },
}));

vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
  useConnectionsStore: connMock.useConnectionsStore,
}));

import { useProvidersStore } from "./providers.store";

function makeTransport() {
  return { request: vi.fn() };
}

const BUNDLE = {
  providers: [
    {
      id: 1,
      name: "ACME",
      type: "openai-compatible",
      baseUrl: "https://api.acme.test",
      apiKey: "REDACTED_SECRET",
      extraHeaders: null,
      enabled: true,
    },
  ],
  models: [
    {
      id: 7,
      providerId: 1,
      modelId: "gpt-x",
      name: "GPT-X",
      type: "llm",
      enabled: true,
      temperature: null,
      topP: null,
      maxTokens: null,
      contextWindow: null,
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function successWithProvider(name: string) {
  return {
    status: 200,
    body: {
      code: "2000",
      success: true,
      data: {
        ...BUNDLE,
        providers: [{ ...BUNDLE.providers[0], name }],
      },
      message: "success",
    },
  };
}

describe("providers.store", () => {
  beforeEach(() => {
    connMock.activeTransport.mockReset();
    connMock.activeConnId = "c1";
    connMock.transport = null;
    connMock.activeTransport.mockImplementation(() => connMock.transport);
    useProvidersStore.getState().resetForTest();
  });

  it("load 解包 bundle 并清 error", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue({
      status: 200,
      body: {
        code: "2000",
        success: true,
        data: BUNDLE,
        message: "success",
      },
    });
    connMock.activeTransport.mockReturnValue(t);
    await useProvidersStore.getState().load();
    const s = useProvidersStore.getState();
    expect(s.bundle?.providers).toHaveLength(1);
    expect(s.bundle?.models[0].modelId).toBe("gpt-x");
    expect(s.error).toBeNull();
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.provider.query,
      null,
    );
  });

  it("saveProvider 构造单元素 providers 数组调 save 并本地合并回包行", async () => {
    const t = makeTransport();
    const saved = { ...BUNDLE.providers[0], name: "ACME 2" };
    t.request.mockResolvedValue({
      status: 200,
      body: {
        code: "2000",
        success: true,
        data: { ...BUNDLE, providers: [saved] },
        message: "success",
      },
    });
    connMock.activeTransport.mockReturnValue(t);
    await useProvidersStore.getState().load();
    await useProvidersStore.getState().saveProvider({
      id: 1,
      name: "ACME 2",
      type: "openai-compatible",
      baseUrl: "https://api.acme.test",
    });
    const req = t.request.mock.calls[1];
    expect(req[1]).toBe(ENDPOINTS.provider.save);
    expect(req[2]).toEqual({
      providers: [
        {
          id: 1,
          name: "ACME 2",
          type: "openai-compatible",
          baseUrl: "https://api.acme.test",
        },
      ],
    });
    expect(useProvidersStore.getState().bundle?.providers[0].name).toBe(
      "ACME 2",
    );
  });

  it("wire 业务错 → error 置位且 bundle 不丢", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce({
        status: 200,
        body: {
          code: "2000",
          success: true,
          data: BUNDLE,
          message: "success",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          code: "5000",
          success: false,
          data: null,
          message: "保存失败",
        },
      });
    connMock.activeTransport.mockReturnValue(t);
    await useProvidersStore.getState().load();
    expect(useProvidersStore.getState().bundle).toEqual(BUNDLE);
    await useProvidersStore.getState().saveProvider({
      name: "X",
      type: "openai-compatible",
      baseUrl: "u",
    });
    expect(useProvidersStore.getState().error).toBe("保存失败");
    expect(useProvidersStore.getState().bundle).toEqual(BUNDLE);
  });

  it("removeModels 走 provider/delete 带 modelIds", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue({
      status: 200,
      body: {
        code: "2000",
        success: true,
        data: BUNDLE,
        message: "success",
      },
    });
    connMock.activeTransport.mockReturnValue(t);
    await useProvidersStore.getState().removeModels([7]);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.provider.delete, {
      modelIds: [7],
    });
  });

  it("切连接后丢弃旧主机迟到的 load 响应", async () => {
    const transportA = makeTransport();
    const transportB = makeTransport();
    const responseA = deferred<unknown>();
    const responseB = deferred<unknown>();
    transportA.request.mockReturnValue(responseA.promise);
    transportB.request.mockReturnValue(responseB.promise);

    connMock.transport = transportA;
    const loadA = useProvidersStore.getState().load();
    connMock.activeConnId = "c2";
    connMock.transport = transportB;
    const loadB = useProvidersStore.getState().load();

    responseB.resolve(successWithProvider("HOST-B"));
    await loadB;
    responseA.resolve(successWithProvider("HOST-A"));
    await loadA;

    expect(useProvidersStore.getState().bundle?.providers[0].name).toBe(
      "HOST-B",
    );
  });

  it("写操作串行且旧写完成不提前清除 saving", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const item = {
      name: "first",
      type: "openai-compatible",
      baseUrl: "https://api.acme.test",
    };

    const first = useProvidersStore.getState().saveProvider(item);
    const second = useProvidersStore
      .getState()
      .saveProvider({ ...item, name: "second" });
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(useProvidersStore.getState().saving).toBe(true);

    firstResponse.resolve(successWithProvider("first"));
    await first;
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(useProvidersStore.getState().saving).toBe(true);
    expect(useProvidersStore.getState().bundle).toBeNull();

    secondResponse.resolve(successWithProvider("second"));
    await second;
    expect(useProvidersStore.getState().saving).toBe(false);
    expect(useProvidersStore.getState().bundle?.providers[0].name).toBe(
      "second",
    );
  });
});
