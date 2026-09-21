import { handleUser } from "../../../commons/ipc-user";
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
    handleUser("model:listByProvider", (_, userId, providerId: number) =>
      this.listByProvider(providerId, userId),
    );
    handleUser("model:listAll", (_, userId) => this.listAll(userId));
    handleUser("model:create", (_, userId, p: ModelCreateParams) =>
      this.create(p, userId),
    );
    handleUser("model:update", (_, userId, p: ModelUpdateParams) =>
      this.update(p, userId),
    );
    handleUser("model:delete", (_, userId, id: number) =>
      this.delete(id, userId),
    );
    handleUser("model:test", (_, userId, id: number) => this.test(id, userId));
    handleUser("model:listOllama", (_, userId, providerId: number) =>
      this.listOllama(providerId, userId),
    );
  }

  /** 校验 model 归属（经 provider 链路），不存在与他人所有同报错 */
  private async assertModelOwned(id: number, userId: number): Promise<void> {
    const model = await prisma.model.findUnique({ where: { id } });
    if (!model) {
      throw new Error("MODEL_MISSING");
    }
    await this.providerRepo.assertOwned(model.providerId, userId);
  }

  async listByProvider(
    providerId: number,
    userId: number,
  ): Promise<ModelRecord[]> {
    await this.providerRepo.assertOwned(providerId, userId);
    return (
      await prisma.model.findMany({
        where: { providerId },
        orderBy: { createdAt: "desc" },
      })
    ).map((row) => this.toRecord(row));
  }

  async listAll(userId: number): Promise<ModelRecord[]> {
    // model 无 userId 冗余列，经所属 provider 过滤
    const providers = await prisma.provider.findMany({
      where: { userId },
      select: { id: true },
    });
    return (
      await prisma.model.findMany({
        where: { providerId: { in: providers.map((p) => p.id) } },
        orderBy: [{ providerId: "asc" }, { createdAt: "desc" }],
      })
    ).map((row) => this.toRecord(row));
  }

  /**
   * 全体用户的启用模型（记忆子系统兜底用）：个性化记忆为本机全局
   * （v12 隔离不拆用户），编译回退模型从全局启用池解析
   */
  async listAllEnabledAnyUser(): Promise<ModelRecord[]> {
    return (
      await prisma.model.findMany({
        where: { enabled: true },
        orderBy: { createdAt: "desc" },
      })
    ).map((row) => this.toRecord(row));
  }

  async getById(id: number): Promise<ModelRecord | null> {
    const row = await prisma.model.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  async create(p: ModelCreateParams, userId: number): Promise<ModelRecord> {
    await this.providerRepo.assertOwned(p.providerId, userId);
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

  async update(p: ModelUpdateParams, userId: number): Promise<ModelRecord> {
    await this.assertModelOwned(p.id, userId);
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

  async delete(id: number, userId: number): Promise<void> {
    await this.assertModelOwned(id, userId);
    await prisma.model.delete({ where: { id } });
  }

  async test(id: number, userId: number) {
    await this.assertModelOwned(id, userId);
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

  async listOllama(providerId: number, userId: number) {
    await this.providerRepo.assertOwned(providerId, userId);
    const provider = await this.providerRepo.getRuntimeInfo(providerId);
    if (!provider) {
      throw new Error("PROVIDER_MISSING");
    }
    return listOllamaModels(provider.baseUrl);
  }
}
