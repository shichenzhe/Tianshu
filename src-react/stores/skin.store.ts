/**
 * 皮肤状态管理（外观模块）
 *
 * 皮肤 = { mode（明暗）× hue（色相）× wallpaper（装饰）} 三元组，由
 * documentElement 三属性 data-mode / data-theme / data-wallpaper 驱动
 * （skins.css + globals.css 消费）：
 * - setSkin：皮肤是完整预设——写全三元组（含皮肤自带 hue，覆盖当前 hue）
 * - setHue：正交微调——保持皮肤 mode/wallpaper，仅换 data-theme
 * 两者独立可叠加，最后写入者生效。
 *
 * 持久化沿用旧主题 key "tianshu-theme"：结构 { skin, hue }（version 1）；
 * 旧版 { theme } 由 sanitizePersisted 归一迁移（读 legacy theme 字段映射 hue）。
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getSkin, type SkinDef } from "@/domains/app-settings/model/skins";

export type ThemeType = "blue" | "red" | "green" | "orange";
export type SkinMode = "light" | "dark";

const DEFAULT_SKIN = "light";
const DEFAULT_HUE: ThemeType = "orange"; // 沿用现状默认橙色
const STORAGE_KEY = "tianshu-theme";
const HUES: readonly ThemeType[] = ["blue", "red", "green", "orange"];

/** 持久化形状（version 1）；version 0 旧结构多一个 theme 字段 */
type PersistedSkin = { skin?: string; hue?: string; theme?: string };

/** 未知皮肤 id 告警去重（每个 id 只 warn 一次，避免重复切换刷屏） */
const warnedSkins = new Set<string>();

/** 皮肤 id 归一：未知 id（persist 脏数据等）回落 light + 告警（元数据源 skins.ts） */
function resolveSkin(skinId: string): { id: string; attrs: SkinDef } {
  const attrs = getSkin(skinId);
  if (attrs) return { id: skinId, attrs };
  if (!warnedSkins.has(skinId)) {
    warnedSkins.add(skinId);
    console.warn(
      `[skin.store] 未知皮肤 id "${skinId}"，回落 "${DEFAULT_SKIN}"`,
    );
  }
  return { id: DEFAULT_SKIN, attrs: getSkin(DEFAULT_SKIN)! };
}

function isValidHue(value: string | undefined): value is ThemeType {
  return (HUES as readonly string[]).includes(value ?? "");
}

/** 持久化数据归一：未知皮肤回落 light、非法 hue 回落默认（兼容 legacy theme） */
function sanitizePersisted(persisted: unknown): {
  skin: string;
  hue: ThemeType;
} {
  const raw = (persisted ?? {}) as PersistedSkin;
  const skin = getSkin(raw.skin ?? "") ? raw.skin! : DEFAULT_SKIN;
  const hue = isValidHue(raw.hue)
    ? raw.hue
    : isValidHue(raw.theme)
      ? raw.theme
      : DEFAULT_HUE;
  return { skin, hue };
}

export interface SkinState {
  skin: string; // 皮肤 id，缺省 "light"
  hue: ThemeType; // "blue"|"red"|"green"|"orange"，缺省 "orange"
  setSkin: (skinId: string) => void; // 皮肤完整预设：写 skin + 其自带 hue
  setHue: (hue: ThemeType) => void; // 正交：保 mode/wallpaper 只换 data-theme
}

/**
 * 应用皮肤到 DOM——documentElement 三属性一次写入（:root[data-mode=dark]
 * 特异度加固要求属性写在 html 上）
 * 未知 skin 回落 light；hue 原样写 data-theme（与皮肤 mode/wallpaper 正交组合）
 */
export function applySkin(skin: string, hue: string): void {
  const { attrs } = resolveSkin(skin);
  const root = document.documentElement;
  root.setAttribute("data-mode", attrs.mode);
  root.setAttribute("data-theme", hue);
  if (attrs.wallpaper) {
    root.setAttribute("data-wallpaper", attrs.wallpaper);
  } else {
    root.removeAttribute("data-wallpaper");
  }
}

export const useSkinStore = create<SkinState>()(
  persist(
    (set, get) => ({
      skin: DEFAULT_SKIN,
      hue: DEFAULT_HUE,
      setSkin: (skinId) => {
        const { id, attrs } = resolveSkin(skinId);
        set({ skin: id, hue: attrs.hue });
        applySkin(id, attrs.hue);
      },
      setHue: (hue) => {
        set({ hue });
        applySkin(get().skin, hue);
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      partialize: (state) => ({ skin: state.skin, hue: state.hue }),
      // v0 旧 {theme} → 新 {skin,hue}（sanitizePersisted 兼容 legacy 字段）；
      // 缺失此钩子时 zustand 会直接丢弃版本不符的旧数据
      migrate: (persisted) => sanitizePersisted(persisted),
      // 同版本脏数据（未知 skin / 非法 hue）同样归一
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePersisted(persisted),
      }),
    },
  ),
);

/**
 * 启动初始化 - 从 localStorage 读取并应用（persist 水合可能在组件渲染前
 * 未完成，渲染前手动落 DOM 避免首帧闪色）
 */
export function initSkin(): void {
  let persisted: PersistedSkin | null = null;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      persisted = JSON.parse(stored)?.state ?? null;
    } catch {
      persisted = null; // 忽略解析错误，回落默认
    }
  }
  const { skin, hue } = sanitizePersisted(persisted);
  applySkin(skin, hue);
}
