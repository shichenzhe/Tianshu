import { ipcMain } from "electron";
import prisma from "../../../commons/prisma-client";
import { listOllamaModels, testConnection } from "./connectivity";
import { ProviderRepository } from "./provider.repo";
import type {
  ModelCreateParams,
  ModelRecord,
  ModelUpdateParams,
} from "../../../../src-react/domains/ai/api/model.api";

type ModelRow = NonNullable<Awaited<ReturnType<typeof prisma.model.findFirst>>>;

export class ModelRepository {
  constructor(private providerRepo: ProviderRepository) {
    this.registerIpcHandlers();
  }

  private toRecord(row: ModelRow): ModelRecord {
    return {
      ...row,
      name: row.name ?? undefined,
      temperature: row.temperature ?? undefined,
      topP: row.topP ?? undefined,
      maxTokens: row.maxTokens ?? undefined,
      contextWindow: row.contextWindow ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private registerIpcHandlers() {
    ipcMain.handle("model:listByProvider", (_, providerId: number) =>
      this.listByProvider(providerId),
    );
    ipcMain.handle("model:listAll", () => this.listAll());
    ipcMain.handle("model:create", (_, p: ModelCreateParams) => this.create(p));
    ipcMain.handle("model:update", (_, p: ModelUpdateParams) => this.update(p));
    ipcMain.handle("model:delete", (_, id: number) => this.delete(id));
    ipcMain.handle("model:test", (_, id: number) => this.test(id));
    ipcMain.handle("model:listOllama", (_, providerId: number) =>
      this.listOllama(providerId),
    );
  }

  async listByProvider(providerId: number): Promise<ModelRecord[]> {
    return (
      await prisma.model.findMany({
        where: { providerId },
        orderBy: { createdAt: "desc" },
      })
    ).map((row) => this.toRecord(row));
  }

  async listAll(): Promise<ModelRecord[]> {
    return (
      await prisma.model.findMany({
        orderBy: [{ providerId: "asc" }, { createdAt: "desc" }],
      })
    ).map((row) => this.toRecord(row));
  }

  async getById(id: number): Promise<ModelRecord | null> {
    const row = await prisma.model.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  async create(p: ModelCreateParams): Promise<ModelRecord> {
    const row = await prisma.model.create({
      data: {
        providerId: p.providerId,
        modelId: p.modelId,
        name: p.name,
        temperature: p.temperature,
        topP: p.topP,
        maxTokens: p.maxTokens,
        contextWindow: p.contextWindow,
      },
    });
    return this.toRecord(row);
  }

  async update(p: ModelUpdateParams): Promise<ModelRecord> {
    const row = await prisma.model.update({
      where: { id: p.id },
      data: {
        modelId: p.modelId,
        name: p.name,
        enabled: p.enabled,
        temperature: p.temperature,
        topP: p.topP,
        maxTokens: p.maxTokens,
        contextWindow: p.contextWindow,
      },
    });
    return this.toRecord(row);
  }

  async delete(id: number): Promise<void> {
    await prisma.model.delete({ where: { id } });
  }

  async test(id: number) {
    // 前置校验缺失属业务错误：抛错误码（渲染端 mapIpcError 映射 i18n），
    // 连通性结果（含上游 errorCode）仍按 TestConnectionResult 返回
    const model = await this.getById(id);
    if (!model) {
      throw new Error("MODEL_MISSING");
    }
    const provider = await this.providerRepo.getRuntimeInfo(model.providerId);
    if (!provider) {
      throw new Error("PROVIDER_MISSING");
    }
    return testConnection(provider, model.modelId);
  }

  async listOllama(providerId: number) {
    const provider = await this.providerRepo.getRuntimeInfo(providerId);
    if (!provider) {
      throw new Error("PROVIDER_MISSING");
    }
    return listOllamaModels(provider.baseUrl);
  }
}
