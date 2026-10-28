// 服务商/模型远端数据 store（A1 批）：bundle 读写 + 删除 + 测试/远端拉取
// 直通。请求全走 wireRequest（无连接/业务错统一 error 态）；保存成功按
// 返回 bundle 整包替换（不重拉全量——服务端响应即脱敏后权威态）。
import { create } from "zustand";
import {
  ENDPOINTS,
  type ProviderSaveItem,
  type ModelSaveItem,
} from "@tianshu/protocol";
import { wireRequest } from "../transport/wire";
import { activeTransport, useConnectionsStore } from "./connections.store";

export interface ProviderRow {
  id: number;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string | null;
  extraHeaders: string | null;
  enabled: boolean;
}
export interface ModelRow {
  id: number;
  providerId: number;
  modelId: string;
  name: string | null;
  type: string;
  enabled: boolean;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  contextWindow: number | null;
}
export interface ProviderBundle {
  providers: ProviderRow[];
  models: ModelRow[];
}

interface ProvidersState {
  bundle: ProviderBundle | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load(): Promise<void>;
  saveProvider(item: ProviderSaveItem): Promise<boolean>;
  saveModel(item: ModelSaveItem): Promise<boolean>;
  removeProviders(ids: number[]): Promise<boolean>;
  removeModels(ids: number[]): Promise<boolean>;
  testProvider(
    providerId: number,
  ): Promise<{ ok: boolean; message: string } | null>;
  fetchRemote(providerId: number): Promise<{
    success: boolean;
    message: string;
    models: Array<{ modelId: string; name?: string }>;
  } | null>;
  resetForTest(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function parseProvider(value: unknown): ProviderRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "number" ||
    typeof row.name !== "string" ||
    typeof row.type !== "string" ||
    typeof row.baseUrl !== "string" ||
    typeof row.enabled !== "boolean"
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.baseUrl,
    apiKey: nullableString(row.apiKey),
    extraHeaders: nullableString(row.extraHeaders),
    enabled: row.enabled,
  };
}

function parseModel(value: unknown): ModelRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "number" ||
    typeof row.providerId !== "number" ||
    typeof row.modelId !== "string" ||
    typeof row.type !== "string" ||
    typeof row.enabled !== "boolean"
  ) {
    return null;
  }
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    name: nullableString(row.name),
    type: row.type,
    enabled: row.enabled,
    temperature: nullableNumber(row.temperature),
    topP: nullableNumber(row.topP),
    maxTokens: nullableNumber(row.maxTokens),
    contextWindow: nullableNumber(row.contextWindow),
  };
}

function parseBundle(data: unknown): ProviderBundle | null {
  if (typeof data !== "object" || data === null) return null;
  const bundle = data as { providers?: unknown; models?: unknown };
  if (!Array.isArray(bundle.providers) || !Array.isArray(bundle.models)) {
    return null;
  }
  return {
    providers: bundle.providers
      .map(parseProvider)
      .filter((row): row is ProviderRow => row !== null),
    models: bundle.models
      .map(parseModel)
      .filter((row): row is ModelRow => row !== null),
  };
}

function parseTestResult(
  data: unknown,
): { ok: boolean; message: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const result = data as { ok?: unknown; message?: unknown };
  if (typeof result.ok !== "boolean" || typeof result.message !== "string") {
    return null;
  }
  return { ok: result.ok, message: result.message };
}

function parseRemoteResult(data: unknown): {
  success: boolean;
  message: string;
  models: Array<{ modelId: string; name?: string }>;
} | null {
  if (typeof data !== "object" || data === null) return null;
  const result = data as {
    success?: unknown;
    message?: unknown;
    models?: unknown;
  };
  if (
    typeof result.success !== "boolean" ||
    typeof result.message !== "string" ||
    !Array.isArray(result.models)
  ) {
    return null;
  }
  const models = result.models.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const model = value as { modelId?: unknown; name?: unknown };
    if (typeof model.modelId !== "string") return [];
    return [
      {
        modelId: model.modelId,
        ...(typeof model.name === "string" ? { name: model.name } : {}),
      },
    ];
  });
  return { success: result.success, message: result.message, models };
}

