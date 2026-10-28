// src-react/domains/ai/chat/lib/typing-reveal.ts
/**
 * 流式吐字平滑纯函数（WorkBuddy streaming-text/buffer-core 移植，
 * 调研 2026-10-10）：网络 chunk 忽快忽慢（突发大块/长停顿）直蹦观感差，
 * 显示层改为 rAF 每帧按 EMA 平滑吐 1-6 字符，落后 ≤2 一次性收尾。
 * 纯函数无副作用，hook 驱动见 hooks/use-typing-reveal.ts。
 */

export interface TypingRevealConfig {
  /** 目标吐字间隔（ms，rAF 帧率的节流目标） */
  targetIntervalMs: number;
  /** 每帧吐字数 = floor(emaLag / speedDivisor) */
  speedDivisor: number;
  minCharsPerTick: number;
  maxCharsPerTick: number;
  /** emaLag 增大加速度 / 减小衰减系数（非对称） */
  accelFactor: number;
  decelFactor: number;
  /** 落后 ≤ 此值一次性吐完（衔接收尾不拖尾） */
  fastDrainThreshold: number;
}

export const TYPING_REVEAL_CONFIG: TypingRevealConfig = {
  targetIntervalMs: 40,
  speedDivisor: 24,
  minCharsPerTick: 1,
  maxCharsPerTick: 6,
  accelFactor: 0.3,
  decelFactor: 0.1,
  fastDrainThreshold: 2,
};

export interface TypingRevealState {
  /** 已显示长度（code unit） */
  displayLength: number;
  /** 落后量的指数移动平均（平滑吐字速度） */
  emaLag: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 避免把一个 emoji 的代理对从中间切断。
 * 若切点落在高位代理（0xD800–0xDBFF）之后：
 * - 后面已有低位代理 → 顺延 1，把整对纳入；
 * - 后面还没产出（正处于流式边界）→ 回退 1，宁可少显示一个字符，
 *   也不吐出孤立高位代理。
 */
export function avoidSurrogateSplit(text: string, length: number): number {
  const clamped = clamp(length, 0, text.length);
  if (clamped <= 0) {
    return 0;
  }
  const prevCode = text.charCodeAt(clamped - 1);
  if (!(prevCode >= 0xd800 && prevCode <= 0xdbff)) {
    return clamped;
  }
  const nextCode = clamped < text.length ? text.charCodeAt(clamped) : NaN;
  return nextCode >= 0xdc00 && nextCode <= 0xdfff ? clamped + 1 : clamped - 1;
}

/**
 * 计算下一帧应显示的长度。纯函数：给定当前状态 + 目标长度/文本，返回新状态。
 * 规则：
 * 1. lag <= 0（目标未增长/已追上）：不推进，emaLag 向 0 衰减。
 * 2. lag <= fastDrainThreshold：一次性吐完剩余。
 * 3. 否则按非对称 EMA 更新 emaLag（增大用 accel、减小用 decel），
 *    每帧吐 clamp(floor(emaLag / speedDivisor), min, max) 个字符。
 * 4. 结果做代理对保护。
 */
export function advanceReveal(
  state: TypingRevealState,
  targetLength: number,
  targetText: string,
  config: TypingRevealConfig,
): TypingRevealState {
  const lag = targetLength - state.displayLength;
  if (lag <= 0) {
    return {
      displayLength: Math.min(state.displayLength, targetLength),
      emaLag: state.emaLag * (1 - config.decelFactor),
    };
  }
  if (lag <= config.fastDrainThreshold) {
    return { displayLength: targetLength, emaLag: 0 };
  }
  const factor = lag > state.emaLag ? config.accelFactor : config.decelFactor;
  const nextEmaLag = state.emaLag + (lag - state.emaLag) * factor;
  const step = clamp(
    Math.floor(nextEmaLag / config.speedDivisor),
    config.minCharsPerTick,
    config.maxCharsPerTick,
  );
  const safeNext = avoidSurrogateSplit(
    targetText,
    Math.min(state.displayLength + step, targetLength),
  );
  return {
    displayLength: Math.max(
      state.displayLength,
      Math.min(safeNext, targetLength),
    ),
    emaLag: nextEmaLag,
  };
}
