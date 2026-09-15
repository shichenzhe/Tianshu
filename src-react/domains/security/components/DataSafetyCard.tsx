/**
 * 数据安全卡片（SP1 spec §9.2）：备份开关/配额展示/打开目录、
 * 删除保护开关、批量删除阈值（失焦保存，非法值还原并提示）。
 * 纯持久化——执行层（备份/回收站/审批）SP4 接入。
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import { SecurityApi } from "../api/security.api";

interface DataSafetyCardProps {
  config: SecurityConfig;
  onUpdate: (key: SecurityConfigKey, value: unknown) => void;
}

function SwitchRow({
  labelKey,
  descKey,
  checked,
  onChange,
}: {
  labelKey: string;
  descKey: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useTranslation(["security"]);
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label className="text-sm font-normal">{t(labelKey)}</Label>
        <p className="text-xs text-muted-foreground">{t(descKey)}</p>
      </div>
      <Switch
        aria-label={t(labelKey)}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}

export default function DataSafetyCard({
  config,
  onUpdate,
}: DataSafetyCardProps) {
  const { t } = useTranslation(["security"]);
  const [threshold, setThreshold] = useState(
    String(config.bulkDeleteThreshold),
  );
  const thresholdRef = useRef(config.bulkDeleteThreshold);

  /** 失焦保存：1–99999 整数，非法还原 + toast；保存后以服务端 normalize 回显 */
  const saveThreshold = () => {
    const n = Number(threshold);
    if (!Number.isInteger(n) || n < 1 || n > 99999) {
      setThreshold(String(thresholdRef.current));
      toast.error(t("security:dataSafety.invalidThreshold"));
      return;
    }
    SecurityApi.setConfig("bulkDeleteThreshold", n)
      .then((saved) => {
        thresholdRef.current = saved.bulkDeleteThreshold;
        setThreshold(String(saved.bulkDeleteThreshold));
      })
      .catch(() => toast.error(t("security:error.saveFailed")));
  };

  return (
    <div className="space-y-5">
      <SwitchRow
        labelKey="security:dataSafety.backup"
        descKey="security:dataSafety.backupDesc"
        checked={config.fileBackupEnabled}
        onChange={(v) => onUpdate("fileBackupEnabled", v)}
      />
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {t("security:dataSafety.quota", { size: config.fileBackupMaxSizeMB })}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() =>
            SecurityApi.openBackupDir().catch(() =>
              toast.error(t("security:error.saveFailed")),
            )
          }
        >
          <FolderOpen size={14} />
          {t("security:dataSafety.openBackupDir")}
        </Button>
      </div>
      <SwitchRow
        labelKey="security:dataSafety.deleteProtection"
        descKey="security:dataSafety.deleteProtectionDesc"
        checked={config.deleteProtection}
        onChange={(v) => onUpdate("deleteProtection", v)}
      />
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label className="text-sm font-normal">
            {t("security:dataSafety.bulkThreshold")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("security:dataSafety.bulkThresholdDesc")}
          </p>
        </div>
        <Input
          aria-label={t("security:dataSafety.bulkThreshold")}
          type="number"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          onBlur={saveThreshold}
          className="w-24 text-right"
        />
      </div>
    </div>
  );
}
