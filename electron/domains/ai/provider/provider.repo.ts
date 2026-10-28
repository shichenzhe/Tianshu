import { handleUser } from "../../../commons/ipc-user";
import prisma from "../../../commons/prisma-client";
import { testConnection, type TestConnectionResult } from "./connectivity";
import type {
  ProviderCreateParams,
  ProviderRecord,
  ProviderType,
  ProviderUpdateParams,
} from "../../../../src-react/domains/ai/api/provider.api";
import type { ProviderRuntimeInfo } from "./provider-runtime";

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
    handleUser("provider:test", (_, userId, id: number) =>
      this.test(id, userId),
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
   * provider 级连通测试（comfyui 专用入口：无模型行可挂测试按钮，走
   * GET /system_stats——comfyui 分支不消费 modelId 传空串；其余类型无
   * 模型 id 无从探测，结构化拒绝）
   */
  async test(id: number, userId: number): Promise<TestConnectionResult> {
    await this.assertOwned(id, userId);
    const runtime = await this.getRuntimeInfo(id);
    if (!runtime) {
      throw new Error("PROVIDER_NOT_FOUND");
    }
    if (runtime.type !== "comfyui") {
      return {
        success: false,
        errorCode: "UNSUPPORTED_TYPE_TEST",
        message: "",
      };
    }
    return testConnection(runtime, "");
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
