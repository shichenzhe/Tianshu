import { ipcMain } from "electron";
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
    ipcMain.handle("provider:list", () => this.list());
    ipcMain.handle("provider:getById", (_, id: number) => this.getById(id));
    ipcMain.handle("provider:create", (_, p: ProviderCreateParams) =>
      this.create(p),
    );
    ipcMain.handle("provider:update", (_, p: ProviderUpdateParams) =>
      this.update(p),
    );
    ipcMain.handle("provider:delete", (_, id: number) => this.delete(id));
  }

  async list(): Promise<ProviderRecord[]> {
    return (
      await prisma.provider.findMany({ orderBy: { createdAt: "desc" } })
    ).map((row) => this.toRecord(row));
  }

  async getById(id: number): Promise<ProviderRecord | null> {
    const row = await prisma.provider.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  async create(p: ProviderCreateParams): Promise<ProviderRecord> {
    const row = await prisma.provider.create({
      data: {
        name: p.name,
        type: p.type,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        extraHeaders: p.extraHeaders,
        enabled: p.enabled ?? true,
      },
    });
    return this.toRecord(row);
  }

  async update(p: ProviderUpdateParams): Promise<ProviderRecord> {
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

  async delete(id: number): Promise<void> {
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
