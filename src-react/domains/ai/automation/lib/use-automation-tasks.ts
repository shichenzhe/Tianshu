// src-react/domains/ai/automation/lib/use-automation-tasks.ts
/** 任务列表 query + 主进程 automation:tasks-changed 事件失效(spec §5) */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { on } from "@/lib/ipc";
import { AutomationApi, AUTOMATION_CHANGED_EVENT } from "../api/automation.api";

export function useAutomationTasks() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["automation", "tasks"],
    queryFn: () => AutomationApi.list(),
  });
  useEffect(() => {
    return on(AUTOMATION_CHANGED_EVENT, () => {
      void queryClient.invalidateQueries({ queryKey: ["automation"] });
    });
  }, [queryClient]);
  return query;
}
