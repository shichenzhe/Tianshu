/**
 * 应用定义仓储 + IPC（聚合期核心，切片 C P1）：appDefinition CRUD。
 * graphIds 为 JSON 数组字符串（最小形态不做关联表）；删除应用时解绑
 * 引用它的会话（session.appId 置 null，防悬空绑定——工具作用域对悬空
 * 按"注记回退全量"处理，此处在删除源头即收敛）。provider.repo 口径。
 */
import { handleUser } from "../../../commons/ipc-user";
import prisma from "../../../commons/prisma-client";
import type {
  AppCreateParams,
  AppRecord,
  AppUpdateParams,
} from "../../../../src-react/domains/ai/api/app.api";

type AppRow = NonNullable<
  Awaited<ReturnType<typeof prisma.appDefinition.findFirst>>
>;

export class AppRepository {
  constructor() {
    this.registerIpcHandlers();
  }

  /** graphIds JSON 字符串 → number[]（非法内容容错空数组） */
  static parseGraphIds(raw: string): number[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is number => Number.isInteger(v));
      }
    } catch {
      // 非法 JSON 容错
    }
    return [];
  }

  private toRecord(row: AppRow): AppRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      graphIds: AppRepository.parseGraphIds(row.graphIds),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private registerIpcHandlers() {
    handleUser("app:list", (_, userId) => this.list(userId));
    handleUser("app:create", (_, userId, p: AppCreateParams) =>
      this.create(p, userId),
    );
    handleUser("app:update", (_, userId, p: AppUpdateParams) =>
      this.update(p, userId),
    );
    handleUser("app:delete", (_, userId, id: number) =>
      this.delete(id, userId),
    );
  }

  async list(userId: number): Promise<AppRecord[]> {
    return (
      await prisma.appDefinition.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      })
    ).map((row) => this.toRecord(row));
  }

  async create(p: AppCreateParams, userId: number): Promise<AppRecord> {
    if (typeof p.name !== "string" || p.name.trim() === "") {
      throw new Error("名称不能为空");
    }
    const row = await prisma.appDefinition.create({
      data: {
        name: p.name.trim(),
        description: p.description?.trim() || null,
        graphIds: JSON.stringify(
          AppRepository.parseGraphIds(p.graphIds ?? "[]"),
        ),
        userId,
      },
    });
    return this.toRecord(row);
  }

  async update(p: AppUpdateParams, userId: number): Promise<AppRecord> {
    const owned = await prisma.appDefinition.findFirst({
      where: { id: p.id, userId },
    });
    if (!owned) {
      throw new Error("APP_NOT_FOUND");
    }
    const row = await prisma.appDefinition.update({
      where: { id: p.id },
      data: {
        ...(p.name !== undefined ? { name: p.name.trim() } : {}),
        ...(p.description !== undefined
          ? { description: p.description?.trim() || null }
          : {}),
        ...(p.graphIds !== undefined
          ? {
              graphIds: JSON.stringify(AppRepository.parseGraphIds(p.graphIds)),
            }
          : {}),
      },
    });
    return this.toRecord(row);
  }

  /** 删除应用：先解绑引用会话（appId 置 null）再删行 */
  async delete(id: number, userId: number): Promise<void> {
    const owned = await prisma.appDefinition.findFirst({
      where: { id, userId },
    });
    if (!owned) {
      throw new Error("APP_NOT_FOUND");
    }
    await prisma.session.updateMany({
      where: { appId: id },
      data: { appId: null },
    });
    await prisma.appDefinition.delete({ where: { id } });
  }
}

export default AppRepository;
