import { useTranslation } from "react-i18next";
import { Modal, Pressable, Text, View } from "react-native";
import { Camera, FileText, FileUp, Zap, Plus } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";

/**
 * ＋菜单（布局对齐批，参照桌面 PlusMenu 收拢形态；融合批 2026-10-22
 * 收三项）：功能入口不再平铺 Composer 底行，点击＋弹出底部面板——引用
 * 工作空间文件/上传文件/引用技能。原「附加图片」独立项已并入「上传
 * 文件」类型分流（图片文件自动走多模态链——file-pick）。files 能力
 * 门禁只挂引用文件项（上传文件本地读取零远端依赖、引用技能走 skills
 * 面，均不挂 files 门）。
 */
export function PlusSheet({
  visible,
  filesCap,
  onPickFileRef,
  onTakePhoto,
  onPickLocalFile,
  onPickSkillRef,
  onClose,
}: {
  visible: boolean;
  /** files 能力（引用文件项门禁） */
  filesCap: boolean;
  onPickFileRef: () => void;
  /** 拍照输入（输入层现代化批）：系统相机 → 多模态压缩链暂存 */
  onTakePhoto: () => void;
  /** 上传本地文件（系统选择器多选 → 图片分流多模态/文本读取暂存注入） */
  onPickLocalFile: () => void;
  onPickSkillRef: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();

  const items = [
    ...(filesCap
      ? [
          {
            key: "fileRef",
            label: t("pickFileRef"),
            Icon: FileText,
            onPress: onPickFileRef,
          },
        ]
      : []),
    {
      key: "takePhoto",
      label: t("takePhoto"),
      Icon: Camera,
      onPress: onTakePhoto,
    },
    {
      key: "localFile",
      label: t("uploadFile"),
      Icon: FileUp,
      onPress: onPickLocalFile,
    },
    {
      key: "skillRef",
      label: t("pickSkillRef"),
      Icon: Zap,
      onPress: onPickSkillRef,
    },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable className="flex-1 justify-end bg-black/60" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="rounded-t-2xl bg-white shadow-lg shadow-black/25 px-4 pb-8 pt-3 dark:bg-neutral-900"
        >
          <View className="mb-2 self-center h-[5px] w-9 rounded-full bg-black/20 dark:bg-white/25" />
          <Text className="mb-1 px-1 text-xs font-medium text-label3 dark:text-[#EBEBF54D]">
            {t("plusMenuTitle")}
          </Text>
          <View className="flex-row flex-wrap px-1">
            {items.map(({ key, label, Icon, onPress }) => (
              <Pressable
                key={key}
                onPress={() => {
                  onClose();
                  // iOS：系统 document-picker 需 present 到根控制器，RN Modal
                  // 关闭动画进行中同帧调起会 present 冲突立即 canceled（真机
                  // 「上传文件无反应」根因）——待 Modal 退场后再回调入口
                  setTimeout(onPress, 350);
                }}
                className="w-1/3 items-center gap-1.5 py-3"
                style={({ pressed }) => ({
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <View
                  className="h-14 w-14 items-center justify-center rounded-2xl"
                  style={{ backgroundColor: colors.subtle }}
                >
                  <Icon size={22} color={colors.primary} />
                </View>
                <Text className="text-xs text-black dark:text-white">
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** ＋按钮（Composer 底行左侧——桌面同位） */
export function PlusButton({
  disabled,
  onPress,
}: {
  disabled?: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className="h-9 w-9 items-center justify-center rounded-lg"
      style={{
        backgroundColor: colors.subtle,
        opacity: disabled ? 0.4 : 1,
      }}
      accessibilityLabel={t("plusMenuTitle")}
    >
      <Plus size={18} color={colors.primary} />
    </Pressable>
  );
}
