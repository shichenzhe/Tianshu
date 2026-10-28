import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from "react-native";
import {
  ArrowUp,
  FileText,
  FileUp,
  ImagePlus,
  Plus,
  Sparkles,
  Square,
  X,
  Zap,
} from "lucide-react-native";

import { PlusSheet } from "@/components/PlusSheet";
import { AppIcon } from "@/components/AppIcon";
import { tapSuccess } from "@/lib/haptics";
import { useThemeColors } from "@/store/theme";

/** 破坏性操作外的强调红（中止键——systemRed 语义，非主题色） */
const STOP_BG = "#FF3B30";

/** 待发送图片（MB-T1：选图暂存 base64，发送时由 startSend 上传） */
export interface PendingImage {
  name: string;
  base64: string;
}

interface Props {
  /** send 受理中（202 至 finish/error 收尾）：输入锁定、发送键变中止 */
  sending: boolean;
  /** 返回是否受理成功（true 时清空输入） */
  onSend: (content: string) => Promise<boolean>;
  /** 中止当前流（fire-and-forget） */
  onStop: () => void;
  /** MB-T1：被控端 files 能力（capability 协商——无则附件按钮不渲染） */
  filesCap?: boolean;
  /** 暂存图（多张——上传文件分流批；发送成功由调用方清除） */
  pendingImages?: PendingImage[];
  /** 移除暂存图（按名） */
  onRemoveImage: (name: string) => void;
  /** LT-T2 编辑态：非 null 时输入预填该文本、显示取消钮（发送由调用方
   *  分流至 editAndResend；进编辑态请以 key 变化 remount 本组件） */
  editingInitialText?: string | null;
  /** 取消编辑（编辑态取消钮） */
  onCancelEdit?: () => void;
  /** LT-T4 文件引用入口（files 能力门禁由调用方把守） */
  onPickFileRef?: () => void;
  /** 已引用文件路径（pill 展示；发送由调用方读内容拼前缀） */
  fileRefs: string[];
  /** 移除引用 */
  onRemoveFileRef: (path: string) => void;
  /** 上传本地文件入口（添加文件对齐批：系统选择器多选 → 文本读取暂存，
   *  发送时内容注入——对齐桌面 file:pickAndRead 语义，不落库不落盘） */
  onPickLocalFile?: () => void;
  /** 拍照输入入口（输入层现代化批）：系统相机 → 多模态压缩链暂存 */
  onTakePhoto?: () => void;
  /** 已上传本地文件（pill 展示；内容随发送注入消息文本） */
  localFiles?: Array<{ name: string; content: string }>;
  /** 移除本地文件（按名） */
  onRemoveLocalFile?: (name: string) => void;
  /** 技能引用入口（功能对齐批：skills/query 面由调用方把守） */
  onPickSkillRef?: () => void;
  /** 已引用技能名（pill 展示；发送时 skills/read 并入消息文本） */
  skillRefs: string[];
  /** 移除技能引用 */
  onRemoveSkillRef: (name: string) => void;
  /** 快捷提示填入（quickPrompts 点击）：nonce 变化即以 text 替换输入
   *  （对齐 PC setContent(prompt)——同提示重复点击也生效） */
  prefill?: { text: string; nonce: number } | null;
  /** A9 阶段 3 润色入口：传入即露出润色键——对当前草稿调 session/polish，
   *  返回非 null（润色后文本）即替换草稿；null（失败）草稿不动（提示由
   *  调用方出）。loading 态（防重复点）在组件内自管 */
  onPolish?: (text: string) => Promise<string | null>;
  /** 底行左槽（＋菜单右侧）：权限/专家/模式胶囊——桌面 ChatInput 底行
   *  左组同位（props: "flex flex-wrap items-center gap-y-1" 桌面原文） */
  bottomLeft?: ReactNode;
  /** 底行右槽（发送键左侧）：用量胶囊 + 模型选择——桌面底行右组
   *  （ContextUsageButton → ModelPicker → 发送/停止）同位同序 */
  bottomRight?: ReactNode;
}

/** 输入区（T14）：多行输入 + 附件/发送/中止键；sending 锁输入
 * （CONCURRENT_REQUEST 守卫的客户端侧配合）。MB-T1 增图片附件 pill
 * （files 能力门禁；发送时上传对齐桌面 FA 口径） */
