import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";

/** 微信式通用行：左图标/头像 + 标题(+副标题) + 右槽 + chevron；
 *  hairline 分隔，isLast（GroupSection 注入）末行去线 */
export function ListItem({
  icon,
  title,
  subtitle,
  right,
  onPress,
  showChevron = true,
  isLast = false,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  isLast?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={onPress == null}
      className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      {icon}
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className="text-[15px] text-black dark:text-white"
        >
          {title}
        </Text>
        {subtitle != null && (
          <Text
            numberOfLines={1}
            className="mt-0.5 text-[13px] text-label2 dark:text-[#EBEBF599]"
          >
            {subtitle}
          </Text>
        )}
      </View>
      {right}
      {showChevron && onPress != null && (
        <ChevronRight size={16} color="#C7C7CC" />
      )}
    </Pressable>
  );
}
