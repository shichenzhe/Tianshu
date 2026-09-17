/**
 * 新建任务落地页（spec §3）：场景 Tab + 胶囊栏 + 输入卡 + 配置栏；
 * 发送时才创建 session（dispatch，Task 14 接入）
 */
import { useTranslation } from "react-i18next";

import { SCENARIO_KEYS } from "../lib/scenario";
import { useNewTaskStore } from "../store/new-task-store";
import ContextBar from "../components/ContextBar";
import NewTaskInputCard from "../components/NewTaskInputCard";
import PromptChips from "../components/PromptChips";
import { cn } from "@/lib/utils";

export default function NewTaskView() {
  const { t } = useTranslation(["newTask", "common"]);
  const scenario = useNewTaskStore((s) => s.scenario);
  const setScenario = useNewTaskStore((s) => s.setScenario);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center gap-4 px-6 py-10">
      <h1 className="text-center text-2xl font-semibold text-foreground">
        {t("newTask:heroTitle", { app: t("common:appName") })}
      </h1>
      <div
        role="tablist"
        aria-label={t("newTask:scenario.daily")}
        className="flex items-center justify-center gap-2"
      >
        {SCENARIO_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={scenario === key}
            onClick={() => setScenario(key)}
            className={cn(
              "rounded-full border border-border/50 px-4 py-1.5 text-sm transition-colors",
              scenario === key
                ? "bg-primary-subtle text-primary hover:border-primary/30"
                : "text-muted-foreground hover:bg-primary-subtle hover:text-primary",
            )}
          >
            {t(`newTask:scenario.${key}`)}
          </button>
        ))}
      </div>
      <PromptChips />
      <NewTaskInputCard />
      {/* 配置栏（输入卡下方：任务级工作空间 + 权限档位） */}
      <ContextBar />
    </div>
  );
}
