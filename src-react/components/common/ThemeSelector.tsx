/**
 * 主题切换组件
 * 提供蓝色/红色/绿色/橙色四种主题选择
 */

import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Palette } from "lucide-react";
import { useThemeStore, type ThemeType } from "@/stores/theme.store";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const themeColors: Record<ThemeType, string> = {
  blue: "hsl(220 50% 52%)",
  red: "hsl(355 50% 52%)",
  green: "hsl(150 60% 40%)",
  orange: "hsl(18 65% 60%)",
};

interface ThemeSelectorProps {
  size?: "sm" | "md";
}

export default function ThemeSelector({ size = "md" }: ThemeSelectorProps) {
  const { t } = useTranslation(["layout"]);
  const { theme, setTheme } = useThemeStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTimer = useRef<NodeJS.Timeout | null>(null);

  const iconSize = size === "sm" ? "w-4 h-4" : "w-5 h-5";
  const buttonSize = size === "sm" ? "w-8 h-8" : "w-9 h-9";

  const themeConfig: ThemeType[] = ["blue", "red", "green", "orange"];

  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(open) => {
        if (!open) {
          menuTimer.current = setTimeout(() => setMenuOpen(false), 200);
        }
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <div
          className={`${buttonSize} flex items-center justify-center rounded-md cursor-pointer hover:bg-muted text-muted-foreground transition-all duration-200`}
          onMouseEnter={() => {
            if (menuTimer.current) clearTimeout(menuTimer.current);
            setMenuOpen(true);
          }}
          onMouseLeave={() => {
            menuTimer.current = setTimeout(() => setMenuOpen(false), 200);
          }}
        >
          <Palette className={iconSize} />
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={2}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={() => {
          if (menuTimer.current) clearTimeout(menuTimer.current);
        }}
        onMouseLeave={() => {
          menuTimer.current = setTimeout(() => setMenuOpen(false), 200);
        }}
      >
        {themeConfig.map((themeType) => {
          const color = themeColors[themeType];
          const isSelected = theme === themeType;

          return (
            <DropdownMenuItem
              key={themeType}
              onClick={() => setTheme(themeType)}
              className="flex items-center gap-2 cursor-pointer"
            >
              <span
                className="w-4 h-4 rounded-sm"
                style={{ backgroundColor: color }}
              />
              <span>{t(`layout:theme.${themeType}`)}</span>
              {isSelected && (
                <span className="ml-auto text-xs text-muted-foreground">✓</span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
