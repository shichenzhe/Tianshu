/**
 * 「+」菜单（tab 条行尾，Task 15）：shadcn DropdownMenu（弹层 z-[75]
 * 项目口径，触发器即原占位 + 按钮）——新建 Markdown/文本（唯一名
 * 未命名-{n}：现有 tabs 标题里 未命名-(\d+) 取最大 n+1 → workspace:
 * writeFile 空内容 baselineMtime:null + expectNotExists（终审 I2：唯一
 * 名探测仅扫本窗 tabs，磁盘已有同名抛 FILE_EXISTS → 换名 n+2 重试一次，
 * 仍冲突 toast 放弃，不静默覆写）→ openTab + 回填写盘 mtime）、
 * 打开文件（fileWindow:pickFile 返回相对路径数组逐个 openTab）、最近打开
 * （recentOf ≤10 点击 openTab）。网址 tab 已废止（spec §13 项 2）。
 * 空间来源：首个 workspace tab 所属空间；无则 workspace:list 首个绑定
 * 目录空间（T14 同款过滤）；都无 → 新建/打开禁用 + needWorkspace 提示。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import WorkspaceApi from "@/domains/ai/api/workspace.api";
import { invoke } from "@/lib/ipc";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import {
  dedupeKeyOf,
  useFileWindowStore,
  type FileWindowTab,
} from "../store/file-window.store";
import { recentOf } from "../lib/recent-files";
import { titleOfResource } from "../lib/tab-title";

interface WriteFileResult {
  absPath: string;
  mtime: number;
}

/** 唯一名基数：现有 tabs 标题（workspace=basename）里 未命名-(\d+) 最大 n */
function maxUntitledN(tabs: FileWindowTab[]): number {
  let max = 0;
  for (const tab of tabs) {
    const m = /^未命名-(\d+)/.exec(tab.title);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** 唯一名：基数最大 n + step（缺省 1；FILE_EXISTS 换名重试取 2） */
function nextUntitledPath(
  ext: "md" | "txt",
  tabs: FileWindowTab[],
  step = 1,
): string {
  return `未命名-${maxUntitledN(tabs) + step}.${ext}`;
}

export default function NewTabMenu() {
  const { t } = useTranslation(["chat"]);
  const tabs = useFileWindowStore((s) => s.tabs);
  const [open, setOpen] = useState(false);
  // list 首个绑定目录空间（无 workspace tab 时的空间来源）；checked=已探测
  const [fallbackId, setFallbackId] = useState<number | null>(null);
  const [fallbackChecked, setFallbackChecked] = useState(false);

  const workspaceTab = tabs.find((x) => x.resource.kind === "workspace");
  const workspaceId =
    workspaceTab?.resource.kind === "workspace"
      ? workspaceTab.resource.workspaceId
      : fallbackId;

  // 菜单展开时探测兜底空间（每次会话一次；已有 workspace tab 则跳过）
  useEffect(() => {
    if (!open || workspaceTab || fallbackChecked) return;
    let cancelled = false;
    setFallbackChecked(true);
    WorkspaceApi.list()
      .then((list) => {
        if (!cancelled)
          setFallbackId(
            list.find((w) => !!w.directoryPath?.trim())?.id ?? null,
          );
      })
      .catch(() => {
        if (!cancelled) setFallbackId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceTab, fallbackChecked]);

  const guardWorkspace = (): number | null => {
    if (workspaceId != null) return workspaceId;
    toast.error(t("chat:fileWindow.file.needWorkspace"));
    return null;
  };

  /** 单路径新建写盘（expectNotExists 拒覆写磁盘既有）+ 开 tab 回填基线；
   *  返回 exists 供调用方换名重试，其余失败已 toast 终止 */
  const createAt = async (
    wsId: number,
    path: string,
  ): Promise<"created" | "exists" | "failed"> => {
    try {
      const result = await invoke<WriteFileResult>("workspace:writeFile", {
        workspaceId: wsId,
        path,
        content: "",
        baselineMtime: null,
        expectNotExists: true,
      });
      const { tabId } = useFileWindowStore.getState().openTab({
        kind: "workspace",
        workspaceId: wsId,
        path,
      });
      // 写盘 mtime 落基线（内容区读取 mtime 一致时不再重复吸收）
      useFileWindowStore.getState().patchTab(tabId, {
        baselineMtime: result.mtime,
      });
      return "created";
    } catch (e) {
      if (e instanceof Error && e.message.includes("FILE_EXISTS"))
        return "exists";
      toast.error(mapIpcError(e));
      return "failed";
    }
  };

  const createFile = async (ext: "md" | "txt") => {
    const wsId = guardWorkspace();
    if (wsId == null) return;
    const tabs = useFileWindowStore.getState().tabs;
    if ((await createAt(wsId, nextUntitledPath(ext, tabs))) === "created")
      return;
    // 磁盘已有同名（探测仅扫本窗 tabs）：换名 n+2 重试一次，仍冲突报错放弃
    if ((await createAt(wsId, nextUntitledPath(ext, tabs, 2))) === "exists") {
      toast.error(t("chat:errors.FILE_EXISTS"));
    }
  };

  const openFiles = async () => {
    const wsId = guardWorkspace();
    if (wsId == null) return;
    try {
      const paths = await invoke<string[]>("fileWindow:pickFile", {
        workspaceId: wsId,
      });
      paths.forEach((p) =>
        useFileWindowStore
          .getState()
          .openTab({ kind: "workspace", workspaceId: wsId, path: p }),
      );
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const recents = recentOf();
  const noWorkspace = workspaceId == null && fallbackChecked;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <IconTooltip label={t("chat:fileWindow.tab.new")}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("chat:fileWindow.tab.new")}
            className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-primary"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
      </IconTooltip>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuItem
          disabled={noWorkspace}
          onSelect={() => void createFile("md")}
        >
          {t("chat:fileWindow.file.newMarkdown")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={noWorkspace}
          onSelect={() => void createFile("txt")}
        >
          {t("chat:fileWindow.file.newText")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={noWorkspace}
          onSelect={() => void openFiles()}
        >
          {t("chat:fileWindow.file.openFile")}
        </DropdownMenuItem>
        {noWorkspace && (
          <p className="px-2.5 pb-1.5 text-xs text-muted-foreground">
            {t("chat:fileWindow.file.needWorkspace")}
          </p>
        )}
        {recents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {t("chat:fileWindow.file.recent")}
            </DropdownMenuLabel>
            {recents.map((resource) => (
              <DropdownMenuItem
                key={dedupeKeyOf(resource)}
                className="text-xs"
                onSelect={() => useFileWindowStore.getState().openTab(resource)}
              >
                <span className="max-w-full truncate">
                  {titleOfResource(resource)}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
