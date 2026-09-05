/**
 * 伪工具调用碎片检测：本地推理服务未实现结构化 tool_calls 时，
 * 模型把 Qwen 工具语法（<tool_call> 字面量 / <| 特殊 token）直接写进正文。
 * 命中的 text 块不按正文渲染，收进警示折叠区（issue: DB message #68 复现）
 */

/** 命中阈值：<tool_call> 字面量至少出现次数（1 次可能是讨论语法的正常输出） */
const TOOL_CALL_TAG_MIN = 2;
const TOOL_CALL_TAG = "<tool_call>";
/** 分词器特殊 token 前缀，正常文本不应出现 */
const SPECIAL_TOKEN = "<|";

export function detectPseudoToolCallText(text: string): boolean {
  if (!text) {
    return false;
  }
  let count = 0;
  let index = text.indexOf(TOOL_CALL_TAG);
  while (index !== -1) {
    count += 1;
    if (count >= TOOL_CALL_TAG_MIN) {
      return true;
    }
    index = text.indexOf(TOOL_CALL_TAG, index + TOOL_CALL_TAG.length);
  }
  return text.includes(SPECIAL_TOKEN);
}
