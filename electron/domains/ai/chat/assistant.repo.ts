import { handleUser } from "../../../commons/ipc-user";
import prisma from "../../../commons/prisma-client";
import type {
  AssistantCreateParams,
  AssistantRecord,
  AssistantUpdateParams,
} from "../../../../src-react/domains/ai/api/assistant.api";

type AssistantRow = NonNullable<
  Awaited<ReturnType<typeof prisma.assistant.findFirst>>
>;

export class AssistantRepository {
  constructor() {
    this.registerIpcHandlers();
  }

  /** tags 列为 JSON 数组字符串；坏数据回退空数组不抛错（展示字段） */
  private parseTags(raw: string | null): string[] {
    if (!raw) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }

  private toRecord(row: AssistantRow): AssistantRecord {
    return {
      ...row,
      icon: row.icon ?? undefined,
      temperature: row.temperature ?? undefined,
      topP: row.topP ?? undefined,
      maxTokens: row.maxTokens ?? undefined,
      description: row.description ?? undefined,
      tags: this.parseTags(row.tags),
      sourceSlug: row.sourceSlug ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private registerIpcHandlers() {
    handleUser("assistant:list", (_, userId) => this.list(userId));
    handleUser("assistant:create", (_, userId, p: AssistantCreateParams) =>
      this.create(p, userId),
    );
    handleUser("assistant:update", (_, userId, p: AssistantUpdateParams) =>
      this.update(p, userId),
    );
    handleUser("assistant:delete", (_, userId, id: number) =>
      this.delete(id, userId),
    );
  }

  /** 校验助手归当前用户（不存在与他人所有同报错，不泄露存在性） */
  private async assertOwned(id: number, userId: number): Promise<void> {
    const row = await prisma.assistant.findFirst({ where: { id, userId } });
    if (!row) {
      throw new Error("ASSISTANT_NOT_FOUND");
    }
  }

  async list(userId: number): Promise<AssistantRecord[]> {
    return (
      await prisma.assistant.findMany({
        where: { userId },
        orderBy: [{ builtin: "desc" }, { createdAt: "asc" }],
      })
    ).map((row) => this.toRecord(row));
  }

  async getById(id: number): Promise<AssistantRecord | null> {
    const row = await prisma.assistant.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  async create(
    p: AssistantCreateParams,
    userId: number,
  ): Promise<AssistantRecord> {
    const row = await prisma.assistant.create({
      data: {
        name: p.name,
        icon: p.icon,
        systemPrompt: p.systemPrompt,
        temperature: p.temperature,
        topP: p.topP,
        maxTokens: p.maxTokens,
        description: p.description,
        tags: p.tags ? JSON.stringify(p.tags) : undefined,
        sourceSlug: p.sourceSlug,
        userId,
      },
    });
    return this.toRecord(row);
  }

  async update(
    p: AssistantUpdateParams,
    userId: number,
  ): Promise<AssistantRecord> {
    await this.assertOwned(p.id, userId);
    const row = await prisma.assistant.update({
      where: { id: p.id },
      data: {
        name: p.name,
        icon: p.icon,
        systemPrompt: p.systemPrompt,
        temperature: p.temperature,
        topP: p.topP,
        maxTokens: p.maxTokens,
        description: p.description,
        // tags undefined 时键整体不出现在 data（区别于 null = 清空）
        ...(p.tags === undefined
          ? {}
          : { tags: p.tags === null ? null : JSON.stringify(p.tags) }),
      },
    });
    return this.toRecord(row);
  }

  async delete(id: number, userId: number): Promise<void> {
    const row = await prisma.assistant.findFirst({ where: { id, userId } });
    if (!row) {
      throw new Error("ASSISTANT_NOT_FOUND");
    }
    if (row.builtin) {
      // 错误码由渲染端 mapIpcError 映射 i18n 文案
      throw new Error("ASSISTANT_BUILTIN");
    }
    await prisma.assistant.delete({ where: { id } });
  }
}
