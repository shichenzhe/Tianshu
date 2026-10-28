import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, TextInput, View } from "react-native";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";

interface Props {
  /** 命中总数（0 = 无命中） */
  hitCount: number;
  /** 当前命中位置（0 基，调用方已按命中数收敛） */
  activePos: number;
  /** 防抖后的关键字上抛（300ms——桌面 250ms，移动端按键节奏放宽） */
  onQueryChange: (query: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

/**
 * 会话内搜索条（A9 阶段 1）：输入区上方的展开态搜索框——放大镜入口在
 * 页头（调用方），本条含 TextInput + 命中计数 + 上/下导航 + 关闭。
 * 300ms 防抖在本组件内；命中计算与滚动定位由调用方（会话页）负责。
 */
export function SessionSearchBar({
  hitCount,
  activePos,
  onQueryChange,
  onPrev,
  onNext,
  onClose,
}: Props) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [input, setInput] = useState("");

  // 300ms 防抖：输入停歇才上抛关键字（命中重算+首条定位都随之触发）
  useEffect(() => {
    const timer = setTimeout(() => onQueryChange(input), 300);
    return () => clearTimeout(timer);
  }, [input, onQueryChange]);

  const noHits = hitCount === 0;
  const navDisabled = noHits;

  return (
    <View className="flex-row items-center gap-2 border-b border-sep px-3 py-2 dark:border-[#545458A6]">
      <Search size={15} color="#8E8E93" />
      <TextInput
        value={input}
        onChangeText={setInput}
        placeholder={t("searchMessagesPlaceholder")}
        placeholderTextColor="#8E8E93"
        autoFocus
        returnKeyType="search"
        className="min-h-[30px] flex-1 px-1 text-sm text-black dark:text-white"
      />
      <Text className="w-12 text-center text-xs text-label2 dark:text-[#EBEBF599]">
        {noHits
          ? t("searchHitCounter", { current: 0, total: 0 })
          : t("searchHitCounter", {
              current: activePos + 1,
              total: hitCount,
            })}
      </Text>
      <Pressable
        onPress={onPrev}
        disabled={navDisabled}
        hitSlop={6}
        accessibilityLabel={t("searchPrev")}
        style={{ opacity: navDisabled ? 0.3 : 1 }}
      >
        <ChevronUp size={18} color={colors.primary} />
      </Pressable>
      <Pressable
        onPress={onNext}
        disabled={navDisabled}
        hitSlop={6}
        accessibilityLabel={t("searchNext")}
        style={{ opacity: navDisabled ? 0.3 : 1 }}
      >
        <ChevronDown size={18} color={colors.primary} />
      </Pressable>
      <Pressable
        onPress={onClose}
        hitSlop={6}
        accessibilityLabel={t("searchClose")}
      >
        <X size={16} color="#8E8E93" />
      </Pressable>
    </View>
  );
}
