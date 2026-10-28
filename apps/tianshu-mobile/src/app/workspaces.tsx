// 工作空间管理页（A8 批）：设置页入口进入。列表（名/默认模型标记/绑定目录
// basename 展示——path 取最后一段，过长截断）+ 新建（name 必填 + icon 可选
// emoji）/ 重命名 / 删除（Alert 二键确认，文案明示级联删除全部会话与消息
// 不可恢复）。绑定目录行只读标注「桌面端绑定」——自由传路径是桌面 GUI 写面，
// 移动端不做绑定/解绑。写面走 sessions store 的 workspace 写 actions（串行 +
// 防迟到）。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Folder,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react-native";

import { AppActionSheet } from "@/components/AppActionSheet";
import { DialogShell } from "@/components/DialogShell";
import { FormField } from "@/components/FormField";
import { FormFooter } from "@/components/FormFooter";
import { PageHeader } from "@/components/PageHeader";
import { toast } from "@/lib/toast-bus";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import {
  useSessionsStore,
  type WorkspaceBrief,
} from "@/store/sessions.store";
import { useThemeColors } from "@/store/theme";

/** 绑定目录展示名：取路径最后一段（跨 win/posix 分隔符），过长由
 *  numberOfLines 截断 */
function basenameOf(path: string): string {
  const segs = path.split(/[\\/]/).filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1] : path;
}

/** 行内小标记（默认模型/桌面端绑定）：subtle 底圆角签 */
function Tag({ label, colors }: { label: string; colors: { subtle: string } }) {
  return (
    <View
      className="rounded px-1.5 py-0.5"
      style={{ backgroundColor: colors.subtle }}
    >
      <Text className="text-[11px] text-label2 dark:text-[#EBEBF599]">
        {label}
      </Text>
    </View>
  );
}

/** 工作空间行：目录图标 + 名（+默认模型标记）+ 绑定目录 meta（+桌面端绑定
 *  标注/未绑定标注）+ ⋯ 菜单 */
function WorkspaceRow({
  workspace,
  isLast,
  onMenu,
}: {
  workspace: WorkspaceBrief;
  isLast: boolean;
  onMenu: (workspace: WorkspaceBrief) => void;
}) {
  const { t } = useTranslation("workspace");
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={() => onMenu(workspace)}
      onLongPress={() => onMenu(workspace)}
      className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      <Folder size={20} color={colors.primary} />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text
            numberOfLines={1}
            className="shrink text-[15px] text-black dark:text-white"
          >
            {workspace.name}
          </Text>
          {workspace.defaultModelId != null && (
            <Tag label={t("defaultModelTag")} colors={colors} />
          )}
        </View>
        <View className="mt-0.5 flex-row items-center gap-2">
          <Text
            numberOfLines={1}
            className="shrink text-xs text-label3 dark:text-[#EBEBF54D]"
          >
            {workspace.directoryPath != null
              ? basenameOf(workspace.directoryPath)
              : t("unbound")}
          </Text>
          {workspace.directoryPath != null && (
            <Tag label={t("boundOnDesktop")} colors={colors} />
          )}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => onMenu(workspace)}
      >
        <MoreHorizontal size={18} color="#C7C7CC" />
      </Pressable>
    </Pressable>
  );
}

/** 新建/重命名共用表单对话框：name 必填 + icon 可选（emoji，仅新建展示——
 *  wire 概要不回读 icon，重命名只发送 name） */
function WorkspaceFormDialog({
  title,
  initialName,
  withIcon,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  initialName: string;
  withIcon: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: { name: string; icon: string | null }) => void;
}) {
  const { t } = useTranslation("workspace");
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState("");
  return (
    <DialogShell
      title={title}
      busy={busy}
      onClose={onClose}
      footer={
        <FormFooter
          busy={busy}
          confirmDisabled={!name.trim()}
          onConfirm={() =>
            onSubmit({ name: name.trim(), icon: icon.trim() || null })
          }
          onCancel={onClose}
        />
      }
    >
      <FormField label={t("name")} value={name} onChangeText={setName} />
      {withIcon && (
        <FormField
          label={t("icon")}
          value={icon}
          onChangeText={setIcon}
          placeholder={t("iconPlaceholder")}
        />
      )}
    </DialogShell>
  );
}

