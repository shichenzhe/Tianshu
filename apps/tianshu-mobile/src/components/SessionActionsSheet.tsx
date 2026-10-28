import { useTranslation } from "react-i18next";
import {
  Archive,
  ArchiveRestore,
  Pencil,
  Pin,
  PinOff,
  Trash,
} from "lucide-react-native";

import type { SessionBrief } from "@/store/sessions.store";
import { AppActionSheet } from "./AppActionSheet";

/**
 * 会话长按操作面板（LA 交互批，视觉对齐 MessageActionsSheet）：置顶/
 * 归档切换按当前态具名（已置顶→「取消置顶」），删除红色破坏性行——替代
 * 原「长按 Alert 删除确认」：操作具名可发现，确认语义收敛到面板本身
 * （两步触达：长按 → 点按；对齐 UX 批 regenerate sheet 裁定）。
 * 写操作走 sessions.store.update（session/update）/remove。
 */
export function SessionActionsSheet({
  session,
  onTogglePin,
  onToggleArchive,
  onRename,
  onDelete,
  onClose,
}: {
  session: SessionBrief | null;
  onTogglePin: (pinned: boolean) => void;
  onToggleArchive: (archived: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");

  if (!session) return null;
  const pinned = session.pinnedAt != null;
  const archived = session.archivedAt != null;
  const items = [
    {
      key: "rename",
      label: t("rename"),
      Icon: Pencil,
      danger: false,
      onPress: onRename,
    },
    {
      key: "pin",
      label: pinned ? t("unpin") : t("pin"),
      Icon: pinned ? PinOff : Pin,
      danger: false,
      onPress: () => onTogglePin(!pinned),
    },
    {
      key: "archive",
      label: archived ? t("unarchive") : t("archive"),
      Icon: archived ? ArchiveRestore : Archive,
      danger: false,
      onPress: () => onToggleArchive(!archived),
    },
    {
      key: "delete",
      label: t("delete"),
      Icon: Trash,
      danger: true,
      onPress: onDelete,
    },
  ];

  return (
    <AppActionSheet
      visible
      title={session.title ?? t("untitled")}
      items={items}
      onClose={onClose}
    />
  );
}
