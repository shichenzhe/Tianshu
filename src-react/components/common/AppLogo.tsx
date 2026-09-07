/**
 * 应用 Logo（天枢 · 枢星轴心）
 * 内联 SVG 引用主题 CSS 变量，星形随主题色（蓝/红/绿/橙）即时切换
 */
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface AppLogoProps {
  className?: string;
}

export default function AppLogo({ className }: AppLogoProps) {
  const { t } = useTranslation(["common"]);
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={t("common:appName")}
      className={cn("shrink-0", className)}
    >
      {/* 轨道环（中性灰，不随主题） */}
      <path
        d="M 44 54.78 A 24 24 0 1 1 56 34"
        fill="none"
        stroke="#64748B"
        strokeWidth={2.5}
        strokeLinecap="round"
      />
      {/* 轨道上的运转星点 */}
      <circle cx={52.78} cy={46} r={3} fill="var(--color-primary)" />
      {/* 光晕 */}
      <circle
        cx={32}
        cy={34}
        r={16}
        fill="var(--color-primary)"
        fillOpacity={0.12}
      />
      {/* 中央四角枢星 */}
      <path
        d="M 32 17 Q 34.5 31.5 49 34 Q 34.5 36.5 32 51 Q 29.5 36.5 15 34 Q 29.5 31.5 32 17 Z"
        fill="var(--color-primary)"
      />
    </svg>
  );
}
