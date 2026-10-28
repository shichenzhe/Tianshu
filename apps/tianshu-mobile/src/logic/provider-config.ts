import type { ModelSaveItem, ProviderSaveItem } from "@tianshu/protocol";

export interface ProviderFormValues {
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  extraHeaders: string;
  enabled: boolean;
  clearApiKey: boolean;
  clearExtraHeaders: boolean;
}

export interface ModelFormValues {
  modelId: string;
  name: string;
  type: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  contextWindow: string;
}

export interface RemoteModelChoice {
  modelId: string;
  name?: string;
  imported: boolean;
}

type FormResult<T, E extends string> =
  { ok: true; item: T } | { ok: false; error: E };

function optionalNumber(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error("invalid-number");
  return value;
}

function optionalInt(raw: string): number | undefined {
  const value = optionalNumber(raw);
  if (value !== undefined && !Number.isInteger(value)) {
    throw new Error("invalid-number");
  }
  return value;
}

export function buildProviderSave(
  input: ProviderFormValues,
  editingId?: number,
): FormResult<ProviderSaveItem, "required" | "invalidJson"> {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim();
  if (!name || !baseUrl) return { ok: false, error: "required" };
  const apiKey = input.apiKey.trim();
  const extraHeaders = input.extraHeaders.trim();
  if (extraHeaders) {
    try {
      const parsed: unknown = JSON.parse(extraHeaders);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== "string")
      ) {
        return { ok: false, error: "invalidJson" };
      }
    } catch {
      return { ok: false, error: "invalidJson" };
    }
  }
  const editedApiKey = input.clearApiKey ? null : apiKey || undefined;
  const editedHeaders = input.clearExtraHeaders
    ? null
    : extraHeaders || undefined;
  const secrets =
    editingId === undefined
      ? {
          ...(apiKey ? { apiKey } : {}),
          ...(extraHeaders ? { extraHeaders } : {}),
        }
      : {
          ...(editedApiKey !== undefined ? { apiKey: editedApiKey } : {}),
          ...(editedHeaders !== undefined
            ? { extraHeaders: editedHeaders }
            : {}),
        };
  return {
    ok: true,
    item: {
      ...(editingId === undefined ? {} : { id: editingId }),
      name,
      type: input.type,
      baseUrl,
      enabled: input.enabled,
      ...secrets,
    },
  };
}

export function buildModelSave(
  providerId: number,
  input: ModelFormValues,
  editingId?: number,
): FormResult<
  ModelSaveItem,
  "required" | "invalidNumber" | "positiveIntRequired" | "maxTokensLtContext"
> {
  const modelId = input.modelId.trim();
  if (!modelId) return { ok: false, error: "required" };
  try {
    const temperature = optionalNumber(input.temperature);
    const topP = optionalNumber(input.topP);
    const maxTokens = optionalInt(input.maxTokens);
    const contextWindow = optionalInt(input.contextWindow);
    if ((maxTokens ?? 1) <= 0 || (contextWindow ?? 1) <= 0) {
      return { ok: false, error: "positiveIntRequired" };
    }
    if (
      maxTokens !== undefined &&
      contextWindow !== undefined &&
      maxTokens >= contextWindow
    ) {
      return { ok: false, error: "maxTokensLtContext" };
    }
    const editing = editingId !== undefined;
    const empty = <T>(value: T | undefined) =>
      value ?? (editing ? null : undefined);
    return {
      ok: true,
      item: {
        ...(editing ? { id: editingId } : {}),
        providerId,
        modelId,
        name: empty(input.name.trim() || undefined),
        type: input.type,
        temperature: empty(temperature),
        topP: empty(topP),
        maxTokens: empty(maxTokens),
        contextWindow: empty(contextWindow),
      },
    };
  } catch {
    return { ok: false, error: "invalidNumber" };
  }
}

export function prepareRemoteModels(
  models: Array<{ modelId: string; name?: string }>,
  existingIds: Set<string>,
): RemoteModelChoice[] {
  const seen = new Set<string>();
  const rows = models.flatMap((model) => {
    if (seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    return [{ ...model, imported: existingIds.has(model.modelId) }];
  });
  return rows.sort((a, b) => Number(a.imported) - Number(b.imported));
}

function inferModelType(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes("embed")) return "embedding";
  if (id.includes("rerank")) return "reranker";
  if (id.includes("tts") || id.includes("speech")) return "tts";
  if (id.includes("whisper") || id.includes("asr")) return "asr";
  return "llm";
}

export function buildRemoteModelSave(
  providerId: number,
  model: { modelId: string; name?: string },
): ModelSaveItem {
  return {
    providerId,
    modelId: model.modelId,
    name: model.name?.trim() || undefined,
    type: inferModelType(model.modelId),
    enabled: true,
  };
}

export async function importRemoteModels(
  providerId: number,
  rows: RemoteModelChoice[],
  selected: Set<string>,
  save: (item: ModelSaveItem) => Promise<boolean>,
): Promise<{ succeeded: Set<string>; failed: Set<string> }> {
  const succeeded = new Set<string>();
  const failed = new Set<string>();
  for (const row of rows) {
    if (row.imported || !selected.has(row.modelId)) continue;
    const saved = await save(buildRemoteModelSave(providerId, row));
    if (saved) succeeded.add(row.modelId);
    else failed.add(row.modelId);
  }
  return { succeeded, failed };
}
