/**
 * 语言切换组件
 */

import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const languages = [
  { code: "zh-CN", key: "zhCN" },
  { code: "en-US", key: "enUS" },
];

interface LanguageSelectorProps {
  size?: "sm" | "md";
}

export default function LanguageSelector({
  size = "md",
}: LanguageSelectorProps) {
  const { t, i18n } = useTranslation(["layout"]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTimer = useRef<NodeJS.Timeout | null>(null);

  const iconSize = size === "sm" ? "w-4 h-4" : "w-5 h-5";
  const buttonSize = size === "sm" ? "w-8 h-8" : "w-9 h-9";

  const changeLanguage = (langCode: string) => {
    i18n.changeLanguage(langCode);
  };

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
          <Languages className={iconSize} />
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
        {languages.map((lang) => {
          const isSelected = lang.code === i18n.language;
          return (
            <DropdownMenuItem
              key={lang.code}
              onClick={() => changeLanguage(lang.code)}
              className="flex items-center gap-2 cursor-pointer"
            >
              <span>{t(`layout:language.${lang.key}`)}</span>
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
