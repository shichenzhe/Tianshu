import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

/** 骨架行（GL-P4 行化）：卡容器由使用方提供，行间 hairline（末行消隐） */
function SkeletonRow() {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.4, { duration: 800 }),
        withTiming(1, { duration: 800 }),
      ),
      -1,
    );
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <View className="border-b border-sep px-4 py-3 last:border-b-0 dark:border-[#545458A6]">
      <Animated.View style={style}>
        <View className="h-4 w-3/5 rounded bg-field dark:bg-[#3A3A3C]" />
        <View className="mt-2 h-3 w-1/3 rounded bg-field dark:bg-[#3A3A3C]" />
      </Animated.View>
    </View>
  );
}

/** 会话列表首拉骨架（动效批续）：整组卡骨架占位——不闪「暂无会话」空态 */
export function SkeletonSessionList() {
  return (
    <View>
      {[0, 1, 2, 3, 4].map((i) =>
        i === 2 ? (
          // 第二组换组模拟分组结构（组间留白）
          <View key={i} className="mt-4">
            <View className="mb-1.5 h-3 w-16 rounded bg-field dark:bg-[#3A3A3C]" />
            <View className="overflow-hidden rounded-2xl bg-card dark:bg-[#1C1C1E]">
              <SkeletonRow />
              <SkeletonRow />
            </View>
          </View>
        ) : null,
      )}
      <View className="overflow-hidden rounded-2xl bg-card dark:bg-[#1C1C1E]">
        {[0, 1].map((i) => (
          <SkeletonRow key={i} />
        ))}
      </View>
    </View>
  );
}
