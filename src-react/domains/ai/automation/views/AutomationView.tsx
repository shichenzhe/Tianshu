/**
 * 自动化（占位页）：定时/触发式任务后续迭代
 */
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";

export default function AutomationView() {
  const { t } = useTranslation(["chat"]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Clock className="h-10 w-10 text-muted-foreground" />
      <h2 className="text-base font-medium text-foreground">
        {t("chat:automation.title")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t("chat:task.comingSoon")}
      </p>
    </div>
  );
}
