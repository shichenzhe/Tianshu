/**
 * 审计中心（SP1 spec §9.2）：卡片态（embedded，最近 8 条 + 查看全部/
 * 导出/清空）与全量态（分页 + keyword + 手动刷新），两态均 30s 轮询。
 * eventType → i18n messageKey：events.<点换下划线>，detail JSON 插值；
 * 缺失 key 回落 eventType 原文（旧版本数据向前兼容）。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Download, RefreshCw, Trash2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import i18n from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import type { AuditEntry, AuditListResult } from "../model/types";

const CARD_PAGE_SIZE = 8;
const POLL_INTERVAL_MS = 30_000;

/** eventType → messageKey（command-safety.blocked → command-safety_blocked）；
 *  config.<key>.updated 无逐键词条，统一映射 config_updated（{{key}} 插值） */
export function eventMessageKey(eventType: string): string {
  if (/^config\.(.+)\.updated$/.test(eventType)) {
    return "security:audit.events.config_updated";
  }
  return `security:audit.events.${eventType.replace(/\./g, "_")}`;
}

function parseDetail(detail: string | null): Record<string, unknown> {
  if (!detail) return {};
  try {
    return JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type TFunc = ReturnType<typeof useTranslation>["t"];

function entryText(t: TFunc, entry: AuditEntry): string {
  const key = eventMessageKey(entry.eventType);
  const detail = parseDetail(entry.detail);
  if (!i18n.exists(key)) {
    return entry.eventType;
  }
  const vars = {
    ...detail,
    summary: String(detail.summary ?? detail.command ?? detail.path ?? ""),
    command: String(detail.command ?? ""),
    key: String(detail.key ?? ""),
    requested: String(detail.requested ?? ""),
    path: String(detail.path ?? ""),
    size: String(detail.size ?? ""),
    reason: String(detail.reason ?? ""),
    files: String(detail.files ?? ""),
    error: String(detail.error ?? ""),
    estimated: String(detail.estimated ?? ""),
  };
  return t(key, vars);
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation(["security"]);
  return (
    <div className="flex items-center gap-2 py-1.5 text-xs">
      <Badge variant="outline" className="shrink-0 text-[10px]">
        {t(`security:audit.categories.${entry.category}`)}
      </Badge>
      <span className="min-w-0 flex-1 truncate">{entryText(t, entry)}</span>
      <span className="shrink-0 text-muted-foreground">
        {format(new Date(entry.createdAt), "yyyy/M/d HH:mm:ss")}
      </span>
    </div>
  );
}

export default function AuditCenter({
  embedded,
  onOpenAll,
  onBack,
}: {
  embedded: boolean;
  onOpenAll?: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation(["security"]);
  const [result, setResult] = useState<AuditListResult | null>(null);
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(
    (p: number, kw: string) => {
      SecurityApi.auditList({
        page: p,
        pageSize: embedded ? CARD_PAGE_SIZE : 100,
        keyword: kw || undefined,
      })
        .then(setResult)
        .catch(() => setResult(null));
    },
    [embedded],
  );

  useEffect(() => {
    load(page, keyword);
    // 两态均 30s 轮询（spec §9.2：面板打开期间保持刷新）
    const timer = setInterval(() => load(page, keyword), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, page, keyword, embedded]);

  const totalPages = result
    ? Math.max(1, Math.ceil(result.total / result.pageSize))
    : 1;

  const exportLog = (formatType: "json" | "csv") => {
    SecurityApi.auditExport(formatType)
      .then((r) => {
        if (r.ok && r.filePath) toast.success(r.filePath);
      })
      .catch(() => toast.error(t("security:error.saveFailed")));
  };

  const clearAll = () => {
    SecurityApi.auditClear()
      .then(() => load(1, keyword))
      .catch(() => toast.error(t("security:error.saveFailed")));
  };

  if (result === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("security:audit.empty")}
      </p>
    );
  }

  const listBody = (
    <div className="divide-y divide-border/50">
      {result.entries.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          {t("security:audit.empty")}
        </p>
      ) : (
        result.entries.map((entry) => <AuditRow key={entry.id} entry={entry} />)
      )}
    </div>
  );

  if (embedded) {
    return (
      <div className="space-y-3">
        {listBody}
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onOpenAll}>
            {t("security:audit.viewAll")}
          </Button>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => exportLog("json")}>
              <Download size={14} />
              {t("security:audit.exportJson")}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Trash2 size={14} />
                  {t("security:audit.clear")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("security:audit.clearTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("security:audit.clearDesc")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={clearAll}>
                    {t("common:confirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} />
          {t("security:audit.back")}
        </Button>
        <Input
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setPage(1);
          }}
          placeholder={t("security:audit.searchPlaceholder")}
          className="h-8 max-w-xs"
        />
        <Button variant="ghost" size="sm" onClick={() => load(page, keyword)}>
          <RefreshCw size={14} />
          {t("security:audit.refresh")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => exportLog("csv")}>
          <Download size={14} />
          {t("security:audit.exportCsv")}
        </Button>
      </div>
      {listBody}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {t("security:audit.pageInfo", {
            page,
            totalPages,
            total: result.total,
          })}
        </p>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            {t("security:audit.prev")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("security:audit.next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
