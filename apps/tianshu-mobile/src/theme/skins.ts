/**
 * 精选皮肤元数据（涟漪/海空/暖沙/墨韵）——纯数据模块，壁纸 require 在
 * skins-assets.ts（UI 层专用，node 单测勿导入，jpg 无法进 node 环境）。
 *
 * 三元组（hue/mode）与桌面 apps/tianshu-desktop src-react/domains/
 * app-settings/model/skins.ts 逐项对齐（两端同步纪律见 colors.ts 头注释），
 * 桌面调整皮肤定义时本表同步改（skins.test.ts 有钉子表）。
 *
 * scrim 为消息区纱层色：基调取桌面 skins.css 各皮肤 body overlay 渐变中段
 * （浅色系叠白/墨韵叠黑），移动端单值平铺不做渐变。
 */
import type { ThemeName } from "./colors";

export type SkinId = "ripple" | "ocean-sky" | "warm-sand" | "ink";

export type SkinMode = "light" | "dark";

export interface SkinDef {
  id: SkinId;
  /** 皮肤名 i18n key 段（settings 命名空间，zh/en 同步） */
  labelKey: string;
  /** 色相（复用 hue preset 四套之一） */
  hue: ThemeName;
  /** 皮肤携带明暗（选皮肤时覆写明暗档一次，随后仍可手动改） */
  mode: SkinMode;
  /** 消息区纱层色（壁纸之上、内容之下） */
  scrim: string;
}

export const SKINS: readonly SkinDef[] = [
  {
    id: "ripple",
    labelKey: "skinRipple",
    hue: "orange",
    mode: "light",
    scrim: "hsla(178, 22%, 98%, 0.55)",
  },
  {
    id: "ocean-sky",
    labelKey: "skinOceanSky",
    hue: "blue",
    mode: "light",
    scrim: "hsla(203, 32%, 98%, 0.52)",
  },
  {
    id: "warm-sand",
    labelKey: "skinWarmSand",
    hue: "orange",
    mode: "light",
    scrim: "hsla(36, 38%, 98%, 0.55)",
  },
  {
    id: "ink",
    labelKey: "skinInk",
    hue: "blue",
    mode: "dark",
    scrim: "hsla(222, 16%, 7%, 0.6)",
  },
];

/** 按 id 查皮肤；未知 id（含桌面其余六款）返回 undefined */
export function getSkin(id: string): SkinDef | undefined {
  return SKINS.find((skin) => skin.id === id);
}

/** 合法皮肤 id 校验（恢复档防注入：未知值一律回落纯色路径） */
export function isSkinId(value: unknown): value is SkinId {
  return (
    typeof value === "string" && SKINS.some((skin) => skin.id === value)
  );
}
