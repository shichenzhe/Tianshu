import { Text, View } from "react-native";

import {
  AVATAR_THEME_ORDER,
  avatarInitial,
  avatarThemeIndex,
} from "@/logic/avatar-color";
import { THEME_PRESETS } from "@/theme/colors";

/** 微信式圆形头像：seed 散列取四主题色之一作底（会话 id/空间名等稳定
 *  seed 得稳定配色），内显标题首字符；size 默认 44（会话行大头像） */
export function Avatar({
  seed,
  title,
  size = 44,
}: {
  seed: string;
  title: string | null;
  size?: number;
}) {
  const themeName = AVATAR_THEME_ORDER[avatarThemeIndex(seed)];
  const bg = THEME_PRESETS[themeName].primary;
  return (
    <View
      className="items-center justify-center rounded-full"
      style={{ width: size, height: size, backgroundColor: bg }}
    >
      <Text
        className="font-semibold text-white"
        style={{ fontSize: size * 0.42 }}
      >
        {avatarInitial(title)}
      </Text>
    </View>
  );
}
