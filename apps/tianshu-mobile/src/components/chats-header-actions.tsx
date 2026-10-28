import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { Search } from "lucide-react-native";

import { AppIcon } from "@/components/AppIcon";
import { StateDot } from "@/components/StateDot";
import { useConnectionsStore } from "@/store/connections.store";
import { useSearchUiStore } from "@/store/search-ui";
import { useThemeColors } from "@/store/theme";
import type { TransportState } from "@/transport/types";

/** 聊天 Tab 顶栏右槽（微信范式 P0）：连接状态点（点击进主机 Tab 管理）+
 *  放大镜展开搜索。新建会话「+」已下放至各工作空间组头（用户裁定：
 *  顶栏创建归属不明——组头创建一眼可知建在哪个空间）。 */
export function ChatsHeaderActions() {
  const { t } = useTranslation("chat");
  const router = useRouter();
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const configs = useConnectionsStore((s) => s.configs);
  const states = useConnectionsStore((s) => s.states);
  const toggleSearch = useSearchUiStore((s) => s.toggleSearch);
  const activeConfig = configs.find((c) => c.id === activeConnId) ?? null;
  const activeState: TransportState | undefined = activeConnId
    ? (states[activeConnId] ?? "idle")
    : undefined;

  return (
    <View className="mr-2 flex-row items-center gap-3">
      <Pressable
        onPress={() => router.push("/connections")}
        hitSlop={8}
        accessibilityLabel={activeConfig?.name ?? t("noConnection")}
      >
        <StateDot state={activeState} />
      </Pressable>
      <Pressable
        onPress={toggleSearch}
        hitSlop={8}
        accessibilityLabel={t("searchPlaceholder")}
      >
        <AppIcon
          name="magnifyingglass"
          fallback={Search}
          size={18}
          color={colors.primary}
        />
      </Pressable>
    </View>
  );
}
