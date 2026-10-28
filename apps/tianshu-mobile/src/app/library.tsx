// 资料库页（A5 批）：浏览（list+面包屑回退）/搜索/最近/收藏四面 + 新建
// （文件夹/Markdown/链接）、重命名/移动（tree 拍平选目标）/删除（文件夹先
// subtreeCount 确认）、文本·Markdown 只读预览与图片预览（markViewed 联动
// 最近）。页内双重 capability 门禁：无连接/无 library 能力 → 降级引导页。
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  Image as ImageIcon,
  Link,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react-native";

import { AppActionSheet } from "@/components/AppActionSheet";
import { CsvPreviewModal } from "@/components/CsvPreviewModal";
import { DialogShell } from "@/components/DialogShell";
import { FilePreviewModal } from "@/components/FilePreviewModal";
import { FormField, PLACEHOLDER } from "@/components/FormField";
import { FormFooter } from "@/components/FormFooter";
import { LibraryTextEditModal } from "@/components/LibraryTextEditModal";
import { PageHeader } from "@/components/PageHeader";
import { ArtifactSection } from "@/components/ArtifactSection";
import { ArtifactPreviewModal } from "@/components/ArtifactPreviewModal";
import { useArtifactStore } from "@/store/artifact.store";
import { formatSize } from "@/lib/format-size";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { toast } from "@/lib/toast-bus";
import {
  imageFailureKey,
  libraryErrorCodeOf,
} from "@/logic/library-image-error";
import { previewRouteOf, TEXT_FILE_TYPES } from "@/logic/library-preview-route";
import { pickLibraryFile } from "@/logic/library-upload";
import { formatRelative } from "@/logic/time";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import { useLibraryStore, type LibraryRow } from "@/store/library.store";
import { useThemeColors } from "@/store/theme";

type CreateKind = "folder" | "file" | "link";

const SEARCH_DEBOUNCE_MS = 300;

function rowIcon(item: LibraryRow, color: string) {
  if (item.kind === "folder") return <Folder size={20} color={color} />;
  if (item.kind === "link") return <Link size={20} color={color} />;
  if (item.fileType === "image") {
    return <ImageIcon size={20} color={color} />;
  }
  return <FileText size={20} color={color} />;
}

/** 行 meta：文件 size+相对时间，文件夹相对时间，链接 url */
function metaOf(
  item: LibraryRow,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  const time = relativeTimeLabel(formatRelative(item.updatedAt), t);
  if (item.kind === "link") return item.url ?? time;
  if (item.kind === "folder") return time;
  return `${formatSize(item.size)} · ${time}`;
}

