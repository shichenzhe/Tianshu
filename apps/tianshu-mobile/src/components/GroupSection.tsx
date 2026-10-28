import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";

/** grouped 分组卡（微信「发现/我」范式）：灰字小组头 + 圆角白卡组；
 *  子元素为 ListItem 时自动注入 isLast（末行去 hairline） */
export function GroupSection({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const items = Children.toArray(children);
  return (
    <View className="gap-1.5">
      {label != null && (
        <Text className="px-1 text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
          {label}
        </Text>
      )}
      <View className="overflow-hidden rounded-2xl">
        {items.map((child, index) =>
          isValidElement(child)
            ? cloneElement(child as ReactElement<{ isLast?: boolean }>, {
                isLast: index === items.length - 1,
              })
            : child,
        )}
      </View>
    </View>
  );
}
