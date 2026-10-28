/**
 * 存储组：缓存目录占用（三段进度条 + 打开目录）与默认工作空间路径（更改）
 * 与执行历史保留（开关 + 成功/失败保留天数，patch 即存）
 * - storageInfo 异步载入，Loading 期间仅渲染加载提示
 * - 工作空间路径初始值来自 getAll，更改经 pickDirectory 确认后持久化并即时更新
 * - 执行历史保留 traceDays/successKeep/failureKeep 不暴露 UI（option 直改）
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";

import {
  SettingsApi,
  type DataRootInfo,
  type RunRetentionSetting,
  type StorageInfo,
} from "../api/settings.api";
import { toOptionMap } from "../model/app-options";
import {
  buildBarSegments,
  formatBytes,
  type StorageSegment,
} from "../model/storage-display";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

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
  const [dataRoot, setDataRoot] = useState<DataRootInfo | null>(null);
  // 执行历史保留配置（null = 未装载，控件禁用并按默认档展示）
  const [retention, setRetention] = useState<RunRetentionSetting | null>(null);
  // 已写入待重启的配置：面板显示重启横条（数据库须冷迁移，重启生效）
  const [pendingRestart, setPendingRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // 初始载入：存储信息、工作空间路径与执行历史保留并行拉取，失败 toast 不阻塞面板
  useEffect(() => {
    let active = true;
    Promise.all([
      SettingsApi.storageInfo(),
      SettingsApi.getAll(),
      SettingsApi.getDataRoot(),
      SettingsApi.getRunRetention(),
    ])
      .then(([storage, items, root, retentionConfig]) => {
        if (!active) {
          return;
        }
        setInfo(storage);
        setWorkspacePath(toOptionMap(items)[WORKSPACE_PATH_KEY] ?? "");
        setDataRoot(root);
        setRetention(retentionConfig);
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

  /** 保存执行历史保留配置：单字段 patch 乐观更新，失败回滚并提示 */
  const saveRetention = (patch: Partial<RunRetentionSetting>) => {
    if (!retention) {
      return;
    }
    const previous = retention;
    setRetention({ ...retention, ...patch });
    SettingsApi.setRunRetention(patch)
      .then(() => toast.success(t("settings:executionHistory.saved")))
      .catch(() => {
        setRetention(previous);
        toast.error(t("settings:error.saveFailed"));
      });
  };

  /** 后端防护错误码 → 本地化提示（嵌套/相对路径等） */
  const dataRootErrorMessage = (e: unknown): string => {
    const message = e instanceof Error ? e.message : "";
    if (message.includes("DATA_ROOT_NESTED")) {
      return t("settings:storage.dataRootNested");
    }
    if (message.includes("DATA_ROOT_MUST_BE_ABSOLUTE")) {
      return t("settings:storage.dataRootNotAbsolute");
    }
    return t("settings:storage.dataRootSetFailed");
  };

  /** 写入数据根配置（null 恢复默认）：重启后生效，提示横条常驻面板 */
  const applyDataRoot = (directory: string | null) => {
    SettingsApi.setDataRoot(directory)
      .then((root) => {
        setDataRoot(root);
        setPendingRestart(true);
        toast.success(t("settings:storage.dataRootRestartPending"));
      })
      .catch((e: unknown) => toast.error(dataRootErrorMessage(e)));
  };

  /** 修改数据目录：选择器取消静默返回；确认即写配置（防护在主进程侧） */
  const changeDataRoot = () => {
    setPicking(true);
    SettingsApi.pickDirectory()
      .then((directory) => {
        if (directory) {
          applyDataRoot(directory);
        }
      })
      .catch(() => toast.error(t("settings:error.openFailed")))
      .finally(() => setPicking(false));
  };

  const relaunch = () => {
    setRestarting(true);
    SettingsApi.relaunchApp().catch(() => {
      setRestarting(false);
      toast.error(t("settings:storage.relaunchFailed"));
    });
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
      {/* 数据目录：说明 + 数据根路径 + 三段占用条 + 打开/修改目录 */}
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
          <div className="flex items-center gap-2">
            {dataRoot?.isCustom && (
              <Button
                variant="outline"
                size="sm"
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                onClick={() => applyDataRoot(null)}
              >
                {t("settings:storage.restoreDefaultDataRoot")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={!info}
              onClick={openCacheDirectory}
            >
              {t("settings:storage.openDirectory")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={picking || !dataRoot}
              onClick={changeDataRoot}
            >
              {t("settings:storage.changeDataRoot")}
            </Button>
          </div>
        </div>
        {info && (
          <div className="space-y-2">
            <p className="break-all text-xs text-muted-foreground">
              {info.userDataPath}
            </p>
            <StorageBar info={info} />
          </div>
        )}
        {pendingRestart && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-primary/20 bg-primary-subtle p-3">
            <p className="text-xs text-muted-foreground">
              {t("settings:storage.dataRootRestartPending")}
            </p>
            <Button size="sm" disabled={restarting} onClick={relaunch}>
              {restarting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              {t("settings:storage.relaunchNow")}
            </Button>
          </div>
        )}
      </div>

      {/* 执行历史保留：开关 + 成功/失败保留天数（traceDays/successKeep/
          failureKeep 不暴露 UI——option 直改）；改值即存单字段 patch */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm font-normal">
              {t("settings:executionHistory.title")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings:executionHistory.desc")}
            </p>
          </div>
          <Switch
            aria-label={t("settings:executionHistory.enabledLabel")}
            checked={retention?.enabled ?? true}
            onCheckedChange={(enabled) => saveRetention({ enabled })}
            disabled={!retention}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {t("settings:executionHistory.successDaysLabel")}
            <Input
              className="h-8 w-20 text-right font-normal"
              type="number"
              min={1}
              max={3650}
              aria-label={t("settings:executionHistory.successDaysLabel")}
              value={retention?.successDays ?? 7}
              onChange={(e) => {
                const successDays = Number(e.target.value);
                if (successDays >= 1) {
                  saveRetention({ successDays });
                }
              }}
              disabled={!retention}
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {t("settings:executionHistory.failureDaysLabel")}
            <Input
              className="h-8 w-20 text-right font-normal"
              type="number"
              min={1}
              max={3650}
              aria-label={t("settings:executionHistory.failureDaysLabel")}
              value={retention?.failureDays ?? 30}
              onChange={(e) => {
                const failureDays = Number(e.target.value);
                if (failureDays >= 1) {
                  saveRetention({ failureDays });
                }
              }}
              disabled={!retention}
            />
          </div>
        </div>
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
