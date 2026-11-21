// src-react/lib/query-invalidate-events.ts
/**
 * 主进程 changed 事件 → React Query 缓存失效的 app 级常驻注册：失效是
 * 全局缓存机制不隶属具体组件，组件级监听随路由卸载丢事件（对话建工作流
 * /定时任务后切列表页，30s staleTime 内不重拉看不到新数据——组件未挂载
 * 时广播无人接）。main.tsx 创建 client 后调用一次；invalidate 按前缀
 * 匹配，覆盖列表/运行历史/模板等全部子 key。
 *
 * 远程桥（orchestration 路由化批 2026-11-10；automation/library 批补
 * automation.changed）：活动主机为远程时订阅 server:event:<connId>，
 * graph.changed（无头端图定义级变更——端点写面/对话工具建图/启停）→
 * 失效 ["orchestration"] 与运行会话缓存；automation.changed（无头端调度执行/过期/异常/
 * 远程任务页写面）→ 失效 ["automation"]（本地 AUTOMATION_CHANGED_EVENT
 * 同款键）。主机切换经 zustand subscribe 感知，旧订阅退订；invalidate
 * 前缀匹配跨主机同标脏（非活动主机仅标脏不重取，host-query.ts 头注释
 * 语义），无数据面影响。
 */
import type { QueryClient } from "@tanstack/react-query";
import { on } from "@/lib/ipc";
import { AUTOMATION_CHANGED_EVENT } from "@/domains/ai/automation/api/automation.api";
import { GRAPH_CHANGED_EVENT } from "@/domains/ai/orchestration/api/orchestration.api";
import { WORKSPACE_CHANGED_EVENT } from "@/domains/ai/api/workspace.api";
import { SESSION_CHANGED_EVENT } from "@/domains/ai/api/session.api";
import { PROJECT_CHANGED_EVENT } from "@/domains/project/api/project.api";
import { useHostStore } from "@/domains/ai/data-source/host.store";

export function registerQueryInvalidation(client: QueryClient): void {
  const invalidateRunSessions = (): void => {
    void client.invalidateQueries({ queryKey: ["automation", "runGroups"] });
    void client.invalidateQueries({ queryKey: ["automation", "run"] });
    void client.invalidateQueries({
      queryKey: ["automation", "runSessionRuns"],
    });
    void client.invalidateQueries({ queryKey: ["sessions"] });
  };
  const invalidateAutomation = (): void => {
    void client.invalidateQueries({ queryKey: ["automation"] });
    void client.invalidateQueries({ queryKey: ["sessions"] });
  };
  on(GRAPH_CHANGED_EVENT, () => {
    void client.invalidateQueries({ queryKey: ["orchestration"] });
    invalidateRunSessions();
  });
  on(AUTOMATION_CHANGED_EVENT, invalidateAutomation);
  // 批③（2026-11-01）：本机被控写入（移动端经 face tap 落本地库）→ 侧栏
  // 分组树缓存失效（前缀失效覆盖 ["projects", user.id] 子 key）
  on(WORKSPACE_CHANGED_EVENT, () => {
    void client.invalidateQueries({ queryKey: ["workspaces"] });
  });
  // 会话结构性写面（2026-11-06）：移动端经 server-face 建/删/归档/置顶/
  // 改名会话 → 侧栏会话树缓存失效（前缀失效覆盖 ["sessions", "all"]）
  on(SESSION_CHANGED_EVENT, invalidateRunSessions);
  on(PROJECT_CHANGED_EVENT, () => {
    void client.invalidateQueries({ queryKey: ["projects"] });
  });

  // —— 远程 graph.changed / automation.changed 桥（见头注释）——
  let unsubscribeRemote: (() => void) | null = null;
  const bindRemote = (connId: string): void => {
    unsubscribeRemote?.();
    unsubscribeRemote = on(`server:event:${connId}`, (_, event) => {
      const type = (event as { type?: string } | null)?.type;
      if (type === "graph.changed") {
        void client.invalidateQueries({ queryKey: ["orchestration"] });
        invalidateRunSessions();
      } else if (type === "automation.changed") {
        invalidateAutomation();
      } else if (type === "graph.run.updated" || type === "session.updated") {
        invalidateRunSessions();
      }
    });
  };
  const syncRemoteBinding = (): void => {
    const host = useHostStore.getState().activeHost;
    if (host.kind === "remote") {
      bindRemote(host.connId);
    } else if (unsubscribeRemote) {
      unsubscribeRemote();
      unsubscribeRemote = null;
    }
  };
  syncRemoteBinding();
  useHostStore.subscribe(syncRemoteBinding);
}
