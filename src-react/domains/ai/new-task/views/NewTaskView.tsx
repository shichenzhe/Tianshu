/**
 * 新建任务落地页（spec §3）：场景 Tab + 胶囊栏 + 输入卡 + 配置栏；
 * 发送时才创建 session（dispatch 编排）；可用模型判定与 ChatView/ModelPicker
 * 共享 ["models"]/["providers"] 查询缓存
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { ModelApi } from "../../api/model.api";
import { ProviderApi } from "../../api/provider.api";
import { dispatchNewTask, mapDispatchError } from "../lib/dispatch";
import { SCENARIO_KEYS } from "../lib/scenario";
import {
  hydratePersistedDraft,
  useNewTaskStore,
} from "../store/new-task-store";
import ContextBar from "../components/ContextBar";
import NewTaskInputCard from "../components/NewTaskInputCard";
import PromptChips from "../components/PromptChips";
import { cn } from "@/lib/utils";

export default function NewTaskView() {
  const { t } = useTranslation(["newTask", "common"]);
  const navigate = useNavigate();
  const scenario = useNewTaskStore((s) => s.scenario);
  const setScenario = useNewTaskStore((s) => s.setScenario);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);

  // 模板胶囊填充（spec §5）：填入后聚焦输入框并把光标落首个 [ 占位处
  // （无占位则落文末）；queueMicrotask 等受控 value 提交后再置选区，
  // 否则 React 写 value 会重置刚设的光标
  const handleTemplateClick = useCallback((filled: string) => {
    useNewTaskStore.getState().setContent(filled);
    queueMicrotask(() => {
      const textarea = inputRef.current;
      if (!textarea) {
        return;
      }
      const caret = filled.indexOf("[");
      const index = caret >= 0 ? caret : filled.length;
      textarea.focus();
      textarea.setSelectionRange(index, index);
    });
  }, []);

  // 恢复持久化配置（store JSDoc「落地页挂载时调用一次」）：走 useState 惰性
  // 初始化而非 effect——子组件（ContextBar）的首空间跟随 effect 先于父 effect
  // 执行，effect 时机恢复会被 null 态先覆写持久化快照
  useState(hydratePersistedDraft);

  // 可用模型判定（ModelPicker 同口径同缓存键：启用模型挂在现存服务商下即可
  // 用）；查询加载/失败期视为不可用（保守置灰，缓存命中即无感）
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => ModelApi.listAll(),
  });
  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const hasUsableModel = useMemo(() => {
    const providerIds = new Set(
      (providersQuery.data ?? []).map((provider) => provider.id),
    );
    return (modelsQuery.data ?? []).some(
      (model) => model.enabled && providerIds.has(model.providerId),
    );
  }, [modelsQuery.data, providersQuery.data]);

  // 发送编排（spec §3.2）：失败 toast 留在落地页（草稿与配置不动），成功清草稿跳会话
  const handleSubmit = useCallback(async () => {
    setSending(true);
    try {
      await dispatchNewTask({ navigate });
    } catch (e) {
      toast.error(mapDispatchError(e));
    } finally {
      setSending(false);
    }
  }, [navigate]);

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
      <PromptChips onTemplateClick={handleTemplateClick} />
      <NewTaskInputCard
        onSubmit={handleSubmit}
        sending={sending}
        hasUsableModel={hasUsableModel}
        inputRef={inputRef}
      />
      {/* 配置栏（输入卡下方：任务级工作空间 + 权限档位） */}
      <ContextBar />
    </div>
  );
}
