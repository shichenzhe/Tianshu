/**
 * 会话「转办」交接摘要（三期批 12）：读整个会话消息 → 调模型生成五段式
 * 交接文档 markdown。结构照 memory-compiler 同构模式——ModelTextFn 注入
 * 可测试覆写、prompt/清洗纯函数、模型候选序解析；不走 runChatStream
 * （一次性补全不落库不污染会话历史，polishText/titleModelText 同款先例）。
 * 错误以中文文案抛出（Electron invoke 拒绝仅保留 message，前端 toast 直显）
 */
import { generateText } from "ai";

import { parseBlocks } from "./blocks";
import { createLanguageModel } from "../provider/provider-factory";
import { stripCodeFence } from "../../../../src-react/domains/app-settings/model/memory-markdown";

/** 五段固定结构（标题精确、顺序固定）；摘要内容语言跟随对话 */
export const HANDOVER_SYSTEM_PROMPT = [
  "你是工作交接助手。把一段项目工作对话整理成一份交接文档，让接手的人可以无缝继续这项工作。",
  "",
  "输出以下五段（标题精确使用、顺序固定，每段以要点列出，宁精勿滥）：",
  "## 工作目标 —— 这段工作要达成什么",
  "## 关键结论 —— 已经得出的结论、敲定的方案与确认的事实",
  "## 复刻建议 —— 接手者如何快速接续；已做出的决策可放心沿用，不必重新讨论",
  "## 当前状态 —— 进行到哪一步、下一步待办、有无阻塞",
  "## 交付物 —— 对话中产出的文件/文档/代码等（无则写「无」）",
  "",
  "格式：只输出 markdown 本体，不要解释，不要代码块围栏；摘要内容语言跟随对话语言。",
].join("\n");

/** 消息行最小面（prisma.message 查询结果可直接满足） */
export interface HandoverMessageRow {
  role: string;
  blocks: string;
}

/** 单行 → 「用户：/助手：+ 文本块拼接」（口径同 memory-compiler 读对话） */
export function handoverRowToLine(row: HandoverMessageRow): string {
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

/** 材料字符上限：超长会话保尾部最新内容（整行丢弃最旧，同记忆管线口径） */
const HANDOVER_MATERIAL_LIMIT = 30000;

/** 从尾端累积不超限的行（保最新） */
function keepTailLines(lines: string[], charLimit: number): string {
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (size + lines[i].length > charLimit) {
      break;
    }
    kept.unshift(lines[i]);
    size += lines[i].length;
  }
  return kept.join("\n");
}

/** 会话消息 → 交接 user prompt（纯函数；空会话产出「（无对话内容）」占位） */
export function buildHandoverUserPrompt(rows: HandoverMessageRow[]): string {
  const material = keepTailLines(
    rows.map(handoverRowToLine).filter((line) => line !== ""),
    HANDOVER_MATERIAL_LIMIT,
  );
  return [
    "以下是待交接的工作对话（按时间顺序，可能已截断保留最新部分）：",
    material || "（无对话内容）",
    "",
    "请按系统指令整理为交接文档。",
  ].join("\n");
}

/** 输出清洗：剥代码围栏 + trim；空输出 → null（调用方报明确错误） */
export function validateHandoverOutput(raw: string): string | null {
  const text = stripCodeFence(raw ?? "").trim();
  return text === "" ? null : text;
}

/** 模型行/provider 行最小查询面（prisma 可直接满足） */
export interface HandoverModelRow {
  id: number;
  providerId: number;
  modelId: string;
  enabled: boolean;
}

export interface HandoverProviderRow {
  type: string;
  baseUrl: string;
  apiKey?: string | null;
  extraHeaders?: string | null;
  enabled: boolean;
}

/** createLanguageModel 入参形态（memory-compiler MemoryModelContext 同构） */
export interface HandoverModelContext {
  type: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: string | null;
  modelId: string;
}

