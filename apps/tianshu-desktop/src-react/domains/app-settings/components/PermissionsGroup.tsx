/**
 * 权限组：锁屏运行 / 开机自启 / 网络代理（三态；自定义展开 host/port 表单）/
 * 自动安装可信技能 / 技能自动更新
 * - 锁屏运行/开机自启走专有通道（系统实时态为唯一事实源）
 * - 其余开关初始值来自 getAll（option 表），勾选即 settings:set 持久化
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  SettingsApi,
  type ProxyMode,
  type SettingItem,
} from "../api/settings.api";
import { parseBoolOption, toOptionMap } from "../model/app-options";
import { useSaveOrRevert } from "../model/use-save-or-revert";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SettingSwitchRow from "./SettingSwitchRow";

/** 代理模式下拉文案 key（value 与后端 ProxyMode 对齐） */
const PROXY_MODE_LABEL_KEYS: Record<ProxyMode, string> = {
  direct: "settings:permission.proxyDirect",
  system: "settings:permission.proxySystem",
  proxy: "settings:permission.proxyCustom",
};

/** option 表设置项名（与后端 OPTION_NAMES 对齐） */
const AUTO_INSTALL_KEY = "autoInstallTrustedSkills";
const AUTO_UPDATE_KEY = "autoUpdateSkills";

/** 端口输入合法性：非空且为 1-65535 整数 */
function isPortInputValid(port: string): boolean {
  const value = Number(port.trim());
  return Number.isInteger(value) && value > 0 && value < 65536;
}

/** 代理模式字符串归一（缺失/非法回退 system，与后端 parseProxyMode 同语义） */
function normalizeProxyMode(raw: string | undefined): ProxyMode {
  return raw === "direct" || raw === "proxy" || raw === "system"
    ? raw
    : "system";
}

