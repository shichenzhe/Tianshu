/**
 * 记忆 AI 管线（spec §5.3）：读近期对话/用户指令 → 调默认模型 →
 * 输出新记忆 markdown。模型调用经 ModelTextFn 注入（测试覆写，
 * 参考 chat.service titleModelText 模式）。无可用模型/无对话材料时
 * 由调用方（scheduler/service）决策跳过。
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { parseBlocks } from "../chat/blocks";
import { aiMessageContentToText } from "../chat/ai-content";
import { formatTimeContext } from "../chat/time-context";
import { createChatModel } from "../orchestration/langchain-model-factory";
import type { ProviderRuntimeInfo } from "../provider/provider-runtime";
import {
  MEMORY_PROFILE_LIMIT,
  buildMemoryMarkdown,
  parseMemoryMarkdown,
  stripCodeFence,
  truncateMemoryMarkdown,
} from "../../../../src-react/domains/app-settings/model/memory-markdown";
import { getAppOptionMap } from "../../app-settings/option-store";
import { PERSONALIZATION_KEYS } from "./personalization.config";

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
// 修订 2026-10-23 次级模型防污染（参照 OpenAI ChatGPT bio 记忆准入判据、
// Anthropic memory tool 指南、mem0 NOT-extract 负面清单；弱模型对具体
// 反例与清单化规则的遵循远好于抽象原则）：
// ① 素材来源限定——画像只从「用户：」内容提炼，助手输出不进画像
// ② 准入二判据 + 精度优先（存疑即丢）；③ 具体负面清单；
// ④ 紧凑判断示例；⑤ 单条上限 500 → 100 字（一条一个事实）
// 修订 2026-10-23b 实测回评补判断层缺口（较强模型仍把当天事件升格为
// 能力、从单次行为脑补习惯、已解决调试进当前关注、跨节重复）：
// ⑥ 频率词禁令；⑦ 技能领域须长期反复；⑧ 当前关注收紧为跨多天；
// ⑨ 操作细节禁区；⑩ 同一事件只记一处
export const MEMORY_COMPILER_SYSTEM_PROMPT = [
  "你是用户画像管理器，不是事件记录器。维护一份精炼、聚焦的用户画像，供 AI 在后续对话中更好地服务用户。",
  "",
  "【素材来源】",
  "画像只从「用户：」开头的内容提炼。「助手：」的消息仅用于理解语境，其中的代码、文档、方案、结论、工具输出一律不进画像（用户明确认可或要求记住的除外）。",
  "",
  "【准入标准】一条信息必须满足其一才可写入：",
  "- 能改变后续对话的回应方式（如偏好、规则、背景）",
  "- 半年后仍有参考价值（如职业、长期项目、里程碑）",
  "存疑时直接丢弃：漏存一条的代价远小于存入一条无用信息。",
  "",
  "【永不写入】",
  "- 临时性内容：一次性问题、临时查询（天气、翻译、单位换算）、当天安排",
  "- 报错调试（含错误码、测试账号名、参数组合等操作细节）；当天已解决的问题不得进入任何一节",
  "- 用户粘贴的材料本身：日志、报错、代码、文件内容（只提炼其反映的稳定偏好）",
  "- 与用户无关的知识：世界常识、第三方技术讲解（无论出自用户还是助手的提问）",
  "- 推测与脑补：「可能」「也许」式的猜测不写；禁止从单次行为推断「日常」「经常」「习惯」等频率——问过一次天气 ≠ 日常关注天气，带过一次孩子 ≠ 日常兼顾家庭",
  "- 敏感信息：证件号、联系方式、账号、密码、密钥",
  "- 寒暄、感谢、对助手表现的评价",
  "",
  "分类（标题精确使用、顺序固定）：",
  "## 工作背景 —— 用户的职业、长期反复从事的技能领域、参与的项目与角色（每条一个主题；单次任务中用过的工具、知识不算技能领域）",
  "## 个人背景 —— 稳定的个人属性：所在地、语言、工作风格偏好、长期兴趣（仅用户明确陈述的非敏感信息）",
  "## 当前关注 —— 跨多天仍在推进的主题与目标（当天开始且当天完成的一次性任务不写；主题式，不是事件流水）",
  "## 近期动态 —— 有分水岭意义的进展与变化（里程碑，不是日常操作）",
  "",
  "提炼原则：",
  "1. 画像式而非流水账：同主题信息合并为一条；「连续多日做 X」提炼为「当前专注 X」",
  "2. 与旧记忆合并：仍然有效的保留（可改写得更精炼），过时的删除，冲突的以新材料为准",
  "3. 用户指令只影响指令提到的内容，其余按上述原则维护",
  "4. 同一事件只记一处：仍在推进写当前关注，已完成写近期动态，不得两节重复",
  "5. 条数上限：工作背景 ≤8 条、个人背景 ≤8 条、当前关注 ≤5 条、近期动态 ≤10 条（超出时保留更新、更重要的）",
  "",
  "【判断示例】（材料 → 判断）",
  "「用户：帮我看看这个报错（附 50 行日志）」→ 不写（临时调试）",
  "「用户：我们后端是 NestJS，示例别用 PHP」→ 工作背景：后端用 NestJS，示例不用 PHP",
  "「助手：（React Suspense 长篇讲解）」→ 不写（助手输出的知识，非用户信息）",
  "「用户：下个月我要搬到深圳了」→ 个人背景：[YYYY-MM-DD] - 计划迁居深圳",
  "「用户：今天厦门天气怎么样」→ 不写（临时查询；不得推断为「日常关注天气」）",
  "「用户：修了一下午 code_permission_denied，搞定了」→ 不写（当天已解决的调试；不得升格为技能或当前关注）",
  "",
  "格式：",
  "- 条目每行一条，格式 [YYYY-MM-DD] - 条目内容，日期未知可省略；近期动态按日期倒序（新的在上）",
  "- 一条一个独立事实，单条 ≤100 字，总长 ≤8000 字",
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
 * 校验 AI 输出（2026-09-21 二次放宽）：剥围栏 + 标题变体修复后，非空即
 * 接受——无任何四节标题时整段进工作背景节（parseMemoryMarkdown 的
 * fallback 语义，与导入粘贴一致）。小模型不守格式时输出仍生效，
 * 质量由下次整理迭代收敛（用户裁决：暂时不管质量）。空输出 → null
 */
