import { useTranslation } from "react-i18next";
import { Copy, PencilLine, RotateCcw } from "lucide-react-native";

import { AppActionSheet } from "./AppActionSheet";

/** 长按目标（UX 批）：role 决定操作集；text 为复制用纯文本；
 *  messageId 供编辑重发定位 */
export interface MessageActionTarget {
  role: "user" | "assistant";
  text: string;
  messageId?: number;
}

/**
 * 消息长按操作面板（UX 批，视觉对齐 PlusSheet）：user 轮 [复制/编辑并
 * 重发]、assistant 轮 [复制/重新生成]——替代原「长按直触/Alert 二次
 * 确认」：操作具名可发现，确认语义收敛到面板本身（操作集与桌面 hover
 * 操作栏同集）。流式生成中不触发（调用方把守）。
 */
export function MessageActionsSheet({
  target,
  onCopy,
  onEdit,
  onRegenerate,
  onClose,
}: {
  target: MessageActionTarget | null;
  onCopy: () => void;
  onEdit: () => void;
  onRegenerate: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");

  const items =
    target?.role === "user"
      ? [
          { key: "copy", label: t("copy"), Icon: Copy, onPress: onCopy },
          {
            key: "edit",
            label: t("editResend"),
            Icon: PencilLine,
            onPress: onEdit,
          },
        ]
      : [
          { key: "copy", label: t("copy"), Icon: Copy, onPress: onCopy },
          {
            key: "regen",
            label: t("regenerate"),
            Icon: RotateCcw,
            onPress: onRegenerate,
          },
        ];

  return (
    <AppActionSheet
      visible={target != null}
      title={target?.text}
      items={items}
      onClose={onClose}
    />
  );
}
