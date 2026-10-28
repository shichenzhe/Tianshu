/**
 * 皮肤缩略卡（"全部皮肤"网格单元）：微缩缩略块同法局部换肤——三元组写在缩略块
 * 上，块内背景色/侧栏竖条/主色圆点/文字线均消费该皮肤语义变量；名称按 locale
 * 分流；premium 右上角标；选中 border-primary + ring 高亮、未选中 hover 抬升
 * （transition 置于基类，选中切换双向平滑过渡）；button + aria-pressed 语义，
 * 选中态另附 sr-only 文案；
 * 选中卡底部色相微调行（radiogroup，顶栏 ThemeSelector 移除后能力迁入）：
 * 四色点各自 data-theme 局部取 bg-primary，点击 onHueChange 仅换色相
 * （stopPropagation，不触发整卡切换）
 */

import { useTranslation } from "react-i18next";

import type { SkinDef } from "@/domains/app-settings/model/skins";
import type { ThemeType } from "@/stores/skin.store";
import { cn } from "@/lib/utils";
import { getSkinName } from "./skin-name";

/** 色相微调色点序（globals.css 四套 data-theme 变量集） */
const HUES: readonly ThemeType[] = ["blue", "red", "green", "orange"];

interface SkinCardProps {
  skin: SkinDef;
  selected: boolean;
  onSelect: (id: string) => void;
  /** 当前生效色相：选中卡缩略块随之反映（微调后可异于皮肤默认 hue） */
  activeHue?: ThemeType;
  /** 色相微调回调（提供时选中卡渲染色点行） */
  onHueChange?: (hue: ThemeType) => void;
}

/** 微缩缩略块：局部三元组绑定 + premium 精选角标 */
function SkinThumbnail({ skin, hue }: { skin: SkinDef; hue: ThemeType }) {
  const { t } = useTranslation(["settings"]);

  return (
    <div
      data-mode={skin.mode}
      data-theme={hue}
      data-wallpaper={skin.wallpaper ?? undefined}
      className="relative flex h-20 items-center gap-2 overflow-hidden rounded bg-background p-2"
    >
      <div className="h-full w-3 shrink-0 rounded-sm bg-muted" />
      <div className="flex flex-1 flex-col items-center gap-1.5">
        <div className="h-6 w-6 rounded-full bg-primary" />
        <div className="h-1.5 w-3/4 rounded bg-muted-foreground/30" />
        <div className="h-1.5 w-1/2 rounded bg-muted-foreground/30" />
      </div>
      {skin.type === "premium" && (
        <span className="absolute right-1.5 top-1.5 rounded-full bg-foreground/80 px-1.5 py-0.5 text-[10px] font-medium text-background">
          {t("settings:appearance.premiumType")}
        </span>
      )}
    </div>
  );
}

export default function SkinCard({
  skin,
  selected,
  onSelect,
  activeHue,
  onHueChange,
}: SkinCardProps) {
  const { t, i18n } = useTranslation(["settings"]);
  // 选中卡缩略块显示实际生效色相（微调后异于皮肤默认）
  const effectiveHue = selected && activeHue ? activeHue : skin.hue;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(skin.id)}
      className={cn(
        "block w-full overflow-hidden rounded-lg border bg-card text-left transition",
        selected
          ? "border-primary ring-2 ring-primary/30"
          : "border-border/50 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md",
      )}
    >
      <SkinThumbnail skin={skin} hue={effectiveHue} />
      <div className="px-2 py-1.5 text-sm">
        {getSkinName(skin, i18n.language)}
        {selected && (
          <span className="sr-only">{t("settings:appearance.selected")}</span>
        )}
      </div>
      {selected && onHueChange && (
        <div
          role="radiogroup"
          aria-label={t("settings:appearance.colorTheme")}
          className="flex items-center gap-2 px-2 pb-2"
          onClick={(e) => e.stopPropagation()}
        >
          {HUES.map((hue) => (
            <span
              key={hue}
              data-theme={hue}
              role="radio"
              aria-checked={hue === activeHue}
              aria-label={t(`layout:theme.${hue}`)}
              onClick={() => onHueChange(hue)}
              className={cn(
                "h-4 w-4 cursor-pointer rounded-full bg-primary transition-transform hover:scale-110",
                hue === activeHue
                  ? "ring-2 ring-primary ring-offset-1 ring-offset-card"
                  : "opacity-75",
              )}
            />
          ))}
        </div>
      )}
    </button>
  );
}
