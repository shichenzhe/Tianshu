/**
 * 跨 AI 导入预置提示词（spec D2：四分类输出，与记忆 markdown 格式一致）。
 * 前端持有，主进程不依赖。EN 版说明文字为英文，但四个分类标题保留中文
 * 原文——与 memory-markdown.ts 解析器的精确标题匹配。
 */
export type ImportPromptLocale = "zh-CN" | "en-US";

const ZH_PROMPT = `请帮我整理一份我的个人使用画像，用途是让我在不同 AI 工具之间保持一致的协作体验。请基于你当前能访问到的、与我相关的长期信息和本次会话上下文进行整理。在涉及我的指令和偏好时，请尽量保留我原本的表述方式，不要过度改写。

分类（按以下顺序输出，标题精确使用）
## 工作背景
我的职业、所在团队、参与的项目及关键决策。仅包含实际参与的内容，每行一条。

## 个人背景
所在地、语言能力、个人兴趣等（仅包含我主动分享过的非敏感信息，不输出证件号、联系方式、账号等隐私数据）。

## 当前关注
我近期的主要关注点和正在推进的事项。

## 近期动态
最近发生的事件与变化，每行一条。

格式
使用上述分类标题作为节标题。每个类别内每行一条记录，按日期从早到晚排列。每行格式：

[YYYY-MM-DD] - 条目内容

如果日期未知，省略日期前缀。

输出
将整个画像包裹在一个代码块中，方便我复制。代码块之后简要说明覆盖度。`;

const EN_PROMPT = `Please compile a personal usage profile of me so that I can keep a consistent collaboration experience across different AI tools. Base it on the long-term information about me that you currently have access to, plus the context of this session. When it comes to my instructions and preferences, please preserve my original wording as much as possible instead of rewriting it.

Categories (output in this exact order, using these exact headings)
## 工作背景
My profession, my team, the projects I take part in, and key decisions. Only include things I actually participated in, one entry per line.

## 个人背景
Location, language abilities, personal interests, etc. (only non-sensitive information I have shared voluntarily; do not output private data such as ID numbers, contact details, or account credentials).

## 当前关注
My main recent focuses and the things I am currently working on.

## 近期动态
Recently happened events and changes, one entry per line.

Format
Use the category headings above as section headings. Within each category, one record per line, ordered by date from earliest to latest. Each line follows this format:

[YYYY-MM-DD] - entry content

If the date is unknown, omit the date prefix.

Output
Wrap the entire profile in a code block so that I can copy it easily. After the code block, briefly describe the coverage.`;

export function getImportPrompt(locale: ImportPromptLocale): string {
  return locale === "zh-CN" ? ZH_PROMPT : EN_PROMPT;
}
