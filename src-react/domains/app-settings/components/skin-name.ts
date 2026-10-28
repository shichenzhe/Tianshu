/**
 * 皮肤显示名 locale 分流（spec §5 决策：品牌化名称为静态双语字段，不走 i18n key）
 * ——ThemePreviewCard 的 aria-label 与 SkinCard 的名称展示共用，杜绝两处分流
 * 逻辑漂移
 */

import type { SkinDef } from "@/domains/app-settings/model/skins";

/** zh* locale 取中文名，其余取英文名 */
export function getSkinName(skin: SkinDef, language: string): string {
  return language.startsWith("zh") ? skin.name : skin.nameEn;
}
