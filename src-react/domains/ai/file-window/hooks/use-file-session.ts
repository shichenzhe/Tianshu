/**
 * 文件会话（每 tab 惰建，spec §6.2）：T26 起面板恒嵌 ChatPane（占位
 * SessionRecord id=-1），首条发送经 ChatPane sessionResolver 直发——本
 * hook 退守为「首条上下文准备 + 直发工具」：
 * - prepareFirstSend（原 sendWithFile/sendWithImage/sendLibrary 的会话
 *   落地与注入前缀计算，发送动作移交 ChatPane）：ensureSession
 *   （session:create + title=文件名）+ library 授权先行（grantFilePath
 *   幂等，spec §6.4）+ workspace 相对路径前缀（引用式：agent 用
 *   read_file 按需读，spec §6.3）/ library 引用式前缀（挂绑定空间：
 *   storagePath+read_file 指示不读全文，T30 spec §17；无绑定降级全文
 *   100k 截断且不带 read_file 死指令——文件四件不注入）/ 图片 tab
 *   absPath→images 附件。
 * - library（T14）：session:create 无默认空间落点（session.repo 缺
 *   workspaceId 即抛 WORKSPACE_NOT_FOUND）——渲染侧自取挂载空间：绑定
 *   目录的空间优先（修复轮 2：文件四件仅绑定空间注入，挂绑定空间
 *   grant 才有消费者），全未绑定时保底挂 list 首个（无空间时 list 自动
 *   补建「默认工作空间」）+ AI 面板降级提示条。
 * - reinject（spec §6.3）：文件被外部/AI 修改后追问时贴最新路径提示重读
 *   （library 文本条目无绑定空间时降级重注全文，T30；仍直发——
 *   dispatchChatSend 绕开 useChatSend.send 的 id 闭包，流式订阅归
 *   ChatPane 内 useChatSend 独占，T26 起本 hook 不再持有订阅）。
 * - T18 会话映射：发送报 SESSION_NOT_FOUND（seed 的会话已被删）时清 tab
 *   绑定 + 摘映射条目 + 专用提示（isSessionGoneError/dropDeadSession），
 *   用户再发即新建会话；grantFilePath 先于发送抛同错误时经 grantOrDrop
 *   就地善后。T22 补两个出口——handleSessionGone（getById 报会话已删
 *   善后）与 ensureLibraryGrant（library 会话授权补注册，等价旧每发
 *   grant 链）。
 */
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import ChatApi, { type ChatSendImage } from "@/domains/ai/api/chat.api";
import type { SessionRecord } from "@/domains/ai/api/session.api";
import WorkspaceApi from "@/domains/ai/api/workspace.api";
import { useChatStore } from "@/domains/ai/chat/store/chat.store";
import { invoke } from "@/lib/ipc";
import FileWindowApi from "../api/file-window.api";
import { libraryContentKindOf } from "../lib/content-kind";
import { libraryItemOf } from "../lib/library-item";
import { removeSession } from "../lib/session-map";
import { useFileWindowStore } from "../store/file-window.store";

/** library 首条注入全文上限（超出截断 + i18n 截断后缀） */
const LIBRARY_INJECT_LIMIT = 100_000;

/** chat:send 的会话不存在错误识别（T18 会话映射 seed 语义）：映射 seed
 *  的会话可能已被删（主窗会话列表删除），Electron invoke 拒绝把主进程
 *  Error("SESSION_NOT_FOUND") 串进 message——按子串匹配，供本 hook 清
 *  绑定与 FileChatPanel 抑制重复 toast */
export function isSessionGoneError(e: unknown): boolean {
  return String(e).includes("SESSION_NOT_FOUND");
}

/** 已删会话善后（T18）：清该 tab 绑定（再发即 ensureSession 新建）+ 摘
 *  映射该条目（同文件其余会话保留）+ 专用提示（面板 catch 按
 *  isSessionGoneError 抑制重复 toast）；「新建任务」不触发本路径 */
function dropDeadSession(
  sessionId: number,
  t: (key: string) => string,
  tabId: string,
): void {
  const tab = useFileWindowStore.getState().tabs.find((x) => x.id === tabId);
  if (!tab) return;
  if (tab.sessionId === sessionId)
    useFileWindowStore.getState().patchTab(tabId, { sessionId: undefined });
  removeSession(tab.resource, sessionId);
  toast.error(t("chat:fileWindow.chat.sessionGone"));
}

