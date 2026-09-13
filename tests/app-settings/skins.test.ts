// @vitest-environment jsdom
/**
 * 皮肤元数据完整性测试（skins.ts 为外观模块权威数据源）：
 * - spec §3.1 十款三元组逐款核对（id/mode/hue/wallpaper 顺序与值）
 * - light/dark 基础款 basic、其余八款 premium；hue/mode 全合法枚举
 * - 双语名称/描述字段非空（spec §5：品牌化内容数据静态双语字段，不走 i18n）
 * - getSkin 查找契约（未知 id → undefined）
 * - 与 skin.store 解析一致性：getSkin 命中 ⇔ store.setSkin 不回落（DOM 三元组同源）
 * - settings.json appearance 界面文案双语齐备（CLAUDE.md i18n 同步规范）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// localStorage stub：skin.store 模块加载期即创建 persist store 读写
// localStorage（与 tests/app-settings/skin-store.test.ts 同款处理）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => void memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

import {
  getSkin,
  SKINS,
  type SkinDef,
} from "@/domains/app-settings/model/skins";
import { useSkinStore } from "@/stores/skin.store";

type Mode = SkinDef["mode"];
type Hue = SkinDef["hue"];

/**
 * spec §3.1 十款三元组表（hue 为 spec 角度值就近映射现有 4 色系）
 * ——逐款 [id, mode, hue, wallpaper]，顺序即 spec 表顺序
 */
const SPEC_TRIPLETS: ReadonlyArray<
  readonly [string, Mode, Hue, string | null]
> = [
  ["light", "light", "blue", null],
  ["dark", "dark", "blue", null],
  ["dawn-mist", "light", "blue", "dawn-mist"],
  ["ripple", "light", "blue", "ripple"],
  ["field", "light", "green", "field"],
  ["ocean-sky", "light", "blue", "ocean-sky"],
  ["warm-sand", "light", "orange", "warm-sand"],
  ["dusk", "dark", "orange", "dusk"],
  ["pine", "dark", "green", "pine"],
  ["ink", "dark", "blue", "ink"],
];

const MODES: readonly Mode[] = ["light", "dark"];
const HUES: readonly Hue[] = ["blue", "red", "green", "orange"];
/** 八款装饰皮肤的 wallpaper 值（须与 skins.css [data-wallpaper] 选择器一致） */
const WALLPAPER_IDS = [
  "dawn-mist",
  "ripple",
  "field",
  "ocean-sky",
  "warm-sand",
  "dusk",
  "pine",
  "ink",
];

const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  delete root().dataset.mode;
  delete root().dataset.theme;
  delete root().dataset.wallpaper;
  useSkinStore.setState({ skin: "light", hue: "orange" });
});

describe("SKINS 十款元数据", () => {
  it("恰好 10 款且 id 唯一", () => {
    expect(SKINS).toHaveLength(10);
    expect(new Set(SKINS.map((s) => s.id)).size).toBe(10);
  });

  it("三元组逐款与 spec §3.1 表一致（含顺序）", () => {
    expect(
      SKINS.map((s) => [s.id, s.mode, s.hue, s.wallpaper] as const),
    ).toEqual(SPEC_TRIPLETS);
  });

  it("light/dark 为 basic，其余八款为 premium", () => {
    for (const skin of SKINS) {
      expect(skin.type).toBe(
        skin.id === "light" || skin.id === "dark" ? "basic" : "premium",
      );
    }
  });

  it("mode/hue 均为合法枚举值", () => {
    for (const skin of SKINS) {
      expect(MODES).toContain(skin.mode);
      expect(HUES).toContain(skin.hue);
    }
  });

  it("wallpaper 与 mode 对应：基础两款 null，light 系五款 + dark 系三款", () => {
    expect(getSkin("light")?.wallpaper).toBeNull();
    expect(getSkin("dark")?.wallpaper).toBeNull();
    const wallpaperSkins = SKINS.filter((s) => s.wallpaper !== null);
    expect(wallpaperSkins.map((s) => s.wallpaper)).toEqual(WALLPAPER_IDS);
    // light 系五款 + dark 系三款，且 wallpaper 值与 id 一致（skins.css 选择器同名）
    expect(wallpaperSkins.filter((s) => s.mode === "light")).toHaveLength(5);
    expect(wallpaperSkins.filter((s) => s.mode === "dark")).toHaveLength(3);
    for (const skin of wallpaperSkins) {
      expect(skin.wallpaper).toBe(skin.id);
    }
  });

  it("名称/描述双语字段均为非空字符串", () => {
    for (const skin of SKINS) {
      expect(skin.name.trim().length).toBeGreaterThan(0);
      expect(skin.nameEn.trim().length).toBeGreaterThan(0);
      expect(skin.desc.trim().length).toBeGreaterThan(0);
      expect(skin.descEn.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("getSkin 查找", () => {
  it("已知 id 返回对应款", () => {
    const ink = getSkin("ink");
    expect(ink).toBeDefined();
    expect(ink?.id).toBe("ink");
    expect(ink?.mode).toBe("dark");
  });

  it("未知 id 返回 undefined", () => {
    expect(getSkin("bogus")).toBeUndefined();
    expect(getSkin("")).toBeUndefined();
  });
});

describe("SKINS 与 skin.store 解析一致性", () => {
  it("getSkin 命中 ⇔ store.setSkin 不回落（双向，全量遍历）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const skin of SKINS) {
      useSkinStore.getState().setSkin(skin.id);
      expect(useSkinStore.getState().skin).toBe(skin.id);
    }
    // 不在 SKINS 中的 id 回落 light
    useSkinStore.getState().setSkin("not-a-skin");
    expect(useSkinStore.getState().skin).toBe("light");
  });

  it("抽 3 款断言 store 侧 DOM 三元组与 SkinDef 一致", () => {
    for (const id of ["dawn-mist", "warm-sand", "ink"]) {
      const def = getSkin(id);
      expect(def).toBeDefined();
      useSkinStore.getState().setSkin(id);
      expect(root().dataset.mode).toBe(def?.mode);
      expect(root().dataset.theme).toBe(def?.hue);
      expect(root().dataset.wallpaper).toBe(def?.wallpaper ?? undefined);
    }
  });
});

describe("settings.json appearance 界面文案双语齐备", () => {
  const EXPECTED_KEYS = [
    "allSkins",
    "basicType",
    "premiumType",
    "preview",
    "selected",
    "title",
  ];

  function loadAppearance(locale: string): Record<string, unknown> {
    const settings = JSON.parse(
      readFileSync(
        path.resolve(
          __dirname,
          `../../src-react/i18n/locales/${locale}/settings.json`,
        ),
        "utf8",
      ),
    );
    return settings.appearance as Record<string, unknown>;
  }

  it("两语言 appearance 组 key 集一致且含全部界面文案 key（非空字符串）", () => {
    for (const locale of ["zh-CN", "en-US"]) {
      const appearance = loadAppearance(locale);
      expect(Object.keys(appearance).sort()).toEqual(EXPECTED_KEYS);
      for (const key of EXPECTED_KEYS) {
        expect(typeof appearance[key]).toBe("string");
        expect((appearance[key] as string).trim().length).toBeGreaterThan(0);
      }
    }
  });
});
