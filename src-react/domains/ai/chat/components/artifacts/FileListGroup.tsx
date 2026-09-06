/**
 * 产物面板文件分组：轻量折叠（头部 ChevronDown 旋转 + 计数），展开渲染
 * FileListItem 列表；空分组展开时显示"暂无文件"占位
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SessionFile } from "../../lib/artifacts";
import FileListItem from "./FileListItem";

interface FileListGroupProps {
  title: string;
  files: SessionFile[];
  defaultOpen: boolean;
  workspaceId: number;
  onPreview: (file: SessionFile) => void;
}

function FileListGroup({
  title,
  files,
  defaultOpen,
  workspaceId,
  onPreview,
}: FileListGroupProps) {
  const { t } = useTranslation(["chat"]);
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1 rounded px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-primary-subtle hover:text-primary"
      >
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span>{title}</span>
        <span className="tabular-nums">({files.length})</span>
      </button>
      {open &&
        (files.length > 0 ? (
          <ul className="mt-0.5 space-y-0.5 px-1">
            {files.map((file) => (
              <FileListItem
                key={`${file.group}:${file.path}`}
                file={file}
                workspaceId={workspaceId}
                onPreview={onPreview}
              />
            ))}
          </ul>
        ) : (
          <p className="px-3 pb-2 pt-1 text-xs text-muted-foreground">
            {t("chat:artifacts.emptyFiles")}
          </p>
        ))}
    </section>
  );
}

export default FileListGroup;