interface EnsuredSession {
  id: number;
  created: boolean;
  /** 挂载空间是否带绑定目录（T30 spec §17 引用式注入判定，仅 library
   *  新建路径有值）：挂绑定空间文件四件才注入（read_file/write_file 可
   *  用）——与 FileChatPanel noBoundWorkspace 判定同源（绑定优先挂载下
   *  两语义等价），取自 ensureSession 自身的 workspace:list（与面板
   *  查询同数据源，不重复 IPC） */
  mountedOnBound?: boolean;
}

export function useFileSession(tabId: string) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const tab = useFileWindowStore((s) => s.tabs.find((x) => x.id === tabId));
  // 并发防重入：首条连点只建一个会话
  const ensuringRef = useRef<Promise<EnsuredSession> | null>(null);

  /** 直发（绕开 ChatPane 内 useChatSend.send 的 id 闭包）：流式状态先行，
   *  失败收尾与 useChatSend.send 完全对齐（finishStream 清流 + invalidate
   *  重取——用户消息可能已落库后才抛 NO_MODEL 等，不失效重取则列表缺条
   *  且重试追加重复消息）。会话不存在（T18 seed 的会话已被删）：清 tab
   *  绑定 + 摘映射该条目 + 专用提示，用户再发即新建 */
  const dispatchChatSend = useCallback(
    async (sessionId: number, content: string, images?: ChatSendImage[]) => {
      useChatStore.getState().startStream(sessionId);
      try {
        await ChatApi.send({ sessionId, content, images });
      } catch (e) {
        useChatStore.getState().finishStream(sessionId);
        void queryClient.invalidateQueries({
          queryKey: ["messages", sessionId],
        });
        if (isSessionGoneError(e)) dropDeadSession(sessionId, t, tabId);
        throw e;
      }
    },
    [queryClient, tabId, t],
  );

  /** 授权注册（library 发送/重注，修复轮 I1）：grant 对已删会话与
   *  chat:send 同抛 SESSION_NOT_FOUND，且发生在 dispatchChatSend 之外——
   *  就地 dropDeadSession（清绑定+摘映射+提示）后 rethrow，调用方抑制/
   *  回填链不变 */
  const grantOrDrop = useCallback(
    async (sessionId: number, absPath: string) => {
      try {
        await FileWindowApi.grantFilePath(sessionId, absPath);
      } catch (e) {
        if (isSessionGoneError(e)) dropDeadSession(sessionId, t, tabId);
        throw e;
      }
    },
    [t, tabId],
  );

  /** library 无绑定空间降级全文前缀（T30 spec §17 项 2，首条与 reinject
   *  共用）：读全文 + 100k 截断 + 截断后缀；读取失败（超限/二进制）前缀
   *  不带正文，发送不中断。文案不带 read_file 指示——降级会话挂未绑定
   *  空间、文件四件不注入，指示是死指令 */
  const libraryFallbackPrefix = useCallback(
    async (name: string, storagePath: string): Promise<string> => {
      let content = "";
      try {
        const read = await invoke<{ kind?: string; content?: string }>(
          "file:readExternalFile",
          storagePath,
        );
        if (typeof read?.content === "string") content = read.content;
      } catch {
        // 全文读取失败：前缀无正文
      }
      if (content.length > LIBRARY_INJECT_LIMIT) {
        content =
          content.slice(0, LIBRARY_INJECT_LIMIT) +
          t("chat:fileWindow.chat.truncated");
      }
      return t("chat:fileWindow.chat.injectPrefixLibrary", {
        name,
        path: storagePath,
        content,
      });
    },
    [t],
  );

  // session:create 缺省 mode 即 agent（session.repo 落库 null → 读侧默认
  // "agent"，无需显式 setMode）——工具直改链路（spec §6.4）天然生效
  const ensureSession = useCallback(async (): Promise<EnsuredSession> => {
    const current = useFileWindowStore
      .getState()
      .tabs.find((x) => x.id === tabId);
    if (current?.sessionId) return { id: current.sessionId, created: false };
    if (!ensuringRef.current) {
      ensuringRef.current = (async () => {
        const resource = useFileWindowStore
          .getState()
          .tabs.find((x) => x.id === tabId)?.resource;
        let workspaceId: number;
        let title: string;
        let mountedOnBound: boolean | undefined;
        if (resource?.kind === "workspace") {
          workspaceId = resource.workspaceId;
          title = resource.path.split("/").pop() || "文件";
        } else if (resource?.kind === "library") {
          // library 会话挂载空间：session:create 无默认落点（缺 workspaceId
          // 即 WORKSPACE_NOT_FOUND），渲染侧自取——绑定空间优先（修复轮 2
          // 观察①：文件四件仅绑定目录的空间注入，挂绑定空间 grant 才有
          // read_file/write_file 消费者）；全未绑定时保底挂 list 首个（无
          // 空间时 list 自动补建「默认工作空间」，createdAt asc 首即默认）
          // ——纯文本对话可用，AI 面板渲染降级提示条
          const item = await libraryItemOf(resource.itemId);
          if (!item) throw new Error("LIBRARY_ITEM_MISSING");
          const workspaces = await WorkspaceApi.list();
          const target =
            workspaces.find((w) => !!w.directoryPath?.trim()) ?? workspaces[0];
          if (!target) throw new Error("WORKSPACE_NOT_FOUND");
          workspaceId = target.id;
          title = item.name;
          // T30：挂绑定空间即文件四件注入（read_file 可用）——引用式注入
          // 判定随挂载结果带回（绑定优先下 ⟺ list 存在绑定空间）
          mountedOnBound = !!target.directoryPath?.trim();
        } else {
          throw new Error("NOT_WORKSPACE_TAB");
        }
        const created = (await invoke("session:create", {
          workspaceId,
          title,
        })) as { id: number };
        // 本窗创建标记随建即写（修复轮 1 Critical 1）：主进程 send 在 ack
        // 前已落库 user 消息——标记若等发送成功再写，有标记必有消息，
        // 判空回收永不执行；反之 send 失败（NO_MODEL/WORKSPACE_DIR_MISSING
        // 等）留下的真空会话漏标记永不回收。瞬态不入快照/移窗不迁移
        useFileWindowStore
          .getState()
          .patchTab(tabId, { sessionId: created.id, sessionCreatedHere: true });
        return { id: created.id, created: true, mountedOnBound };
      })().finally(() => {
        ensuringRef.current = null;
      });
    }
    return ensuringRef.current;
  }, [tabId]);

  /** 占位会话首条上下文（T26，供 ChatPane sessionResolver）：会话惰建 +
   *  首条注入前缀/图片附件计算——发送动作归 ChatPane（本函数不发
   *  chat:send）。失败抛标记码（LIBRARY_ITEM_MISSING/WORKSPACE_DIR_
   *  MISSING 等），提示文案归面板包装层（单点 toast，防双弹） */
  const prepareFirstSend = useCallback(async (): Promise<{
    session: SessionRecord;
    contentPrefix?: string;
    images?: ChatSendImage[];
  }> => {
    const current = useFileWindowStore
      .getState()
      .tabs.find((x) => x.id === tabId);
    const resource = current?.resource;
    // 占位记录：session:create 应答仅 {id}——其余字段为形状占位，消费面
    // 只有 id（面板 onSessionResolved 落 tab 后经 getById 取完整记录）
    const stubOf = (id: number, title: string): SessionRecord => ({
      id,
      workspaceId: resource?.kind === "workspace" ? resource.workspaceId : 0,
      title,
      mode: "agent",
      createdAt: "",
      updatedAt: "",
    });
    if (resource?.kind === "library") {
      const item = await libraryItemOf(resource.itemId);
      if (!item?.storagePath) throw new Error("LIBRARY_ITEM_MISSING");
      const { id, created, mountedOnBound } = await ensureSession();
      // 授权注册先于返回（ChatPane 随后直发，AI 工具直读/直改地基；
      // 幂等——revoke 后重发自动恢复）
      await grantOrDrop(id, item.storagePath);
      // 图片条目：storagePath 直挂附件（imageAttachmentBlocks 白名单含
      // libraryDir，空间外原样透传可读回），前缀精简为路径+指令
      if (libraryContentKindOf(item.fileType) === "image") {
        return {
          session: stubOf(id, item.name),
          contentPrefix: created
            ? t("chat:fileWindow.chat.injectPrefix", {
                path: item.storagePath,
              })
            : undefined,
          images: [{ absPath: item.storagePath }],
        };
      }
      if (!created) return { session: stubOf(id, item.name) };
      // 文本条目（T30 spec §17）：挂绑定空间 → 引用式——不读全文，贴条
      // 目名 + 绝对 storagePath + read_file 指示（模型按需读取；首条上下
      // 文从 ~2.5万-6万 token 降至几十）；无绑定空间降级 → 全文注入
      // （100k 截断，无 read_file 死指令）
      if (mountedOnBound) {
        return {
          session: stubOf(id, item.name),
          contentPrefix: t("chat:fileWindow.chat.injectPrefixLibraryRef", {
            name: item.name,
            path: item.storagePath,
          }),
        };
      }
      return {
        session: stubOf(id, item.name),
        contentPrefix: await libraryFallbackPrefix(item.name, item.storagePath),
      };
    }
    if (resource?.kind === "workspace") {
      const { id, created } = await ensureSession();
      const contentPrefix = created
        ? t("chat:fileWindow.chat.injectPrefix", { path: resource.path })
        : undefined;
      const session = stubOf(id, resource.path.split("/").pop() || "文件");
      // 图片 tab：走多模态 images 附件（absPath = workspace.directoryPath +
      // path；directoryPath 经 workspace:list 取），无 directoryPath 抛标记
      if (current?.contentKind === "image") {
        const wsList = await WorkspaceApi.list();
        const dir = wsList.find(
          (w) => w.id === resource.workspaceId,
        )?.directoryPath;
        if (!dir) throw new Error("WORKSPACE_DIR_MISSING");
        return {
          session,
          contentPrefix,
          images: [{ absPath: `${dir}/${resource.path}` }],
        };
      }
      return { session, contentPrefix };
    }
    throw new Error("NOT_WORKSPACE_TAB");
  }, [ensureSession, grantOrDrop, libraryFallbackPrefix, t, tabId]);

  const liveId = tab?.sessionId ?? -1;

  // 重新注入（spec §6.3）：文件被外部/AI 修改后追问时贴最新路径提示重读；
  // library 附带授权重注（storagePath 为数据根绝对路径，AI 需授权可读）
  const reinject = useCallback(async () => {
    const resource = useFileWindowStore
      .getState()
      .tabs.find((x) => x.id === tabId)?.resource;
    if (!tab?.sessionId || !resource) return;
    if (resource.kind === "library") {
      const item = await libraryItemOf(resource.itemId);
      if (!item?.storagePath) return;
      await grantOrDrop(tab.sessionId, item.storagePath);
      // 引用式（T30 spec §17）：有绑定空间（read_file 可用）贴 storagePath
      // 提示重读；无绑定降级——文本条目重注最新全文（同首条降级模板，无
      // read_file 死指令），图片条目维持路径提示（读取本就不可行）。判定
      // 与 FileChatPanel noBoundWorkspace 同源（workspace:list，面板
      // ["fw-workspaces"] 查询同数据源）
      const workspaces = await WorkspaceApi.list();
      const bound = workspaces.some((w) => !!w.directoryPath?.trim());
      const content =
        bound || libraryContentKindOf(item.fileType) === "image"
          ? t("chat:fileWindow.chat.reinjectFile", { path: item.storagePath })
          : await libraryFallbackPrefix(item.name, item.storagePath);
      await dispatchChatSend(tab.sessionId, content);
      return;
    }
    if (resource.kind !== "workspace") return;
    await dispatchChatSend(
      tab.sessionId,
      t("chat:fileWindow.chat.reinjectFile", { path: resource.path }),
    );
  }, [
    dispatchChatSend,
    grantOrDrop,
    libraryFallbackPrefix,
    tab?.sessionId,
    t,
    tabId,
  ]);

  /** 已删会话善后出口（T22 ChatPane 分支）：getById 报 SESSION_NOT_FOUND
   *  时面板调用（清绑定+摘映射+专用提示），回占位再发即新建 */
  const handleSessionGone = useCallback(
    (sessionId: number) => {
      dropDeadSession(sessionId, t, tabId);
    },
    [t, tabId],
  );

  /** ChatPane 分支 library 授权补注册（T22，spec §6.4）：会话就位即 grant
   *  （幂等；授权持久，revoke 仅关 tab/删会话——等价旧轻输入框路径的
   *  「每次发送前 grant」）。已删会话经 grantOrDrop → dropDeadSession
   *  善后（调用方 catch 静默防双 toast） */
  const ensureLibraryGrant = useCallback(async () => {
    const current = useFileWindowStore
      .getState()
      .tabs.find((x) => x.id === tabId);
    if (current?.resource.kind !== "library" || !current.sessionId) return;
    const item = await libraryItemOf(current.resource.itemId);
    if (!item?.storagePath) return;
    await grantOrDrop(current.sessionId, item.storagePath);
  }, [grantOrDrop, tabId]);

  return {
    sessionId: liveId,
    prepareFirstSend,
    reinject,
    handleSessionGone,
    ensureLibraryGrant,
  };
}
