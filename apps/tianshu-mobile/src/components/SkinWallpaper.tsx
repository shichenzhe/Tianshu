import { Image, View } from "react-native";
import { useColorScheme } from "nativewind";

import { resolveWallpaperScrim, useSkinWallpaper } from "@/theme/skins-assets";

/**
 * 聊天会话屏壁纸层（精选皮肤）：绝对定位铺满父容器（cover）+ 皮肤纱层
 * （浅色系叠白/墨韵叠黑，保消息可读）；纯色主题渲染 null（父级走实色底）。
 * 纱层按当前明暗档取值（深色档统一黑纱——明暗档被手动改暗后浅色系
 * 皮肤壁纸换黑纱保浅字可读，见 resolveWallpaperScrim）。
 * 置于内容树首位、内容背景需透明透出（见 session/[id].tsx 根 View 条件类）；
 * Composer/横幅等自带实色底组件不受影响。
 */
export function SkinWallpaper() {
  const wallpaper = useSkinWallpaper();
  const { colorScheme } = useColorScheme();
  if (!wallpaper) return null;
  return (
    <>
      <Image
        source={wallpaper.source}
        resizeMode="cover"
        className="absolute inset-0"
      />
      <View
        className="absolute inset-0"
        style={{
          backgroundColor: resolveWallpaperScrim(
            wallpaper.scrim,
            colorScheme === "dark" ? "dark" : "light",
          ),
        }}
      />
    </>
  );
}
