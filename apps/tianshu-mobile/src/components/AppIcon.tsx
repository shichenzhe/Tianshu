import { Platform } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";

/**
 * 平台自适应图标（GL-P6②）：iOS 用 SF Symbols（原生质感——expo-symbols
 * 内置 SF 字体渲染，非位图）；Android/web 回退 lucide（SF Symbols 为
 * iOS 资产不可跨端）。类型全部取自 SymbolViewProps 同源（workspace 双
 * 副本 sf-symbols-typescript 名义类型冲突绕行）。
 */
export function AppIcon({
  name,
  fallback: Fallback,
  size,
  color,
  weight = "regular",
}: {
  /** SF Symbol 名（Apple SF Symbols app 查阅；拼错编译期即报） */
  name: SymbolViewProps["name"];
  /** Android/web 回退的 lucide 图标组件 */
  fallback: typeof import("lucide-react-native").ChevronRight;
  size: number;
  color: string;
  weight?: SymbolViewProps["weight"];
}) {
  if (Platform.OS === "ios") {
    // 注：SF 单色着色 prop 为 colors（ColorValue | ColorValue[]，expo-
    // symbols 命名），非 color——曾误诊为双副本类型冲突实为笔误
    return (
      <SymbolView
        name={name}
        size={size}
        colors={color}
        weight={weight}
      />
    );
  }
  return <Fallback size={size} color={color} />;
}