export default function WorkspacesScreen() {
  const { t } = useTranslation(["workspace", "chat", "common", "settings"]);
  const router = useRouter();
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  // workspace 概要随 loadFirst 拉取（覆写语义带 workspace/query）——
  // chat 能力的主机均可用（workspace/query 无独立能力门禁）
  const supported = capabilities?.includes("chat") ?? false;
  const workspaces = useSessionsStore((s) => s.workspaces);
  const loading = useSessionsStore((s) => s.loading);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<WorkspaceBrief | null>(null);
  const [sheetTarget, setSheetTarget] = useState<WorkspaceBrief | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (activeConnId && supported && workspaces.length === 0) {
      void useSessionsStore.getState().loadFirst();
    }
  }, [activeConnId, supported, workspaces.length]);

  function notifyFailure() {
    toast.error(t("workspace:writeFailed"));
  }

  async function handleCreate(values: { name: string; icon: string | null }) {
    setBusy(true);
    const brief = await useSessionsStore
      .getState()
      .createWorkspace(values.name, values.icon ?? undefined);
    setBusy(false);
    if (brief) setCreating(false);
    else notifyFailure();
  }

  async function handleRename(name: string) {
    if (!renaming) return;
    setBusy(true);
    const ok = await useSessionsStore.getState().renameWorkspace(
      renaming.id,
      name,
    );
    setBusy(false);
    if (ok) setRenaming(null);
    else notifyFailure();
  }

  /** 删除：Alert 二键确认——文案明示级联删除全部会话与消息不可恢复
   *  （与桌面 UI 同级联语义，无最后空间保护） */
  function confirmDelete(workspace: WorkspaceBrief) {
    Alert.alert(t("workspace:delete"), t("workspace:deleteConfirm", {
      name: workspace.name,
    }), [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("workspace:delete"),
        style: "destructive",
        onPress: () => void performDelete(workspace.id),
      },
    ]);
  }

  async function performDelete(id: number) {
    setBusy(true);
    const ok = await useSessionsStore.getState().deleteWorkspace(id);
    setBusy(false);
    if (!ok) notifyFailure();
  }

  const sheetItems = sheetTarget
    ? [
        {
          key: "rename",
          label: t("workspace:rename"),
          Icon: Pencil,
          onPress: () => setRenaming(sheetTarget),
        },
        {
          key: "delete",
          label: t("workspace:delete"),
          Icon: Trash2,
          danger: true,
          onPress: () => confirmDelete(sheetTarget),
        },
      ]
    : [];

  function renderContent() {
    if (!activeConnId) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("chat:noConnection")}
          </Text>
          <Pressable
            onPress={() => router.push("/connections")}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">
              {t("common:nav.toConnections")}
            </Text>
          </Pressable>
        </View>
      );
    }
    if (!supported) {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
            {t("workspace:unsupported")}
          </Text>
        </View>
      );
    }
    if (workspaces.length === 0) {
      return loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : (
        <Text className="py-20 text-center text-sm text-label2 dark:text-[#EBEBF599]">
          {t("workspace:empty")}
        </Text>
      );
    }
    return (
      <ScrollView className="flex-1">
        <View className="mx-3 overflow-hidden rounded-2xl">
          {workspaces.map((workspace, index) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              isLast={index === workspaces.length - 1}
              onMenu={setSheetTarget}
            />
          ))}
        </View>
      </ScrollView>
    );
  }

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader
        title={t("workspace:title")}
        backLabel={t("workspace:back")}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("workspace:newWorkspace")}
            disabled={!supported || busy}
            onPress={() => setCreating(true)}
            hitSlop={12}
            className="h-9 w-9 items-center justify-center rounded-full"
            style={({ pressed }) => ({
              backgroundColor: pressed ? colors.subtle : undefined,
              opacity: !supported || busy ? 0.4 : 1,
            })}
          >
            <Plus size={18} color={colors.primary} />
          </Pressable>
        }
      />
      {renderContent()}
      <AppActionSheet
        visible={sheetTarget !== null}
        title={sheetTarget?.name}
        items={sheetItems}
        onClose={() => setSheetTarget(null)}
      />
      {creating && (
        <WorkspaceFormDialog
          title={t("workspace:newWorkspace")}
          initialName=""
          withIcon
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={(values) => void handleCreate(values)}
        />
      )}
      {renaming && (
        <WorkspaceFormDialog
          title={t("workspace:rename")}
          initialName={renaming.name}
          withIcon={false}
          busy={busy}
          onClose={() => setRenaming(null)}
          onSubmit={(values) => void handleRename(values.name)}
        />
      )}
    </SafeAreaView>
  );
}
