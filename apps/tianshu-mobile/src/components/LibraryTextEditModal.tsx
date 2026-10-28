import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

import { DialogShell } from "@/components/DialogShell";
import { toast } from "@/lib/toast-bus";
import {
  editDraftChanged,
  editLoadFailed,
  editLoaded,
  editSaveSettled,
  editSaveStarted,
  hasUnsavedChanges,
  initialEditState,
  type LibraryTextEditState,
} from "@/logic/library-text-edit";
import {
  libraryErrorCodeOf,
  writeFailureKey,
} from "@/logic/library-image-error";
import { useLibraryStore, type LibraryRow } from "@/store/library.store";
import { useThemeColors } from "@/store/theme";

/**
 * 资料库文本编辑弹层（资料库编辑批）：预览态「编辑」入口进入——内容经
 * library/read 拉取，多行 TextInput 编辑 + 保存/取消；保存走
 * writeContent 全量覆写，成功回预览态（父级刷新预览）；取消有改动先
 * Alert 二键确认，无改动直退。状态机纯函数在 logic/library-text-edit，
 * 本组件只做渲染与事件转发。
 */
export function LibraryTextEditModal({
  item,
  visible,
  onClose,
  onSaved,
}: {
  item: LibraryRow | null;
  visible: boolean;
  onClose: () => void;
  /** 保存成功（父级回预览态并刷新预览内容） */
  onSaved: () => void;
}) {
  const { t } = useTranslation(["library", "common"]);
  const colors = useThemeColors();
  const [state, setState] = useState<LibraryTextEditState>(initialEditState());
  const ready = state.status === "ready";
  const saving = ready && state.saving;

  useEffect(() => {
    if (!visible || !item) return;
    let cancelled = false;
    setState(initialEditState());
    useLibraryStore
      .getState()
      .readText(item.id)
      .then(
        (content) => {
          if (!cancelled) setState(editLoaded(content));
        },
        () => {
          if (!cancelled) setState(editLoadFailed());
        },
      );
    return () => {
      cancelled = true;
    };
  }, [visible, item]);

  /** 取消：有未保存改动先确认，无改动直退 */
  function requestClose() {
    if (ready && hasUnsavedChanges(state)) {
      Alert.alert(
        t("library:editDiscardTitle"),
        t("library:editDiscardMessage"),
        [
          { text: t("common:cancel"), style: "cancel" },
          {
            text: t("library:editDiscardConfirm"),
            style: "destructive",
            onPress: onClose,
          },
        ],
      );
      return;
    }
    onClose();
  }

  async function handleSave() {
    if (!item || !ready) return;
    setState(editSaveStarted(state));
    try {
      await useLibraryStore.getState().writeContent(item.id, state.draft);
      onSaved();
    } catch (error) {
      // 按错码出文案：TOO_LARGE/WRITE_FAILED/回退（A5 尾 error 键模式）
      toast.error(t(`library:${writeFailureKey(libraryErrorCodeOf(error))}`));
      setState((current) => editSaveSettled(current));
    }
  }

  return (
    <DialogShell
      title={t("library:editTitle", { name: item?.name ?? "" })}
      busy={saving}
      onClose={requestClose}
      footer={
        <View className="mt-5 flex-row items-center justify-end gap-6 border-t border-sep px-5 py-4 dark:border-[#545458A6]">
          <Pressable disabled={saving} onPress={requestClose} hitSlop={8}>
            <Text className="text-[15px] text-label2 dark:text-[#EBEBF599]">
              {t("common:cancel")}
            </Text>
          </Pressable>
          <Pressable
            disabled={!ready || saving}
            onPress={() => void handleSave()}
            hitSlop={8}
            style={{ opacity: !ready || saving ? 0.4 : 1 }}
          >
            <Text
              className="text-[15px] font-medium"
              style={{ color: colors.primary }}
            >
              {t("library:editSave")}
            </Text>
          </Pressable>
        </View>
      }
    >
      {state.status === "loading" ? (
        <View className="h-40 items-center justify-center">
          <ActivityIndicator color={colors.primary} size="small" />
        </View>
      ) : state.status === "failed" ? (
        <View className="h-40 items-center justify-center">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("library:editLoadFailed")}
          </Text>
        </View>
      ) : (
        <TextInput
          value={state.draft}
          onChangeText={(text) =>
            setState((current) => editDraftChanged(current, text))
          }
          multiline
          editable={!saving}
          textAlignVertical="top"
          className="h-64 rounded-lg border border-sep bg-grouped px-3 py-2 text-[15px] leading-6 text-black dark:border-[#545458A6] dark:bg-neutral-900 dark:text-white"
        />
      )}
    </DialogShell>
  );
}
