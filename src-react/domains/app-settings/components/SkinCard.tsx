/**
 * 皮肤缩略卡（"全部皮肤"网格单元）：微缩缩略块同法局部换肤——三元组写在缩略块
 * 上，块内背景色/侧栏竖条/主色圆点/文字线均消费该皮肤语义变量；名称按 locale
 * 分流；premium 右上角标；选中 border-primary + ring 高亮、未选中 hover 抬升
 * （transition 置于基类，选中切换双向平滑过渡）；button + aria-pressed 语义，
 * 选中态另附 sr-only 文案
 */

import { useTranslation } from "react-i18next";

import type { SkinDef } from "@/domains/app-settings/model/skins";
import { cn } from "@/lib/utils";
import { getSkinName } from "./skin-name";

interface SkinCardProps {
  skin: SkinDef;
  selected: boolean;
  onSelect: (id: string) => void;
}

/** 微缩缩略块：局部三元组绑定 + premium 精选角标 */
function SkinThumbnail({ skin }: { skin: SkinDef }) {
  const { t } = useTranslation(["settings"]);

  return (
    <div
      data-mode={skin.mode}
      data-theme={skin.hue}
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

export default function SkinCard({ skin, selected, onSelect }: SkinCardProps) {
  const { t, i18n } = useTranslation(["settings"]);

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
      <SkinThumbnail skin={skin} />
      <div className="px-2 py-1.5 text-sm">
        {getSkinName(skin, i18n.language)}
        {selected && (
          <span className="sr-only">{t("settings:appearance.selected")}</span>
        )}
      </div>
    </button>
  );
}