export default function PermissionsGroup() {
  const { t } = useTranslation(["settings", "common"]);
  const saveOrRevert = useSaveOrRevert();
  const [keepAwake, setKeepAwake] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [autoInstall, setAutoInstall] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [proxyMode, setProxyMode] = useState<ProxyMode>("system");
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState("");
  const [proxySaving, setProxySaving] = useState(false);

  // 初始载入：option 键值 + 系统实时态（自启/防休眠）一次拉齐；失败不阻塞面板
  useEffect(() => {
    let active = true;
    Promise.all([
      SettingsApi.getAll(),
      SettingsApi.getAutoLaunch(),
      SettingsApi.getKeepAwake(),
    ])
      .then(([items, autoLaunchOn, keepAwakeOn]) => {
        if (active) {
          applyLoadedOptions(items, autoLaunchOn, keepAwakeOn);
        }
      })
      .catch(() => toast.error(t("settings:error.loadFailed")));
    return () => {
      active = false;
    };
  }, []);

  /** 载入结果一次性落到各状态（缺省：技能开关关、代理 system） */
  const applyLoadedOptions = (
    items: SettingItem[],
    autoLaunchOn: boolean,
    keepAwakeOn: boolean,
  ) => {
    const options = toOptionMap(items);
    setAutoLaunch(autoLaunchOn);
    setKeepAwake(keepAwakeOn);
    setAutoInstall(parseBoolOption(options[AUTO_INSTALL_KEY], false));
    setAutoUpdate(parseBoolOption(options[AUTO_UPDATE_KEY], false));
    setProxyMode(normalizeProxyMode(options.proxyMode));
    setProxyHost(options.proxyHost ?? "");
    setProxyPort(options.proxyPort ?? "");
  };

  const toggleKeepAwake = (enabled: boolean) => {
    setKeepAwake(enabled);
    saveOrRevert(SettingsApi.setKeepAwake(enabled), () =>
      setKeepAwake(!enabled),
    );
  };

  const toggleAutoLaunch = (enabled: boolean) => {
    setAutoLaunch(enabled);
    saveOrRevert(SettingsApi.setAutoLaunch(enabled), () =>
      setAutoLaunch(!enabled),
    );
  };

  /** option 型开关：勾选即以字符串布尔持久化 */
  const makeOptionToggle =
    (key: string, setFlag: (on: boolean) => void) => (enabled: boolean) => {
      setFlag(enabled);
      saveOrRevert(SettingsApi.set(key, String(enabled)), () =>
        setFlag(!enabled),
      );
    };

  /** 直连/跟随系统切换即保存；自定义先展开表单由「保存」提交 */
  const changeProxyMode = (mode: ProxyMode) => {
    if (mode === proxyMode) {
      return;
    }
    const previous = proxyMode;
    setProxyMode(mode);
    if (mode !== "proxy") {
      saveOrRevert(SettingsApi.setProxy(mode), () => setProxyMode(previous));
    }
  };

  const proxyValid = proxyHost.trim() !== "" && isPortInputValid(proxyPort);

  /** 提交自定义代理：成功后归一展示（去空格/端口数字化） */
  const saveProxy = () => {
    setProxySaving(true);
    const host = proxyHost.trim();
    const port = Number(proxyPort.trim());
    SettingsApi.setProxy("proxy", host, port)
      .then(() => {
        setProxyHost(host);
        setProxyPort(String(port));
      })
      .catch(() => toast.error(t("settings:error.saveFailed")))
      .finally(() => setProxySaving(false));
  };

  return (
    <>
      <SettingSwitchRow
        label="settings:permission.keepAwake"
        description="settings:permission.keepAwakeDesc"
        checked={keepAwake}
        onCheckedChange={toggleKeepAwake}
      />
      <SettingSwitchRow
        label="settings:permission.autoLaunch"
        description="settings:permission.autoLaunchDesc"
        checked={autoLaunch}
        onCheckedChange={toggleAutoLaunch}
      />
      <SettingSwitchRow
        label="settings:permission.autoInstallTrustedSkills"
        description="settings:permission.autoInstallTrustedSkillsDesc"
        checked={autoInstall}
        onCheckedChange={makeOptionToggle(AUTO_INSTALL_KEY, setAutoInstall)}
      />
      <SettingSwitchRow
        label="settings:permission.autoUpdateSkills"
        description="settings:permission.autoUpdateSkillsDesc"
        checked={autoUpdate}
        onCheckedChange={makeOptionToggle(AUTO_UPDATE_KEY, setAutoUpdate)}
      />
      {/* 网络代理：三态下拉；自定义时展开 host/port 表单 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm font-normal">
            {t("settings:permission.proxy")}
          </Label>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="w-40 justify-between font-normal hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              >
                {t(PROXY_MODE_LABEL_KEYS[proxyMode])}
                <ChevronDown className="h-4 w-4 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-40 border border-border/50 rounded-lg shadow-lg"
            >
              {(Object.keys(PROXY_MODE_LABEL_KEYS) as ProxyMode[]).map(
                (mode) => (
                  <DropdownMenuItem
                    key={mode}
                    onClick={() => changeProxyMode(mode)}
                    className="cursor-pointer"
                  >
                    {t(PROXY_MODE_LABEL_KEYS[mode])}
                    {mode === proxyMode && (
                      <Check className="ml-auto h-4 w-4 text-primary" />
                    )}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {proxyMode === "proxy" && (
          <div className="flex items-end gap-2 rounded-md bg-muted/40 p-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label
                htmlFor="proxy-host"
                className="text-xs font-normal text-muted-foreground"
              >
                {t("settings:permission.proxyHost")}
              </Label>
              <Input
                id="proxy-host"
                value={proxyHost}
                onChange={(e) => setProxyHost(e.target.value)}
                className="h-8"
              />
            </div>
            <div className="w-24 space-y-1.5">
              <Label
                htmlFor="proxy-port"
                className="text-xs font-normal text-muted-foreground"
              >
                {t("settings:permission.proxyPort")}
              </Label>
              <Input
                id="proxy-port"
                value={proxyPort}
                inputMode="numeric"
                onChange={(e) => setProxyPort(e.target.value)}
                className="h-8"
              />
            </div>
            <Button
              size="sm"
              disabled={!proxyValid || proxySaving}
              onClick={saveProxy}
            >
              {proxySaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common:save")}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
