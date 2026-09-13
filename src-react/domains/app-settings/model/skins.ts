/**
 * 皮肤元数据（spec §3.1 十款）——外观模块的权威数据源：
 * - skin.store 的属性解析（getSkin：id → 三元组）与皮肤卡片渲染
 *   （name/desc/type 展示）共用，杜绝两处硬编码漂移
 * - 皮肤名称/描述为品牌化内容数据（spec §5 决策）：静态双语字段内联，
 *   不走 i18n key（避免 40+ key 膨胀）；界面文案走 settings:appearance.*
 * - hue 为 spec 角度值就近映射现有 4 色系（blue 220 / red 355 / green 150 /
 *   orange 18）：260→blue、190→blue、120→green、205→blue、35→orange、
 *   15→orange、150→green、225→blue
 */

export interface SkinDef {
  id: string; // "light"|"dark"|"dawn-mist"|...（spec §3.1 十款）
  mode: "light" | "dark"; // 驱动 data-mode（明暗变量集）
  hue: "blue" | "red" | "green" | "orange"; // 驱动 data-theme（色相）
  wallpaper: string | null; // null=无装饰；否则 data-wallpaper 值（skins.css）
  type: "basic" | "premium"; // 类型胶囊（基础主题/精选皮肤）
  name: string;
  nameEn: string;
  desc: string;
  descEn: string;
}

/** 十款皮肤（顺序即 spec §3.1 表顺序：基础两款 + light 系五款 + dark 系三款） */
export const SKINS: SkinDef[] = [
  {
    id: "light",
    mode: "light",
    hue: "blue",
    wallpaper: null,
    type: "basic",
    name: "浅色",
    nameEn: "Light",
    desc: "纯浅灰界面",
    descEn: "Clean light-gray interface",
  },
  {
    id: "dark",
    mode: "dark",
    hue: "blue",
    wallpaper: null,
    type: "basic",
    name: "深色",
    nameEn: "Dark",
    desc: "深灰夜色界面",
    descEn: "Deep-gray night interface",
  },
  {
    id: "dawn-mist",
    mode: "light",
    hue: "blue",
    wallpaper: "dawn-mist",
    type: "premium",
    name: "晨雾",
    nameEn: "Dawn Mist",
    desc: "淡紫云纹氛围",
    descEn: "Lavender mist ambience",
  },
  {
    id: "ripple",
    mode: "light",
    hue: "blue",
    wallpaper: "ripple",
    type: "premium",
    name: "涟漪",
    nameEn: "Ripple",
    desc: "水纹涟漪清新",
    descEn: "Fresh rippling water",
  },
  {
    id: "field",
    mode: "light",
    hue: "green",
    wallpaper: "field",
    type: "premium",
    name: "原野",
    nameEn: "Field",
    desc: "草地绿意自然",
    descEn: "Natural grassland greenery",
  },
  {
    id: "ocean-sky",
    mode: "light",
    hue: "blue",
    wallpaper: "ocean-sky",
    type: "premium",
    name: "海空",
    nameEn: "Ocean Sky",
    desc: "天海一色湛蓝",
    descEn: "Azure sea meeting sky",
  },
  {
    id: "warm-sand",
    mode: "light",
    hue: "orange",
    wallpaper: "warm-sand",
    type: "premium",
    name: "暖沙",
    nameEn: "Warm Sand",
    desc: "沙丘暖阳",
    descEn: "Sun-warmed dunes",
  },
  {
    id: "dusk",
    mode: "dark",
    hue: "orange",
    wallpaper: "dusk",
    type: "premium",
    name: "暮色",
    nameEn: "Dusk",
    desc: "暖橙暮光夜景",
    descEn: "Warm amber twilight",
  },
  {
    id: "pine",
    mode: "dark",
    hue: "green",
    wallpaper: "pine",
    type: "premium",
    name: "松林",
    nameEn: "Pine",
    desc: "墨绿松林层叠",
    descEn: "Layered dark-green pines",
  },
  {
    id: "ink",
    mode: "dark",
    hue: "blue",
    wallpaper: "ink",
    type: "premium",
    name: "墨韵",
    nameEn: "Ink",
    desc: "深蓝漩涡墨色",
    descEn: "Deep-blue ink swirls",
  },
];

/** 按 id 查找皮肤；未知 id 返回 undefined（调用方自行回落，如 store 回落 light） */
export function getSkin(id: string): SkinDef | undefined {
  return SKINS.find((skin) => skin.id === id);
}
