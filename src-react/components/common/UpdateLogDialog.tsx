/**
 * 更新日志对话框
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { invoke } from "@/lib/ipc";

interface AppInfo {
  name: string;
  version: string;
  productName?: string;
}

interface UpdateLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function UpdateLogDialog({
  open,
  onOpenChange,
}: UpdateLogDialogProps) {
  const { t } = useTranslation(["layout", "common"]);
  const [appInfo, setAppInfo] = useState<AppInfo>({
    name: t("common:appName"),
    version: "unknown",
  });
  const [updateLog, setUpdateLog] = useState<string>(
    t("layout:updateLog.defaultContent"),
  );

  // 获取应用信息
  const loadAppInfo = async () => {
    if (!window.ipcRenderer) {
      setAppInfo({ name: "", version: "" });
      return;
    }

    try {
      const info = await invoke<AppInfo>("app:getInfo");
      setAppInfo({
        name: info.productName || info.name || t("common:appName"),
        version: info.version || "unknown",
      });
    } catch (error) {
      console.error("获取应用信息失败:", error);
      setAppInfo({ name: t("common:appName"), version: "unknown" });
    }
  };

  // 获取更新日志内容
  const loadUpdateLog = async () => {
    if (!window.ipcRenderer) {
      setUpdateLog("");
      return;
    }

    try {
      const content = await invoke<string>("update-log:getContent");
      setUpdateLog(content || t("layout:updateLog.defaultContent"));
    } catch (error) {
      console.error("获取更新日志失败:", error);
      setUpdateLog(t("layout:updateLog.defaultContent"));
    }
  };

  useEffect(() => {
    if (open) {
      loadAppInfo();
      loadUpdateLog();
    }
  }, [open]);

  // 渲染 markdown 内容
  const renderMarkdown = (content: string) => {
    return (
      <div
        className="prose prose-sm max-w-none"
        dangerouslySetInnerHTML={{
          __html: content
            .replace(
              /^# (.*$)/gim,
              '<h1 class="text-2xl font-bold mb-4 text-foreground">$1</h1>',
            )
            .replace(
              /^## (.*$)/gim,
              '<h2 class="text-xl font-semibold mb-3 text-foreground/90">$1</h2>',
            )
            .replace(
              /^### (.*$)/gim,
              '<h3 class="text-lg font-medium mb-2 text-foreground/80">$1</h3>',
            )
            .replace(
              /^- (.*$)/gim,
              '<li class="ml-4 mb-1 text-muted-foreground">$1</li>',
            )
            .replace(
              /\*\*(.*?)\*\*/g,
              '<strong class="font-semibold">$1</strong>',
            )
            .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
            .replace(
              /`(.*?)`/g,
              '<code class="bg-muted px-1 py-0.5 rounded text-sm font-mono">$1</code>',
            )
            .replace(/\n/g, "<br>"),
        }}
      />
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>{t("layout:updateLog.title")}</DialogTitle>
        </DialogHeader>

        <div className="update-log-content">
          {/* 应用信息 */}
          <div className="app-info mb-6 p-4 bg-primary-subtle rounded-lg border border-primary">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-primary">
                  {appInfo.name}
                </h3>
                <p className="text-sm text-primary">
                  {t("layout:updateLog.currentVersion", {
                    version: appInfo.version,
                  })}
                </p>
              </div>
            </div>
          </div>

          {/* 更新日志内容 */}
          <div className="log-container max-h-[400px] overflow-y-auto">
            <div className="update-log-text">{renderMarkdown(updateLog)}</div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => onOpenChange(false)}>
            {t("common:close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
