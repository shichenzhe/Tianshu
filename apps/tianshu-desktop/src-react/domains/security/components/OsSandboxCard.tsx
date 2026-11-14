/**
 * 系统沙箱卡片（OS 沙箱 spec §6.2）：OS 级越界写硬网开关——
 * 与「安全策略」卡（应用层判定门）语义无关，独立 key 消歧。
 * 平台不支持（win32/Linux）置灰声明；sandbox-exec 缺失时警示
 * fail-open 透传状态（spec §11.4 可见性缓解）
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SecurityApi } from "../api/security.api";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface OsSandboxCardProps {
  config: SecurityConfig;
  onToggle: (key: SecurityConfigKey, value: unknown) => void;
}

export default function OsSandboxCard({ config, onToggle }: OsSandboxCardProps) {
  const { t } = useTranslation(["security"]);
  const [status, setStatus] = useState<{
    supported: boolean;
    available: boolean;
  } | null>(null);

  useEffect(() => {
    SecurityApi.osSandboxStatus()
      .then(setStatus)
      .catch(() => setStatus({ supported: false, available: false }));
  }, []);

  const unsupported = status !== null && !status.supported;
  const unavailable = status !== null && status.supported && !status.available;
  const disabled = status === null || unsupported || unavailable;

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label className="text-sm font-normal">
          {t("security:osSandbox.enabled")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("security:osSandbox.enabledDesc")}
        </p>
        {unsupported && (
          <p className="text-xs text-muted-foreground">
            {t("security:osSandbox.unsupported")}
          </p>
        )}
        {unavailable && (
          <p className="text-xs text-muted-foreground">
            {t("security:osSandbox.unavailable")}
          </p>
        )}
      </div>
      <Switch
        aria-label={t("security:osSandbox.enabled")}
        checked={config.osSandboxEnabled && !disabled}
        disabled={disabled}
        onCheckedChange={(checked) => onToggle("osSandboxEnabled", checked)}
      />
    </div>
  );
}
