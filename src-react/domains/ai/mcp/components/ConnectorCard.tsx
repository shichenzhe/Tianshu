/**
 * 市场连接器卡（对齐 SkillHubCard 范式）：lucide 图标主题色块 + 名称 +
 * i18n 描述 line-clamp-3 + 右上三态钮（+ 添加 / Check 已添加禁用——
 * 与 SkillHubCard 的 Loader 态不同：本市场点 + 是同步打开弹窗，无异步过程）
 */
import { useTranslation } from "react-i18next";
import { Check, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { MarketConnector } from "../lib/market-connectors";

export default function ConnectorCard({
  connector,
  added,
  onAdd,
}: {
  connector: MarketConnector;
  added: boolean;
  onAdd: (connector: MarketConnector) => void;
}) {
  const { t } = useTranslation(["ai"]);
  const Icon = connector.icon;
  const label = `${added ? t("ai:mcp.market.added") : t("ai:mcp.market.add")} ${connector.name}`;

  return (
    <Card className="flex flex-col border-border/50 rounded-lg shadow-sm transition-colors hover:border-primary/30">
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between">
          <div className="bg-primary-subtle text-primary flex h-9 w-9 items-center justify-center rounded-lg">
            <Icon className="h-5 w-5" />
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={added}
            aria-label={label}
            className={cn(
              "h-8 w-8 p-0 hover:bg-primary-subtle",
              added ? "text-muted-foreground" : "hover:text-primary",
            )}
            onClick={() => onAdd(connector)}
          >
            {added ? (
              <Check className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </Button>
        </div>
        <p className="text-sm font-medium">{connector.name}</p>
        <p className="line-clamp-3 min-h-10 text-xs leading-5 text-muted-foreground">
          {t(`ai:mcp.connectors.${connector.id}.description`)}
        </p>
      </CardContent>
    </Card>
  );
}
