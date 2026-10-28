import type { ReactNode } from "react";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { ChevronLeft } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";

/** 统一页头（A1 规范化：三个页面原 32px 大标题收为 17px semibold）：
 *  返回键缺省 router.back()，backLabel 作无障碍标签；right 槽原样渲染在
 *  标题后（新增/创建等操作入口）。 */
export function PageHeader({
  title,
  onBack,
  backLabel,
  right,
}: {
  title: string;
  onBack?: () => void;
  backLabel?: string;
  right?: ReactNode;
}) {
  const router = useRouter();
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center gap-2 px-3 pb-3 pt-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        onPress={onBack ?? (() => router.back())}
        hitSlop={12}
        className="h-9 w-9 items-center justify-center"
      >
        <ChevronLeft size={26} color={colors.primary} />
      </Pressable>
      <Text
        numberOfLines={1}
        className="min-w-0 flex-1 text-[17px] font-semibold text-black dark:text-white"
      >
        {title}
      </Text>
      {right}
    </View>
  );
}
