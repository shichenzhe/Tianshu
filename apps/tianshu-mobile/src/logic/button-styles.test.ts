import { describe, expect, it } from "vitest";

import {
  ACTION_DANGER,
  THEME_PRESETS,
  resolveThemeColors,
} from "../theme/colors";
import {
  buttonLabelClassName,
  buttonLabelTint,
  buttonShellStyle,
} from "./button-styles";

const light = resolveThemeColors(THEME_PRESETS.blue, "light");
const dark = resolveThemeColors(THEME_PRESETS.blue, "dark");

describe("buttonShellStyle（实色底对象式唯一通道，批 2026-11-01）", () => {
  it("filled：主色实底、无透明态", () => {
    expect(buttonShellStyle("filled", light, false, false)).toEqual({
      borderRadius: 8,
      backgroundColor: light.primary,
    });
  });

  it("tinted：subtle 淡底，明暗随 scheme 取值", () => {
    expect(
      buttonShellStyle("tinted", light, false, false).backgroundColor,
    ).toBe(THEME_PRESETS.blue.subtle);
    expect(buttonShellStyle("tinted", dark, true, false).backgroundColor).toBe(
      THEME_PRESETS.blue.subtleDark,
    );
  });

  it("outlined：主色描边透明底", () => {
    expect(buttonShellStyle("outlined", light, false, false)).toEqual({
      borderRadius: 8,
      borderWidth: 1,
      borderColor: light.primary,
      backgroundColor: "transparent",
    });
  });

  it("plain：中性描边，暗色换 #545458A6", () => {
    expect(buttonShellStyle("plain", light, false, false).borderColor).toBe(
      "rgba(60,60,67,0.18)",
    );
    expect(buttonShellStyle("plain", dark, true, false).borderColor).toBe(
      "#545458A6",
    );
  });

  it("danger：标准红 10% 淡底、无边框", () => {
    expect(buttonShellStyle("danger", light, false, false)).toEqual({
      borderRadius: 8,
      backgroundColor: `${ACTION_DANGER}1a`,
    });
  });

  it("按压反馈=背景层 opacity 0.72（不依赖函数式 style），底色不变", () => {
    const pressed = buttonShellStyle("filled", light, false, true);
    expect(pressed.opacity).toBe(0.72);
    expect(pressed.backgroundColor).toBe(light.primary);
  });
});

describe("buttonLabelTint / buttonLabelClassName", () => {
  it("tint：tinted=primaryActive、outlined=primary、danger=标准红", () => {
    expect(buttonLabelTint("tinted", light)).toBe(light.primaryActive);
    expect(buttonLabelTint("outlined", light)).toBe(light.primary);
    expect(buttonLabelTint("danger", light)).toBe(ACTION_DANGER);
  });

  it("filled/plain 文字走静态 className（tint=null）", () => {
    expect(buttonLabelTint("filled", light)).toBeNull();
    expect(buttonLabelTint("plain", light)).toBeNull();
    expect(buttonLabelClassName("filled")).toBe("text-white");
    expect(buttonLabelClassName("plain")).toBe(
      "text-label2 dark:text-[#EBEBF599]",
    );
  });
});
