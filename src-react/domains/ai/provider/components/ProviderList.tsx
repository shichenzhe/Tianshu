// src-react/domains/ai/provider/components/ProviderList.tsx
/** 左列服务商列表（spec §3.1）：点击即切详情；停用行降透明 + 微标 */
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProviderRecord } from "../../api/provider.api";

export default function ProviderList({
  providers,
  modelCounts,
  selectedId,
  totalModels,
  onSelect,
  onAdd,
}: {
  providers: ProviderRecord[];
  modelCounts: Map<number, number>;
  selectedId: number | null;
  totalModels: number;
  onSelect: (id: number) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation(["ai"]);
  return (
    <div className="flex w-56 shrink-0 flex-col rounded-lg border border-border/50 bg-card">
      <div className="flex items-center border-b border-border/50 px-3 py-2.5">
        <span className="flex-1 text-sm font-medium text-foreground">
          {t("ai:provider.masterTitle")}
        </span>
        <Button size="sm" className="h-7 px-2" onClick={onAdd}>
          <Plus className="h-3 w-3" />
          {t("ai:provider.add")}
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            data-selected={selectedId === provider.id}
            onClick={() => onSelect(provider.id)}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
              selectedId === provider.id
                ? "bg-primary-subtle text-primary"
                : "text-foreground hover:bg-primary-subtle/60"
            } ${provider.enabled ? "" : "opacity-55"}`}
          >
            <span className="flex-1 truncate">{provider.name}</span>
            {!provider.enabled && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t("ai:provider.disabledTag")}
              </span>
            )}
            <span className="shrink-0 rounded-full border border-border/50 px-1.5 text-[10px] text-muted-foreground">
              {modelCounts.get(provider.id) ?? 0}
            </span>
          </button>
        ))}
        {providers.length === 0 && (
          <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
            {t("ai:provider.empty")}
          </p>
        )}
      </div>
      <div className="border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
        {t("ai:provider.summary", {
          providers: providers.length,
          models: totalModels,
        })}
      </div>
    </div>
  );
}
