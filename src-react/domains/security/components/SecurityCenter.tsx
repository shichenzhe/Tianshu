/**
 * 安全中心首页（SP1 spec §9）：Dialog 内视图栈（首页 ↔ 审计全列表；
 * SP2-SP5 的三个二级页后续并入同一视图栈）。配置一次拉取、子卡片
 * 乐观保存（useSaveOrRevert 兜底回滚），照 app-settings 惯例。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import { SecurityApi } from "../api/security.api";
import { useSaveOrRevert } from "@/domains/app-settings/model/use-save-or-revert";
import SandboxCard from "./SandboxCard";
import DataSafetyCard from "./DataSafetyCard";
import AuditCenter from "./AuditCenter";
import SettingsGroup from "@/domains/app-settings/components/SettingsGroup";

type SecurityView = "home" | "audit-all";

export default function SecurityCenter() {
  const { t } = useTranslation(["security"]);
  const saveOrRevert = useSaveOrRevert();
  const [config, setConfig] = useState<SecurityConfig | null>(null);
  const [view, setView] = useState<SecurityView>("home");

  useEffect(() => {
    SecurityApi.getConfig()
      .then((state) => setConfig(state.config))
      .catch(() => setConfig(null));
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

  if (config === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("security:loadFailed")}
      </p>
    );
  }

  if (view === "audit-all") {
    return (
      <div className="p-1">
        <AuditCenter embedded={false} onBack={() => setView("home")} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsGroup title={t("security:sandbox.title")}>
        <SandboxCard config={config} onToggle={updateConfig} />
      </SettingsGroup>
      <SettingsGroup title={t("security:dataSafety.title")}>
        <DataSafetyCard config={config} onUpdate={updateConfig} />
      </SettingsGroup>
      <SettingsGroup title={t("security:audit.title")}>
        <AuditCenter embedded onOpenAll={() => setView("audit-all")} />
      </SettingsGroup>
    </div>
  );
}
