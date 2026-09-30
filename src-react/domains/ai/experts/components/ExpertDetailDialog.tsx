/**
 * 市场专家详情弹窗：完整描述 + 提示词折叠预览 +
 * 「添加到我的专家」（已添加时禁用）/「添加并对话」双动作
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ExpertMarketItem } from "../data/marketplace";

export default function ExpertDetailDialog({
  item,
  added,
  adding,
  onAdd,
  onAddAndChat,
  onOpenChange,
}: {
  item: ExpertMarketItem | null;
  added: boolean;
  adding: boolean;
  onAdd: () => void;
  onAddAndChat: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [promptOpen, setPromptOpen] = useState(false);
  if (!item) {
    return (
      <Dialog open={false} onOpenChange={onOpenChange}>
        <DialogContent />
      </Dialog>
    );
  }
  const typeLabel =
    item.type === "team"
      ? t("chat:experts.market.typeTeam")
      : t("chat:experts.market.typeExpert");
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-xl leading-none">
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {item.badge && <Badge variant="secondary">{item.badge}</Badge>}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {`${item.subtitle} · ${typeLabel}`}
          </p>
          <p className="text-sm text-foreground">{item.description}</p>
          <div className="flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            onClick={() => setPromptOpen((v) => !v)}
          >
            {promptOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {t("chat:experts.market.systemPromptPreview")}
          </button>
          <p
            className={cn(
              "whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs text-muted-foreground",
              !promptOpen && "hidden",
            )}
          >
            {item.systemPrompt}
          </p>
        </div>
        <DialogFooter>
          {added ? (
            <Button variant="outline" disabled className="gap-1">
              <Check className="h-4 w-4" />
              {t("chat:experts.market.added")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={adding}
                onClick={onAdd}
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              >
                {t("chat:experts.market.addToMine")}
              </Button>
              <Button disabled={adding} onClick={onAddAndChat}>
                {t("chat:experts.market.addAndChat")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
