/**
 * 记忆 AI 管线（spec §5.3）：读近期对话/用户指令 → 调默认模型 →
 * 输出新记忆 markdown。模型调用经 ModelTextFn 注入（测试覆写，
 * 参考 chat.service titleModelText 模式）。无可用模型/无对话材料时
 * 由调用方（scheduler/service）决策跳过。
 */
import { generateText } from "ai";

import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { parseBlocks } from "../chat/blocks";
import { createLanguageModel } from "../provider/provider-factory";
import type { ProviderRuntimeInfo } from "../provider/provider-factory";
import {
  MEMORY_PROFILE_LIMIT,
  stripCodeFence,
  truncateMemoryMarkdown,
} from "../../../../src-react/domains/app-settings/model/memory-markdown";

/** provider 运行时信息查询面（ProviderRepository 可直接满足） */
export interface ProviderRuntimeSource {
  getRuntimeInfo(id: number): Promise<ProviderRuntimeInfo | null>;
}

/** 模型行最小查询面（ModelRepository.getById/listAll 可直接满足） */
export interface MemoryModelRow {
  id: number;
  providerId: number;
  modelId: string;
  enabled: boolean;
}

export interface MemoryModelContext {
  type: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: string | null;
  modelId: string;
}

export type ModelTextFn = (
  system: string,
  prompt: string,
  signal?: AbortSignal,
) => Promise<string>;

export const MEMORY_COMPILER_SYSTEM_PROMPT = [
  "你是记忆管理器。给定当前记忆与新材料（近期对话或用户指令），输出完整的新记忆 markdown。",
  "硬性要求：",
  "1. 分类标题固定为四节且顺序为：## 工作背景、## 个人背景、## 当前关注、## 近期动态；",
  "2. 条目每行一条，格式 [YYYY-MM-DD] - 条目内容，日期未知可省略；",
  "3. 近期动态最多 20 条，按日期倒序（新的在上）；",
  "4. 单条不超过 500 字；总长不超过 8000 字；",
  "5. 保留仍然有效的旧记忆，合并去重，删除过时条目；用户指令只影响指令提到的内容；",
  "6. 只输出 markdown 本体，不要解释，不要代码块围栏。",
].join("\n");

export function buildCompileUserPrompt(
  currentMemory: string,
  material: string,
): string {
  return `当前记忆：\n${currentMemory || "（空）"}\n\n近期对话材料：\n${material}`;
}

export function buildInstructionUserPrompt(
  currentMemory: string,
  instruction: string,
): string {
  return `当前记忆：\n${currentMemory || "（空）"}\n\n用户指令（应用增删改后输出完整新记忆）：\n${instruction}`;
}

/** 校验 AI 输出（I2 四标题齐备）：剥围栏、截断；四节标题缺一 → null */
export function validateMemoryOutput(raw: string): string | null {
  const text = stripCodeFence(raw ?? "");
  if (
    text === "" ||
    !["工作背景", "个人背景", "当前关注", "近期动态"].every((t) =>
      text.includes(`## ${t}`),
    )
  ) {
    return null;
  }
  return truncateMemoryMarkdown(text, MEMORY_PROFILE_LIMIT);
}

/**
 * prisma.message 最小查询面（测试注入用）。session 为可选增强：
 * 提供时按未归档会话过滤（schema 无 relation，两步查询实现）。
 */
export interface ConversationPrismaLike {
  message: {
    findMany(
      args: unknown,
    ): Promise<Array<{ id: number; role: string; blocks: string }>>;
  };
  session?: {
    findMany(args: unknown): Promise<Array<{ id: number }>>;
  };
}

function rowToLine(row: { role: string; blocks: string }): string {
  const text = parseBlocks(row.blocks)
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (text === "") {
    return "";
  }
  return `${row.role === "user" ? "用户" : "助手"}：${text}`;
}

