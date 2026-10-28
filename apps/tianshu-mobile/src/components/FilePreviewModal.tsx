import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ENDPOINTS } from "@tianshu/protocol";
import * as Clipboard from "expo-clipboard";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Copy, Pencil, X } from "lucide-react-native";
import { WebView } from "react-native-webview";

import { toast } from "@/lib/toast-bus";
import { fileRefBasename } from "@/logic/file-refs";
import {
  buildWidgetSrcDoc,
  parseWidgetResize,
  WIDGET_INITIAL_HEIGHT,
} from "@/logic/widget-srcdoc";
import { MarkdownLite } from "@/components/MarkdownLite";
import { useThemeColors } from "@/store/theme";
import { wireRequest } from "@/transport/wire";

/** 预览渲染上限（字符）：files/read 上限 512KB，全量塞渲染树会卡 */
const PREVIEW_MAX_CHARS = 50000;

type PreviewState = { status: "loading" } | { status: "ok"; content: string };

/**
 * 文件全文预览弹层（MR-T6，自 MessageFileRef 抽取复用）：缺省 files/read
 * 拉全文；提供 loadContent 时改走自定义拉取（技能卡走 skills/read——成功
 * string / 失败 null 同失败口径）→ MarkdownLite 渲染 + 超长截断（按行
 * 边界取整）+ 复制全文；读取失败 toast 并关闭。visible 置 true 时发起
 * 拉取。
 */
export function FilePreviewModal({
  path,
  workspaceId,
  loadContent,
  visible,
  onClose,
  onEdit,
}: {
  path: string;
  workspaceId: number | null;
  /** 自定义拉取（取代缺省 files/read）：成功 string，失败 null 走既有
   *  失败 toast + onClose；缺省行为不变（MessageFileRef/产物 sheet） */
  loadContent?: () => Promise<string | null>;
  visible: boolean;
  onClose: () => void;
  /** 资料库编辑批：调用方提供时预览态头部出「编辑」入口（仅文本类条目
   *  传入；其余消费方缺省无此按钮） */
  onEdit?: () => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // HTML 产物 WebView 预览（富内容批）：高度桥复用 widget 协议
  const [htmlHeight, setHtmlHeight] = useState(WIDGET_INITIAL_HEIGHT);
  const isHtml = /\.(html?)$/i.test(path);

  useEffect(() => {
    if (!visible) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview({ status: "loading" });
    const fetch =
      loadContent ??
      (() =>
        wireRequest("POST", ENDPOINTS.files.read, { workspaceId, path }).then(
          (r) => {
            const content = r.ok
              ? (r.data as { content?: unknown } | null)?.content
              : undefined;
            return typeof content === "string" ? content : null;
          },
        ));
    void fetch().then((content) => {
      if (cancelled) return;
      if (typeof content === "string") {
        setPreview({ status: "ok", content });
      } else {
        toast.error(t("fileReadFailed"));
        onClose();
      }
    });
    return () => {
      cancelled = true;
    };
    // 拉取按 visible/path 单次触发；loadContent 须调用方 useCallback 稳定；
    // t/onClose 为稳定引用或随语言/宿主更新重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, path, workspaceId, loadContent]);

  const handleCopy = async (content: string) => {
    try {
      await Clipboard.setStringAsync(content);
      toast.info(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const fullContent = preview?.status === "ok" ? preview.content : null;
  const truncated =
    fullContent != null && fullContent.length > PREVIEW_MAX_CHARS;
  const shownContent = truncated
    ? fullContent.slice(0, PREVIEW_MAX_CHARS).replace(/\n[^\n]*$/, "")
    : fullContent;
  const lineCount = fullContent != null ? fullContent.split("\n").length : 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        className="flex-1 justify-center bg-black/60 px-4"
        onPress={onClose}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="max-h-[85%] rounded-2xl bg-white shadow-lg shadow-black/25 p-4 dark:bg-neutral-900"
        >
          <View className="mb-1 flex-row items-center gap-2">
            <Text
              numberOfLines={1}
              className="flex-1 text-sm font-medium text-black dark:text-white"
            >
              {t("fileRefPreviewTitle", { name: fileRefBasename(path) })}
            </Text>
            {preview?.status === "ok" && (
              <>
                {onEdit && (
                  <Pressable
                    onPress={onEdit}
                    accessibilityLabel={t("fileRefEdit")}
                    hitSlop={8}
                    className="mr-1"
                  >
                    <Pencil size={16} color={colors.primary} />
                  </Pressable>
                )}
                <Pressable
                  onPress={() => void handleCopy(preview.content)}
                  accessibilityLabel={t("copy")}
                  hitSlop={8}
                  className="mr-1"
                >
                  <Copy size={16} color={colors.primary} />
                </Pressable>
              </>
            )}
            <Pressable
              onPress={onClose}
              accessibilityLabel={t("close")}
              hitSlop={8}
            >
              <X size={18} color={colors.primary} />
            </Pressable>
          </View>
          <Text
            numberOfLines={1}
            className="mb-2 text-xs text-label3 dark:text-[#EBEBF54D]"
          >
            {path}
          </Text>
          {preview?.status !== "ok" ? (
            <View className="h-40 items-center justify-center">
              <ActivityIndicator size="small" color="#8E8E93" />
            </View>
          ) : isHtml ? (
            // HTML 产物走 WebView 沙箱（复用 widget CSP+高度桥）；不套 50k
            // 截断——截断破坏页面结构，512KB read 上限天然封顶
            <WebView
              source={{ html: buildWidgetSrcDoc(preview.content) }}
              javaScriptEnabled
              originWhitelist={["*"]}
              style={{ height: htmlHeight, backgroundColor: "transparent" }}
              onMessage={(e) => {
                const next = parseWidgetResize(e.nativeEvent.data);
                if (next != null) setHtmlHeight(next);
              }}
            />
          ) : (
            <>
              {truncated && (
                <Text className="mb-1 text-xs text-amber-600 dark:text-amber-400">
                  {t("fileRefTruncated", {
                    shown: shownContent?.length ?? 0,
                    total: fullContent?.length ?? 0,
                  })}
                </Text>
              )}
              <ScrollView>
                <MarkdownLite text={shownContent ?? ""} />
                <Text className="mt-3 mb-1 text-[10px] text-black/30 dark:text-white/30">
                  {t("fileRefStats", {
                    lines: lineCount,
                    chars: fullContent?.length ?? 0,
                  })}
                </Text>
              </ScrollView>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
