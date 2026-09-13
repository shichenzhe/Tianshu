/**
 * 资产拖拽上传区（spec §6.4）：包裹面板内容，文件拖入显示虚线覆盖层，
 * 拖出隐藏；drop 经 preload 暴露的 window.filePath.getPathForFile（File.path
 * 的官方替代）解析本地绝对路径后回调 onFiles（空路径过滤，解析失败的
 * 目录项交由后端 upload failed 收集兜底）。
 * 覆盖层进出子元素不闪烁：dragenter/dragleave 成对冒泡计数（进出各 ±1），
 * 覆盖层自身 pointer-events-none 不成为事件目标。
 */
import { useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

interface AssetUploadDropZoneProps {
  children: ReactNode;
  /** 拖放解析出的本地绝对路径（至少一项，空串已过滤） */
  onFiles: (absPaths: string[]) => void;
}

/** 拖拽负载是否含文件（文本选择等非文件拖拽忽略） */
function hasFilePayload(event: ReactDragEvent): boolean {
  const types = event.dataTransfer?.types;
  return !!types && Array.from(types).includes("Files");
}

export default function AssetUploadDropZone({
  children,
  onFiles,
}: AssetUploadDropZoneProps) {
  const { t } = useTranslation(["project"]);
  const [dragging, setDragging] = useState(false);
  /** 当前拖拽深度（进入子元素 +1 / 离开 -1，归零才算真正离开区域） */
  const dragDepth = useRef(0);

  const resetDrag = () => {
    dragDepth.current = 0;
    setDragging(false);
  };

  const handleDragEnter = (event: ReactDragEvent) => {
    if (!hasFilePayload(event)) {
      return;
    }
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  // dragover 阻止默认行为是 drop 生效的前提（浏览器否则直接打开文件）
  const handleDragOver = (event: ReactDragEvent) => {
    if (!hasFilePayload(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: ReactDragEvent) => {
    if (!hasFilePayload(event)) {
      return;
    }
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setDragging(false);
    }
  };

  const handleDrop = (event: ReactDragEvent) => {
    event.preventDefault();
    resetDrag();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) {
      return;
    }
    const absPaths = files
      .map((file) => window.filePath.getPathForFile(file))
      .filter((path) => path !== "");
    if (absPaths.length > 0) {
      onFiles(absPaths);
    }
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      {dragging && (
        <div
          className={cn(
            "pointer-events-none absolute inset-2 z-10 flex items-center",
            "justify-center rounded-lg border-2 border-dashed border-primary/50",
            "bg-primary-subtle",
          )}
        >
          <span className="text-sm font-medium text-primary">
            {t("project:assets.dropHere")}
          </span>
        </div>
      )}
    </div>
  );
}
