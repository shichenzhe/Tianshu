/**
 * 精选场景卡：渐变背景 + 标题 + 推荐专家（头像+名称，取前 3）。
 * 点卡片背景进场景聚合（onOpenScenario）；点专家行开该专家详情
 */
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { ExpertMarketItem, ExpertScenario } from "../data/marketplace";

export default function ScenarioCard({
  scenario,
  experts,
  onOpenScenario,
  onOpenExpert,
}: {
  scenario: ExpertScenario;
  experts: ExpertMarketItem[];
  onOpenScenario: () => void;
  onOpenExpert: (item: ExpertMarketItem) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <div
      className={cn(
        "w-56 shrink-0 cursor-pointer rounded-lg border border-border/50 bg-gradient-to-br p-3 transition-colors hover:border-primary/30",
        scenario.gradient,
      )}
      onClick={onOpenScenario}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-lg leading-none">{scenario.icon}</span>
        <p className="text-sm font-medium text-foreground">
          {t(`chat:experts.scenarios.${scenario.titleKey}`)}
        </p>
      </div>
      <div className="mt-2 space-y-1">
        {experts.slice(0, 3).map((expert) => (
          <button
            key={expert.slug}
            type="button"
            className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-primary-subtle"
            onClick={(e) => {
              e.stopPropagation();
              onOpenExpert(expert);
            }}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs">
              {expert.icon}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {expert.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
