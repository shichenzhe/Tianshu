import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useThemeColors } from "@/store/theme";
import {
  subscribeToast,
  type ToastKind,
  type ToastPayload,
} from "@/lib/toast-bus";

/**
 * 轻提示宿主（App 根挂载单份——_layout；总线与发射面在 lib/toast-bus）：
 * 顶部安全区下滑入的浮动条，等级色点 + 文案，按时长自动隐去（error 最
 * 长），点击即收；新条替换在显条（单条模型——移动端顶部空间不堆叠）。
 */

/** 等级配色（语义状态色非主题色——warning 琥珀/error 红对齐桌面先例） */
const KIND_COLOR: Record<ToastKind, string> = {
  info: "#3b82f6",
  warning: "#f59e0b",
  error: "#FF3B30",
};

/** 在显时长（毫秒）：error 需阅读时间最长；携带动作按钮时 +2.5s
 *  （撤销窗口对齐调用方定时） */
const KIND_DURATION: Record<ToastKind, number> = {
  info: 2500,
  warning: 3500,
  error: 4500,
};
const ACTION_EXTRA_MS = 2500;

/** 动画载体：opacity 是 Animated.Value，必须经 Animated 包装组件进原生
 *  ——裸 Pressable 会把动画值对象原样下发（Android 真机红屏
 *  "ReadableNativeMap cannot be cast to java.lang.Double"，createViewInstance
 *  即炸——1414fe9a 真机遗留，上传文件触发 toast.warning 暴露） */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function ToastHost() {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const [current, setCurrent] = useState<ToastPayload | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(
    (duration: number) => {
      if (hideTimer.current !== null) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      Animated.timing(opacity, {
        toValue: 0,
        duration,
        useNativeDriver: true,
      }).start(() => setCurrent(null));
    },
    [opacity],
  );

  useEffect(() => {
    const unsubscribe = subscribeToast((payload) => {
      if (hideTimer.current !== null) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setCurrent(payload); // 新条替换在显条
      Animated.timing(opacity, {
        toValue: 1,
        duration: 160,
        useNativeDriver: true,
      }).start();
      hideTimer.current = setTimeout(
        () => {
          hideTimer.current = null;
          dismiss(200);
        },
        KIND_DURATION[payload.kind] +
          (payload.action ? ACTION_EXTRA_MS : 0),
      );
    });
    return () => {
      unsubscribe();
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    };
  }, [opacity, dismiss]);

  if (current === null) return null;

  return (
    <AnimatedPressable
      // 点击即收（长 error 文案阅读完手动关）
      onPress={() => dismiss(120)}
      className={`absolute left-4 right-4 overflow-hidden rounded-2xl border border-[#54545866] px-3.5 py-2.5 ${
        // GL-P6③：iOS 真毛玻璃（Liquid Glass）——BlurView 承担底，tint 减轻；
        // Android blur 需 experimentalBlurMethod（性能权衡），保持半透明实底
        Platform.OS === "ios" ? "bg-[#1C1C1E73]" : "bg-[#1C1C1EC7]"
      }`}
      style={{
        top: insets.top + 8,
        opacity,
        shadowColor: "#000",
        shadowOpacity: 0.25,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 6,
      }}
    >
      {Platform.OS === "ios" && (
        <BlurView
          intensity={40}
          tint="default"
          style={StyleSheet.absoluteFill}
        />
      )}
      <View className="flex-row items-center gap-2">
        <View
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: KIND_COLOR[current.kind] }}
        />
        <Text className="flex-1 text-sm leading-5 text-white">
          {current.message}
        </Text>
        {current.action != null && (
          // 动作按钮（撤销删除批）：嵌套 Pressable 内层夺权，外层点击即收
          // 不触发——RN responder 天然隔离
          <Pressable
            hitSlop={8}
            onPress={() => {
              current.action?.onAction();
              dismiss(120);
            }}
            accessibilityLabel={current.action.label}
          >
            <Text
              className="text-sm font-semibold"
              style={{ color: colors.primary }}
            >
              {current.action.label}
            </Text>
          </Pressable>
        )}
      </View>
    </AnimatedPressable>
  );
}
