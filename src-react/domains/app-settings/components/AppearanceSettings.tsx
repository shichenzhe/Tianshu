/**
 * 外观设置页（spec §3.2）：主题预览大卡（当前皮肤，点击卡片即时换肤——
 * store 驱动）+「全部皮肤」十款缩略卡网格（窄 2 列 → md 3 列 → xl 5 列响应）。
 * 选中态读 store.skin 单一数据源；整页滚动由 SettingsDialog 内容区承担
 * （外观分支同样走右栏 overflow-y-auto 容器）
 */

import { useTranslation } from "react-i18next";

import { getSkin, SKINS } from "@/domains/app-settings/model/skins";
import { useSkinStore } from "@/stores/skin.store";
import ThemePreviewCard from "./ThemePreviewCard";
import SkinCard from "./SkinCard";

export default function AppearanceSettings() {
  const { t } = useTranslation(["settings"]);
  // hue/setHue 接线色相微调：选中卡色点行 + 预览卡如实反映（顶栏
  // ThemeSelector 移除后，色相微调能力迁至皮肤卡）
  const { skin, setSkin, hue, setHue } = useSkinStore();
  // store.skin 经 sanitizePersisted 归一恒为合法 id，?? SKINS[0] 仅类型收敛兜底
  const currentSkin = getSkin(skin) ?? SKINS[0];

  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold text-foreground">
        {t("settings:appearance.title")}
      </h2>
      <ThemePreviewCard skin={currentSkin} hue={hue} />
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          {t("settings:appearance.allSkins")}
        </h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {SKINS.map((item) => (
            <SkinCard
              key={item.id}
              skin={item}
              selected={item.id === skin}
              onSelect={setSkin}
              activeHue={hue}
              onHueChange={setHue}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