/** prisma 最小查询面（workspace/model/provider；测试可注入 stub） */
export interface HandoverPrismaLike {
  workspace: {
    findMany(args: unknown): Promise<Array<{ defaultModelId: number | null }>>;
  };
  model: { findMany(args: unknown): Promise<HandoverModelRow[]> };
  provider: {
    findUnique(args: unknown): Promise<HandoverProviderRow | null>;
  };
  message: {
    findMany(args: unknown): Promise<HandoverMessageRow[]>;
  };
}

/**
 * 模型解析：会话当前模型优先，回落用户空间默认 → 任意启用模型
 * （候选序同 memory-compiler，去掉设置页记忆模型强指定——那是记忆专属；
 * 禁用模型/禁用服务商自然跳过）。无可可用模型 → null
 */
export async function resolveHandoverModel(
  prismaLike: HandoverPrismaLike,
  currentModelId: number | null,
): Promise<HandoverModelContext | null> {
  const [workspaces, enabledModels] = await Promise.all([
    prismaLike.workspace.findMany({
      // 只取用户空间：资产空间（projectId 非空）defaultModelId 恒空
      where: { projectId: null },
      orderBy: { id: "asc" },
      select: { defaultModelId: true },
    }),
    prismaLike.model.findMany({
      where: { enabled: true },
      orderBy: { id: "asc" },
    }),
  ]);
  const enabled = new Set(enabledModels.map((model) => model.id));
  const defaults = workspaces
    .map((workspace) => workspace.defaultModelId)
    .filter((id): id is number => id !== null);
  const candidateIds = [
    ...(currentModelId != null ? [currentModelId] : []),
    ...defaults,
    ...enabledModels.map((model) => model.id),
  ].filter((id) => enabled.has(id));
  for (const id of [...new Set(candidateIds)]) {
    const model = enabledModels.find((row) => row.id === id)!;
    const provider = await prismaLike.provider.findUnique({
      where: { id: model.providerId },
    });
    if (provider?.enabled) {
      return {
        type: provider.type,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey ?? undefined,
        extraHeaders: provider.extraHeaders,
        modelId: model.modelId,
      };
    }
  }
  return null;
}

/** 一次性补全注入面（测试覆写；默认走真实 generateText） */
export type HandoverModelTextFn = (
  system: string,
  prompt: string,
) => Promise<string>;

function defaultModelText(model: HandoverModelContext): HandoverModelTextFn {
  return async (system, prompt) => {
    const result = await generateText({
      model: createLanguageModel(model, model.modelId),
      system,
      prompt,
    });
    return result.text;
  };
}

/**
 * 交接摘要编排：读会话消息 → 拼 prompt → 模型补全 → 清洗输出。
 * 无消息/无模型/输出空 throw 中文错误（前端 toast 直显）；模型调用失败
 * 原样上抛
 */
export async function runHandoverSummary(opts: {
  prismaLike: HandoverPrismaLike;
  sessionId: number;
  /** 会话当前模型 id（调用方已取会话行；null 走默认候选序） */
  currentModelId: number | null;
  modelText?: HandoverModelTextFn;
}): Promise<string> {
  const rows = await opts.prismaLike.message.findMany({
    where: { sessionId: opts.sessionId, role: { in: ["user", "assistant"] } },
    orderBy: { createdAt: "asc" },
  });
  if (!rows.some((row) => handoverRowToLine(row) !== "")) {
    throw new Error("会话暂无消息，无法生成交接摘要");
  }
  const model = await resolveHandoverModel(
    opts.prismaLike,
    opts.currentModelId,
  );
  if (!model) {
    throw new Error("未配置可用模型，请先在服务商设置中配置");
  }
  const modelText = opts.modelText ?? defaultModelText(model);
  const raw = await modelText(
    HANDOVER_SYSTEM_PROMPT,
    buildHandoverUserPrompt(rows),
  );
  const validated = validateHandoverOutput(raw);
  if (validated === null) {
    throw new Error("交接摘要生成失败（模型输出为空）");
  }
  return validated;
}
