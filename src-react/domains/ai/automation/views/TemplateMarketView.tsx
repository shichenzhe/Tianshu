// src-react/domains/ai/automation/views/TemplateMarketView.tsx
/** 模版市场:双列卡片,点击复用模板进 CreateTaskDialog(spec §5);
 *  顶行(返回/标题)迁入顶栏（TopBar 中段） */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import * as Icons from "lucide-react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePageHeader } from "@/components/layout/page-header.store";
import { AutomationApi, type TemplateRecord } from "../api/automation.api";
import { camelSlug } from "../lib/camel-slug";
import { CreateTaskDialog } from "../components/CreateTaskDialog";
import { useAutomationStore } from "../store/automation.store";

function TemplateIcon({ name }: { name: string }) {
  const Icon =
    (Icons as unknown as Record<string, Icons.LucideIcon>)[name] ??
    Icons.Sparkles;
  return <Icon className="h-6 w-6 text-primary" />;
}

export default function TemplateMarketView() {
  const { t } = useTranslation(["chat"]);
  const setView = useAutomationStore((s) => s.setView);
  const [selected, setSelected] = useState<TemplateRecord | undefined>();
  const { data: templates = [] } = useQuery({
    queryKey: ["automation", "templates"],
    queryFn: () => AutomationApi.templates(),
  });

  // 顶行（TopBar 中段）：返回 + 标题（AutomationView 的 Tab 工具栏
  // 已在此视图前置空，不叠加）
  usePageHeader({
    leading: (
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setView("list")}
        aria-label={t("chat:automation.template.back")}
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
    ),
    title: (
      <h2 className="truncate text-sm font-medium text-foreground">
        {t("chat:automation.template.marketTitle")}
      </h2>
    ),
  });

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-4">
        {templates.map((tpl) => (
          <button
            key={tpl.slug}
            type="button"
            className="flex flex-col items-start gap-2 rounded-lg border border-border/50 p-4 text-left shadow-sm transition-colors hover:bg-primary-subtle hover:border-primary/30"
            onClick={() => setSelected(tpl)}
          >
            <TemplateIcon name={tpl.icon} />
            <p className="text-sm font-medium text-foreground">
              {t(`chat:automation.templateData.${camelSlug(tpl.slug)}.title`)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(`chat:automation.templateData.${camelSlug(tpl.slug)}.desc`)}
            </p>
          </button>
        ))}
      </div>
      <CreateTaskDialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(undefined)}
        template={selected}
      />
    </div>
  );
}
