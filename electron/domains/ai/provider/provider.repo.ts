import { handleUser } from "../../../commons/ipc-user";
import prisma from "../../../commons/prisma-client";
import type {
  ProviderCreateParams,
  ProviderRecord,
  ProviderType,
  ProviderUpdateParams,
} from "../../../../src-react/domains/ai/api/provider.api";
import type { ProviderRuntimeInfo } from "./provider-factory";

type ProviderRow = NonNullable<
  Awaited<ReturnType<typeof prisma.provider.findFirst>>
>;

export class ProviderRepository {
  constructor() {
    this.registerIpcHandlers();
  }

  private toRecord(row: ProviderRow): ProviderRecord {
    return {
      ...row,
      type: row.type as ProviderType,
      apiKey: row.apiKey ?? undefined,
      extraHeaders: row.extraHeaders ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private registerIpcHandlers() {
    handleUser("provider:list", (_, userId) => this.list(userId));
    handleUser("provider:getById", (_, userId, id: number) =>
      this.getById(id, userId),
    );
    handleUser("provider:create", (_, userId, p: ProviderCreateParams) =>
      this.create(p, userId),
    );
    handleUser("provider:update", (_, userId, p: ProviderUpdateParams) =>
      this.update(p, userId),
    );
    handleUser("provider:delete", (_, userId, id: number) =>
      this.delete(id, userId),
    );
  }

  /**
   * 校验 provider 归当前用户（不存在与他人所有同报错，不泄露存在性）
   */
  async assertOwned(id: number, userId: number): Promise<void> {
    const row = await prisma.provider.findFirst({ where: { id, userId } });
    if (!row) {
      throw new Error("PROVIDER_NOT_FOUND");
    }
  }

  async list(userId: number): Promise<ProviderRecord[]> {
    return (
      await prisma.provider.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      })
    ).map((row) => this.toRecord(row));
  }

  async getById(id: number, userId: number): Promise<ProviderRecord | null> {
    const row = await prisma.provider.findFirst({ where: { id, userId } });
    return row ? this.toRecord(row) : null;
  }

  async create(
    p: ProviderCreateParams,
    userId: number,
  ): Promise<ProviderRecord> {
    const row = await prisma.provider.create({
      data: {
        name: p.name,
        type: p.type,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        extraHeaders: p.extraHeaders,
        enabled: p.enabled ?? true,
        userId,
      },
    });
    return this.toRecord(row);
  }

  async update(
    p: ProviderUpdateParams,
    userId: number,
  ): Promise<ProviderRecord> {
    await this.assertOwned(p.id, userId);
    const row = await prisma.provider.update({
      where: { id: p.id },
      data: {
        name: p.name,
        type: p.type,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        extraHeaders: p.extraHeaders,
        enabled: p.enabled,
      },
    });
    return this.toRecord(row);
  }

  async delete(id: number, userId: number): Promise<void> {
    await this.assertOwned(id, userId);
    await prisma.model.deleteMany({ where: { providerId: id } });
    await prisma.provider.delete({ where: { id } });
  }

  /**
   * 供 chat 引擎使用的运行时信息（不含展示字段）
   */
  async getRuntimeInfo(id: number): Promise<ProviderRuntimeInfo | null> {
    const row = await prisma.provider.findUnique({
      where: { id },
      select: { type: true, baseUrl: true, apiKey: true, extraHeaders: true },
    });
    if (!row) {
      return null;
    }
    return {
      type: row.type,
      baseUrl: row.baseUrl,
      apiKey: row.apiKey ?? undefined,
      extraHeaders: row.extraHeaders ?? undefined,
    };
  }
}
