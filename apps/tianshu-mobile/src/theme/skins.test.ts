/**
 * 精选皮肤元数据不变量：
 * - 四款齐备且 id 唯一（涟漪/海空/暖沙/墨韵）
 * - 三元组（hue/mode）与桌面 apps/tianshu-desktop src-react/domains/
 *   app-settings/model/skins.ts 逐项对齐——两端同步纪律（colors.ts 头注释），
 *   桌面改皮肤定义时本表须同步改
 * - scrim 为合法 hsla 串（消息区纱层，基调取桌面 skins.css body overlay 中段）
 */
import { describe, expect, it } from "vitest";

import { getSkin, isSkinId, SKINS } from "../theme/skins";

describe("SKINS 元数据", () => {
  it("恰好四款：涟漪/海空/暖沙/墨韵，id 唯一", () => {
    expect(SKINS.map((skin) => skin.id)).toEqual([
      "ripple",
      "ocean-sky",
      "warm-sand",
      "ink",
    ]);
    expect(new Set(SKINS.map((skin) => skin.id)).size).toBe(SKINS.length);
  });

  it("三元组对齐桌面：hue/mode 逐款一致（桌面 skins.ts 为权威源）", () => {
    const expectations: Record<string, { hue: string; mode: string }> = {
      ripple: { hue: "orange", mode: "light" },
      "ocean-sky": { hue: "blue", mode: "light" },
      "warm-sand": { hue: "orange", mode: "light" },
      ink: { hue: "blue", mode: "dark" },
    };
    for (const skin of SKINS) {
      expect({ hue: skin.hue, mode: skin.mode }).toEqual(
        expectations[skin.id],
      );
    }
  });

  it("每款带消息区纱层色（合法 hsla 串）与 i18n labelKey", () => {
    for (const skin of SKINS) {
      expect(skin.scrim).toMatch(/^hsla\(\d+, \d+%, \d+%, [\d.]+\)$/);
      expect(skin.labelKey).toMatch(/^skin[A-Z]/);
    }
  });
});

describe("getSkin / isSkinId", () => {
  it("getSkin 按 id 命中，未知 id 返回 undefined", () => {
    expect(getSkin("ink")?.mode).toBe("dark");
    expect(getSkin("dawn-mist")).toBeUndefined();
  });

  it("isSkinId：四款 id 为真，其余（含桌面其余皮肤/任意串）为假", () => {
    for (const id of ["ripple", "ocean-sky", "warm-sand", "ink"]) {
      expect(isSkinId(id)).toBe(true);
    }
    for (const id of ["dawn-mist", "field", "pine", "dusk", "", null, 42]) {
      expect(isSkinId(id)).toBe(false);
    }
  });
});
