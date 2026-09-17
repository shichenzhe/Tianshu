/**
 * AI 润色菜单（spec §4 底部工具栏右组）：三风格一次性补全
 * （ChatApi.polish，T6 通道——不落库不建 session）。成功 setContent
 * 替换全文；失败 toast 原文不动；空文本静默不发请求；未绑工作空间
 * toast 提示不发请求。loading 只锁触发钮（disabled），不锁 textarea。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ChatApi, { type PolishStyle } from "../../api/chat.api";
import { useNewTaskStore } from "../store/new-task-store";

/** 菜单项 i18n 尾 key 与 chat:polish style 值同名 */
const POLISH_STYLES: PolishStyle[] = [
  "professional",
  "concise",
  "translate-en",
];

export default function PolishMenu() {
  const { t } = useTranslation(["newTask"]);
  const content = useNewTaskStore((s) => s.content);
  const setContent = useNewTaskStore((s) => s.setContent);
  const workspaceId = useNewTaskStore((s) => s.workspaceId);
  const [loading, setLoading] = useState(false);

  /** 润色当前全文：空文本/未绑空间前置拦截，失败保留原文 */
  const handlePolish = async (style: PolishStyle) => {
    if (content.trim() === "") {
      return;
    }
    if (workspaceId === null) {
      toast.error(t("newTask:context.noWorkspace"));
      return;
    }
    setLoading(true);
    try {
      const result = await ChatApi.polish({
        workspaceId,
        text: content,
        style,
      });
      setContent(result.text);
    } catch {
      toast.error(t("newTask:polish.failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          aria-label={t("newTask:polish.title")}
          title={t("newTask:polish.title")}
          className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary"
        >
          <Wand2 className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-40 border border-border/50 rounded-lg shadow-lg"
      >
        {POLISH_STYLES.map((style) => (
          <DropdownMenuItem
            key={style}
            onClick={() => void handlePolish(style)}
          >
            {t(`newTask:polish.${style}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
