/**
 * 单个技能卡片：图标（名称首字符占位）/名称/描述/来源标签；
 * 普通模式右上角 Toggle，批量模式左上角 Checkbox（互斥展示）
 */
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import type { SkillRecord } from "../api/skill.api";

interface SkillCardProps {
  record: SkillRecord;
  batchMode: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
}

export default function SkillCard({
  record,
  batchMode,
  checked,
  onCheckedChange,
  onEnabledChange,
}: SkillCardProps) {
  const { t } = useTranslation(["chat"]);

  return (
    <Card
      className={cn(
        "flex flex-col border-border/50 rounded-lg shadow-sm",
        batchMode && checked && "border-primary/50 bg-primary-subtle/40",
      )}
    >
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start gap-2">
          {batchMode ? (
            <Checkbox
              checked={checked}
              onCheckedChange={(v) => onCheckedChange(v === true)}
              className="mt-1"
              aria-label={record.name}
            />
          ) : (
            <Switch
              checked={record.enabled}
              onCheckedChange={(v) => onEnabledChange(v === true)}
              aria-label={record.name}
            />
          )}
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-sm font-semibold text-primary">
            {record.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {record.name}
            </p>
            <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
              {record.description ?? ""}
            </p>
          </div>
          {["builtin", "market"].includes(record.source) && (
            <Badge variant="secondary" className="shrink-0">
              {t(`chat:skills.source.${record.source}`)}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
