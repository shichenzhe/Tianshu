/**
 * 文本复制 hook（消息操作行/代码块工具条共用）：写入剪贴板 + 对勾
 * 1500ms 复位 + 成功/失败 toast（common 命名空间文案）。
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

export function useCopyText(): {
  copied: boolean;
  copyText: (text: string) => Promise<void>;
} {
  const { t } = useTranslation(["common"]);
  const [copied, setCopied] = useState(false);

  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        toast.success(t("common:copied"));
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        toast.error(t("common:copyFailed"));
      }
    },
    [t],
  );

  return { copied, copyText };
}
