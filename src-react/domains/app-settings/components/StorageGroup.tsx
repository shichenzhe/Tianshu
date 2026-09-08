/**
 * 存储组：缓存目录占用（三段进度条 + 打开目录）与默认工作空间路径（更改）
 * - storageInfo 异步载入，Loading 期间仅渲染加载提示
 * - 工作空间路径初始值来自 getAll，更改经 pickDirectory 确认后持久化并即时更新
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { SettingsApi, type StorageInfo } from "../api/settings.api";
import { toOptionMap } from "../model/app-options";
import {
  buildBarSegments,
  formatBytes,
  type StorageSegment,
} from "../model/storage-display";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/** 进度条/图例三段视觉（缓存 primary / 其他占用 muted / 可用更浅） */
const SEGMENT_STYLES: Record<StorageSegment["kind"], string> = {
  cache: "bg-primary",
  other: "bg-muted",
  free: "bg-muted/40",
};

/** 图例文案 key */
const SEGMENT_LABEL_KEYS: Record<StorageSegment["kind"], string> = {
  cache: "settings:storage.cacheLegend",
  other: "settings:storage.otherLegend",
  free: "settings:storage.freeLegend",
};

const WORKSPACE_PATH_KEY = "workspacePath";

/** 三段占用条 + 图例 + 已用/总量数值 */
function StorageBar({ info }: { info: StorageInfo }) {
  const { t } = useTranslation(["settings"]);
  const segments = buildBarSegments(info);
  const visibleSegments = segments.filter(
    (segment) => segment.kind === "cache" || segment.bytes > 0,
  );
  const usedBytes = segments.reduce(
    (sum, segment) => (segment.kind === "free" ? sum : sum + segment.bytes),
    0,
  );
  return (
    <div className="space-y-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-border/50">
        {segments.map((segment) => (
          <div
            key={segment.kind}
            className={SEGMENT_STYLES[segment.kind]}
            style={{ width: `${(segment.ratio * 100).toFixed(1)}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {info.diskTotal > 0 && (
          <span>
            {t("settings:storage.diskCaption", {
              used: formatBytes(usedBytes),
              total: formatBytes(info.diskTotal),
            })}
          </span>
        )}
        {visibleSegments.map((segment) => (
          <span key={segment.kind} className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${SEGMENT_STYLES[segment.kind]}`}
            />
            {t(SEGMENT_LABEL_KEYS[segment.kind])} · {formatBytes(segment.bytes)}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function StorageGroup() {
  const { t } = useTranslation(["settings", "common"]);
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [picking, setPicking] = useState(false);

  // 初始载入：存储信息与工作空间路径并行拉取，失败 toast 不阻塞面板
  useEffect(() => {
    let active = true;
    Promise.all([SettingsApi.storageInfo(), SettingsApi.getAll()])
      .then(([storage, items]) => {
        if (!active) {
          return;
        }
        setInfo(storage);
        setWorkspacePath(toOptionMap(items)[WORKSPACE_PATH_KEY] ?? "");
      })
      .catch(() => toast.error(t("settings:error.loadFailed")))
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const openCacheDirectory = () => {
    if (!info) {
      return;
    }
    SettingsApi.openDirectory(info.userDataPath).catch(() =>
      toast.error(t("settings:error.openFailed")),
    );
  };

  /** 选择目录：取消（null）静默返回；确认则持久化并即时更新展示 */
  const changeWorkspacePath = () => {
    setPicking(true);
    SettingsApi.pickDirectory()
      .then((directory) => persistWorkspacePath(directory))
      .catch(() => toast.error(t("settings:error.saveFailed")))
      .finally(() => setPicking(false));
  };

  const persistWorkspacePath = (directory: string | null) => {
    if (!directory) {
      return Promise.resolve();
    }
    return SettingsApi.set(WORKSPACE_PATH_KEY, directory).then(() =>
      setWorkspacePath(directory),
    );
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("common:loading")}
      </div>
    );
  }

  return (
    <>
      {/* 缓存目录：说明 + userData 路径 + 三段占用条 + 打开目录 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm font-normal">
              {t("settings:storage.cacheDirectory")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings:storage.cacheDirectoryDesc")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            disabled={!info}
            onClick={openCacheDirectory}
          >
            {t("settings:storage.openDirectory")}
          </Button>
        </div>
        {info && (
          <div className="space-y-2">
            <p className="break-all text-xs text-muted-foreground">
              {info.userDataPath}
            </p>
            <StorageBar info={info} />
          </div>
        )}
      </div>

      {/* 默认工作空间路径 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm font-normal">
              {t("settings:storage.workspacePath")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings:storage.workspacePathDesc")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            disabled={picking}
            onClick={changeWorkspacePath}
          >
            {picking && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("settings:storage.change")}
          </Button>
        </div>
        <p className="break-all text-xs text-muted-foreground">
          {workspacePath || t("settings:storage.workspaceNotSet")}
        </p>
      </div>
    </>
  );
}