export function Composer({
  sending,
  onSend,
  onStop,
  filesCap = false,
  pendingImages = [],
  onRemoveImage,
  editingInitialText = null,
  onCancelEdit,
  onPickFileRef,
  fileRefs,
  onRemoveFileRef,
  onPickLocalFile,
  onTakePhoto,
  localFiles = [],
  onRemoveLocalFile,
  onPickSkillRef,
  skillRefs = [],
  onRemoveSkillRef,
  prefill = null,
  onPolish,
  bottomLeft,
  bottomRight,
}: Props) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [text, setText] = useState(editingInitialText ?? "");
  const editing = editingInitialText != null;
  const [busy, setBusy] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [polishing, setPolishing] = useState(false);

  // 快捷提示填入（发送/编辑态不打扰——仅空闲时替换输入）
  useEffect(() => {
    if (prefill == null || sending || editing) return;
    setText(prefill.text);
  }, [prefill, sending, editing]);

  const canSend = text.trim() !== "" && !busy;

  async function handleSend() {
    if (!canSend) return;
    setBusy(true);
    const accepted = await onSend(text.trim());
    setBusy(false);
    if (accepted) {
      tapSuccess(); // 发送受理触觉确认（输入层现代化批）
      setText("");
    }
  }

  // A9 阶段 3 润色：成功以返回值替换草稿，null（失败）不动——loading 态
  // 锁键防重复点
  async function handlePolish() {
    if (onPolish == null || polishing || text.trim() === "") return;
    setPolishing(true);
    try {
      const polished = await onPolish(text);
      if (polished != null) {
        setText(polished);
      }
    } finally {
      setPolishing(false);
    }
  }

  return (
    <View className="border-t border-sep dark:border-[#545458A6]">
      {pendingImages.length > 0 && (
        <View className="flex-row flex-wrap items-center gap-2 px-3 pt-2">
          {pendingImages.map((image) => (
            <View
              key={image.name}
              className="flex-row items-center gap-1.5 rounded-lg bg-field px-2.5 py-1.5 dark:bg-[#2C2C2E]"
            >
              <ImagePlus size={13} color={colors.primary} />
              <Text
                numberOfLines={1}
                className="max-w-48 text-xs text-black/80 dark:text-white/80"
              >
                {image.name}
              </Text>
              <Pressable
                onPress={() => onRemoveImage(image.name)}
                hitSlop={8}
                disabled={sending}
                accessibilityLabel="remove image"
              >
                <X size={14} color="#8E8E93" />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {fileRefs.length > 0 && (
        <View className="flex-row flex-wrap items-center gap-1.5 px-3 pt-2">
          {fileRefs.map((path) => (
            <View
              key={path}
              className="flex-row items-center gap-1 rounded-md bg-field px-2 py-1 dark:bg-[#2C2C2E]"
            >
              <FileText size={11} color={colors.primary} />
              <Text
                numberOfLines={1}
                className="max-w-40 text-xs text-black/80 dark:text-white/80"
              >
                {path}
              </Text>
              <Pressable
                onPress={() => onRemoveFileRef(path)}
                hitSlop={6}
                disabled={sending}
                accessibilityLabel={`remove ref ${path}`}
              >
                <X size={12} color="#8E8E93" />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {localFiles.length > 0 && (
        <View className="flex-row flex-wrap items-center gap-1.5 px-3 pt-2">
          {localFiles.map((file) => (
            <View
              key={file.name}
              className="flex-row items-center gap-1 rounded-md bg-field px-2 py-1 dark:bg-[#2C2C2E]"
            >
              <FileUp size={11} color={colors.primary} />
              <Text
                numberOfLines={1}
                className="max-w-40 text-xs text-black/80 dark:text-white/80"
              >
                {file.name}
              </Text>
              <Pressable
                onPress={() => onRemoveLocalFile?.(file.name)}
                hitSlop={6}
                disabled={sending}
                accessibilityLabel={`remove file ${file.name}`}
              >
                <X size={12} color="#8E8E93" />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {skillRefs.length > 0 && (
        <View className="flex-row flex-wrap items-center gap-1.5 px-3 pt-2">
          {skillRefs.map((name) => (
            <View
              key={name}
              className="flex-row items-center gap-1 rounded-md bg-field px-2 py-1 dark:bg-[#2C2C2E]"
            >
              <Zap size={11} color={colors.primary} />
              <Text
                numberOfLines={1}
                className="max-w-40 text-xs text-black/80 dark:text-white/80"
              >
                {name}
              </Text>
              <Pressable
                onPress={() => onRemoveSkillRef(name)}
                hitSlop={6}
                disabled={sending}
                accessibilityLabel={`remove skill ${name}`}
              >
                <X size={12} color="#8E8E93" />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {editing && !sending && (
        <View className="flex-row items-center justify-between px-3 pt-2">
          <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
            {t("editing")}
          </Text>
          <Pressable onPress={onCancelEdit} hitSlop={8}>
            <Text className="text-xs" style={{ color: colors.primary }}>
              {t("cancelEdit")}
            </Text>
          </Pressable>
        </View>
      )}
      {/* chips 行（GL 批重构）：权限·专家·模式·用量·模型胶囊收纳为条上
          一行轻 chips——替代原底行控制台式胶囊堆（槽位契约不变仅换位，
          桌面对齐注释随 GL 批解除视觉同构约束） */}
      {(bottomLeft != null || bottomRight != null) && (
        <View className="flex-row flex-wrap items-center gap-1.5 px-3 pb-1.5 pt-2">
          {bottomLeft}
          {bottomRight}
        </View>
      )}
      {/* 输入条一体（ChatGPT 式）：＋与发送/中止内嵌大圆角条内，多行增高 */}
      <View className="px-3 pb-2">
        <View className="flex-row items-end gap-1.5 rounded-[24px] bg-field px-1.5 py-1.5 dark:bg-[#2C2C2E]">
          {!sending && !editing && (
            <Pressable
              onPress={() => setPlusOpen(true)}
              disabled={busy}
              hitSlop={4}
              accessibilityLabel={t("plusMenuTitle")}
              className="h-9 w-9 items-center justify-center self-center rounded-full"
              style={{ opacity: busy ? 0.4 : 1 }}
            >
              <AppIcon
                name="plus"
                fallback={Plus}
                size={20}
                color={colors.primary}
                weight="semibold"
              />
            </Pressable>
          )}
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={sending ? t("sending") : t("placeholder")}
            placeholderTextColor="#8E8E93"
            multiline
            editable={!sending}
            className="max-h-32 min-h-[36px] flex-1 px-1 py-1.5 text-[15px] text-black dark:text-white"
          />
          {onPolish != null && !sending && text.trim() !== "" && (
            <Pressable
              onPress={() => void handlePolish()}
              disabled={polishing}
              hitSlop={4}
              accessibilityLabel={t("polish")}
              className="h-9 w-9 items-center justify-center self-center rounded-full"
              style={{ opacity: polishing ? 0.4 : 1 }}
            >
              {polishing ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Sparkles size={18} color={colors.primary} />
              )}
            </Pressable>
          )}
          {sending ? (
            <Pressable
              onPress={onStop}
              accessibilityLabel={t("stop")}
              className="h-9 w-9 items-center justify-center rounded-full"
              style={{ backgroundColor: STOP_BG }}
            >
              <Square size={12} color="#fff" fill="#fff" />
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void handleSend()}
              disabled={!canSend}
              accessibilityLabel={t("send")}
              className="h-9 w-9 items-center justify-center rounded-full"
              style={{
                backgroundColor: colors.primary,
                opacity: canSend ? 1 : 0.4,
              }}
            >
              <AppIcon
                name="arrow.up"
                fallback={ArrowUp}
                size={18}
                color="#fff"
                weight="semibold"
              />
            </Pressable>
          )}
        </View>
      </View>

      {/* ＋菜单面板（引用文件/上传文件(含图片分流)/引用技能） */}
      <PlusSheet
        visible={plusOpen}
        filesCap={filesCap}
        onPickFileRef={() => onPickFileRef?.()}
        onPickLocalFile={() => onPickLocalFile?.()}
        onTakePhoto={() => onTakePhoto?.()}
        onPickSkillRef={() => onPickSkillRef?.()}
        onClose={() => setPlusOpen(false)}
      />
    </View>
  );
}
