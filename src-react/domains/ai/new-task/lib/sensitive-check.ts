/** 发送前敏感词预检（新建任务 spec §6）：本地词表，命中禁发并提示；
 *  词表内容为运营配置，此处为机制 + 可替换占位词 */
const SENSITIVE_WORDS: readonly string[] = ["示例违禁词A", "示例违禁词B"];

export function checkSensitive(text: string): string | null {
  const normalized = text.toLowerCase();
  for (const word of SENSITIVE_WORDS) {
    if (normalized.includes(word.toLowerCase())) {
      return word;
    }
  }
  return null;
}
