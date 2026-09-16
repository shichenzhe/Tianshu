/**
 * 运行时工具二级页（SP6 spec §5）：13 内置工具按四组（文件/命令/技能/计划）
 * 展示开关——关闭即从注入层剔除，对本机所有 AI 会话与自动化即刻生效；
 * disabledTools 数组保持 BUILTIN_TOOLS 名单序（defaults.builtinTools 序）。
 */
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type {
  BuiltinToolMeta,
  SecurityConfig,
  SecurityConfigKey,
} from "../model/types";

interface RuntimeDetailViewProps {
  config: SecurityConfig;
  defaults: { builtinTools: BuiltinToolMeta[] };
  onBack: () => void;
  onToggle: (key: SecurityConfigKey, value: unknown) => void;
}

const GROUPS: { group: BuiltinToolMeta["group"]; labelKey: string }[] = [
  { group: "file", labelKey: "security:runtimeDetail.groupFile" },
  { group: "command", labelKey: "security:runtimeDetail.groupCommand" },
  { group: "skill", labelKey: "security:runtimeDetail.groupSkill" },
  { group: "plan", labelKey: "security:runtimeDetail.groupPlan" },
];

export default function RuntimeDetailView({
  config,
  defaults,
  onBack,
  onToggle,
}: RuntimeDetailViewProps) {
  const { t } = useTranslation(["security"]);

  /** 增删工具名并保持名单序（defaults.builtinTools 即权威名单序） */
  const toggleTool = (name: string, enabled: boolean) => {
    const disabled = new Set(config.disabledTools);
    if (enabled) {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }
    const order = defaults.builtinTools.map((tool) => tool.name);
    onToggle(
      "disabledTools",
      order.filter((n) => disabled.has(n)),
    );
  };

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-medium">
        {t("security:runtimeDetail.title")}
      </h3>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft size={14} />
        {t("security:audit.back")}
      </Button>
      <p className="text-xs text-muted-foreground">
        {t("security:runtimeDetail.note")}
      </p>
      {GROUPS.map(({ group, labelKey }) => (
        <section key={group} className="space-y-2">
          <h4 className="text-sm font-medium">{t(labelKey)}</h4>
          {defaults.builtinTools
            .filter((tool) => tool.group === group)
            .map((tool) => (
              <div
                key={tool.name}
                className="flex items-center justify-between gap-4"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">{tool.name}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {t(
                        tool.kind === "read"
                          ? "security:runtimeDetail.kindRead"
                          : "security:runtimeDetail.kindWrite",
                      )}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t(`security:runtimeDetail.tools.${tool.name}`)}
                  </p>
                </div>
                <Switch
                  aria-label={t(`security:runtimeDetail.tools.${tool.name}`)}
                  checked={!config.disabledTools.includes(tool.name)}
                  onCheckedChange={(checked) => toggleTool(tool.name, checked)}
                />
              </div>
            ))}
        </section>
      ))}
    </div>
  );
}
