/**
 * 网络安全二级页（SP5 spec §6/§7）：内置恶意域只读区 + 用户允许/拒绝名单 CRUD +
 * 断网与恶意拦截开关 + 子进程覆盖边界提示。
 */
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import { SecurityApi } from "../api/security.api";
import RuleSection from "./RuleSection";
import { validateNonEmpty } from "./validators";

interface NetworkDetailViewProps {
  config: SecurityConfig;
  defaults: { maliciousDomains: string[] };
  onBack: () => void;
  onRulesChange: (config: SecurityConfig) => void;
  onToggle: (key: SecurityConfigKey, value: unknown) => void;
}

export default function NetworkDetailView({
  config,
  defaults,
  onBack,
  onRulesChange,
  onToggle,
}: NetworkDetailViewProps) {
  const { t } = useTranslation(["security"]);
  const save = async (key: SecurityConfigKey, items: string[]) => {
    try {
      onRulesChange(await SecurityApi.setConfig(key, items));
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  const switches: {
    labelKey: string;
    descKey: string;
    k: "blockAllNetwork" | "maliciousDomainProtection";
  }[] = [
    {
      labelKey: "security:networkDetail.blockAllNetwork",
      descKey: "security:networkDetail.blockAllNetworkDesc",
      k: "blockAllNetwork",
    },
    {
      labelKey: "security:networkDetail.malicious",
      descKey: "security:networkDetail.maliciousDesc",
      k: "maliciousDomainProtection",
    },
  ];
  return (
    <div className="space-y-6">
      <h3 className="text-sm font-medium">
        {t("security:networkDetail.title")}
      </h3>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft size={14} />
        {t("security:audit.back")}
      </Button>
      <p className="text-xs text-muted-foreground">
        {t("security:networkDetail.priorityNote")}
      </p>
      {switches.map(({ labelKey, descKey, k }) => (
        <div key={k} className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm font-normal">{t(labelKey)}</Label>
            <p className="text-xs text-muted-foreground">{t(descKey)}</p>
          </div>
          <Switch
            aria-label={t(labelKey)}
            checked={config[k]}
            onCheckedChange={(checked) => onToggle(k, checked)}
          />
        </div>
      ))}
      <RuleSection
        titleKey="security:networkDetail.denylist.title"
        descKey="security:networkDetail.denylist.desc"
        placeholderKey="security:networkDetail.denylist.placeholder"
        invalidKey="security:invalidEntry"
        items={config.domainDeny}
        validate={validateNonEmpty}
        onSave={(items) => save("domainDeny", items)}
      />
      <RuleSection
        titleKey="security:networkDetail.allowlist.title"
        descKey="security:networkDetail.allowlist.desc"
        placeholderKey="security:networkDetail.allowlist.placeholder"
        invalidKey="security:invalidEntry"
        items={config.domainAllow}
        validate={validateNonEmpty}
        onSave={(items) => save("domainAllow", items)}
      />
      <section className="space-y-2">
        <div>
          <h4 className="text-sm font-medium">
            {t("security:networkDetail.builtin.title")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t("security:networkDetail.builtin.desc")}
          </p>
        </div>
        <details className="space-y-1">
          <summary className="cursor-pointer text-xs text-primary">
            {t("security:networkDetail.builtin.expand", {
              count: defaults.maliciousDomains.length,
            })}
          </summary>
          {defaults.maliciousDomains.map((item) => (
            <div key={item} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {item}
              </span>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {t("security:networkDetail.builtinTag")}
              </Badge>
            </div>
          ))}
        </details>
      </section>
      <p className="text-xs text-muted-foreground">
        {t("security:networkDetail.boundaryNote")}
      </p>
    </div>
  );
}
