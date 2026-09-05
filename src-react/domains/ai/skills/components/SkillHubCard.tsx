/**
 * 市场技能卡:iconUrl(img onError 回退首字符)/名称/中文描述截断/下载量/
 * 安装按钮三态(已安装 Check 灰态禁用/安装中 Loader 旋转/待安装 + → onInstall)
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { SkillHubSkill } from "../api/skillhub-types";

export default function SkillHubCard({
  skill,
  installed,
  installing,
  onInstall,
}: {
  skill: SkillHubSkill;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const [iconFailed, setIconFailed] = useState(false);
  const description = skill.description_zh || skill.description;

  return (
    <Card className="flex flex-col border-border/50 rounded-lg shadow-sm">
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start gap-2">
          {skill.iconUrl && !iconFailed ? (
            <img
              src={skill.iconUrl}
              alt={skill.name}
              className="h-9 w-9 shrink-0 rounded-lg object-cover"
              onError={() => setIconFailed(true)}
            />
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-sm font-semibold text-primary">
              {skill.name.charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {skill.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("chat:skills.downloads", { count: skill.downloads })}
            </p>
          </div>
          {installed ? (
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
              aria-label={t("chat:skills.installedBadge")}
            >
              <Check className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={installing}
              aria-label={t("chat:skills.addSkill")}
              onClick={onInstall}
            >
              {installing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
        <p className={cn("line-clamp-2 min-h-8 text-xs text-muted-foreground")}>
          {description}
        </p>
      </CardContent>
    </Card>
  );
}
