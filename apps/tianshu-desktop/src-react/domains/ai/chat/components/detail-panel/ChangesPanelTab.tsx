/**
 * 查看变更 tab：工作树变更列表（状态徽标 + 刷新）+ 单文件 diff 着色视图
 * （零依赖解析 unified diff）。非 git/未绑定/无变更三空态；untracked
 * 点击提示无 diff（spec R15）。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, FileDiff, RefreshCw } from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import WorkspaceApi, {
  type GitChangeFile,
  type GitFileDiffResult,
  type GitWorkingChanges,
  type WorkspaceRecord,
} from "../../../api/workspace.api";
import { mapIpcError } from "../../lib/error-message";

const STATUS_LABEL: Record<GitChangeFile["status"], string> = {
  modified: "chat:changes.modified",
  added: "chat:changes.added",
  deleted: "chat:changes.deleted",
  renamed: "chat:changes.renamed",
  untracked: "chat:changes.untracked",
};

interface ChangesPanelTabProps {
  workspace: WorkspaceRecord;
}

export default function ChangesPanelTab({ workspace }: ChangesPanelTabProps) {
  const { t } = useTranslation(["chat"]);
  const [changes, setChanges] = useState<GitWorkingChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [diffOf, setDiffOf] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiffResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setChanges(await WorkspaceApi.gitStatus(workspace.id));
    } catch (e) {
      toast.error(mapIpcError(e) || t("chat:changes.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [workspace.id, t]);

  useEffect(() => {
    if (workspace.directoryPath) void load();
  }, [load, workspace.directoryPath]);

  useEffect(() => {
    if (diffOf === null) return;
    let cancelled = false;
    WorkspaceApi.gitDiff(workspace.id, diffOf)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((e) => {
        if (!cancelled)
          toast.error(mapIpcError(e) || t("chat:changes.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [diffOf, workspace.id, t]);

  if (!workspace.directoryPath) {
    return <Empty text={t("chat:changes.noDirectory")} />;
  }
  if (changes === null && loading) {
    return <Empty text={t("chat:detailPanel.loadingDir")} />;
  }
  if (changes?.kind === "not-git") {
    return <Empty text={t("chat:changes.notGit")} />;
  }
  const files = changes?.kind === "ok" ? changes.files : [];

  if (diffOf !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
          <IconTooltip label={t("chat:changes.back")}>
            <button
              type="button"
              aria-label={t("chat:changes.back")}
              onClick={() => {
                setDiffOf(null);
                setDiff(null);
              }}
              className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          </IconTooltip>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {diffOf}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1 font-mono text-[11px] leading-5">
          {diff === null ? (
            <p className="px-2 py-1 text-muted-foreground">
              {t("chat:detailPanel.loadingDir")}
            </p>
          ) : diff.kind === "untracked" ? (
            <p className="px-2 py-1 text-muted-foreground">
              {t("chat:changes.untrackedNoDiff")}
            </p>
          ) : (
            <>
              {diff.text.split("\n").map((line, i) => (
                <DiffLine key={i} line={line} />
              ))}
              {diff.truncated && (
                <p className="px-2 py-1 text-[10px] text-muted-foreground">
                  {t("chat:changes.diffTruncated")}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center border-b border-border/50 px-2 py-1.5">
        <span className="flex-1 text-xs font-medium">
          {t("chat:detailPanel.changes")}
        </span>
        <IconTooltip label={t("chat:changes.refresh")}>
          <button
            type="button"
            aria-label={t("chat:changes.refresh")}
            onClick={() => void load()}
            className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        </IconTooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {files.length === 0 ? (
          <Empty text={t("chat:changes.empty")} />
        ) : (
          <>
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setDiffOf(file.path)}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-primary-subtle hover:text-primary"
              >
                <span
                  className={`shrink-0 rounded px-1 text-[10px] ${
                    file.status === "added" || file.status === "modified"
                      ? "bg-primary-subtle text-primary"
                      : "text-muted-foreground"
                  }`}
                >
                  {t(STATUS_LABEL[file.status])}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {file.path}
                </span>
                {file.staged && (
                  <span className="shrink-0 text-[10px] text-primary">
                    {t("chat:changes.staged")}
                  </span>
                )}
              </button>
            ))}
            {changes?.kind === "ok" && changes.truncated && (
              <p className="px-2 py-1 text-[10px] text-muted-foreground">
                {t("chat:changes.listTruncated")}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DiffLine({ line }: { line: string }) {
  const base = "whitespace-pre-wrap break-all px-2";
  if (line.startsWith("+")) {
    return <p className={`${base} bg-primary-subtle text-primary`}>{line}</p>;
  }
  if (line.startsWith("-")) {
    return <p className={`${base} opacity-60`}>{line}</p>;
  }
  if (
    line.startsWith("@@") ||
    line.startsWith("diff --git") ||
    line.startsWith("index ")
  ) {
    return <p className={`${base} text-muted-foreground`}>{line}</p>;
  }
  return <p className={base}>{line}</p>;
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
      <FileDiff className="h-8 w-8" />
      <p className="text-xs">{text}</p>
    </div>
  );
}
