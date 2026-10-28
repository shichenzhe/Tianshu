// src-react/lib/query-invalidate-events.ts
/**
 * 主进程 changed 事件 → React Query 缓存失效的 app 级常驻注册：失效是
 * 全局缓存机制不隶属具体组件，组件级监听随路由卸载丢事件（对话建工作流
 * /定时任务后切列表页，30s staleTime 内不重拉看不到新数据——组件未挂载
 * 时广播无人接）。main.tsx 创建 client 后调用一次；invalidate 按前缀
 * 匹配，覆盖列表/运行历史/模板等全部子 key。
 */
import type { QueryClient } from "@tanstack/react-query";
import { on } from "@/lib/ipc";
import { AUTOMATION_CHANGED_EVENT } from "@/domains/ai/automation/api/automation.api";
import { GRAPH_CHANGED_EVENT } from "@/domains/ai/orchestration/api/orchestration.api";

export function registerQueryInvalidation(client: QueryClient): void {
  on(GRAPH_CHANGED_EVENT, () => {
    void client.invalidateQueries({ queryKey: ["orchestration"] });
  });
  on(AUTOMATION_CHANGED_EVENT, () => {
    void client.invalidateQueries({ queryKey: ["automation"] });
  });
}
