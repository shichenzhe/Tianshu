/**
 * 字体缩放模型
 * 三档缩放（小/默认/大），以 html 元素 fontSize 驱动全局 rem 布局即时生效；
 * 持久化于 localStorage（key: tianshu-font-scale），缺省 default
 */

export type FontScale = "small" | "default" | "large";

/** 全部合法档位（顺序即滑条刻度顺序） */
export const FONT_SCALES: FontScale[] = ["small", "default", "large"];

const FONT_SCALE_STORAGE_KEY = "tianshu-font-scale";

/** 各档位对应的 html fontSize */
const FONT_SCALE_SIZES: Record<FontScale, string> = {
  small: "14px",
  default: "16px",
  large: "18px",
};

/** 判断字符串是否为合法档位 */
export function isFontScale(value: string): value is FontScale {
  return (FONT_SCALES as string[]).includes(value);
}

/** 读取持久化档位，缺失或非法时回退 default */
export function readFontScale(): FontScale {
  const stored = localStorage.getItem(FONT_SCALE_STORAGE_KEY);
  return stored && isFontScale(stored) ? stored : "default";
}

/** 应用档位：写 localStorage 并即时改 html fontSize */
export function applyFontScale(scale: FontScale): void {
  localStorage.setItem(FONT_SCALE_STORAGE_KEY, scale);
  document.documentElement.style.fontSize = FONT_SCALE_SIZES[scale];
}

/** 启动恢复：按持久化档位初始化（在应用入口调用一次） */
export function initFontScale(): void {
  applyFontScale(readFontScale());
}
