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

const BUILTIN_ASSISTANTS: AssistantCreateParams[] = [
  {
    name: "通用助手",
    icon: "🤖",
    systemPrompt: "你是一个乐于助人的通用 AI 助手，回答简洁准确。",
  },
  {
    name: "翻译助手",
    icon: "🌍",
    systemPrompt:
      "你是一名专业翻译。用户输入什么语言，就翻译成另一种语言：中文输入译成英文，其他语言输入译成中文。只输出译文，不解释。",
  },
  {
    name: "代码审查",
    icon: "🔍",
    systemPrompt:
      "你是一名资深代码审查员。针对用户给出的代码，指出正确性问题、可读性问题与潜在风险，按严重程度排序，并给出修改建议。",
  },
];

export class AssistantRepository {
  constructor() {
    this.registerIpcHandlers();
  }

  private toRecord(row: AssistantRow): AssistantRecord {
    return {
      ...row,
      icon: row.icon ?? undefined,
      temperature: row.temperature ?? undefined,
      topP: row.topP ?? undefined,
      maxTokens: row.maxTokens ?? undefined,
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

  /**
   * 播种内置助手（每用户一份；原启动期 seedIfEmpty 因多用户隔离改为
   * 首次 list 时按用户补种）
   */
  private async seedIfEmptyFor(userId: number): Promise<void> {
    const count = await prisma.assistant.count({ where: { userId } });
    if (count === 0) {
      await prisma.assistant.createMany({
        data: BUILTIN_ASSISTANTS.map((a) => ({
          ...a,
          builtin: true,
          userId,
        })),
      });
    }
  }

  /** 校验助手归当前用户（不存在与他人所有同报错，不泄露存在性） */
  private async assertOwned(id: number, userId: number): Promise<void> {
    const row = await prisma.assistant.findFirst({ where: { id, userId } });
    if (!row) {
      throw new Error("ASSISTANT_NOT_FOUND");
    }
  }

  async list(userId: number): Promise<AssistantRecord[]> {
    await this.seedIfEmptyFor(userId);
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
