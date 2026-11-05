/**
 * 记忆注入预算治理（P6，批9 2026-11-05）：persona(4000)+memory(1500)+
 * memoryProfile(8000)+customInstructions(1500) 全量进 system 对小窗口
 * 模型挤占历史——超预算按段优先级裁剪。纯函数、三端单源（桌面
 * assembleContext 消费；预算内逐字节不变，前缀缓存友好）。
 *
 * 段保留优先序（高 → 低）：customInstructions > memory（手动记忆） >
 * 工作背景/个人背景 > 当前关注 > 近期动态——超预算时从最低优先级起裁。
 * persona 是用户亲自撰写的人设，不在裁剪序内（恒保留，先占预算）。
 */
import { estimateTokens } from "./history-truncate";
import type { PersonalizationConfig } from "./personalization-config";

/** 记忆段预算占上下文窗口比例（131072 窗口 → ~15.7K token，覆盖
 *  四段全量上限 15K 字符 ≈ 7.5K token 仍不裁——大窗口行为与批前一致） */
export const MEMORY_BUDGET_RATIO = 0.12;

/** 小窗口保底预算：8K/16K 模型也至少留 2048 token 给记忆段 */
export const MEMORY_BUDGET_MIN_TOKENS = 2048;

/**
 * 记忆段 token 预算：窗口未知/无效 → Infinity（不裁剪——与批前
 * 「全量注入」行为一致，测试与降级路径不受影响）
 */
export function personalizationBudgetTokens(
  contextWindow: number | null | undefined,
): number {
  if (!contextWindow || contextWindow <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    MEMORY_BUDGET_MIN_TOKENS,
    Math.floor(contextWindow * MEMORY_BUDGET_RATIO),
  );
}

/** 四节标题（与桌面 memory-markdown MEMORY_SECTION_DEFS 同序；core
 *  不反向依赖桌面 src-react，标题字面量内联单源） */
const SECTION_TITLES = [
  "工作背景",
  "个人背景",
  "当前关注",
  "近期动态",
] as const;

/** 裁剪序（先裁低优先级）：近期动态 → 当前关注 → 个人背景 → 工作背景 */
const SECTION_TRIM_ORDER = [
  "近期动态",
  "当前关注",
  "个人背景",
  "工作背景",
] as const;

interface ProfileLine {
  text: string;
  /** 所属节标题；null = 标题行/节外内容（不可裁） */
  section: string | null;
  isHeading: boolean;
}

/** 画像按行归类（节标题行标记 isHeading；无标题画像整体视作工作背景） */
function classifyProfileLines(profile: string): ProfileLine[] {
  const lines = profile.split("\n");
  let current: string | null =
    lines.length > 0 && hasAnyHeading(lines) ? null : "工作背景";
  return lines.map((text) => {
    const heading = SECTION_TITLES.find(
      (title) => text.trim() === `## ${title}`,
    );
    if (heading) {
      current = heading;
      return { text, section: null, isHeading: true };
    }
    return { text, section: current, isHeading: false };
  });
}

function hasAnyHeading(lines: string[]): boolean {
  return lines.some((line) =>
    SECTION_TITLES.some((title) => line.trim() === `## ${title}`),
  );
}

function rebuildProfile(lines: ProfileLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

/**
 * 画像裁剪到预算内（纯函数）：预算内原样返回（逐字节稳定）；超预算从
 * 裁剪序最前的节起逐行丢弃——近期动态按日期倒序（新的在上）从节尾丢
 * （节尾=最旧），其余节按追加序（尾部为最新内容，与 truncateMemoryMarkdown
 * 保尾语义一致）从节头丢；节内容清空后标题行一并移除；全部裁完 → 空串
 */
export function trimProfileToBudget(
  profile: string,
  budgetTokens: number,
): string {
  if (profile === "" || estimateTokens(profile) <= budgetTokens) {
    return profile;
  }
  const lines = classifyProfileLines(profile);
  // 逐行丢弃循环：每轮找裁剪序内仍有内容行的最前节，按该节丢弃向丢一行
  for (;;) {
    if (estimateTokens(rebuildProfile(lines)) <= budgetTokens) {
      return rebuildProfile(lines);
    }
    let removed = false;
    for (const title of SECTION_TRIM_ORDER) {
      const contentIdx = lines.findIndex(
        (line) => !line.isHeading && line.section === title,
      );
      const lastIdx = findLastIndex(
        lines,
        (line) => !line.isHeading && line.section === title,
      );
      if (lastIdx === -1) {
        continue;
      }
      // 近期动态（倒序新在上）丢节尾最旧；其余节（追加序新在尾）丢节头最旧
      const dropIdx = title === "近期动态" ? lastIdx : contentIdx;
      lines.splice(dropIdx, 1);
      removed = true;
      // 节内容清空 → 孤立标题一并移除（不留空节壳）
      if (
        !lines.some((line) => !line.isHeading && line.section === title) &&
        title !== "工作背景"
      ) {
        const headingIdx = lines.findIndex(
          (line) => line.isHeading && line.text.trim() === `## ${title}`,
        );
        if (headingIdx !== -1) {
          lines.splice(headingIdx, 1);
        }
      }
      break;
    }
    if (!removed) {
      // 只剩不可裁行（标题/节外）仍超预算 → 整体放弃
      return "";
    }
  }
}

/** ES2022 兼容 findLastIndex */
function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) {
      return i;
    }
  }
  return -1;
}

/**
 * 整配置级预算应用（assembleContext 消费）：persona/memory/
 * customInstructions 按优先序先占预算（自身不裁——各限长 4000/1500/1500
 * 上限可控），画像只用余量；画像裁剪无变化时返回原对象（引用稳定）
 */
export function trimPersonalizationForBudget(
  config: PersonalizationConfig,
  contextWindow: number | null | undefined,
): PersonalizationConfig {
  const budget = personalizationBudgetTokens(contextWindow);
  if (!Number.isFinite(budget)) {
    return config;
  }
  const fixed =
    estimateTokens(config.persona) +
    estimateTokens(config.memory) +
    estimateTokens(config.customInstructions);
  const profileBudget = budget - fixed;
  const trimmed =
    profileBudget <= 0
      ? ""
      : trimProfileToBudget(config.memoryProfile, profileBudget);
  return trimmed === config.memoryProfile
    ? config
    : { ...config, memoryProfile: trimmed };
}
