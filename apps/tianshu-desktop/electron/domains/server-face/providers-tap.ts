// A1 终审 F5：providers face 桥独立 tap，便于用内存仓储直测写面与脱敏。
// 掩码防回写、归属错误项标识、顺序应用失败即停均与原 ipc.ts 桥同语义。
import { REDACTED_SECRET } from "@tianshu/protocol";
import type { ProviderRepository } from "../ai/provider/provider.repo";
import type { ModelRepository } from "../ai/provider/model.repo";
import type { ProviderType } from "../../../src-react/domains/ai/api/provider.api";
import type { ModelType } from "../../../src-react/domains/ai/api/model.api";
import type { ServerFaceProviders } from "./deps";

/** A1 终审 F1 fail-closed：异常形状不得原样回泄潜在秘密。
 *  A4 批起导出复用——mcp detail 的 env/headers 恒掩码同口径。 */
export function redactExtraHeaders(
  raw: string | null | undefined,
): string | null | undefined {
  if (typeof raw !== "string" || raw === "") return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return REDACTED_SECRET;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    redacted[key] =
      typeof value === "string" && value === "" ? value : REDACTED_SECRET;
  }
  return JSON.stringify(redacted);
}

function redactProviderSecrets<
  T extends { apiKey?: string | null; extraHeaders?: string | null },
>(provider: T): T {
  return {
    ...provider,
    apiKey: provider.apiKey ? REDACTED_SECRET : provider.apiKey,
    extraHeaders: redactExtraHeaders(provider.extraHeaders),
  };
}

export function createProvidersFace(deps: {
  providerRepo: Pick<
    ProviderRepository,
    "list" | "create" | "update" | "delete"
  >;
  modelRepo: Pick<
    ModelRepository,
    "listAll" | "create" | "update" | "delete" | "listRemote"
  >;
}): ServerFaceProviders {
  const listBundle: ServerFaceProviders["listBundle"] = async (userId) => ({
    providers: (await deps.providerRepo.list(userId)).map(
      redactProviderSecrets,
    ),
    models: await deps.modelRepo.listAll(userId),
  });

  return {
    listBundle,
    deleteProviders: async (ids, userId) => {
      for (const id of ids) await deps.providerRepo.delete(id, userId);
    },
    deleteModels: async (ids, userId) => {
      for (const id of ids) await deps.modelRepo.delete(id, userId);
    },
    listRemote: (providerId, userId) =>
      deps.modelRepo.listRemote(providerId, userId),
    save: async (payload, userId) => {
      for (const item of payload.providers ?? []) {
        const apiKey =
          item.apiKey === REDACTED_SECRET ? undefined : item.apiKey;
        const extraHeaders =
          typeof item.extraHeaders === "string" &&
          item.extraHeaders.includes(REDACTED_SECRET)
            ? undefined
            : item.extraHeaders;
        try {
          if (item.id != null) {
            await deps.providerRepo.update(
              {
                id: item.id,
                name: item.name,
                type: item.type as ProviderType,
                baseUrl: item.baseUrl,
                apiKey,
                extraHeaders,
                enabled: item.enabled,
              },
              userId,
            );
          } else {
            await deps.providerRepo.create(
              {
                name: item.name,
                type: item.type as ProviderType,
                baseUrl: item.baseUrl,
                apiKey: apiKey ?? undefined,
                extraHeaders: extraHeaders ?? undefined,
                enabled: item.enabled,
              },
              userId,
            );
          }
        } catch (e) {
          throw new Error(
            `服务商「${item.name}」保存失败：${e instanceof Error ? e.message : String(e)}`,
            { cause: e },
          );
        }
      }
      for (const item of payload.models ?? []) {
        try {
          if (item.id != null) {
            await deps.modelRepo.update(
              {
                id: item.id,
                modelId: item.modelId,
                name: item.name,
                enabled: item.enabled,
                type: item.type as ModelType,
                temperature: item.temperature,
                topP: item.topP,
                maxTokens: item.maxTokens,
                contextWindow: item.contextWindow,
              },
              userId,
            );
          } else {
            const created = await deps.modelRepo.create(
              {
                providerId: item.providerId,
                modelId: item.modelId,
                name: item.name ?? undefined,
                type: item.type as ModelType,
                temperature: item.temperature ?? undefined,
                topP: item.topP ?? undefined,
                maxTokens: item.maxTokens ?? undefined,
                contextWindow: item.contextWindow ?? undefined,
              },
              userId,
            );
            if (item.enabled === false) {
              await deps.modelRepo.update(
                { id: created.id, enabled: false },
                userId,
              );
            }
          }
        } catch (e) {
          throw new Error(
            `模型「${item.modelId}」保存失败：${e instanceof Error ? e.message : String(e)}`,
            { cause: e },
          );
        }
      }
      return listBundle(userId);
    },
  };
}
