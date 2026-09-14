/**
 * 事项附件区（子系统 D spec §2.5）：回形针菜单（上传文件 = pickFiles→
 * AssetApi.upload 至 attachments/ 子目录 / 从资产挑选 = listWorkspaceFiles
 * 列表选择）；chips = 文件名 + 删除（已挂记录删走 removeAttachment 通道并
 * 上抛移除，暂存项仅上抛）。本地任务（projectId null）不渲染。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Paperclip, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { invoke } from "@/lib/ipc";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import AssetApi from "../api/asset.api";
import PlanItemApi, { PLAN_ITEM_ATTACHMENTS_KEY } from "../api/plan-item.api";

/** 附件暂存/已挂统一形状：id 有值 = 已挂库记录（删走通道），无 = 暂存待建 */
export interface PendingAttachment {
  id?: number;
  fileName: string;
  assetPath: string;
}

interface PlanItemAttachmentsProps {
  /** 所属项目 id；null = 本地任务（附件区整体不渲染） */
  projectId: number | null;
  /** 资产空间 workspace id（「从资产挑选」列表数据源） */
  workspaceId?: number;
  /** 编辑目标事项 id（已挂记录删除后失效附件缓存用） */
  planItemId?: number;
  /** 当前附件（已挂 + 暂存） */
  value: PendingAttachment[];
  /** 受控变更上抛（新建暂存/挑选追加、删除移除） */
  onChange: (next: PendingAttachment[]) => void;
}

/** 上传目标子目录（资产空间 workspace 相对路径前缀） */
const ATTACHMENT_FOLDER = "attachments";

/** 菜单行按钮（回形针 Popover 内两项：上传文件 / 从资产挑选） */
function MenuButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 w-full rounded-md px-2 text-left text-xs font-normal transition-colors hover:bg-primary-subtle hover:text-primary"
    >
      {label}
    </button>
  );
}

/** 资产挑选列表：过滤搜索框 + workspace 递归相对路径行，点选上抛路径 */
function AssetPickerList({
  workspaceId,
  onPick,
}: {
  workspaceId?: number;
  onPick: (path: string) => void;
}) {
  const { t } = useTranslation(["project"]);
  const [search, setSearch] = useState("");
  // 与 ChatInput @ 面板同源：5 分钟内复用缓存，未绑定时不可用
  const filesQuery = useQuery({
    queryKey: ["workspace-files", workspaceId],
    queryFn: () =>
      invoke<string[] | null>("file:listWorkspaceFiles", workspaceId),
    enabled: workspaceId !== undefined,
    staleTime: 300_000,
  });
  const keyword = search.trim().toLowerCase();
  const files = (filesQuery.data ?? []).filter(
    (path) => !keyword || path.toLowerCase().includes(keyword),
  );
  return (
    <div className="space-y-2">
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        aria-label={t("project:plan.filterAssets")}
        placeholder={t("project:plan.filterAssets")}
        className="h-8 text-xs"
      />
      <div className="max-h-56 overflow-y-auto">
        {files.map((path) => (
          <button
            key={path}
            type="button"
            onClick={() => onPick(path)}
            className="block w-full truncate rounded-md px-2 py-1 text-left text-xs font-normal transition-colors hover:bg-primary-subtle hover:text-primary"
          >
            {path}
          </button>
        ))}
        {files.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {t("project:plan.noAssetFiles")}
          </p>
        )}
      </div>
    </div>
  );
}

export default function PlanItemAttachments({
  projectId,
  workspaceId,
  planItemId,
  value,
  onChange,
}: PlanItemAttachmentsProps) {
  const { t } = useTranslation(["project", "common"]);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);

  if (projectId === null) {
    return null;
  }

  /** 上传成功条目（后端返回含重名序号的最终名）→ 暂存 chips（无 id） */
  const appendUploaded = (names: string[]) => {
    if (names.length === 0) {
      return;
    }
    onChange([
      ...value,
      ...names.map((name) => ({
        fileName: name,
        assetPath: `${ATTACHMENT_FOLDER}/${name}`,
      })),
    ]);
  };

  /** 上传文件：系统多选 → 拷入资产空间 attachments/ 子目录 */
  const handleUpload = async () => {
    try {
      const absPaths = await AssetApi.pickFiles();
      if (!absPaths || absPaths.length === 0) {
        return;
      }
      const result = await AssetApi.upload(
        projectId,
        ATTACHMENT_FOLDER,
        absPaths,
      );
      appendUploaded(result.uploaded);
      if (result.failed.length > 0) {
        toast.error(t("project:plan.uploadFailed"));
      }
      setOpen(false);
    } catch (error) {
      toast.error(mapIpcError(error));
    }
  };

  /** 从资产挑选：挂 workspace 相对路径（fileName = 路径末段） */
  const handlePick = (path: string) => {
    onChange([
      ...value,
      { fileName: path.split("/").pop() ?? path, assetPath: path },
    ]);
    setOpen(false);
  };

  /** chips 删除：已挂记录走 removeAttachment 通道 + 失效重取，暂存项仅上抛 */
  const handleRemove = async (attachment: PendingAttachment) => {
    if (attachment.id !== undefined) {
      try {
        await PlanItemApi.removeAttachment(attachment.id);
        if (planItemId !== undefined) {
          await queryClient.invalidateQueries({
            queryKey: PLAN_ITEM_ATTACHMENTS_KEY(planItemId),
          });
        }
      } catch (error) {
        toast.error(mapIpcError(error));
        return;
      }
    }
    onChange(value.filter((entry) => entry !== attachment));
  };

  const closeMenu = () => {
    setOpen(false);
    setPicking(false);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium">
          {t("project:plan.attachments")}
        </span>
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (next) {
              setOpen(true);
            } else {
              closeMenu();
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label={t("project:plan.attachments")}
              className="h-7 w-7 p-0 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label={t("project:plan.attachments")}
            className="w-64 rounded-lg border border-border/50 p-2 shadow-lg"
          >
            {picking ? (
              <AssetPickerList workspaceId={workspaceId} onPick={handlePick} />
            ) : (
              <div className="flex flex-col gap-0.5">
                <MenuButton
                  label={t("project:plan.upload")}
                  onClick={() => void handleUpload()}
                />
                <MenuButton
                  label={t("project:plan.pickFromAssets")}
                  onClick={() => setPicking(true)}
                />
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((attachment) => (
            <span
              key={`${attachment.id ?? "pending"}-${attachment.assetPath}`}
              className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-0.5 text-xs"
            >
              {attachment.fileName}
              <button
                type="button"
                aria-label={t("common:close")}
                onClick={() => void handleRemove(attachment)}
                className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