/** 组装 where：role/时间窗基础过滤 + 未归档会话 id 集（可选） */
async function buildConversationWhere(
  prismaLike: ConversationPrismaLike,
  cutoff: Date,
): Promise<Record<string, unknown>> {
  const where: Record<string, unknown> = {
    role: { in: ["user", "assistant"] },
    createdAt: { gte: cutoff },
  };
  if (prismaLike.session) {
    const sessions = await prismaLike.session.findMany({
      where: { archivedAt: null },
      select: { id: true },
    });
    where.sessionId = { in: sessions.map((s) => s.id) };
  }
  return where;
}

/** 从尾端累积不超 charLimit 的行（保最新，超限丢弃最旧） */
function keepRecentLines(lines: string[], charLimit: number): string {
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > charLimit) {
      break;
    }
    kept.unshift(lines[i]);
    size += lines[i].length;
  }
  return kept.join("\n");
}

/** 近 7 天 user/assistant 消息 → "用户：…\n助手：…" 文本；保最新 charLimit 字符 */
export async function fetchRecentConversation(
  prismaLike: ConversationPrismaLike,
  days: number = 7,
  charLimit: number = 30000,
): Promise<string> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prismaLike.message.findMany({
    where: await buildConversationWhere(prismaLike, cutoff),
    orderBy: { id: "asc" },
  });
  return keepRecentLines(
    rows.map(rowToLine).filter((line) => line !== ""),
    charLimit,
  );
}

/** 候选模型 id 序：workspace.defaultModelId 优先，其后全部启用模型 */
async function listModelCandidateIds(
  listModels: () => Promise<MemoryModelRow[]>,
): Promise<number[]> {
  const workspaces = await prisma.workspace.findMany({
    orderBy: { id: "asc" },
    select: { defaultModelId: true },
  });
  const defaults = workspaces
    .map((w) => w.defaultModelId)
    .filter((id): id is number => id !== null);
  return [
    ...defaults,
    ...(await listModels()).filter((m) => m.enabled).map((m) => m.id),
  ];
}

/** 默认模型解析：workspace.defaultModelId 优先，回退任意启用模型 */
export async function resolveMemoryModel(
  providerRepo: ProviderRuntimeSource,
  modelRepo: { getById(id: number): Promise<MemoryModelRow | null> },
  listModels: () => Promise<MemoryModelRow[]>,
): Promise<MemoryModelContext | null> {
  for (const id of await listModelCandidateIds(listModels)) {
    const model = await modelRepo.getById(id);
    if (!model || !model.enabled) {
      continue;
    }
    const provider = await providerRepo.getRuntimeInfo(model.providerId);
    if (provider) {
      return { ...provider, modelId: model.modelId };
    }
  }
  return null;
}

export interface CompileMemoryOptions {
  currentMemory: string;
  material: string;
  instructionMode: boolean;
  model: MemoryModelContext;
  modelText?: ModelTextFn;
  signal?: AbortSignal;
}

/** 执行一次记忆整理/指令应用；失败 throw，输出非法 throw */
export async function compileMemory(
  opts: CompileMemoryOptions,
): Promise<string> {
  const modelText: ModelTextFn =
    opts.modelText ??
    (async (system, prompt, signal) => {
      const result = await generateText({
        model: createLanguageModel(opts.model, opts.model.modelId),
        system,
        prompt,
        abortSignal: signal,
      });
      return result.text;
    });
  const prompt = opts.instructionMode
    ? buildInstructionUserPrompt(opts.currentMemory, opts.material)
    : buildCompileUserPrompt(opts.currentMemory, opts.material);
  const raw = await modelText(
    MEMORY_COMPILER_SYSTEM_PROMPT,
    prompt,
    opts.signal,
  );
  const validated = validateMemoryOutput(raw);
  if (validated === null) {
    Log.warn("记忆整理输出无法解析", (raw ?? "").slice(0, 200));
    throw new Error("MEMORY_COMPILE_FAILED");
  }
  return validated;
}
