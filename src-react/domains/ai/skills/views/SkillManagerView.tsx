/**
 * "我安装的"技能管理页：搜索 + 用户/系统技能双分组 + 批量管理模式
 * （全选/清空/开启/关闭/卸载/取消，仅作用于用户组）。系统组
 * （source builtin）不可勾选不可卸载，仅可单独禁用。卸载 AlertDialog
 * 二次确认，批量结果 toast 汇总
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { invoke } from "@/lib/ipc";
import SkillApi from "../api/skill.api";
import { useHostStore } from "../../data-source/host.store";
import { filterSkillRecords, partitionSkillRecords } from "../lib/skill-filter";
import { mapIpcError } from "../../chat/lib/error-message";
import SkillCard from "../components/SkillCard";

export default function SkillManagerView() {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const recordsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
  });
  const records = recordsQuery.data ?? [];
  /** 用户/系统技能分区:builtin 单独成组(不可卸载,仅可禁用) */
  const { user, system } = useMemo(
    () => partitionSkillRecords(records),
    [records],
  );
  const visibleUser = useMemo(
    () => filterSkillRecords(user, keyword),
    [user, keyword],
  );
  const visibleSystem = useMemo(
    () => filterSkillRecords(system, keyword),
    [system, keyword],
  );

  // 远程主机（HD-P2b）：安装/卸载/打标/导入是文件系统面本地专属——
  // 远程态整页只读提示（写操作若放行会误写本地库）；远程技能的
  // 消费面（输入联想/技能子菜单启停/@ 引用注入）经 api 路由化照常可用
  const isRemoteHost = useHostStore((s) => s.activeHost.kind === "remote");
  if (isRemoteHost) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {t("chat:skills.remoteUnavailable")}
        </p>
      </div>
    );
  }

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["skillRecords"] });
  };

  const toggleChecked = (name: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
  };

  const handleEnabledChange = async (name: string, enabled: boolean) => {
    try {
      await SkillApi.setEnabled(name, enabled);
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const runBatch = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await invalidate();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleUninstall = async () => {
    const names = [...selected];
    setConfirmOpen(false);
    try {
      const result = await SkillApi.batchUninstall(names);
      await invalidate();
      if (result.failed.length === 0) {
        toast.success(t("chat:skills.batchDone", { count: names.length }));
      } else {
        toast.warning(
          t("chat:skills.batchDone", {
            count: result.succeeded.length,
          }),
          {
            description: t("chat:skills.batchFailed", {
              names: result.failed.map((f) => f.name).join(", "),
            }),
          },
        );
      }
      setSelected(new Set());
      setBatchMode(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const openSkillDir = async () => {
    try {
      await invoke("skill:openDir");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 顶部操作条：搜索 + 批量管理（添加技能下拉 P-B 接入） */}
      {!batchMode ? (
        <div className="flex items-center gap-2">
          <div className="relative w-56">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t("chat:skills.searchPlaceholder")}
              className="h-8 pl-7 text-sm"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={() => {
              setBatchMode(true);
              setSelected(new Set());
            }}
          >
            {t("chat:skills.batchManage")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
          <span className="text-xs text-muted-foreground">
            {t("chat:skills.selected", { count: selected.size })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={() => setSelected(new Set(visibleUser.map((r) => r.name)))}
          >
            {t("chat:skills.selectAll")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={() => setSelected(new Set())}
          >
            {t("chat:skills.clear")}
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={selected.size === 0}
              onClick={() =>
                runBatch(() => SkillApi.batchSetEnabled([...selected], true))
              }
            >
              {t("chat:skills.enable")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={selected.size === 0}
              onClick={() =>
                runBatch(() => SkillApi.batchSetEnabled([...selected], false))
              }
            >
              {t("chat:skills.disable")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-destructive hover:border-destructive/30"
              disabled={selected.size === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {t("chat:skills.uninstall")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setBatchMode(false);
                setSelected(new Set());
              }}
            >
              {t("chat:skills.cancelBatch")}
            </Button>
          </div>
        </div>
      )}

      {recordsQuery.isPending ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t("common:loading")}
        </p>
      ) : recordsQuery.isError ? (
        <p className="py-16 text-center text-sm text-destructive">
          {t("common:failed")}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {user.length === 0 && !keyword.trim() ? (
            <Card className="border-border/50 rounded-lg shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">
                  {t("chat:skills.empty")}
                </CardTitle>
                <CardDescription>{t("chat:skills.emptyTip")}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => void openSkillDir()}>
                  <FolderOpen className="mr-1 h-4 w-4" />
                  {t("chat:skills.openDir")}
                </Button>
              </CardContent>
            </Card>
          ) : (
            visibleUser.length > 0 && (
              <section className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-sm font-medium text-foreground">
                    {t("chat:skills.groupUser")}
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {user.length}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {visibleUser.map((record) => (
                    <SkillCard
                      key={record.id}
                      record={record}
                      batchMode={batchMode}
                      checked={selected.has(record.name)}
                      onCheckedChange={(checked) =>
                        toggleChecked(record.name, checked)
                      }
                      onEnabledChange={(enabled) =>
                        void handleEnabledChange(record.name, enabled)
                      }
                    />
                  ))}
                </div>
              </section>
            )
          )}
          {visibleSystem.length > 0 && (
            <section className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <h3 className="text-sm font-medium text-foreground">
                  {t("chat:skills.groupSystem")}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {system.length}
                </span>
                <span className="text-xs text-muted-foreground/70">
                  {t("chat:skills.systemGroupHint")}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {visibleSystem.map((record) => (
                  <SkillCard
                    key={record.id}
                    record={record}
                    batchMode={batchMode}
                    selectable={false}
                    checked={false}
                    onCheckedChange={() => {}}
                    onEnabledChange={(enabled) =>
                      void handleEnabledChange(record.name, enabled)
                    }
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat:skills.uninstallTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:skills.uninstallDesc", {
                names: [...selected].join(", "),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleUninstall()}
            >
              {t("chat:skills.uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
