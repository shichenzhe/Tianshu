/**
 * AI 润色按钮（spec §4 底部工具栏右组，通用润色交互）：点击即对当前
 * 全文发起一次性补全（ChatApi.polish，style 固定 professional 通用档——
 * 弃三风格下拉，交互为单按钮直发）。润色中触发钮转 Loader2 转圈且禁点
 * （不锁 textarea），成功 setContent 替换全文；失败 toast 原文不动；
 * 空文本静默不发请求；未绑工作空间 toast 提示不发请求。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import ChatApi from "../../api/chat.api";
import { useNewTaskStore } from "../store/new-task-store";

export default function PolishButton() {
  const { t } = useTranslation(["newTask"]);
  const content = useNewTaskStore((s) => s.content);
  const setContent = useNewTaskStore((s) => s.setContent);
  const workspaceId = useNewTaskStore((s) => s.workspaceId);
  const [loading, setLoading] = useState(false);

  /** 润色当前全文（通用风格）：空文本/未绑空间前置拦截，失败保留原文 */
  const handlePolish = async () => {
    if (loading) {
      return;
    }
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
        style: "professional",
      });
      setContent(result.text);
    } catch {
      toast.error(t("newTask:polish.failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={loading}
      onClick={() => void handlePolish()}
      aria-label={t("newTask:polish.title")}
      title={t("newTask:polish.title")}
      className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Wand2 className="h-4 w-4" />
      )}
    </Button>
  );
}
