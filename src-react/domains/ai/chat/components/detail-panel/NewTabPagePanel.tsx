/**
 * 「新标签页」占位 tab 内容页（WorkBuddy newTab 形态）：垂直选项列表，
 * 点击选项将本占位 tab 原地替换为所选类型（replaceTab 保序换 id/kind/
 * 清负载并激活）；关闭占位 tab 即取消。选项图标/词条沿用旧 NewTabMenu
 * 口径（产物项为天枢补充，WorkBuddy 无此项）。
 */
import { useTranslation } from "react-i18next";
import {
  FileDiff,
  FolderTree,
  Globe,
  Package,
  SquareTerminal,
} from "lucide-react";
import type { WorkspaceRecord } from "../../../api/workspace.api";
import {
  useDetailPanelStore,
  type DetailTabKind,
} from "../../store/detail-panel.store";

/** 可替换的目标类型（newTab 自身不可再替换为 newTab；file 只由列表点击
 *  打开——标题为动态文件名，不提供手动新建入口） */
type TargetKind = Exclude<DetailTabKind, "newTab" | "file">;

const KIND_LABEL: Record<TargetKind, string> = {
  artifacts: "chat:detailPanel.openArtifacts",
  browser: "chat:detailPanel.openBrowser",
  workspace: "chat:detailPanel.openWorkspaceFiles",
  terminal: "chat:detailPanel.openTerminal",
  changes: "chat:detailPanel.openChanges",
};

const KIND_ICON: Record<TargetKind, typeof Globe> = {
  artifacts: Package,
  browser: Globe,
  workspace: FolderTree,
  terminal: SquareTerminal,
  changes: FileDiff,
};

interface NewTabPagePanelProps {
  sessionId: number;
  tabId: string;
  /** 当前会话空间记录（工作空间行右侧显示空间名，未绑定为 null 不显示） */
  workspace: WorkspaceRecord | null;
}

export default function NewTabPagePanel({
  sessionId,
  tabId,
  workspace,
}: NewTabPagePanelProps) {
  const { t } = useTranslation(["chat"]);
  const replaceTab = useDetailPanelStore((s) => s.replaceTab);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        {t("chat:detailPanel.newTab")}
      </p>
      {(Object.keys(KIND_LABEL) as TargetKind[]).map((kind) => {
        const Icon = KIND_ICON[kind];
        return (
          <button
            key={kind}
            type="button"
            onClick={() =>
              replaceTab(sessionId, tabId, kind, t(`chat:detailPanel.${kind}`))
            }
            className="flex w-full items-center gap-2 rounded p-2 text-sm text-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              {t(KIND_LABEL[kind])}
            </span>
            {kind === "workspace" && workspace ? (
              <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                {workspace.name}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
