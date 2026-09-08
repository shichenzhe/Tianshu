/**
 * 设置面板对话框
 * 左栏固定宽导航（通用为当前页；个人主页/外观/快捷键占位禁用），
 * 右栏滚动区按分组渲染：常规/权限/存储/通知四组
 */

import { useTranslation } from "react-i18next";
import {
  Keyboard,
  Palette,
  Settings,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SettingsGroup from "./SettingsGroup";
import GeneralGroup from "./GeneralGroup";
import PermissionsGroup from "./PermissionsGroup";
import StorageGroup from "./StorageGroup";
import NotificationsGroup from "./NotificationsGroup";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 导航项（disabled = 占位，敬请期待） */
const NAV_ITEMS: { id: string; icon: LucideIcon; disabled: boolean }[] = [
  { id: "general", icon: Settings, disabled: false },
  { id: "profile", icon: UserRound, disabled: true },
  { id: "appearance", icon: Palette, disabled: true },
  { id: "shortcuts", icon: Keyboard, disabled: true },
];

export default function SettingsDialog({
  open,
  onOpenChange,
}: SettingsDialogProps) {
  const { t } = useTranslation(["settings"]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[70vh] p-0 gap-0 flex flex-col overflow-hidden">
        <DialogHeader className="px-6 py-4 pr-12 border-b border-border/50">
          <DialogTitle>{t("settings:title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-1 overflow-hidden">
          {/* 左栏导航 */}
          <nav className="w-44 shrink-0 border-r border-border/50 p-3 space-y-1">
            {NAV_ITEMS.map(({ id, icon: Icon, disabled }) => (
              <button
                key={id}
                type="button"
                disabled={disabled}
                title={disabled ? t("settings:nav.comingSoon") : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors",
                  id === "general"
                    ? "bg-primary-subtle text-primary font-medium"
                    : "cursor-pointer hover:bg-primary-subtle hover:text-primary",
                  disabled &&
                    "opacity-50 pointer-events-none hover:bg-transparent hover:text-foreground",
                )}
              >
                <Icon size={14} className="shrink-0" />
                <span className="truncate">{t(`settings:nav.${id}`)}</span>
                {disabled && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {t("settings:nav.comingSoon")}
                  </span>
                )}
              </button>
            ))}
          </nav>
          {/* 右栏滚动分组区 */}
          <div className="flex-1 overflow-y-auto p-6 space-y-8">
            <SettingsGroup title={t("settings:groups.general")}>
              <GeneralGroup />
            </SettingsGroup>
            <SettingsGroup title={t("settings:groups.permission")}>
              <PermissionsGroup />
            </SettingsGroup>
            <SettingsGroup title={t("settings:groups.storage")}>
              <StorageGroup />
            </SettingsGroup>
            <SettingsGroup title={t("settings:groups.notification")}>
              <NotificationsGroup />
            </SettingsGroup>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
