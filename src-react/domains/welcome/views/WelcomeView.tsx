/**
 * 欢迎页：应用名 + 版本 + 更新日志入口
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NotebookPen } from "lucide-react";

import { invoke } from "@/lib/ipc";
import UpdateLogDialog from "@/components/common/UpdateLogDialog";
import { Button } from "@/components/ui/button";

interface AppInfo {
  name: string;
  version: string;
  productName: string;
}

export default function WelcomeView() {
  const { t } = useTranslation(["welcome"]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    invoke<AppInfo>("app:getInfo")
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
  }, []);

  return (
    <div className="p-6">
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <img src="./pc_logo.svg" alt="{{APP_NAME}}" className="w-16 h-16" />
        <h1 className="text-2xl font-bold text-foreground">
          {t("welcome:greeting", {
            appName: appInfo?.productName || "{{APP_NAME}}",
          })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("welcome:version", { version: appInfo?.version ?? "..." })}
        </p>
        <p className="text-sm text-muted-foreground max-w-md text-center">
          {t("welcome:getStarted")}
        </p>
        <Button
          variant="outline"
          className="mt-2 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() => setLogOpen(true)}
        >
          <NotebookPen className="w-4 h-4 mr-2" />
          {t("welcome:viewUpdateLog")}
        </Button>
      </div>

      <UpdateLogDialog open={logOpen} onOpenChange={setLogOpen} />
    </div>
  );
}
