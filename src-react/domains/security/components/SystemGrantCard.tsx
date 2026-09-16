/**
 * 系统授权卡（SP6 spec §4）：首页第四卡——活跃完全访问会话（一键收回）+
 * 工作空间工具记忆（单行撤销/全部撤销）。自取数组件，撤销后本地列表即时
 * 更新并 toast；加载失败按 AuditCenter 惯例回落空态。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SecurityApi } from "../api/security.api";

type FullGrantRow = Awaited<
  ReturnType<typeof SecurityApi.listFullGrants>
>[number];
type RememberedGrantRow = Awaited<
  ReturnType<typeof SecurityApi.listRemembered>
>[number];

/** 确认弹窗（destructive 确认按钮）：trigger 为触发按钮，onConfirm 为确认动作 */
function ConfirmDialog({
  triggerLabel,
  confirmDescKey,
  disabled,
  onConfirm,
}: {
  triggerLabel: string;
  confirmDescKey: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(["security"]);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        >
          {triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("security:systemGrant.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t(confirmDescKey)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={onConfirm}
          >
            {t("common:confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function SystemGrantCard() {
  const { t } = useTranslation(["security"]);
  const [fullGrants, setFullGrants] = useState<FullGrantRow[] | null>(null);
  const [remembered, setRemembered] = useState<RememberedGrantRow[] | null>(
    null,
  );

  useEffect(() => {
    SecurityApi.listFullGrants()
      .then(setFullGrants)
      .catch(() => setFullGrants([]));
    SecurityApi.listRemembered()
      .then(setRemembered)
      .catch(() => setRemembered([]));
  }, []);

  if (fullGrants === null || remembered === null) {
    return (
      <p className="text-sm text-muted-foreground">{t("common:loading")}</p>
    );
  }

  const notifyRevoked = () => toast.success(t("security:systemGrant.revoked"));
  const onRevokeFailed = () => toast.error(t("security:error.saveFailed"));

  const revokeAllFull = () => {
    SecurityApi.revokeAllFull()
      .then(() => {
        setFullGrants([]);
        notifyRevoked();
      })
      .catch(onRevokeFailed);
  };

  const revokeRemembered = (id: number) => {
    SecurityApi.revokeRemembered(id)
      .then(() => {
        setRemembered((rows) => (rows ?? []).filter((row) => row.id !== id));
        notifyRevoked();
      })
      .catch(onRevokeFailed);
  };

  const revokeAllRemembered = () => {
    SecurityApi.revokeAllRemembered()
      .then(() => {
        setRemembered([]);
        notifyRevoked();
      })
      .catch(onRevokeFailed);
  };

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        {t("security:systemGrant.desc")}
      </p>
      <section className="space-y-2">
        <div>
          <h4 className="text-sm font-medium">
            {t("security:systemGrant.fullTitle")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t("security:systemGrant.fullDesc")}
          </p>
        </div>
        <div className="space-y-1">
          {fullGrants.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              {t("security:systemGrant.emptyFull")}
            </p>
          ) : (
            fullGrants.map(({ sessionId, title }) => (
              <div key={sessionId} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {t("security:systemGrant.fullBadge")}
                </Badge>
              </div>
            ))
          )}
        </div>
        <div className="flex justify-end">
          <ConfirmDialog
            triggerLabel={t("security:systemGrant.revokeAllFull")}
            confirmDescKey="security:systemGrant.revokeAllFullConfirm"
            disabled={fullGrants.length === 0}
            onConfirm={revokeAllFull}
          />
        </div>
      </section>
      <section className="space-y-2">
        <div>
          <h4 className="text-sm font-medium">
            {t("security:systemGrant.rememberedTitle")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t("security:systemGrant.rememberedDesc")}
          </p>
        </div>
        <div className="divide-y divide-border/50">
          {remembered.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              {t("security:systemGrant.emptyRemembered")}
            </p>
          ) : (
            remembered.map((row) => (
              <div key={row.id} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {row.workspaceName}
                </span>
                <span className="shrink-0 font-mono text-xs">
                  {row.toolName}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {format(new Date(row.createdAt), "yyyy/M/d HH:mm:ss")}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => revokeRemembered(row.id)}
                >
                  {t("security:systemGrant.revoke")}
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="flex justify-end">
          <ConfirmDialog
            triggerLabel={t("security:systemGrant.revokeAll")}
            confirmDescKey="security:systemGrant.revokeAllConfirm"
            disabled={remembered.length === 0}
            onConfirm={revokeAllRemembered}
          />
        </div>
      </section>
    </div>
  );
}
