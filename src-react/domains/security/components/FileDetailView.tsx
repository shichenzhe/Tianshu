/**
 * 文件安全二级页（SP3 spec §5）：内置清单只读区（三层防删第 2 层——
 * 展示合并、内置分列不可删）+ 用户黑/白名单 CRUD + 重置为默认。
 */
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import { SecurityApi } from "../api/security.api";
import RuleSection from "./RuleSection";
import { validateNonEmpty } from "./validators";

interface FileDetailViewProps {
  config: SecurityConfig;
  defaults: { fileBlocklist: string[] };
  onBack: () => void;
  onRulesChange: (config: SecurityConfig) => void;
}

export default function FileDetailView({
  config,
  defaults,
  onBack,
  onRulesChange,
}: FileDetailViewProps) {
  const { t } = useTranslation(["security"]);
  const save = async (key: SecurityConfigKey, items: string[]) => {
    try {
      onRulesChange(await SecurityApi.setConfig(key, items));
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  const reset = async () => {
    try {
      onRulesChange(await SecurityApi.resetFileRules());
      toast.success(t("security:fileDetail.resetDone"));
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  return (
    <div className="space-y-6">
      <h3 className="text-sm font-medium">{t("security:fileDetail.title")}</h3>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} />
          {t("security:audit.back")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() => void reset()}
        >
          <RotateCcw size={14} />
          {t("security:fileDetail.reset")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("security:fileDetail.priorityNote")}
      </p>
      <section className="space-y-2">
        <div>
          <h4 className="text-sm font-medium">
            {t("security:fileDetail.builtin.title")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t("security:fileDetail.builtin.desc")}
          </p>
        </div>
        <div className="space-y-1">
          {defaults.fileBlocklist.map((item) => (
            <div key={item} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {item}
              </span>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {t("security:fileDetail.builtinTag")}
              </Badge>
            </div>
          ))}
        </div>
      </section>
      <RuleSection
        titleKey="security:fileDetail.blocklist.title"
        descKey="security:fileDetail.blocklist.desc"
        placeholderKey="security:fileDetail.blocklist.placeholder"
        invalidKey="security:invalidEntry"
        items={config.fileBlocklist}
        validate={validateNonEmpty}
        onSave={(items) => save("fileBlocklist", items)}
      />
      <RuleSection
        titleKey="security:fileDetail.allowlist.title"
        descKey="security:fileDetail.allowlist.desc"
        placeholderKey="security:fileDetail.allowlist.placeholder"
        invalidKey="security:invalidEntry"
        items={config.fileAllowlist}
        validate={validateNonEmpty}
        onSave={(items) => save("fileAllowlist", items)}
      />
    </div>
  );
}