let reqSeq = 0;
let writeChain: Promise<unknown> = Promise.resolve();
let pendingWrites = 0;

interface RequestToken {
  seq: number;
  connId: string | null;
  transport: ReturnType<typeof activeTransport>;
}

function beginRequest(): RequestToken {
  return {
    seq: ++reqSeq,
    connId: useConnectionsStore.getState().activeConnId,
    transport: activeTransport(),
  };
}

function isCurrentRequest(token: RequestToken): boolean {
  return (
    token.seq === reqSeq &&
    token.connId === useConnectionsStore.getState().activeConnId &&
    token.transport === activeTransport()
  );
}

export const useProvidersStore = create<ProvidersState>((set) => {
  async function enqueueWrite(path: string, body: unknown): Promise<boolean> {
    const token = beginRequest();
    pendingWrites += 1;
    set({ saving: true, loading: false, error: null });
    const doWrite = async (): Promise<boolean> => {
      try {
        const result = await wireRequest("POST", path, body, token.transport);
        if (!isCurrentRequest(token)) return false;
        if (!result.ok) {
          set({ error: result.message });
          return false;
        }
        const bundle = parseBundle(result.data);
        if (!bundle) {
          set({ error: "Invalid provider bundle response" });
          return false;
        }
        set({ bundle, error: null });
        return true;
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
        return false;
      } finally {
        pendingWrites -= 1;
        // 只由最后一项在途写清除；旧写迟到不得提前解锁后续写。
        if (pendingWrites === 0) set({ saving: false });
      }
    };
    const queued = writeChain.then(doWrite);
    writeChain = queued;
    return queued;
  }

  return {
    bundle: null,
    loading: false,
    saving: false,
    error: null,

    load: async () => {
      const token = beginRequest();
      set({ loading: true, error: null });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.provider.query,
          null,
          token.transport,
        );
        if (!isCurrentRequest(token)) return;
        if (!result.ok) {
          set({ error: result.message });
          return;
        }
        const bundle = parseBundle(result.data);
        if (!bundle) {
          set({ error: "Invalid provider bundle response" });
          return;
        }
        set({ bundle, error: null });
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
      } finally {
        if (isCurrentRequest(token)) set({ loading: false });
      }
    },

    // 密钥三态原样透传：undefined 保留、null 清除、字符串更新；
    // 脱敏掩码由服务端按未传处理，避免回写覆盖真实密钥。
    saveProvider: (item) =>
      enqueueWrite(ENDPOINTS.provider.save, { providers: [item] }),

    saveModel: (item) =>
      enqueueWrite(ENDPOINTS.provider.save, { models: [item] }),

    removeProviders: (ids) =>
      enqueueWrite(ENDPOINTS.provider.delete, { providerIds: ids }),

    removeModels: (ids) =>
      enqueueWrite(ENDPOINTS.provider.delete, { modelIds: ids }),

    testProvider: async (providerId) => {
      const token = beginRequest();
      set({ loading: false, error: null });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.provider.test,
          { providerId },
          token.transport,
        );
        if (!isCurrentRequest(token)) return null;
        if (!result.ok) {
          set({ error: result.message });
          return null;
        }
        const parsed = parseTestResult(result.data);
        if (!parsed) {
          set({ error: "Invalid provider test response" });
          return null;
        }
        set({ error: null });
        return parsed;
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
        return null;
      }
    },

    fetchRemote: async (providerId) => {
      const token = beginRequest();
      set({ loading: false, error: null });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.provider.fetchModels,
          { providerId },
          token.transport,
        );
        if (!isCurrentRequest(token)) return null;
        if (!result.ok) {
          set({ error: result.message });
          return null;
        }
        const parsed = parseRemoteResult(result.data);
        if (!parsed) {
          set({ error: "Invalid remote models response" });
          return null;
        }
        set({ error: null });
        return parsed;
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
        return null;
      }
    },

    resetForTest: () => {
      reqSeq += 1;
      writeChain = Promise.resolve();
      pendingWrites = 0;
      set({ bundle: null, loading: false, saving: false, error: null });
    },
  };
});
