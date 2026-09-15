/**
 * 设置面板对话框
 * 左栏固定宽导航（通用/个性化/记忆与进化/外观/快捷键/安全中心六页），右栏按导航
 * 整页切换：通用页四分组（常规/权限/存储/通知）、其余页各自整页
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Keyboard,
  Lightbulb,
  Palette,
  Settings,
  Shield,
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
import SecurityCenter from "@/domains/security/components/SecurityCenter";
import SettingsGroup from "./SettingsGroup";
import GeneralGroup from "./GeneralGroup";
import PermissionsGroup from "./PermissionsGroup";
import StorageGroup from "./StorageGroup";
import NotificationsGroup from "./NotificationsGroup";
import ShortcutsGroup from "./ShortcutsGroup";
import ProfileGroup from "./ProfileGroup";
import MemoryGroup from "./MemoryGroup";
import AppearanceSettings from "./AppearanceSettings";
import {
  useSettingsUiStore,
  type SettingsTab,
} from "../store/settings-ui.store";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 导航项 */
const NAV_ITEMS: { id: SettingsTab; icon: LucideIcon }[] = [
  { id: "general", icon: Settings },
  { id: "profile", icon: UserRound },
  { id: "memory", icon: Lightbulb },
  { id: "appearance", icon: Palette },
  { id: "shortcuts", icon: Keyboard },
  { id: "security", icon: Shield },
];

export default function SettingsDialog({
  open,
  onOpenChange,
}: SettingsDialogProps) {
  const { t } = useTranslation(["settings"]);
  // 入口直达页（如用户菜单「记忆与进化」）：null = 默认 general
  const settingsTab = useSettingsUiStore((s) => s.settingsTab);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  // 打开时定位到入口指定页（tab 只在打开瞬间生效）；关闭统一回退通用页
  // （下次打开不残留快捷键页的搜索/监听状态）
  useEffect(() => {
    if (open) {
      if (settingsTab !== null) {
        setActiveTab(settingsTab);
      }
    } else {
      setActiveTab("general");
    }
  }, [open, settingsTab]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[70vh] p-0 gap-0 flex flex-col overflow-hidden">
        <DialogHeader className="px-6 py-4 pr-12 border-b border-border/50">
          <DialogTitle>{t("settings:title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-1 overflow-hidden">
          {/* 左栏导航 */}
          <nav className="w-44 shrink-0 border-r border-border/50 p-3 space-y-1">
            {NAV_ITEMS.map(({ id, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors",
                  id === activeTab
                    ? "bg-primary-subtle text-primary font-medium"
                    : "cursor-pointer hover:bg-primary-subtle hover:text-primary",
                )}
              >
                <Icon size={14} className="shrink-0" />
                <span className="truncate">{t(`settings:nav.${id}`)}</span>
              </button>
            ))}
          </nav>
          {/* 右栏：按导航整页切换安全中心页/快捷键页/个性化页/记忆页/外观页/通用页 */}
          {activeTab === "security" ? (
            <div className="flex-1 overflow-y-auto p-6">
              <SecurityCenter />
            </div>
          ) : activeTab === "shortcuts" ? (
            <div className="flex-1 overflow-y-auto p-6">
              <ShortcutsGroup />
            </div>
          ) : activeTab === "profile" ? (
            <div className="flex-1 overflow-y-auto p-6">
              <ProfileGroup />
            </div>
          ) : activeTab === "memory" ? (
            <div className="flex-1 overflow-y-auto p-6">
              <MemoryGroup />
            </div>
          ) : activeTab === "appearance" ? (
            <div className="flex-1 overflow-y-auto p-6">
              <AppearanceSettings />
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
