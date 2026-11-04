/**
 * 通知组：桌面通知（系统授权态分支：未授权→去授权跳系统设置；已授权→测试
 * 通知经主进程 IPC，成功/失败均 toast 可见反馈）、
 * 客户端通知开关、提示音（无音效/默认提示音，选中默认提示音即试听）
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import { toast } from "sonner";

import { SettingsApi } from "../api/settings.api";
import {
  desktopPermission,
  openNotificationSettings,
} from "../model/desktop-notification";
import { parseBoolOption, toOptionMap } from "../model/app-options";
import { useSaveOrRevert } from "../model/use-save-or-revert";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SettingSwitchRow from "./SettingSwitchRow";

/** 提示音选项（value 为 option 表 sound 键取值） */
const SOUND_OPTIONS = [
  { value: "none", labelKey: "settings:notification.soundNone" },
  { value: "default", labelKey: "settings:notification.soundDefault" },
] as const;

/** option 表设置项名 */
const CLIENT_NOTIFICATION_KEY = "clientNotification";
const SOUND_KEY = "sound";

export default function NotificationsGroup() {
  const { t } = useTranslation(["settings", "common"]);
  const saveOrRevert = useSaveOrRevert();
  const [permission] = useState<NotificationPermission>(() =>
    desktopPermission(),
  );
  const [clientOn, setClientOn] = useState(true);
  const [sound, setSound] = useState("none");

  // 初始载入：option 键值（缺失时客户端通知默认开、提示音默认无）
  useEffect(() => {
    let active = true;
    SettingsApi.getAll()
      .then((items) => {
        if (!active) {
          return;
        }
        const options = toOptionMap(items);
        setClientOn(parseBoolOption(options[CLIENT_NOTIFICATION_KEY], true));
        setSound(options[SOUND_KEY] === "default" ? "default" : "none");
      })
      .catch(() => toast.error(t("settings:error.loadFailed")));
    return () => {
      active = false;
    };
  }, []);

  const toggleClient = (enabled: boolean) => {
    setClientOn(enabled);
    saveOrRevert(
      SettingsApi.set(CLIENT_NOTIFICATION_KEY, String(enabled)),
      () => setClientOn(!enabled),
    );
  };

  /** 提示音切换即持久化；选默认提示音顺带 beep 试听（试听失败不影响保存） */
  const changeSound = (next: string) => {
    if (next === sound) {
      return;
    }
    const previous = sound;
    setSound(next);
    if (next === "default") {
      SettingsApi.beep().catch(() => undefined);
    }
    saveOrRevert(SettingsApi.set(SOUND_KEY, next), () => setSound(previous));
  };

  /** 测试通知走主进程 IPC（渲染层在未签名 dev 下被系统静默丢弃），
   * 成功/失败均 toast 给可见反馈（成功文案引导检查系统通知权限） */
  const sendTest = () => {
    SettingsApi.testNotification(
      t("common:appName"),
      t("settings:notification.testBody"),
    )
      .then(() => toast.info(t("settings:notification.testSent")))
      .catch(() => toast.error(t("settings:error.testNotificationFailed")));
  };

  /** 去授权：经主进程白名单桥跳系统设置，失败 toast */
  const authorize = () => {
    openNotificationSettings().catch(() =>
      toast.error(t("settings:error.openExternalFailed")),
    );
  };

  const granted = permission === "granted";
  const currentSound =
    SOUND_OPTIONS.find((option) => option.value === sound) ?? SOUND_OPTIONS[0];

  return (
    <>
      {/* 桌面通知：授权管理在系统层，按授权态分支展示操作 */}
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label className="text-sm font-normal">
            {t("settings:notification.desktop")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("settings:notification.desktopDesc")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t(
              granted
                ? "settings:notification.granted"
                : "settings:notification.notGranted",
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            onClick={granted ? sendTest : authorize}
          >
            {t(
              granted
                ? "settings:notification.testNotification"
                : "settings:notification.authorize",
            )}
          </Button>
        </div>
      </div>

      <SettingSwitchRow
        label="settings:notification.client"
        description="settings:notification.clientDesc"
        checked={clientOn}
        onCheckedChange={toggleClient}
      />

      {/* 提示音 */}
      <div className="flex items-center justify-between gap-4">
        <Label className="text-sm font-normal">
          {t("settings:notification.sound")}
        </Label>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-40 justify-between font-normal hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            >
              {t(currentSound.labelKey)}
              <ChevronDown className="h-4 w-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40 border border-border/50 rounded-lg shadow-lg"
          >
            {SOUND_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onClick={() => changeSound(option.value)}
                className="cursor-pointer"
              >
                {t(option.labelKey)}
                {option.value === sound && (
                  <Check className="ml-auto h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