export function validateMemoryOutput(raw: string): string | null {
  const text = normalizeHeadingLines(stripCodeFence(raw ?? ""));
  if (text === "") {
    return null;
  }
  return truncateMemoryMarkdown(
    buildMemoryMarkdown(parseMemoryMarkdown(text)),
    MEMORY_PROFILE_LIMIT,
  );
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
    // 倒序限量取最新（keepRecentLines 只保尾部 charLimit 字符，近 N 天
    // 全量读回是白搬——长用户 7 天消息含大 blocks 可达数十 MB）；取回后
    // 翻转回时间正序再拼接。500 条按平均 60 字符/条下限估算仍覆盖
    // 30000 字符预算
    orderBy: { id: "desc" },
    take: 500,
    select: { role: true, blocks: true },
  });
  rows.reverse();
  return keepRecentLines(
    rows.map(rowToLine).filter((line) => line !== ""),
    charLimit,
  );
}

/**
 * 设置页强指定的记忆整理模型 id（option memoryModelId）：空/非正整数 →
 * null（保持既有解析逻辑）；指定但不可用（已删/禁用/服务商缺配置）时由
 * 候选序自然回退，不额外报错
 */
async function preferredMemoryModelId(): Promise<number | null> {
  const map = await getAppOptionMap(prisma.option, [
    PERSONALIZATION_KEYS.memoryModelId,
  ]);
  const raw = map.get(PERSONALIZATION_KEYS.memoryModelId)?.trim() ?? "";
  const id = Number(raw);
  return raw !== "" && Number.isInteger(id) && id > 0 ? id : null;
}

/** 候选模型 id 序：设置页强指定优先，其后 workspace 默认、全部启用模型 */
async function listModelCandidateIds(
  listModels: () => Promise<MemoryModelRow[]>,
): Promise<number[]> {
  const [preferred, workspaces, enabled] = await Promise.all([
    preferredMemoryModelId(),
    prisma.workspace.findMany({
      // P2 遍历面核查：只取用户空间——资产空间（projectId 非空）的
      // defaultModelId 恒空，显式过滤防未来语义漂移
      where: { projectId: null },
      orderBy: { id: "asc" },
      select: { defaultModelId: true },
    }),
    listModels(),
  ]);
  const defaults = workspaces
    .map((w) => w.defaultModelId)
    .filter((id): id is number => id !== null);
  return [
    ...(preferred !== null ? [preferred] : []),
    ...defaults,
    ...enabled.filter((m) => m.enabled).map((m) => m.id),
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
      const chat = createChatModel(opts.model, opts.model.modelId);
      const aiMessage = await chat.invoke(
        [new SystemMessage(system), new HumanMessage(prompt)],
        { signal },
      );
      return aiMessageContentToText(aiMessage.content);
    });
  // prompt 头部注入时间行：条目格式 [YYYY-MM-DD]/近期动态倒序/淘汰
  // 过时内容都需要「今天」基准（模型无时钟，缺基准时只能凭训练期的
  // 静态时间感猜日期）。与 chat 注入同一原则：时间放 user prompt
  //（每请求唯一变化部分），system 保持逐字节稳定（前缀缓存考量见
  // time-context 头注释）
  const prompt = `当前时间：${formatTimeContext(new Date())}\n\n${
    opts.instructionMode
      ? buildInstructionUserPrompt(opts.currentMemory, opts.material)
      : buildCompileUserPrompt(opts.currentMemory, opts.material)
  }`;
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
      `MEMORY_COMPILE_FAILED（模型输出为空，前 100 字：${(raw ?? "").slice(0, 100)}）`,
    );
  }
  return validated;
}
