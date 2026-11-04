/**
 * 安全中心首页（SP1 spec §9）：Dialog 内视图栈（首页 ↔ 审计全列表 ↔
 * 命令/文件/网络安全二级页，SP5 网络页并入同一视图栈）。配置
 * 一次拉取、子卡片乐观保存（useSaveOrRevert 兜底回滚），照 app-settings
 * 惯例。加载三态：null=拉取中（显示 loading）、loadFailed=失败、否则渲染。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  SecurityConfig,
  SecurityConfigKey,
  SecurityConfigState,
} from "../model/types";
import { SecurityApi } from "../api/security.api";
import { useSaveOrRevert } from "@/domains/app-settings/model/use-save-or-revert";
import SandboxCard from "./SandboxCard";
import DataSafetyCard from "./DataSafetyCard";
import SystemGrantCard from "./SystemGrantCard";
import AuditCenter from "./AuditCenter";
import CommandDetailView from "./CommandDetailView";
import FileDetailView from "./FileDetailView";
import NetworkDetailView from "./NetworkDetailView";
import RuntimeDetailView from "./RuntimeDetailView";
import SettingsGroup from "@/domains/app-settings/components/SettingsGroup";

type SecurityView =
  "home" | "audit-all" | "command" | "file" | "network" | "runtime";

export default function SecurityCenter() {
  const { t } = useTranslation(["security"]);
  const saveOrRevert = useSaveOrRevert();
  const [config, setConfig] = useState<SecurityConfig | null>(null);
  const [defaults, setDefaults] = useState<
    SecurityConfigState["defaults"] | null
  >(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [view, setView] = useState<SecurityView>("home");

  useEffect(() => {
    SecurityApi.getConfig()
      .then((state) => {
        setConfig(state.config);
        setDefaults(state.defaults);
      })
      .catch(() => setLoadFailed(true));
  }, []);

  /** 单 key 乐观保存：本地先改，失败回滚并 toast（useSaveOrRevert） */
  const updateConfig = useCallback(
    (key: SecurityConfigKey, value: unknown) => {
      if (!config) return;
      const before = config;
      setConfig({ ...config, [key]: value } as SecurityConfig);
      saveOrRevert(
        SecurityApi.setConfig(key, value).then((saved) => setConfig(saved)),
        () => setConfig(before),
      );
    },
    [config, saveOrRevert],
  );

  if (loadFailed) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("security:loadFailed")}
      </p>
    );
  }

  if (config === null) {
    return (
      <p className="text-sm text-muted-foreground">{t("common:loading")}</p>
    );
  }

  if (view === "audit-all") {
    return (
      <div className="p-1">
        <AuditCenter embedded={false} onBack={() => setView("home")} />
      </div>
    );
  }

  if (view === "command") {
    return (
      <div className="p-1">
        <CommandDetailView
          config={config}
          onBack={() => setView("home")}
          onRulesChange={setConfig}
        />
      </div>
    );
  }

  if (view === "file") {
    return (
      <div className="p-1">
        <FileDetailView
          config={config}
          defaults={defaults ?? { fileBlocklist: [] }}
          onBack={() => setView("home")}
          onRulesChange={setConfig}
        />
      </div>
    );
  }

  if (view === "network") {
    return (
      <div className="p-1">
        <NetworkDetailView
          config={config}
          defaults={
            defaults ?? {
              fileBlocklist: [],
              maliciousDomains: [],
              builtinTools: [],
            }
          }
          onBack={() => setView("home")}
          onRulesChange={setConfig}
          onToggle={updateConfig}
        />
      </div>
    );
  }

  if (view === "runtime") {
    return (
      <div className="p-1">
        <RuntimeDetailView
          config={config}
          defaults={
            defaults ?? {
              fileBlocklist: [],
              maliciousDomains: [],
              builtinTools: [],
            }
          }
          onBack={() => setView("home")}
          onToggle={updateConfig}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsGroup title={t("security:sandbox.title")}>
        <SandboxCard
          config={config}
          onToggle={updateConfig}
          onOpenCommand={() => setView("command")}
          onOpenFile={() => setView("file")}
          onOpenNetwork={() => setView("network")}
          onOpenRuntime={() => setView("runtime")}
        />
      </SettingsGroup>
      <SettingsGroup title={t("security:dataSafety.title")}>
        <DataSafetyCard config={config} onUpdate={updateConfig} />
      </SettingsGroup>
      <SettingsGroup title={t("security:systemGrant.title")}>
        <SystemGrantCard />
      </SettingsGroup>
      <SettingsGroup title={t("security:audit.title")}>
        <AuditCenter embedded onOpenAll={() => setView("audit-all")} />
      </SettingsGroup>
    </div>
  );
}
