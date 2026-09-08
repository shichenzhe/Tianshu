/**
 * 常规组：界面语言 + 字体大小
 * - 语言：下拉切换，调 i18n.changeLanguage（持久化由 i18n 初始化的
 *   languageChanged 监听写 localStorage tianshu-locale）
 * - 字体：三档滑条（小/默认/大），html fontSize 14/16/18 即时生效并
 *   持久化到 localStorage tianshu-font-scale
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  applyFontScale,
  FONT_SCALES,
  readFontScale,
  type FontScale,
} from "../model/font-scale";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** 可选语言（code 与 i18n 资源一致） */
const LANGUAGES = [
  { code: "zh-CN", labelKey: "settings:general.zhCN" },
  { code: "en-US", labelKey: "settings:general.enUS" },
];

/** 字体档位滑条刻度文案 key */
const FONT_SCALE_LABEL_KEYS: Record<FontScale, string> = {
  small: "settings:general.fontSmall",
  default: "settings:general.fontDefault",
  large: "settings:general.fontLarge",
};

export default function GeneralGroup() {
  const { t, i18n } = useTranslation(["settings"]);
  const [fontScale, setFontScale] = useState<FontScale>(readFontScale());

  const currentLanguage =
    LANGUAGES.find((lang) => lang.code === i18n.language) ?? LANGUAGES[0];

  const changeLanguage = (langCode: string) => {
    i18n.changeLanguage(langCode);
  };

  const changeFontScale = (scale: FontScale) => {
    setFontScale(scale);
    applyFontScale(scale);
  };

  const changeFontScaleIndex = (index: number) => {
    changeFontScale(FONT_SCALES[index]);
  };

  return (
    <>
      {/* 界面语言 */}
      <div className="flex items-center justify-between gap-4">
        <Label className="text-sm font-normal">
          {t("settings:general.language")}
        </Label>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-40 justify-between font-normal hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            >
              {t(currentLanguage.labelKey)}
              <ChevronDown className="h-4 w-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40 border border-border/50 rounded-lg shadow-lg"
          >
            {LANGUAGES.map((lang) => (
              <DropdownMenuItem
                key={lang.code}
                onClick={() => changeLanguage(lang.code)}
                className="cursor-pointer"
              >
                {t(lang.labelKey)}
                {lang.code === currentLanguage.code && (
                  <Check className="ml-auto h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 字体大小（三档滑条） */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm font-normal">
            {t("settings:general.fontSize")}
          </Label>
          <span className="text-sm text-muted-foreground">
            {t(FONT_SCALE_LABEL_KEYS[fontScale])}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={FONT_SCALES.length - 1}
          step={1}
          value={FONT_SCALES.indexOf(fontScale)}
          onChange={(e) => changeFontScaleIndex(Number(e.target.value))}
          aria-label={t("settings:general.fontSize")}
          className="w-56 accent-primary cursor-pointer"
        />
        <div className="flex w-56 justify-between">
          {FONT_SCALES.map((scale) => (
            <button
              key={scale}
              type="button"
              onClick={() => changeFontScale(scale)}
              className={cn(
                "text-xs cursor-pointer hover:text-primary",
                scale === fontScale
                  ? "text-primary font-medium"
                  : "text-muted-foreground",
              )}
            >
              {t(FONT_SCALE_LABEL_KEYS[scale])}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
