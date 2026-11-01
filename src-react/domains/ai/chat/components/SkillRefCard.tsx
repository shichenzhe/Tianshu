/**
 * user 消息技能引用卡片（skill_ref 批）：skill_ref 块的渲染形态（形态
 * 对齐 MessageFileRef——图标 + 名单行卡片），点击 readSkill 弹层预览
 * SKILL.md 全文（本地/远程同通道，SkillApi.readSkill 已主机路由化）。
 * 旧 text 前缀注入消息不产生本卡片（splitFileRefPrefix 兜历史格式）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Zap } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import SkillApi from "../../skills/api/skill.api";
import { mapIpcError } from "../lib/error-message";

interface SkillRefCardProps {
  /** 技能名（readSkill 键 / skill_ref.name） */
  name: string;
}

export default function SkillRefCard({ name }: SkillRefCardProps) {
  const { t } = useTranslation(["chat"]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const openPreview = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const result = await SkillApi.readSkill(name);
      setContent(result.content);
      setPreviewOpen(true);
    } catch (e) {
      toast.error(mapIpcError(e) || t("chat:message.skillRefFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void openPreview()}
        aria-label={t("chat:message.skillRefOpen", { name })}
        title={t("chat:message.skillRefOpen", { name })}
        className="flex w-full max-w-[360px] items-center gap-2.5 rounded-lg border border-border/50 bg-secondary px-3 py-2 text-left shadow-sm transition-colors hover:border-primary/30 hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Zap className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {t("chat:message.skillRefKind")}
          </span>
        </span>
      </button>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex h-[80vh] max-w-[60vw] flex-col border-border/50 p-0 sm:rounded-lg">
          <DialogTitle className="shrink-0 border-b border-border/50 px-4 py-3 text-sm">
            {t("chat:message.skillRefPreviewTitle", { name })}
          </DialogTitle>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
              {content ?? ""}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
