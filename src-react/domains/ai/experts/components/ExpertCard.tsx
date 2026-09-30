/**
 * 市场专家卡：emoji 头像/名称/徽章/身份标签/描述截断/标签胶囊 +
 * 添加三态按钮（同 SkillHubCard 范式）；点卡片主体开详情弹窗
 */
import { useTranslation } from "react-i18next";
import { Check, Loader2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ExpertMarketItem } from "../data/marketplace";

export default function ExpertCard({
  item,
  added,
  adding,
  onAdd,
  onOpenDetail,
}: {
  item: ExpertMarketItem;
  added: boolean;
  adding: boolean;
  onAdd: () => void;
  onOpenDetail: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <Card
      className="flex cursor-pointer flex-col border-border/50 rounded-lg shadow-sm transition-colors hover:border-primary/30"
      onClick={onOpenDetail}
    >
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start gap-2">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-xl leading-none">
            {item.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="truncate text-sm font-medium text-foreground">
                {item.name}
              </p>
              {item.badge && (
                <Badge
                  variant="secondary"
                  className="h-4 shrink-0 px-1.5 text-[10px]"
                >
                  {item.badge}
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {item.subtitle}
            </p>
          </div>
          {added ? (
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
              aria-label={t("chat:experts.market.added")}
            >
              <Check className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={adding}
              aria-label={t("chat:experts.market.add")}
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
            >
              {adding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
        <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
          {item.description}
        </p>
        <div className="mt-auto flex flex-wrap gap-1 pt-1">
          {item.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
