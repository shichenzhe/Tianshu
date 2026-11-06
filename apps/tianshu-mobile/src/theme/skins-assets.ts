/**
 * 皮肤壁纸资产装配（UI 层专用）：jpg require 集中于此，纯数据/逻辑留在
 * skins.ts——node 单测（store/skins）不导入本模块（jpg 资产进不了 node
 * 环境，vitest 资产管线产物与 metro require 数字语义不同）。
 * 壁纸仅供聊天会话屏与设置页缩略预览消费。
 */
import type { ImageSourcePropType } from "react-native";

import { useThemeStore } from "../store/theme";
import ink from "../../assets/skins/ink.jpg";
import oceanSky from "../../assets/skins/ocean-sky.jpg";
import ripple from "../../assets/skins/ripple.jpg";
import warmSand from "../../assets/skins/warm-sand.jpg";
import { getSkin, type SkinId } from "./skins";

// metro 资产通道支持 import 形态（与 require 等价，返回 asset 模块）；
// node 单测不加载真图——skins-assets.test.ts 以 vi.mock 拦四张 jpg
// （require 形态绕过 vitest mock 图直载二进制，故用 import）
export const SKIN_WALLPAPERS: Record<SkinId, ImageSourcePropType> = {
  ripple,
  "ocean-sky": oceanSky,
  "warm-sand": warmSand,
  ink,
};

export interface SkinWallpaper {
  source: ImageSourcePropType;
  /** 消息区纱层色（壁纸之上、内容之下，随皮肤） */
  scrim: string;
}

/** 深色档兜底黑纱：皮肤自带纱随皮肤明暗设计（浅色系=白纱），但明暗档
 *  可被用户手动改暗（皮肤只覆写一次）——深色档下浅色壁纸叠白纱会压浅字，
 *  统一换黑纱保可读（色值对齐墨韵纱基调） */
export const DARK_SCRIM = "hsla(222, 16%, 7%, 0.62)";

/** 壁纸纱层按当前明暗档取值：浅色档用皮肤纱，深色档统一黑纱 */
export function resolveWallpaperScrim(
  skinScrim: string,
  scheme: "light" | "dark",
): string {
  return scheme === "dark" ? DARK_SCRIM : skinScrim;
}

/** 皮肤 → 壁纸 + 纱层；null（纯色主题）/未知 id → null（调用方走纯色底） */
export function resolveSkinWallpaper(
  skinId: SkinId | null,
): SkinWallpaper | null {
  if (!skinId) return null;
  const skin = getSkin(skinId);
  if (!skin) return null;
  return { source: SKIN_WALLPAPERS[skin.id], scrim: skin.scrim };
}

/** 生效皮肤壁纸（hook 形态，组件消费） */
export function useSkinWallpaper(): SkinWallpaper | null {
  const skinId = useThemeStore((state) => state.skinId);
  return resolveSkinWallpaper(skinId);
}
