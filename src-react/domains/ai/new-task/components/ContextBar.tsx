/**
 * 新建任务配置栏（spec §4 输入卡下方）：任务级工作空间选择入口——
 * WorkspacePickerMenu 下拉显式选择（搜索/点选即生效/新建空间/打开本地
 * 空间；不默认跟随列表第一个，修订 spec 裁定 11）；持久化的 workspaceId
 * 失效（空间已删/换库）时归零回引导态（未选时发送置灰并有提示）。
 * 权限胶囊已随工具栏对齐迁入 NewTaskInputCard（修订裁定 9，此处不再
 * 渲染权限档位）。空列表降级灰字 noWorkspace（不可下拉）。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import WorkspaceApi from "../../api/workspace.api";
import { useNewTaskStore } from "../store/new-task-store";
import WorkspacePickerMenu from "./WorkspacePickerMenu";

/** data 空时稳定引用，避免 effect 依赖数组随渲染抖动 */
const NO_WORKSPACES: never[] = [];

export default function ContextBar() {
  const { t } = useTranslation(["newTask"]);
  const workspaceId = useNewTaskStore((s) => s.workspaceId);
  const setWorkspaceId = useNewTaskStore((s) => s.setWorkspaceId);

  // 只消费 data（列表/空态均由 data 有无推导）
  const { data } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });
  const workspaces = data ?? NO_WORKSPACES;

  // 持久化脏 id 归零：加载完成后（data !== undefined，加载期/查询失败不
  // 动）发现 id 不在列表 → 回引导态（setWorkspaceId(null) 自带持久化）
  useEffect(() => {
    if (data === undefined || workspaceId === null) {
      return;
    }
    if (!workspaces.some((w) => w.id === workspaceId)) {
      setWorkspaceId(null);
    }
  }, [data, workspaceId, workspaces, setWorkspaceId]);

  return (
    <div className="flex items-center justify-center gap-2">
      {workspaces.length > 0 ? (
        <WorkspacePickerMenu />
      ) : (
        <span className="text-xs text-muted-foreground">
          {t("newTask:context.noWorkspace")}
        </span>
      )}
    </div>
  );
}
