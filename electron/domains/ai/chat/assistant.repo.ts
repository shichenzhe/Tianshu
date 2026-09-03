import { ipcMain } from "electron";
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
    void this.seedIfEmpty();
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
    ipcMain.handle("assistant:list", () => this.list());
    ipcMain.handle("assistant:create", (_, p: AssistantCreateParams) =>
      this.create(p),
    );
    ipcMain.handle("assistant:update", (_, p: AssistantUpdateParams) =>
      this.update(p),
    );
    ipcMain.handle("assistant:delete", (_, id: number) => this.delete(id));
  }

  async seedIfEmpty(): Promise<void> {
    const count = await prisma.assistant.count();
    if (count === 0) {
      await prisma.assistant.createMany({
        data: BUILTIN_ASSISTANTS.map((a) => ({ ...a, builtin: true })),
      });
    }
  }

  async list(): Promise<AssistantRecord[]> {
    return (
      await prisma.assistant.findMany({
        orderBy: [{ builtin: "desc" }, { createdAt: "asc" }],
      })
    ).map((row) => this.toRecord(row));
  }

  async getById(id: number): Promise<AssistantRecord | null> {
    const row = await prisma.assistant.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  async create(p: AssistantCreateParams): Promise<AssistantRecord> {
    const row = await prisma.assistant.create({
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

  async update(p: AssistantUpdateParams): Promise<AssistantRecord> {
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

  async delete(id: number): Promise<void> {
    const row = await prisma.assistant.findUnique({ where: { id } });
    if (row?.builtin) {
      // 错误码由渲染端 mapIpcError 映射 i18n 文案
      throw new Error("ASSISTANT_BUILTIN");
    }
    await prisma.assistant.delete({ where: { id } });
  }
}
