/**
 * ＋菜单「专家」二级浮层：搜索过滤 + 默认助手/专家预设列表（单选，
 * 选中写会话后浮层关闭），头像取 icon 字段（emoji）或名称首字母；
 * 底部「召唤更多专家」跳专家·技能·连接器管理页
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, Check, Search, Users } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import AssistantApi from "../../api/assistant.api";
import SessionApi from "../../api/session.api";
import { mapIpcError } from "../lib/error-message";

const ASSISTANTS_KEY = ["assistants"] as const;
const SESSIONS_KEY = ["sessions"] as const;
const EXPERTS_ROUTE = "/module/ai/experts?tab=assistants";

interface ExpertSubMenuProps {
  /** 会话模式必传（写会话）；草稿模式（onPick）下忽略 */
  sessionId?: number;
  currentAssistantId?: number;
  /** 已挂载专家白名单（项目动态流）；未传不过滤（AI 模块行为不变） */
  allowedIds?: number[];
  /** 草稿模式回调（新建任务落地页 PlusMenu 对齐）：传入时选中纯前端
      暂存不写会话（session 创建后由 dispatch 落库），null = 默认助手 */
  onPick?: (assistantId: number | null) => void;
}

export default function ExpertSubMenu({
  sessionId,
  currentAssistantId,
  allowedIds,
  onPick,
}: ExpertSubMenuProps) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  const assistantsQuery = useQuery({
    queryKey: ASSISTANTS_KEY,
    queryFn: () => AssistantApi.list(),
  });
  // 挂载过滤在前、关键字过滤在后：未传 allowedIds 时数组原样透传
  const mounted = useMemo(
    () =>
      allowedIds
        ? (assistantsQuery.data ?? []).filter((assistant) =>
            allowedIds.includes(assistant.id),
          )
        : (assistantsQuery.data ?? []),
    [assistantsQuery.data, allowedIds],
  );
  const keyword = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      keyword
        ? mounted.filter((assistant) =>
            assistant.name.toLowerCase().includes(keyword),
          )
        : mounted,
    [mounted, keyword],
  );

  /** 单选：草稿模式纯回调暂存；会话模式写会话后失效 sessions，
      选中态与徽章随缓存刷新 */
  const handleSelect = async (assistantId: number | null) => {
    if (onPick) {
      onPick(assistantId);
      return;
    }
    if ((assistantId ?? undefined) === currentAssistantId) {
      return;
    }
    try {
      await SessionApi.setAssistant(sessionId!, assistantId);
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {/* Bot 同专家管理页/全局侧边栏专家入口图标先例 */}
        <Bot />
        {t("chat:plus.expert")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64 border border-border/50 rounded-lg shadow-lg">
        <div className="p-1.5 pb-1">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("chat:plus.searchExperts")}
              onKeyDownCapture={(e) => e.stopPropagation()}
              className="h-7 border-border/50 pl-7 text-xs"
            />
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {assistantsQuery.isError ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("chat:plus.loadFailed")}
            </p>
          ) : (
            <>
              <DropdownMenuItem
                onClick={() => void handleSelect(null)}
                className={keyword ? "hidden" : undefined}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                  ✦
                </span>
                <span className="truncate text-xs">
                  {t("chat:plus.noAssistant")}
                </span>
                {currentAssistantId === undefined && (
                  <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
              {filtered.length === 0 && keyword ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  {t("chat:plus.expertNoMatch")}
                </p>
              ) : (
                filtered.map((assistant) => (
                  <DropdownMenuItem
                    key={assistant.id}
                    onClick={() => void handleSelect(assistant.id)}
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs text-primary">
                      {assistant.icon ??
                        assistant.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {assistant.name}
                    </span>
                    {assistant.id === currentAssistantId && (
                      <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </>
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate(EXPERTS_ROUTE)}>
          <Users />
          {t("chat:plus.summonExperts")}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
