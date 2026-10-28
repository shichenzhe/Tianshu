// src-react/domains/ai/automation/lib/use-automation-tasks.ts
/** 任务列表 query（tasks-changed 事件失效在 app 级
 *  registerQueryInvalidation 常驻注册，不随组件卸载丢事件）(spec §5) */
import { useQuery } from "@tanstack/react-query";
import { AutomationApi } from "../api/automation.api";

export function useAutomationTasks() {
  return useQuery({
    queryKey: ["automation", "tasks"],
    queryFn: () => AutomationApi.list(),
  });
}
