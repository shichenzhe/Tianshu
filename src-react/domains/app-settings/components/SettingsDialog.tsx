/**
 * 设置面板对话框
 * 左栏固定宽导航（通用/个性化/快捷键为可用页；外观占位禁用），
 * 右栏按导航切换：通用页四分组（常规/权限/存储/通知）、个性化页整页
 * 或快捷键页整页
 */

import { useEffect, useState } from "react";
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
import ShortcutsGroup from "./ShortcutsGroup";
import ProfileGroup from "./ProfileGroup";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 右栏可用页 id（其余导航项为占位禁用） */
type SettingsTabId = "general" | "profile" | "shortcuts";

/** 导航项（disabled = 占位，敬请期待） */
const NAV_ITEMS: {
  id: string;
  icon: LucideIcon;
  disabled: boolean;
}[] = [
  { id: "general", icon: Settings, disabled: false },
  { id: "profile", icon: UserRound, disabled: false },
  { id: "appearance", icon: Palette, disabled: true },
  { id: "shortcuts", icon: Keyboard, disabled: false },
];

export default function SettingsDialog({
  open,
  onOpenChange,
}: SettingsDialogProps) {
  const { t } = useTranslation(["settings"]);
  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");

  // 关闭面板回退通用页（下次打开不残留快捷键页的搜索/监听状态）
  useEffect(() => {
    if (!open) {
      setActiveTab("general");
    }
  }, [open]);

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
                onClick={() => setActiveTab(id as SettingsTabId)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors",
                  id === activeTab
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
          {/* 右栏：按导航切换通用页/个性化页/快捷键页 */}
          {activeTab === "shortcuts" ? (
            <div className="flex-1 overflow-y-auto p-6">
              <ShortcutsGroup />
            </div>
          ) : activeTab === "profile" ? (
            <div className="flex-1 overflow-y-auto p-6">
              <ProfileGroup />
            </div>
          ) : (
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
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
