// src-react/domains/ai/orchestration/views/GraphListView.tsx
/**
 * 编排图列表(spec §6)：行列表(名称/节点数/启停/删除) + 新建入口——空白
 * 直接进 graphs/new；模板下拉 navigate 时 state 携 graphTemplate 预填
 * (Task 13 编辑器消费)。删除捕获 GRAPH_IN_USE 前缀展示引用任务清单。
 */
import { useDeferredValue, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Compass,
  Database,
  Download,
  FileSearch,
  ListChecks,
  Plus,
  Table,
  Terminal,
  Upload,
  Workflow,
} from "lucide-react";
import { usePageHeaderStore } from "@/components/layout/page-header.store";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAutomationStore } from "@/domains/ai/automation/store/automation.store";
import {
  GRAPH_IN_USE_ERROR,
  GraphApi,
  type GraphRecord,
} from "../api/orchestration.api";
import { GraphRow } from "../components/GraphRow";
import GraphRunHistoryDialog from "../components/GraphRunHistoryDialog";
import GraphTestRunDialog from "../components/GraphTestRunDialog";

/** 图编辑器路由基址（:id 为数字或 new 新建态，Task 13 处理） */
const GRAPHS_BASE = "/module/ai/graphs";

/** 模板 icon(lucide 名)→组件映射，未知名兜底 Workflow */
const TEMPLATE_ICONS: Record<string, typeof Workflow> = {
  workflow: Workflow,
  "file-search": FileSearch,
  terminal: Terminal,
  compass: Compass,
  database: Database,
  table: Table,
};

/** 图列表 query（graphs-changed 事件失效在 app 级
 *  registerQueryInvalidation 常驻注册，不随组件卸载丢事件） */
export function useGraphs() {
  return useQuery({
    queryKey: ["orchestration", "graphs"],
    queryFn: () => GraphApi.list(),
  });
}

/** 模板创建下拉（空态与列表态新建入口共用）：navigate 携 graphTemplate
 * 预填（Task 13 编辑器消费）；size 与同排主按钮保持一致 */
