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
  buildMemoryMarkdown,
  hasMemoryHeadings,
  parseMemoryMarkdown,
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

// 修订 2026-09-10 验收反馈「去流水账」：画像式提炼 + 淘汰一次性内容 + 各节条数上限
export const MEMORY_COMPILER_SYSTEM_PROMPT = [
  "你是用户画像管理器，不是事件记录器。维护一份精炼、聚焦的用户画像，供 AI 在后续对话中更好地服务用户。",
  "",
  "分类（标题精确使用、顺序固定）：",
  "## 工作背景 —— 用户的职业、技能领域、参与的项目与角色（每条一个主题）",
  "## 个人背景 —— 稳定的个人属性：所在地、语言、工作风格偏好、长期兴趣（仅用户主动分享的非敏感信息）",
  "## 当前关注 —— 用户当下聚焦的主题与目标（主题式，不是事件流水）",
  "## 近期动态 —— 有分水岭意义的进展与变化（里程碑，不是日常操作）",
  "",
  "提炼原则：",
  "1. 画像式而非流水账：同主题信息合并为一条；「连续多日做 X」提炼为「当前专注 X」",
  "2. 淘汰无长期价值的内容：一次性问题（临时查询、天气）、寒暄、与用户画像无关的讨论、已结束且无后续影响的事务",
  "3. 宁少而精：工作背景 ≤8 条、个人背景 ≤8 条、当前关注 ≤5 条、近期动态 ≤10 条（超出时保留更新、更重要的）",
  "4. 与旧记忆合并：仍然有效的保留（可改写得更精炼），过时的删除，冲突的以新材料为准",
  "5. 用户指令只影响指令提到的内容，其余按上述原则维护",
  "",
  "格式：",
  "- 条目每行一条，格式 [YYYY-MM-DD] - 条目内容，日期未知可省略；近期动态按日期倒序（新的在上）",
  "- 单条 ≤500 字，总长 ≤8000 字",
  "- 只输出 markdown 本体，不要解释，不要代码块围栏",
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

/**
 * 标题变体修复：模型常见偏差（`## **工作背景**`、`## 工作背景 —— 说明`、
 * `### 标题`、`##标题`）统一重写为标准标题行；标题词延续（如
 * 「工作背景补充」）不满足后缀约束，不误伤
 */
const HEADING_VARIANT =
  /^#{2,}\s*[*_]{0,2}(工作背景|个人背景|当前关注|近期动态)[*_]{0,2}(?:\s*$|\s*[—–-].*)$/;

function normalizeHeadingLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = HEADING_VARIANT.exec(line.trim());
      return m ? `## ${m[1]}` : line;
    })
    .join("\n");
}

/**
 * 校验 AI 输出（I2 放宽修订 2026-09-21）：剥围栏 + 标题变体修复后，
 * 含任一四节标题即合格——归一化固定节序、丢弃节外杂散；消费端
 * parseMemoryMarkdown 本就缺节容错（缺节空串），原「四标题字面齐备」
 * 校验致模型省略空节（如近期无里程碑）时整轮作废并 10 分钟无限重试。
 * 空输出/无任何标题 → null
 */
export function validateMemoryOutput(raw: string): string | null {
  const text = normalizeHeadingLines(stripCodeFence(raw ?? ""));
  if (text === "" || !hasMemoryHeadings(text)) {
    return null;
  }
  const normalized = buildMemoryMarkdown(parseMemoryMarkdown(text));
  return normalized === ""
    ? null
    : truncateMemoryMarkdown(normalized, MEMORY_PROFILE_LIMIT);
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
      // 全局画像只消化普通会话：项目动态流（projectId 非空）不进夜间记忆
      where: { archivedAt: null, projectId: null },
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
    // P2 遍历面核查：只取用户空间——资产空间（projectId 非空）的
    // defaultModelId 恒空，显式过滤防未来语义漂移
    where: { projectId: null },
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
    // 诊断随异常透出（memoryLastError 限长 200，摘要取 100 字）
    throw new Error(
      `MEMORY_COMPILE_FAILED（模型输出为空或无任何记忆标题，前 100 字：${(raw ?? "").slice(0, 100)}）`,
    );
  }
  return validated;
}
