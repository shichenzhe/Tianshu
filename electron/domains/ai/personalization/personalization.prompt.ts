/**
 * 个性化 system prompt 拼接（spec §4.2，纯函数）：
 * 段序 persona → baseSystem → 风格 → 身份 → 记忆 → 指令；"\n\n" 连接，
 * 空段跳过。缓存友好约束（spec §4.6/D3）：同 config → 逐字节相同输出，
 * 段内禁止任何时间戳/随机数/会话相关内容。
 */
import type {
  PersonalizationConfig,
  ResponseStyle,
} from "./personalization.config";

/** 风格 → 注入文案（spec §4.3 定稿；default 不在表 = 跳过风格段） */
export const STYLE_PROMPTS: Record<
  Exclude<ResponseStyle, "default">,
  string
> = {
  professional:
    "以专业严谨的风格回答：使用书面化、逻辑性强的表达，避免口语化和表情符号；复杂内容用编号列表组织；表述清晰、准确、值得信赖。",
  friendly:
    "以亲和友善的风格回答：语气温暖、平易近人，适当使用 emoji，多用「没问题」「别担心」这类情感连接词，多给予正向反馈和鼓励。",
  direct:
    "以直言不讳的风格回答：省略寒暄与客套话，直接给出核心答案；段落尽量精短；不要使用「好的，为您查询到…」之类的过渡语。",
  imaginative:
    "以天马行空的风格回答：富有想象力，解释复杂概念时主动使用比喻和类比；语言更具文学性和创造性，尤其适合创意类任务。",
  pragmatic:
    "以高效务实的风格回答：极致压缩文字，仅保留关键数据、代码或结论；去除所有修饰性形容词，追求最大信息密度。",
  snarky:
    "以毒舌吐槽的风格回答：可以幽默地调侃、反讽，模拟「损友」人设，但在关键信息上必须保持准确，绝不真正贬低或伤害用户。",
  socratic:
    "以启发引导的风格回答：不直接给出最终答案，而是通过苏格拉底式提问引导用户自己思考并得出结论，适合学习与辅导场景。",
};

/** 身份段句子（spec §4.2：默认名/空值不注入；两句皆无 → 整段跳过） */
function identityLines(config: PersonalizationConfig): string[] {
  const lines: string[] = [];
  const aiName = config.aiName.trim();
  if (aiName !== "" && aiName !== "天枢") {
    lines.push(`你的名字是「${config.aiName}」，对话中以此自称。`);
  }
  if (config.userNickname.trim() !== "") {
    lines.push(`称呼用户为「${config.userNickname}」。`);
  }
  return lines;
}

/** baseSystem 前后的个性化段（persona 前置，行为段后置） */
function personalSegments(
  config: PersonalizationConfig,
  baseSystem: string | undefined,
): string[] {
  const segments: string[] = [];
  if (config.persona.trim() !== "") {
    segments.push(config.persona);
  }
  if (baseSystem) {
    segments.push(baseSystem);
  }
  const stylePrompt =
    config.responseStyle === "default"
      ? undefined
      : STYLE_PROMPTS[config.responseStyle];
  if (stylePrompt) {
    segments.push(`【回复风格】\n${stylePrompt}`);
  }
  const identity = identityLines(config);
  if (identity.length > 0) {
    segments.push(`【身份】\n${identity.join("\n")}`);
  }
  if (config.memory.trim() !== "") {
    segments.push(
      `【用户长期记忆】\n以下是用户希望你长期记住的信息，请在对话中遵循：\n${config.memory}`,
    );
  }
  if (config.customInstructions.trim() !== "") {
    segments.push(
      `【用户自定义指令】\n用户设定的全局规则，必须遵守：\n${config.customInstructions}`,
    );
  }
  return segments;
}

/**
 * 全默认 → 原样返回 baseSystem（D8 回归保证）；baseSystem 可能 undefined。
 * 无任何段时不返回 ""而返回 undefined——AI SDK 仅对 undefined 省略 system
 * 消息，"" 会在协议层发出空 system（anthropic/gemini 等会拒绝）。
 */
export function buildPersonalizedSystem(
  config: PersonalizationConfig,
  baseSystem: string | undefined,
): string | undefined {
  const segments = personalSegments(config, baseSystem);
  return segments.length > 0 ? segments.join("\n\n") : undefined;
}