function TemplateMenuButton({
  size = "default",
}: {
  size?: ButtonProps["size"];
}) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const { data: templates = [] } = useQuery({
    queryKey: ["orchestration", "templates"],
    queryFn: () => GraphApi.templates(),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={size}
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        >
          {t("chat:orchestration.templateMenu")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="border border-border/50 rounded-lg shadow-lg"
      >
        {templates.map((tpl) => {
          const Icon = TEMPLATE_ICONS[tpl.icon] ?? Workflow;
          return (
            <DropdownMenuItem
              key={tpl.slug}
              onClick={() =>
                navigate(`${GRAPHS_BASE}/new`, {
                  state: { graphTemplate: tpl },
                })
              }
            >
              <Icon className="h-4 w-4 mr-2" />
              <div className="flex flex-col">
                <span className="text-sm">{t(tpl.titleI18nKey)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(tpl.descI18nKey)}
                </span>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function GraphListView({
  standalone = false,
}: {
  /** 独立路由（/module/ai/graphs）注册顶栏标题；automation 页 graphs
   * tab 内嵌时不注册（顶栏由 AutomationView 的 tab 组占用，子组件写
   * store 会覆盖父注册——故仅 standalone 分支写） */
  standalone?: boolean;
}) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: graphs = [], isLoading } = useGraphs();
  const search = useAutomationStore((s) => s.search);
  const [pendingDelete, setPendingDelete] = useState<GraphRecord>();
  const [deleting, setDeleting] = useState(false);
  // 手动执行目标：非空即开试运行弹窗（传库内已存 graphJson，非编辑草稿）
  const [pendingRun, setPendingRun] = useState<GraphRecord>();
  // 运行记录目标：非空即开运行历史弹窗
  const [pendingHistory, setPendingHistory] = useState<GraphRecord | null>(
    null,
  );
  // 批量导出：批量模式 + 选中集合（页面自包含，不入全局 store）
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const exitBatch = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
  };

  /** 批量导出：选中图聚合 bundle 落盘（主进程 save dialog）；取消静默 */
  async function handleBatchExport() {
    if (selectedIds.size === 0 || exporting) {
      return;
    }
    setExporting(true);
    try {
      const result = await GraphApi.exportWorkflows([...selectedIds]);
      if (result) {
        toast.success(
          t("chat:orchestration.batchExported", {
            count: result.count,
            path: result.path,
          }),
        );
        exitBatch();
      }
    } catch (e) {
      toast.error(
        t("chat:orchestration.loadFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setExporting(false);
    }
  }

  // 顶栏标题（仅独立路由；t 入 deps——语言切换时重写标题）
  useEffect(() => {
    if (!standalone) {
      return;
    }
    const { setPageHeader } = usePageHeaderStore.getState();
    setPageHeader({
      title: (
        <h2 className="truncate text-sm font-medium text-foreground">
          {t("chat:sidebar.workflows")}
        </h2>
      ),
    });
    return () => setPageHeader(null);
  }, [standalone, t]);

  /** 导入工作流：文件选择（主进程）→ 校验（失败 toast）→ 复用模板预填
   * 链路进编辑器（titleI18nKey 塞导入名——i18next 缺 key 原样回显） */
  async function handleImport() {
    const result = await GraphApi.importWorkflow();
    if (result === null) {
      return; // 取消
    }
    if (!result.ok) {
      toast.error(
        t("chat:orchestration.importFailed", { reason: result.reason }),
      );
      return;
    }
    // bundle 已在主进程批量建库：toast 汇总 + 失效列表；单图走预填链路
    if (result.kind === "bundle") {
      if (result.imported.length > 0) {
        toast.success(
          t("chat:orchestration.bundleImported", {
            count: result.imported.length,
          }),
        );
        await queryClient.invalidateQueries({
          queryKey: ["orchestration", "graphs"],
        });
      }
      for (const failure of result.failed) {
        toast.error(
          t("chat:orchestration.bundleItemFailed", {
            name: failure.name,
            reason: failure.reason,
          }),
        );
      }
      return;
    }
    navigate(`${GRAPHS_BASE}/new`, {
      state: {
        graphTemplate: {
          slug: "import",
          icon: "workflow",
          titleI18nKey: result.name,
          descI18nKey: result.description,
          graphJson: result.graphJson,
        },
      },
    });
  }

  /** 库内 graphJson → 输入变量名清单（容错：解析失败按无变量） */
  function variablesOf(record: GraphRecord): string[] {
    try {
      const schema = JSON.parse(record.graphJson).inputSchema;
      return schema && typeof schema === "object" ? Object.keys(schema) : [];
    } catch {
      return [];
    }
  }

  const deferredSearch = useDeferredValue(search);
  const visible = deferredSearch
    ? graphs.filter((g) =>
        g.name.toLowerCase().includes(deferredSearch.toLowerCase()),
      )
    : graphs;

  async function handleDelete() {
    if (!pendingDelete) {
      return;
    }
    setDeleting(true);
    try {
      await GraphApi.remove(pendingDelete.id);
      toast.success(t("chat:orchestration.deleted"));
      await queryClient.invalidateQueries({
        queryKey: ["orchestration", "graphs"],
      });
      // 图运行记录同表级联删除，自动化运行历史视图一并失效
      await queryClient.invalidateQueries({ queryKey: ["automation", "runs"] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith(GRAPH_IN_USE_ERROR)) {
        toast.error(
          t("chat:orchestration.deleteInUse", {
            names: message.slice(GRAPH_IN_USE_ERROR.length),
          }),
        );
      } else {
        toast.error(t("chat:orchestration.loadFailed", { message }));
      }
    } finally {
      setDeleting(false);
      setPendingDelete(undefined);
    }
  }

  if (!isLoading && graphs.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <Workflow className="h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          {t("chat:orchestration.empty")}
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={() => navigate(`${GRAPHS_BASE}/new`)}>
            {t("chat:orchestration.emptyAction")}
          </Button>
          <TemplateMenuButton />
          <Button variant="outline" onClick={() => void handleImport()}>
            <Upload className="h-4 w-4 mr-1" />
            {t("chat:orchestration.importAction")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
      {/* 新建入口：空白直接进编辑器；模板预填经路由 state 传递 */}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => navigate(`${GRAPHS_BASE}/new`)}>
          <Plus className="h-4 w-4 mr-1" />
          {t("chat:orchestration.new")}
        </Button>
        <TemplateMenuButton size="sm" />
        <Button variant="outline" size="sm" onClick={() => void handleImport()}>
          <Upload className="h-4 w-4 mr-1" />
          {t("chat:orchestration.importAction")}
        </Button>
        {graphs.length > 0 && (
          <Button
            variant={batchMode ? "default" : "outline"}
            size="sm"
            className={
              batchMode
                ? ""
                : "hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            }
            onClick={() => (batchMode ? exitBatch() : setBatchMode(true))}
          >
            <ListChecks className="h-4 w-4 mr-1" />
            {t(
              batchMode
                ? "chat:orchestration.batchExit"
                : "chat:orchestration.batchManage",
            )}
          </Button>
        )}
      </div>

      {/* 批量操作栏：全选 + 计数 + 导出（batchMode 时替换工具栏语义） */}
      {batchMode && (
        <div className="flex items-center justify-between rounded-lg border border-border/50 bg-card px-3 py-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={
                selectedIds.size === 0
                  ? false
                  : selectedIds.size === visible.length
                    ? true
                    : "indeterminate"
              }
              onCheckedChange={() => {
                setSelectedIds(
                  selectedIds.size === visible.length
                    ? new Set()
                    : new Set(visible.map((g) => g.id)),
                );
              }}
              disabled={exporting}
              aria-label={t("chat:orchestration.batchSelectAll")}
            />
            {t("chat:orchestration.batchSelected", {
              count: selectedIds.size,
            })}
          </label>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={selectedIds.size === 0 || exporting}
              onClick={() => void handleBatchExport()}
            >
              <Download className="h-3.5 w-3.5 mr-1" />
              {t("chat:orchestration.batchExport")}
            </Button>
          </div>
        </div>
      )}

      {!isLoading && visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t("chat:orchestration.empty")}
        </p>
      ) : (
        visible.map((graph) => (
          <GraphRow
            key={graph.id}
            graph={graph}
            onClick={() => navigate(`${GRAPHS_BASE}/${graph.id}`)}
            onDelete={() => setPendingDelete(graph)}
            onRun={() => setPendingRun(graph)}
            onHistory={() => setPendingHistory(graph)}
            batchMode={batchMode}
            selected={selectedIds.has(graph.id)}
            onToggleSelect={() => toggleSelect(graph.id)}
          />
        ))
      )}

      <AlertDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(undefined);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat:orchestration.confirmDeleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:orchestration.confirmDeleteDesc", {
                name: pendingDelete?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={handleDelete}
            >
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 手动执行：复用编辑器试运行弹窗，draftJson 传库内已存版本；
       * 触发成功即切运行历史弹窗（running 徽标 + 收尾自动刷新，供结果查看） */}
      {pendingRun && (
        <GraphTestRunDialog
          graphId={pendingRun.id}
          draftJson={pendingRun.graphJson}
          variables={variablesOf(pendingRun)}
          open={pendingRun !== undefined}
          onOpenChange={(open) => {
            if (!open) {
              setPendingRun(undefined);
            }
          }}
          onStarted={() => setPendingHistory(pendingRun)}
        />
      )}
      {/* 运行记录：复用编辑器运行历史弹窗（分页 + 行展开轨迹） */}
      {pendingHistory && (
        <GraphRunHistoryDialog
          graphId={pendingHistory.id}
          open={pendingHistory !== null}
          onOpenChange={(open) => {
            if (!open) {
              setPendingHistory(null);
            }
          }}
        />
      )}
    </div>
  );
}
