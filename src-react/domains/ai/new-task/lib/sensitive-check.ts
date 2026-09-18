/** 发送前敏感词预检（新建任务 spec §6）：本地词表，命中禁发并提示；
 *  词表为内置基础通用档（高置信违法黑话/短语，子串匹配下尽量选组合词
 *  降低正常讨论误伤），按类别分组，运营可按需增删维护：
 *  - 暴力恐怖：爆炸物制作与枪支交易
 *  - 毒品：常见硬毒品名
 *  - 赌博：私彩/赌球类
 *  - 诈骗洗钱：黑产渠道类
 *  - 色情：招嫖类 */
const SENSITIVE_WORDS: readonly string[] = [
  // 暴力恐怖
  "制作炸弹",
  "爆炸装置",
  "枪支买卖",
  "购买枪支",
  // 毒品
  "冰毒",
  "海洛因",
  "摇头丸",
  // 赌博
  "赌球",
  "六合彩",
  "时时彩",
  "私彩",
  // 诈骗洗钱
  "洗钱渠道",
  "银行卡四件套",
  "办假证",
  "刷单返利",
  // 色情
  "招嫖",
  "嫖娼",
  "色情服务",
];

export function checkSensitive(text: string): string | null {
  const normalized = text.toLowerCase();
  for (const word of SENSITIVE_WORDS) {
    if (normalized.includes(word.toLowerCase())) {
      return word;
    }
  }
  return null;
}
