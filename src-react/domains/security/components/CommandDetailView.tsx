/**
 * 命令安全二级页（SP2 spec §7）：三名单 CRUD（PRD 附录交互——添加行
 * → 输入框 → 对勾/叉号）+ 优先级说明 + 重置为默认。
 * CRUD 走 setConfig 整组替换；黑名单仅接受裸程序名。
 */
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  CmdRule,
  SecurityConfig,
  SecurityConfigKey,
} from "../model/types";
import { SecurityApi } from "../api/security.api";
import RuleSection from "./RuleSection";

interface CommandDetailViewProps {
  config: SecurityConfig;
  onBack: () => void;
  onRulesChange: (config: SecurityConfig) => void;
}

/** 黑名单输入校验：裸程序名（无路径分隔符/空白），原样返回或 null */
function validateProgram(raw: string): string | null {
  const v = raw.trim();
  return v !== "" && !/[/\\\s]/.test(v) ? v : null;
}

export default function CommandDetailView({
  config,
  onBack,
  onRulesChange,
}: CommandDetailViewProps) {
  const { t } = useTranslation(["security"]);
  const save = async (key: SecurityConfigKey, value: unknown) => {
    try {
      const saved = await SecurityApi.setConfig(key, value);
      onRulesChange(saved);
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  const reset = async () => {
    try {
      onRulesChange(await SecurityApi.resetCommandRules());
      toast.success(t("security:commandDetail.resetDone"));
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  const toRules = (items: string[]): CmdRule[] =>
    items.map((line) => ({ prefix: line.trim().split(/\s+/) }));
  return (
    <div className="space-y-6">
      <h3 className="text-sm font-medium">
        {t("security:commandDetail.title")}
      </h3>
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
          {t("security:commandDetail.reset")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("security:commandDetail.priorityNote")}
      </p>
      <RuleSection
        titleKey="security:commandDetail.programBlacklist.title"
        descKey="security:commandDetail.programBlacklist.desc"
        placeholderKey="security:commandDetail.programBlacklist.placeholder"
        invalidKey="security:commandDetail.programBlacklist.invalid"
        items={config.programBlacklist}
        validate={validateProgram}
        onSave={(items) => save("programBlacklist", items)}
      />
      <RuleSection
        titleKey="security:commandDetail.allow.title"
        descKey="security:commandDetail.allow.desc"
        placeholderKey="security:commandDetail.allow.placeholder"
        invalidKey="security:commandDetail.invalidCommand"
        items={config.cmdAllow.map((r) => r.prefix.join(" "))}
        validate={(raw) => (raw.trim() !== "" ? raw.trim() : null)}
        onSave={(items) => save("cmdAllow", toRules(items))}
      />
      <RuleSection
        titleKey="security:commandDetail.ask.title"
        descKey="security:commandDetail.ask.desc"
        placeholderKey="security:commandDetail.ask.placeholder"
        invalidKey="security:commandDetail.invalidCommand"
        items={config.cmdAsk.map((r) => r.prefix.join(" "))}
        validate={(raw) => (raw.trim() !== "" ? raw.trim() : null)}
        onSave={(items) => save("cmdAsk", toRules(items))}
      />
    </div>
  );
}