/** 浏览态面包屑横滚：根「资料库」+ 各级名，点击跳回对应层 */
function Breadcrumbs({
  breadcrumbs,
  rootLabel,
  onNavigate,
}: {
  breadcrumbs: LibraryRow[];
  rootLabel: string;
  onNavigate: (parentId: number | null) => void;
}) {
  const colors = useThemeColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 0 }}
      contentContainerStyle={{
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 12,
        paddingBottom: 8,
      }}
    >
      <Pressable onPress={() => onNavigate(null)} hitSlop={8}>
        <Text className="text-sm" style={{ color: colors.primary }}>
          {rootLabel}
        </Text>
      </Pressable>
      {breadcrumbs.map((crumb) => (
        <View key={crumb.id} className="flex-row items-center gap-1">
          <ChevronRight size={12} color="#C7C7CC" />
          <Pressable onPress={() => onNavigate(crumb.id)} hitSlop={8}>
            <Text className="text-sm" style={{ color: colors.primary }}>
              {crumb.name}
            </Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

/** 分段栏 [浏览|最近|收藏]（search 模式时隐藏） */
function ModeSegments({
  mode,
  disabled,
  onSelect,
}: {
  mode: string;
  disabled: boolean;
  onSelect: (mode: "browse" | "recent" | "favorites") => void;
}) {
  const { t } = useTranslation("library");
  const colors = useThemeColors();
  const options = [
    { key: "browse", label: t("browse") },
    { key: "recent", label: t("recent") },
    { key: "favorites", label: t("favorites") },
  ] as const;
  return (
    <View className="px-3 pb-2">
      <View className="flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
        {options.map((option) => {
          const active = option.key === mode;
          return (
            <Pressable
              key={option.key}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(option.key)}
              className="flex-1 items-center rounded-md px-3 py-2"
              style={{
                backgroundColor: active ? colors.primary : "transparent",
              }}
            >
              <Text
                className={`text-xs ${active ? "font-medium text-white" : "text-label2 dark:text-[#EBEBF599]"}`}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** 列表行：kind/fileType 图标 + 名称 + meta + 收藏星 + ⋯ 菜单 */
function LibraryListRow({
  item,
  meta,
  isLast,
  onOpen,
  onMenu,
  onToggleFavorite,
}: {
  item: LibraryRow;
  meta: string;
  isLast: boolean;
  onOpen: (item: LibraryRow) => void;
  onMenu: (item: LibraryRow) => void;
  onToggleFavorite: (item: LibraryRow) => void;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={() => onOpen(item)}
      onLongPress={() => onMenu(item)}
      className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      {rowIcon(item, colors.primary)}
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className="text-[15px] text-black dark:text-white"
        >
          {item.name}
        </Text>
        <Text
          numberOfLines={1}
          className="mt-0.5 text-xs text-label3 dark:text-[#EBEBF54D]"
        >
          {meta}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => onToggleFavorite(item)}
      >
        <Star
          size={16}
          color={item.favorite ? colors.primary : "#C7C7CC"}
          fill={item.favorite ? colors.primary : "transparent"}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => onMenu(item)}
      >
        <MoreHorizontal size={18} color="#C7C7CC" />
      </Pressable>
    </Pressable>
  );
}

/** 新建对话框：文件夹 / Markdown（固定 .md，缺扩展名自动补）/ 链接（url+标题） */
function CreateDialog({
  kind,
  busy,
  onClose,
  onSubmit,
}: {
  kind: CreateKind;
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: {
    name?: string;
    url?: string;
    title?: string | null;
  }) => void;
}) {
  const { t } = useTranslation("library");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const titleKey =
    kind === "folder" ? "newFolder" : kind === "file" ? "newFile" : "newLink";

  function handleConfirm() {
    if (kind === "link") {
      const trimmed = url.trim();
      if (!/^https?:\/\//i.test(trimmed)) {
        setError(t("invalidUrl"));
        return;
      }
      onSubmit({ url: trimmed, title: linkTitle.trim() || null });
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) return;
    // 移动端固定 Markdown：缺 .md 扩展名自动补全
    const finalName =
      kind === "file" && !/\.md$/i.test(trimmed) ? `${trimmed}.md` : trimmed;
    onSubmit({ name: finalName });
  }

  return (
    <DialogShell
      title={t(titleKey)}
      busy={busy}
      onClose={onClose}
      footer={
        <FormFooter
          busy={busy}
          confirmDisabled={kind === "link" ? !url.trim() : !name.trim()}
          onConfirm={handleConfirm}
          onCancel={onClose}
        />
      }
    >
      {kind === "link" ? (
        <>
          <FormField
            label={t("linkUrl")}
            value={url}
            onChangeText={(text) => {
              setUrl(text);
              setError(null);
            }}
            placeholder="https://"
          />
          <FormField
            label={t("linkTitle")}
            value={linkTitle}
            onChangeText={setLinkTitle}
          />
        </>
      ) : (
        <FormField
          label={t("name")}
          value={name}
          onChangeText={setName}
          placeholder={kind === "file" ? "笔记.md" : undefined}
        />
      )}
      {error && <Text className="text-xs text-red-500">{error}</Text>}
    </DialogShell>
  );
}

/** 重命名对话框（校验非空） */
function RenameDialog({
  item,
  busy,
  onClose,
  onSubmit,
}: {
  item: LibraryRow;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const { t } = useTranslation("library");
  const [name, setName] = useState(item.name);
  return (
    <DialogShell
      title={t("rename")}
      busy={busy}
      onClose={onClose}
      footer={
        <FormFooter
          busy={busy}
          confirmDisabled={!name.trim()}
          onConfirm={() => onSubmit(name.trim())}
          onCancel={onClose}
        />
      }
    >
      <FormField label={t("name")} value={name} onChangeText={setName} />
    </DialogShell>
  );
}

/** 移动对话框：library/tree 全量拍平，只显 folder 行（缩进按 location 深度） */
function MoveDialog({
  item,
  busy,
  onClose,
  onSubmit,
}: {
  item: LibraryRow;
  busy: boolean;
  onClose: () => void;
  onSubmit: (targetParentId: number | null) => void;
}) {
  const { t } = useTranslation("library");
  const colors = useThemeColors();
  const loadTree = useLibraryStore((state) => state.loadTree);
  const [folders, setFolders] = useState<LibraryRow[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // 根目录目标为 null，与「未选择」同值——用独立旗标区分
  const [rootSelected, setRootSelected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadTree().then((rows) => {
      if (cancelled) return;
      setFolders(
        rows.filter((row) => row.kind === "folder" && row.id !== item.id),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [item.id, loadTree]);

  function renderRow(
    key: string,
    label: string,
    depth: number,
    target: number | null,
    Icon: typeof Folder,
  ) {
    const active = rootSelected
      ? target === null
      : target !== null && selected === target;
    return (
      <Pressable
        key={key}
        onPress={() => {
          if (target === null) {
            setRootSelected(true);
          } else {
            setRootSelected(false);
            setSelected(target);
          }
        }}
        className="flex-row items-center gap-3 rounded-lg px-3 py-3"
        style={{
          backgroundColor: active ? colors.subtle : "transparent",
          marginLeft: depth * 16,
        }}
      >
        <Icon size={16} color={colors.primary} />
        <Text
          numberOfLines={1}
          className="flex-1 text-sm text-black dark:text-white"
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <DialogShell
      title={t("moveTo")}
      busy={busy}
      onClose={onClose}
      footer={
        <FormFooter
          busy={busy}
          confirmDisabled={!rootSelected && selected === null}
          onConfirm={() => onSubmit(rootSelected ? null : selected)}
          onCancel={onClose}
        />
      }
    >
      <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
        {t("selectTarget")}
      </Text>
      {folders === null ? (
        <ActivityIndicator color={colors.primary} size="small" />
      ) : (
        <View className="gap-0.5">
          {renderRow("root", t("moveToRoot"), 0, null, FolderOpen)}
          {folders.map((folder) =>
            renderRow(
              String(folder.id),
              folder.name,
              folder.location.length + 1,
              folder.id,
              Folder,
            ),
          )}
        </View>
      )}
    </DialogShell>
  );
}

/** 图片预览弹层：readImage 拼 data URL 渲染；失败按错误码出独立文案
 *  （LIBRARY_TOO_LARGE/LIBRARY_BINARY，A5 尾）；variant=svg 时改走 WebView
 *  data URL（服务端白名单已扩 svg） */
function ImagePreviewModal({
  item,
  variant = "image",
  visible,
  onClose,
}: {
  item: LibraryRow | null;
  variant?: "image" | "svg";
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("library");
  const readImage = useLibraryStore((state) => state.readImage);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ok"; url: string }
    | { status: "failed"; code: string | null }
  >({ status: "loading" });

  useEffect(() => {
    if (!visible || !item) return;
    let cancelled = false;
    setState({ status: "loading" });
    readImage(item.id)
      .then((result) => {
        if (cancelled) return;
        setState({
          status: "ok",
          url: `data:${result.mime};base64,${result.dataBase64}`,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: "failed", code: libraryErrorCodeOf(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [visible, item, readImage]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View className="flex-1 items-center justify-center bg-black/80 px-6">
        <Pressable
          accessibilityLabel={t("back")}
          hitSlop={12}
          className="absolute right-5 top-14 z-10"
          onPress={onClose}
        >
          <X size={24} color="white" />
        </Pressable>
        {state.status === "ok" ? (
          variant === "svg" ? (
            <WebView
              source={{ uri: state.url }}
              originWhitelist={["*"]}
              className="h-3/4 w-full"
              style={{ backgroundColor: "transparent" }}
            />
          ) : (
            <Image
              source={{ uri: state.url }}
              resizeMode="contain"
              className="h-3/4 w-full"
            />
          )
        ) : (
          <View className="h-48 items-center justify-center">
            {state.status === "loading" ? (
              <ActivityIndicator color="white" size="large" />
            ) : (
              <Text className="text-center text-sm text-white/80">
                {t(imageFailureKey(state.code))}
              </Text>
            )}
          </View>
        )}
        {item && (
          <Text numberOfLines={1} className="mt-3 text-xs text-white/70">
            {item.name}
          </Text>
        )}
      </View>
    </Modal>
  );
}

export default function LibraryScreen() {
  const { t } = useTranslation(["library", "chat", "common"]);
  const router = useRouter();
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((state) => state.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const supported = capabilities?.includes("library") ?? false;
  const mode = useLibraryStore((state) => state.mode);
  const items = useLibraryStore((state) => state.items);
  const breadcrumbs = useLibraryStore((state) => state.breadcrumbs);
  const loading = useLibraryStore((state) => state.loading);
  const saving = useLibraryStore((state) => state.saving);
  const error = useLibraryStore((state) => state.error);
  const initialized = useLibraryStore((state) => state.initialized);
  const [query, setQuery] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  // 上传进度单槽：picker→上传全程占用，防重复进入（资料库上传批）
  const [uploading, setUploading] = useState(false);
  const [renameTarget, setRenameTarget] = useState<LibraryRow | null>(null);
  const [moveTarget, setMoveTarget] = useState<LibraryRow | null>(null);
  const [sheetTarget, setSheetTarget] = useState<LibraryRow | null>(null);
  const [previewTarget, setPreviewTarget] = useState<LibraryRow | null>(null);
  // 资料库编辑批：保存成功后 +1 触发预览重拉（loadContent 依赖推进）
  const [previewKey, setPreviewKey] = useState(0);
  const [editTarget, setEditTarget] = useState<LibraryRow | null>(null);
  const [csvTarget, setCsvTarget] = useState<LibraryRow | null>(null);
  const [imageTarget, setImageTarget] = useState<{
    item: LibraryRow;
    variant: "image" | "svg";
  } | null>(null);
  // AR 批：资料/本地产物视图切换——unsupported（无头端 404）时无切换条
  const artifactUnsupported = useArtifactStore((s2) => s2.unsupported);
  const [view, setView] = useState<"files" | "artifacts">("files");

  useEffect(() => {
    if (activeConnId && supported) {
      void useLibraryStore.getState().load(null);
    }
  }, [activeConnId, supported]);

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  /** 搜索输入防抖：非空即 search 模式，清空回浏览态 */
  function handleQueryChange(text: string) {
    setQuery(text);
    useLibraryStore.getState().setKeyword(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const keyword = text.trim();
    searchTimer.current = setTimeout(() => {
      if (keyword) void useLibraryStore.getState().search(keyword);
      else void useLibraryStore.getState().setMode("browse");
    }, SEARCH_DEBOUNCE_MS);
  }

  /** 行点击：文件夹进入 / 链接桌面端打开 / 文件按扩展名分流预览
   *  （A5 尾：html→WebView、csv→表格、svg→WebView data URL、bmp/ico 前置
   *  拦截提示桌面端，previewRouteOf 纯函数） */
  function openItem(item: LibraryRow) {
    if (item.kind === "folder") {
      void useLibraryStore.getState().load(item.id);
      return;
    }
    if (item.kind === "link") {
      toast.info(t("library:linkOpenOnDesktop"));
      return;
    }
    const route = previewRouteOf(item);
    if (route.kind === "desktop") {
      toast.info(t("library:previewOnDesktop"));
      return;
    }
    if (route.kind === "text") {
      setPreviewTarget(item);
    } else if (route.kind === "csv") {
      setCsvTarget(item);
    } else {
      setImageTarget({
        item,
        variant: route.kind === "svg" ? "svg" : "image",
      });
    }
    // 打开文件预览即 markViewed（联动桌面端「最近」口径）
    void useLibraryStore.getState().markViewed(item.id);
  }

  function notifyFailure() {
    const message = useLibraryStore.getState().error;
    toast.error(message || t("library:loadFailed"));
  }

  /** 删除：文件直接确认；文件夹先 subtreeCount 再带计数确认 */
  async function confirmDelete(item: LibraryRow) {
    let message = t("library:confirmDelete", { name: item.name });
    if (item.kind === "folder") {
      const count = await useLibraryStore.getState().subtreeCount(item.id);
      if (count !== null) {
        message = t("library:deleteFolderConfirm", { count });
      }
    }
    Alert.alert(t("library:delete"), message, [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("library:delete"),
        style: "destructive",
        onPress: () => void performRemove([item.id]),
      },
    ]);
  }

  async function performRemove(ids: number[]) {
    const ok = await useLibraryStore.getState().remove(ids);
    if (!ok) notifyFailure();
  }

  /** 导入文件：上传链（picker→扩展名守卫→3MB 预检）→ store.uploadFile；
   *  路由分流——浏览态按当前目录传 parentId（根目录 null），其余态传 null；
   *  失败按 codedError.code 出文案（LIBRARY_UPLOAD_INVALID 独立码） */
  async function handleImportFile() {
    if (uploading) return;
    setUploading(true);
    try {
      const picked = await pickLibraryFile();
      if (picked === null) return;
      if (picked === "invalid") {
        toast.error(t("library:importInvalid"));
        return;
      }
      if (picked === "tooLarge") {
        toast.error(t("library:importTooLarge"));
        return;
      }
      const store = useLibraryStore.getState();
      const parentId = store.mode === "browse" ? store.currentParentId : null;
      await store.uploadFile(parentId, picked.name, picked.base64);
    } catch (error) {
      const code = (error as { code?: string }).code;
      toast.error(
        code === "LIBRARY_UPLOAD_INVALID"
          ? t("library:errorUploadInvalid")
          : error instanceof Error && error.message
            ? error.message
            : t("library:importFailed"),
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleCreate(values: {
    name?: string;
    url?: string;
    title?: string | null;
  }) {
    const store = useLibraryStore.getState();
    let ok = false;
    if (createKind === "folder" && values.name) {
      ok = await store.createFolder(values.name);
    } else if (createKind === "file" && values.name) {
      ok = await store.createFile(values.name);
    } else if (createKind === "link" && values.url) {
      ok = await store.addLink(values.url, values.title ?? null);
    }
    if (ok) setCreateKind(null);
    else notifyFailure();
  }

  async function handleRename(name: string) {
    if (!renameTarget) return;
    const ok = await useLibraryStore.getState().rename(renameTarget.id, name);
    if (ok) setRenameTarget(null);
    else notifyFailure();
  }

  async function handleMove(targetParentId: number | null) {
    if (!moveTarget) return;
    const ok = await useLibraryStore
      .getState()
      .move([moveTarget.id], targetParentId);
    if (ok) setMoveTarget(null);
    else notifyFailure();
  }

  /** 错误重试：按当前模式重拉（非浏览态失败时脏标记未清，必重拉） */
  function retryLoad() {
    const store = useLibraryStore.getState();
    if (store.mode === "browse") void store.load(store.currentParentId);
    else if (store.mode === "recent") void store.loadRecent();
    else if (store.mode === "favorites") void store.loadFavorites();
    else void store.search(store.keyword);
  }

  const previewLoader = useCallback(async () => {
    if (!previewTarget) return null;
    try {
      return await useLibraryStore.getState().readText(previewTarget.id);
    } catch {
      return null;
    }
  }, [previewTarget, previewKey]);

  /** 预览态「编辑」入口可用性：文本类条目（markdown/text/code）——html
   *  走 WebView 渲染，内容含整页结构，编辑批 v1 不做 */
  function previewEditable(item: LibraryRow | null): boolean {
    if (!item || item.kind !== "file" || !item.fileType) return false;
    if (/\.html?$/i.test(item.name)) return false;
    return TEXT_FILE_TYPES.has(item.fileType);
  }

  /** 编辑保存成功：回预览态并刷新预览内容（列表行已由 store 就地更新） */
  function handleEditSaved() {
    setEditTarget(null);
    setPreviewKey((key) => key + 1);
  }

  const rowActionItems = sheetTarget
    ? [
        {
          key: "rename",
          label: t("library:rename"),
          Icon: Pencil,
          onPress: () => setRenameTarget(sheetTarget),
        },
        {
          key: "move",
          label: t("library:move"),
          Icon: FolderInput,
          onPress: () => setMoveTarget(sheetTarget),
        },
        {
          key: "favorite",
          label: t(
            sheetTarget.favorite ? "library:unfavorite" : "library:favorite",
          ),
          Icon: Star,
          onPress: () =>
            void useLibraryStore.getState().toggleFavorite(sheetTarget.id),
        },
        {
          key: "delete",
          label: t("library:delete"),
          Icon: Trash2,
          danger: true,
          onPress: () => void confirmDelete(sheetTarget),
        },
      ]
    : [];

  const createActionItems = [
    {
      key: "folder",
      label: t("library:newFolder"),
      Icon: Folder,
      onPress: () => setCreateKind("folder"),
    },
    {
      key: "file",
      label: t("library:newFile"),
      Icon: FileText,
      onPress: () => setCreateKind("file"),
    },
    {
      key: "link",
      label: t("library:newLink"),
      Icon: Link,
      onPress: () => setCreateKind("link"),
    },
    {
      key: "import",
      label: uploading ? t("library:importing") : t("library:importFile"),
      Icon: Upload,
      disabled: uploading,
      onPress: () => void handleImportFile(),
    },
  ];

  const emptyKey =
    mode === "browse"
      ? breadcrumbs.length > 0
        ? "folderEmpty"
        : "empty"
      : "empty";

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
            {t("library:unsupported")}
          </Text>
        </View>
      );
    }
    if (loading && !initialized) {
      return (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      );
    }
    if (error && !initialized) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("library:loadFailed")}
          </Text>
          <Text className="text-center text-xs text-label3 dark:text-[#EBEBF54D]">
            {error}
          </Text>
          <Pressable
            onPress={retryLoad}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">{t("library:retry")}</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <ScrollView className="flex-1">
        {mode === "browse" && (
          <Breadcrumbs
            breadcrumbs={breadcrumbs}
            rootLabel={t("library:rootName")}
            onNavigate={(parentId) =>
              void useLibraryStore.getState().load(parentId)
            }
          />
        )}
        {items.length === 0 ? (
          <Text className="py-20 text-center text-sm text-label2 dark:text-[#EBEBF599]">
            {t(`library:${emptyKey}`)}
          </Text>
        ) : (
          <View className="mx-3 overflow-hidden rounded-2xl">
            {items.map((item, index) => (
              <LibraryListRow
                key={item.id}
                item={item}
                meta={metaOf(item, t)}
                isLast={index === items.length - 1}
                onOpen={openItem}
                onMenu={setSheetTarget}
                onToggleFavorite={(row) =>
                  void useLibraryStore.getState().toggleFavorite(row.id)
                }
              />
            ))}
          </View>
        )}
      </ScrollView>
    );
  }

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader
        title={t("library:title")}
        backLabel={t("library:back")}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("library:newFolder")}
            disabled={!supported || saving || uploading}
            onPress={() => setCreateSheetOpen(true)}
            hitSlop={12}
            className="h-9 w-9 items-center justify-center rounded-full"
            style={({ pressed }) => ({
              backgroundColor: pressed ? colors.subtle : undefined,
              opacity: !supported || saving || uploading ? 0.4 : 1,
            })}
          >
            <Plus size={18} color={colors.primary} />
          </Pressable>
        }
      />
      {!artifactUnsupported && (
        <View className="flex-row gap-1 px-3 pb-2">
          {(["files", "artifacts"] as const).map((v) => (
            <Pressable
              key={v}
              accessibilityRole="button"
              onPress={() => setView(v)}
              className="flex-1 items-center rounded-lg py-1.5"
              style={{
                backgroundColor: view === v ? colors.subtle : undefined,
              }}
            >
              <Text
                className="text-sm"
                style={{ color: view === v ? colors.primary : "#8E8E93" }}
              >
                {t(v === "files" ? "library:tabFiles" : "library:tabArtifacts")}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {view === "files" && (
        <>
          <View className="px-3 pb-2">
            <TextInput
              value={query}
              onChangeText={handleQueryChange}
              placeholder={t("library:searchPlaceholder")}
              placeholderTextColor={PLACEHOLDER}
              autoCapitalize="none"
              autoCorrect={false}
              className="rounded-lg border border-sep bg-field px-3 py-2 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
            />
          </View>
          {mode !== "search" && (
            <ModeSegments
              mode={mode}
              disabled={saving}
              onSelect={(next) => void useLibraryStore.getState().setMode(next)}
            />
          )}
          {renderContent()}
        </>
      )}
      {view === "artifacts" && (
        <ArtifactSection
          onOpenPreview={(item) =>
            void useArtifactStore.getState().openPreview(item)
          }
        />
      )}
      <ArtifactPreviewModal />
      <AppActionSheet
        visible={createSheetOpen}
        items={createActionItems}
        onClose={() => setCreateSheetOpen(false)}
      />
      <AppActionSheet
        visible={sheetTarget !== null}
        title={sheetTarget?.name}
        items={rowActionItems}
        onClose={() => setSheetTarget(null)}
      />
      {createKind && (
        <CreateDialog
          kind={createKind}
          busy={saving}
          onClose={() => setCreateKind(null)}
          onSubmit={(values) => void handleCreate(values)}
        />
      )}
      {renameTarget && (
        <RenameDialog
          item={renameTarget}
          busy={saving}
          onClose={() => setRenameTarget(null)}
          onSubmit={(name) => void handleRename(name)}
        />
      )}
      {moveTarget && (
        <MoveDialog
          item={moveTarget}
          busy={saving}
          onClose={() => setMoveTarget(null)}
          onSubmit={(targetId) => void handleMove(targetId)}
        />
      )}
      <FilePreviewModal
        visible={previewTarget !== null}
        path={previewTarget?.name ?? ""}
        workspaceId={0}
        loadContent={previewLoader}
        onClose={() => setPreviewTarget(null)}
        onEdit={
          previewEditable(previewTarget)
            ? () => setEditTarget(previewTarget)
            : undefined
        }
      />
      {editTarget && (
        <LibraryTextEditModal
          item={editTarget}
          visible
          onClose={() => setEditTarget(null)}
          onSaved={handleEditSaved}
        />
      )}
      <ImagePreviewModal
        item={imageTarget?.item ?? null}
        variant={imageTarget?.variant ?? "image"}
        visible={imageTarget !== null}
        onClose={() => setImageTarget(null)}
      />
      <CsvPreviewModal
        item={csvTarget}
        visible={csvTarget !== null}
        onClose={() => setCsvTarget(null)}
      />
    </SafeAreaView>
  );
}
