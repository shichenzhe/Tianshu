// @vitest-environment jsdom
/**
 * 惰建会话（spec §6.2/§6.3，T26 重构）：prepareFirstSend（ChatPane
 * sessionResolver 数据源）——首条 session:create（title=文件名）+ 首条
 * 注入前缀计算（真实 i18n 插值 {{path}}）/ library 引用式前缀（挂绑定
 * 空间：storagePath+read 指示不读全文，T30 spec §17；无绑定降级
 * 全文 100k 截断且不带 read 死指令）/ 图片 tab absPath→images
 * 附件；本 hook 不发 chat:send（发送动作移交 ChatPane 直发）。既有会话
 * （seed/二次发送）无前缀；library 授权注册（grantFilePath 幂等）先于
 * 返回。reinject 仍直发（dispatchChatSend），贴最新路径提示重读（无绑定
 * 降级文本条目重注全文）；发送失败收尾对齐 useChatSend.send（finishStream
 * + invalidate 重取）。条目缺失/空间缺 directoryPath 抛标记码（提示文案
 * 归面板包装层，见 file-chat-panel.test.tsx）。useChatSend 此处 mock
 * （真实流式订阅换绑链路见 use-file-session-stream.test.tsx）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));
vi.mock("../../../src-react/domains/ai/chat/hooks/use-chat-send", () => ({
  useChatSend: () => ({
    sending: false,
    send: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
    editResend: vi.fn(),
  }),
}));

// localStorage stub（T18 会话映射断言用）：tests/ai/edit-bar.test.tsx 同款
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
  });
});

// 真实 i18n：注入前缀的 {{path}} 插值须真文案验证
import "../../../src-react/i18n";
// i18n 键集对称校验（T30）直接取 locale JSON（运行时校验，编译期不耦合）
import zhChat from "../../../src-react/i18n/locales/zh-CN/chat.json";
import enChat from "../../../src-react/i18n/locales/en-US/chat.json";
import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { useFileSession } from "../../../src-react/domains/ai/file-window/hooks/use-file-session";
import { useChatStore } from "../../../src-react/domains/ai/chat/store/chat.store";
import { recentSessionOf } from "../../../src-react/domains/ai/file-window/lib/session-map";

// client 须单例：dispatchChatSend（hook 内 useQueryClient）失效重取断言用
const queryClient = new QueryClient();
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

const toastErrorSpy = vi.spyOn(toast, "error");
const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

beforeEach(() => {
  useFileWindowStore.getState().reset();
  useChatStore.setState({ streams: {}, isStreaming: {} });
  invokeMock.mockReset();
  toastErrorSpy.mockClear();
  invalidateSpy.mockClear();
  localStorage.clear();
});

it("首条：建会话（title=文件名）+ 相对路径前缀；本 hook 不发 chat:send；既有会话无前缀", async () => {
  invokeMock.mockResolvedValue({ id: 99, workspaceId: 7 });
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "docs/a.md" });
  const { result } = renderHook(() => useFileSession(tabId), { wrapper });
  let resolved!: Awaited<ReturnType<typeof result.current.prepareFirstSend>>;
  await act(async () => {
    resolved = await result.current.prepareFirstSend();
  });
  await waitFor(() =>
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(99),
  );
  // 本窗创建标记随建即写（修复轮 1 Critical 1）：send 尚未发生（本 hook
  // 不发 chat:send）——send 失败的空会话同样带标记可回收
  expect(useFileWindowStore.getState().tabs[0].sessionCreatedHere).toBe(true);
  const createCall = invokeMock.mock.calls.find(
    (c) => c[0] === "session:create",
  );
  expect(createCall?.[1]).toMatchObject({ workspaceId: 7, title: "a.md" });
  // 前缀引用式（相对路径，spec §10 偏离 5）+ 不拼用户文本（发送归 ChatPane）
  expect(resolved.session.id).toBe(99);
  expect(resolved.contentPrefix).toContain("docs/a.md");
  expect(resolved.contentPrefix).not.toContain("总结");
  expect(resolved.images).toBeUndefined();
  expect(invokeMock.mock.calls.some((c) => c[0] === "chat:send")).toBe(false);
  // 二次解析（既有会话）：不重复注入、不重建
  await act(async () => {
    resolved = await result.current.prepareFirstSend();
  });
  expect(resolved.contentPrefix).toBeUndefined();
  expect(
    invokeMock.mock.calls.filter((c) => c[0] === "session:create"),
  ).toHaveLength(1);
});

it("图片 tab：images 绝对路径（directoryPath+path）+ 前缀；无 directoryPath 抛标记码", async () => {
  invokeMock.mockImplementation((ch: string) =>
    ch === "workspace:list"
      ? [
          { id: 7, directoryPath: "/ws/root" },
          { id: 8, directoryPath: null },
        ]
      : { id: 55, workspaceId: 7 },
  );
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "img/a.png" });
  const { result } = renderHook(() => useFileSession(tabId), { wrapper });
  let resolved!: Awaited<ReturnType<typeof result.current.prepareFirstSend>>;
  await act(async () => {
    resolved = await result.current.prepareFirstSend();
  });
  expect(resolved.images).toEqual([{ absPath: "/ws/root/img/a.png" }]);
  expect(resolved.contentPrefix).toContain("img/a.png");
  // 空间无 directoryPath：标记码上抛（提示归面板），不带 images 返回。
  // 会话已按旧序先建（ensureSession 先于目录解析，与原 sendWithImage
  // 一致——空会话由 T26 关闭回收兜底）
  invokeMock.mockImplementation((ch: string) =>
    ch === "workspace:list" ? [{ id: 7, directoryPath: null }] : { id: 56 },
  );
  useFileWindowStore.getState().reset();
  const { tabId: tabId2 } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "img/b.png" });
  const { result: result2 } = renderHook(() => useFileSession(tabId2), {
    wrapper,
  });
  await act(async () => {
    await expect(result2.current.prepareFirstSend()).rejects.toThrow(
      "WORKSPACE_DIR_MISSING",
    );
  });
  // 失败路径同样带标记（修复轮 1 Critical 1）：建会后 send 失败的空会话
  // 关 tab 即判空回收
  const failedTab = useFileWindowStore.getState().tabs[0];
  expect(failedTab.sessionId).toBe(56);
  expect(failedTab.sessionCreatedHere).toBe(true);
});

it("reinject：贴最新路径提示重读（仍直发 chat:send，spec §6.3）", async () => {
  invokeMock.mockResolvedValue({ id: 99, workspaceId: 7 });
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "docs/a.md" });
  const { result } = renderHook(() => useFileSession(tabId), { wrapper });
  await act(() => result.current.prepareFirstSend());
  await waitFor(() =>
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(99),
  );
  await act(() => result.current.reinject());
  const sendCalls = invokeMock.mock.calls.filter((c) => c[0] === "chat:send");
  expect(sendCalls.at(-1)?.[1].sessionId).toBe(99);
  expect(sendCalls.at(-1)?.[1].content).toContain("docs/a.md");
});

it("reinject 发送失败：finishStream 清流（不卡停止态）+ invalidate 重取（对齐 useChatSend.send）", async () => {
  // 用户消息可能已落库后才抛 NO_MODEL 等：chat:send invoke 拒绝模拟
  invokeMock.mockImplementation((ch: string) =>
    ch === "chat:send" ? Promise.reject(new Error("NO_MODEL")) : null,
  );
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "docs/a.md" });
  useFileWindowStore.getState().patchTab(tabId, { sessionId: 77 });
  const { result } = renderHook(() => useFileSession(tabId), { wrapper });
  await act(async () => {
    await expect(result.current.reinject()).rejects.toThrow("NO_MODEL");
  });
  expect(useChatStore.getState().isStreaming[77]).toBeUndefined();
  expect(invalidateSpy).toHaveBeenCalledWith({
    queryKey: ["messages", 77],
  });
});

describe("library 会话（引用式注入 + 无绑定降级全文，T30 spec §17）", () => {
  /** library 条目（tree 平铺 find id 消费） */
  const LIB_ITEM = {
    id: 3,
    name: "note.md",
    kind: "file",
    fileType: "text/markdown",
    storagePath: "/root/library/3.md",
    updatedAt: "2026-10-14T00:00:00.000Z",
  };

  it("无绑定空间降级：全文前缀（无 read 死指令）+ grant 注册；次条不重复注入（grant 幂等）", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "library:tree") return [LIB_ITEM];
      if (ch === "workspace:list")
        return [{ id: 11, directoryPath: null }, { id: 12 }];
      if (ch === "file:readExternalFile")
        return { kind: "text", content: "# 全文内容" };
      if (ch === "session:create") return { id: 88, workspaceId: 11 };
      return null;
    });
    const { tabId } = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3 });
    const { result } = renderHook(() => useFileSession(tabId), { wrapper });
    let resolved!: Awaited<ReturnType<typeof result.current.prepareFirstSend>>;
    await act(async () => {
      resolved = await result.current.prepareFirstSend();
    });
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(88),
    );
    // 全未绑定时保底挂空间列表首个（session:create 无默认落点——缺
    // workspaceId 即 WORKSPACE_NOT_FOUND；无空间时 list 自动补建默认空间）
    const createCall = invokeMock.mock.calls.find(
      (c) => c[0] === "session:create",
    );
    expect(createCall?.[1]).toMatchObject({
      workspaceId: 11,
      title: "note.md",
    });
    // 授权注册（storagePath 从条目取；幂等——revoke 后重发自动恢复）
    expect(invokeMock).toHaveBeenCalledWith("fileWindow:grantFilePath", {
      sessionId: 88,
      absPath: "/root/library/3.md",
    });
    // 无绑定空间降级（T30 spec §17 项 2）：全文前缀（injectPrefixLibrary
    // 插值 name/path/content——绝对路径入前缀），不带 read 指示——
    // 挂未绑定空间文件四件不注入，指示是死指令
    expect(resolved.contentPrefix).toContain("note.md");
    expect(resolved.contentPrefix).toContain("/root/library/3.md");
    expect(resolved.contentPrefix).toContain("# 全文内容");
    expect(resolved.contentPrefix).not.toContain("read");
    expect(resolved.contentPrefix).not.toContain("总结");
    // 本 hook 不发 chat:send
    expect(invokeMock.mock.calls.some((c) => c[0] === "chat:send")).toBe(false);
    // 次条：不重复注入前缀；grant 幂等重注
    await act(async () => {
      resolved = await result.current.prepareFirstSend();
    });
    expect(resolved.contentPrefix).toBeUndefined();
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "fileWindow:grantFilePath"),
    ).toHaveLength(2);
  });

  it("无绑定降级：全文超 100k 截断 + 截断后缀；读取失败不阻断（前缀无正文）", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "library:tree") return [LIB_ITEM];
      if (ch === "workspace:list") return [{ id: 11, directoryPath: null }];
      if (ch === "file:readExternalFile")
        return { kind: "text", content: "x".repeat(100_001) };
      if (ch === "session:create") return { id: 89, workspaceId: 11 };
      return null;
    });
    const { tabId } = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3 });
    const { result } = renderHook(() => useFileSession(tabId), { wrapper });
    let resolved!: Awaited<ReturnType<typeof result.current.prepareFirstSend>>;
    await act(async () => {
      resolved = await result.current.prepareFirstSend();
    });
    // x 连跑恰好 100k + 截断提示后缀（zh-CN 缺省文案含「截断」）
    expect(resolved.contentPrefix?.match(/x+/)?.[0].length).toBe(100_000);
    expect(resolved.contentPrefix).toContain("截断");

    // 读取失败（超限/二进制）：不抛不阻断，前缀仍带条目名与路径
    invokeMock.mockReset();
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "library:tree") return [LIB_ITEM];
      if (ch === "workspace:list") return [{ id: 11, directoryPath: null }];
      if (ch === "file:readExternalFile")
        return Promise.reject(new Error("文件超过 512KB 预览上限"));
      if (ch === "session:create") return { id: 90, workspaceId: 11 };
      return null;
    });
    useFileWindowStore.getState().reset();
    const { tabId: tabId2 } = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3 });
    const { result: result2 } = renderHook(() => useFileSession(tabId2), {
      wrapper,
    });
    await act(async () => {
      resolved = await result2.current.prepareFirstSend();
    });
    expect(resolved.contentPrefix).toContain("note.md");
    expect(resolved.contentPrefix).toContain("/root/library/3.md");
  });

  it("条目缺失或无 storagePath → 抛 LIBRARY_ITEM_MISSING（不建会话；提示归面板）", async () => {
    invokeMock.mockImplementation((ch: string) =>
      ch === "library:tree" ? [{ ...LIB_ITEM, storagePath: null }] : null,
    );
    const { tabId } = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3 });
    const { result } = renderHook(() => useFileSession(tabId), { wrapper });
    await act(async () => {
      await expect(result.current.prepareFirstSend()).rejects.toThrow(
        "LIBRARY_ITEM_MISSING",
      );
    });
    expect(invokeMock.mock.calls.some((c) => c[0] === "session:create")).toBe(
      false,
    );
    expect(toastErrorSpy).not.toHaveBeenCalled();

    // tree 空平铺（条目已删）同路径
    invokeMock.mockImplementation((ch: string) =>
      ch === "library:tree" ? [] : null,
    );
    useFileWindowStore.getState().reset();
    const { tabId: tabId2 } = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3 });
    const { result: result2 } = renderHook(() => useFileSession(tabId2), {
      wrapper,
    });
    await act(async () => {
      await expect(result2.current.prepareFirstSend()).rejects.toThrow(
        "LIBRARY_ITEM_MISSING",
      );
    });
  });

  it("reinject（绑定空间）：授权重注 + 贴 storagePath 提示重读（引用式，不读全文）", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "library:tree") return [LIB_ITEM];
      if (ch === "workspace:list")
        return [{ id: 12, directoryPath: "/ws/root" }];
      if (ch === "file:readExternalFile")
        return { kind: "text", content: "# 全文" };
      if (ch === "session:create") return { id: 91, workspaceId: 12 };
      return null;
    });
    const { tabId } = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3 });
    const { result } = renderHook(() => useFileSession(tabId), { wrapper });
    await act(() => result.current.prepareFirstSend());
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(91),
    );
    await act(() => result.current.reinject());
    const sendCalls = invokeMock.mock.calls.filter((c) => c[0] === "chat:send");
    expect(sendCalls.at(-1)?.[1].sessionId).toBe(91);
    expect(sendCalls.at(-1)?.[1].content).toContain("/root/library/3.md");
    expect(sendCalls.at(-1)?.[1].content).toContain("read");
    // 引用式全链（首条 + 重注）：全程不读全文
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "file:readExternalFile"),
    ).toBe(false);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "fileWindow:grantFilePath"),
    ).toHaveLength(2);
  });

  it("reinject 无绑定降级（T30）：文本条目重注全文（无 read 死指令）+ grant 先于发送", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "library:tree") return [LIB_ITEM];
      if (ch === "workspace:list") return [{ id: 11, directoryPath: null }];
      if (ch === "file:readExternalFile")
        return { kind: "text", content: "# 最新全文" };
      if (ch === "session:create") return { id: 94, workspaceId: 11 };
      return null;
    });
    const { tabId } = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3 });
    // 既有会话（reinject 不走 ensureSession）
    useFileWindowStore.getState().patchTab(tabId, { sessionId: 94 });
    const { result } = renderHook(() => useFileSession(tabId), { wrapper });
    await act(() => result.current.reinject());
    const sendCalls = invokeMock.mock.calls.filter((c) => c[0] === "chat:send");
    expect(sendCalls.at(-1)?.[1].sessionId).toBe(94);
    // 挂未绑定空间 read 不可用：降级重注最新全文（同首条降级模板）
    expect(sendCalls.at(-1)?.[1].content).toContain("note.md");
    expect(sendCalls.at(-1)?.[1].content).toContain("/root/library/3.md");
    expect(sendCalls.at(-1)?.[1].content).toContain("# 最新全文");
    expect(sendCalls.at(-1)?.[1].content).not.toContain("read");
    // 授权重注先于发送（会话已删善后链保持：grant 抛 SESSION_NOT_FOUND
    // 即在发送前善后，见「library 死 seed」用例）
    const channels = invokeMock.mock.calls.map((c) => c[0]);
    expect(channels.indexOf("fileWindow:grantFilePath")).toBeLessThan(
      channels.indexOf("chat:send"),
    );
  });

  it("修复轮 2 + T30：绑定目录空间优先挂载 + 引用式前缀（storagePath+read 指示、不读全文）", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "library:tree") return [LIB_ITEM];
      if (ch === "workspace:list")
        return [
          { id: 11, directoryPath: null },
          { id: 12, directoryPath: "/ws/root" },
        ];
      if (ch === "file:readExternalFile")
        return { kind: "text", content: "# 全文内容" };
      if (ch === "session:create") return { id: 93, workspaceId: 12 };
      return null;
    });
    const { tabId } = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3 });
    const { result } = renderHook(() => useFileSession(tabId), { wrapper });
    let resolved!: Awaited<ReturnType<typeof result.current.prepareFirstSend>>;
    await act(async () => {
      resolved = await result.current.prepareFirstSend();
    });
    // 首个未绑、次个绑定 → 会话挂绑定空间（文件四件才有消费者）
    const createCall = invokeMock.mock.calls.find(
      (c) => c[0] === "session:create",
    );
    expect(createCall?.[1]).toMatchObject({ workspaceId: 12 });
    // 引用式（T30 spec §17 项 1）：条目名 + 绝对 storagePath + read
    // 指示；不含正文、不读全文（file:readExternalFile 未被调）
    expect(resolved.contentPrefix).toContain("note.md");
    expect(resolved.contentPrefix).toContain("/root/library/3.md");
    expect(resolved.contentPrefix).toContain("read");
    expect(resolved.contentPrefix).not.toContain("# 全文内容");
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "file:readExternalFile"),
    ).toBe(false);
    // grant 先于返回（ChatPane 随后直发——AI 工具直读/直改地基）
    expect(invokeMock).toHaveBeenCalledWith("fileWindow:grantFilePath", {
      sessionId: 93,
      absPath: "/root/library/3.md",
    });
  });

  it("image 条目（修复轮 Important 2）：storagePath 直挂附件 + 路径指令前缀（不读全文）+ grant 注册", async () => {
    const IMG_ITEM = {
      ...LIB_ITEM,
      id: 6,
      name: "p.png",
      fileType: "image/png",
      storagePath: "/root/library/6.png",
    };
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "library:tree") return [IMG_ITEM];
      if (ch === "workspace:list") return [{ id: 11, directoryPath: null }];
      if (ch === "session:create") return { id: 92, workspaceId: 11 };
      return null;
    });
    const { tabId } = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 6 });
    const { result } = renderHook(() => useFileSession(tabId), { wrapper });
    let resolved!: Awaited<ReturnType<typeof result.current.prepareFirstSend>>;
    await act(async () => {
      resolved = await result.current.prepareFirstSend();
    });
    // 附件 = storagePath 绝对路径（imageAttachmentBlocks 白名单含 libraryDir）
    expect(resolved.images).toEqual([{ absPath: "/root/library/6.png" }]);
    expect(resolved.contentPrefix).toContain("/root/library/6.png");
    // 图片不读全文（readExternalFile 未触）；授权已注册
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "file:readExternalFile"),
    ).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("fileWindow:grantFilePath", {
      sessionId: 92,
      absPath: "/root/library/6.png",
    });
  });
});

describe("seed 会话已删（T18 文件→会话映射清理）", () => {
  const RESOURCE = { kind: "workspace", workspaceId: 7, path: "docs/a.md" };
  const MAP_KEY = "tianshu-file-window-session-map";
  /** Electron invoke 拒绝的会话不存在错误原样（串在 message 里） */
  const goneSend = () =>
    Promise.reject(
      new Error(
        "Error invoking remote method 'chat:send': Error: SESSION_NOT_FOUND",
      ),
    );

  it("SESSION_NOT_FOUND：清 tab 绑定 + 摘映射该条目 + 专用提示；其他错误不清；再发即新建", async () => {
    invokeMock.mockImplementation((ch: string) =>
      ch === "session:create"
        ? { id: 99, workspaceId: 7 }
        : ch === "chat:send"
          ? Promise.reject(new Error("NO_MODEL"))
          : null,
    );
    const { tabId } = useFileWindowStore.getState().openTab(RESOURCE);
    // seed 同型：tab 带 sessionId 55 + 映射预置 [55, 54]（历史映射 seed 不
    // 带 sessionCreatedHere——非本窗创建，关 tab 不回收）
    useFileWindowStore.getState().patchTab(tabId, { sessionId: 55 });
    expect(
      useFileWindowStore.getState().tabs[0].sessionCreatedHere,
    ).toBeUndefined();
    localStorage.setItem(
      MAP_KEY,
      JSON.stringify({ "w:7:docs/a.md": [55, 54] }),
    );
    const { result } = renderHook(() => useFileSession(tabId), { wrapper });
    // 其他错误（NO_MODEL，reinject 直发）：绑定与映射不动
    await act(async () => {
      await expect(result.current.reinject()).rejects.toThrow("NO_MODEL");
    });
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(55);
    expect(recentSessionOf(RESOURCE)).toBe(55);
    // 会话不存在：清 tab 绑定 + 摘映射 55（54 仍在）+ 专用提示
    invokeMock.mockImplementation((ch: string) =>
      ch === "session:create"
        ? { id: 99, workspaceId: 7 }
        : ch === "chat:send"
          ? goneSend()
          : null,
    );
    await act(async () => {
      await expect(result.current.reinject()).rejects.toThrow(
        "SESSION_NOT_FOUND",
      );
    });
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBeUndefined();
    expect(recentSessionOf(RESOURCE)).toBe(54);
    expect(toastErrorSpy).toHaveBeenCalledTimes(1);
    expect(toastErrorSpy).toHaveBeenCalledWith(expect.stringContaining("会话"));
    // 再发：prepareFirstSend 新建（session:create 99）并落 tab
    invokeMock.mockImplementation((ch: string) =>
      ch === "session:create"
        ? { id: 99, workspaceId: 7 }
        : Promise.resolve(null),
    );
    await act(() => result.current.prepareFirstSend());
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(99),
    );
  });

  it("library 死 seed（修复轮 I1）：grantFilePath 先于发送抛 SESSION_NOT_FOUND → 清绑定 + 摘映射 + 提示；再发新建", async () => {
    /** grant 的会话不存在拒绝（granted-paths-ipc 归属校验同错误码） */
    const goneGrant = () =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'fileWindow:grantFilePath': Error: SESSION_NOT_FOUND",
        ),
      );
    const LIB_ITEM = {
      id: 3,
      name: "note.md",
      kind: "file",
      fileType: "text/markdown",
      storagePath: "/root/library/3.md",
      updatedAt: "2026-10-14T00:00:00.000Z",
    };
    const stub = (grant: () => Promise<unknown>) =>
      invokeMock.mockImplementation((ch: string) => {
        if (ch === "library:tree") return [LIB_ITEM];
        if (ch === "workspace:list") return [{ id: 11, directoryPath: null }];
        if (ch === "session:create") return { id: 99, workspaceId: 11 };
        if (ch === "fileWindow:grantFilePath") return grant();
        if (ch === "chat:send") return Promise.resolve(null);
        return null;
      });
    stub(goneGrant);
    const resource = { kind: "library", itemId: 3 };
    const { tabId } = useFileWindowStore.getState().openTab(resource);
    // seed 同型：tab 绑定 88 + 映射预置 [88, 87]
    useFileWindowStore.getState().patchTab(tabId, { sessionId: 88 });
    localStorage.setItem(MAP_KEY, JSON.stringify({ "l:3": [88, 87] }));
    const { result } = renderHook(() => useFileSession(tabId), { wrapper });
    // grant 在 dispatchChatSend 之前抛（reinject library 首步授权重注）：
    // 也须清绑定/摘映射/提示（非空转）
    await act(async () => {
      await expect(result.current.reinject()).rejects.toThrow(
        "SESSION_NOT_FOUND",
      );
    });
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBeUndefined();
    expect(recentSessionOf(resource)).toBe(87);
    expect(toastErrorSpy).toHaveBeenCalledWith(expect.stringContaining("会话"));
    // 再发：prepareFirstSend 新建 99，grant 放行
    stub(() => Promise.resolve(null));
    await act(() => result.current.prepareFirstSend());
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(99),
    );
  });
});

describe("T30 i18n 双侧三键对称（引用式首条/无绑定降级全文/重注提示）", () => {
  /** 三键：引用式首条前缀（新键）/ 降级全文前缀（沿用键，去 read
   *  死指令）/ 重注路径提示（绑定空间引用式共用） */
  const REF_KEYS = [
    "injectPrefixLibraryRef",
    "injectPrefixLibrary",
    "reinjectFile",
  ] as const;

  /** locale JSON → fileWindow.chat 文本表（运行时索引，缺键即测试失败） */
  const chatTexts = (locale: "zh-CN" | "en-US"): Record<string, string> =>
    ((locale === "zh-CN" ? zhChat : enChat) as Record<string, unknown>)[
      "fileWindow"
    ]["chat"] as Record<string, string>;

  /** 模板插值变量集（{{var}} 排序拍平） */
  const varsOf = (tpl: string): string[] =>
    [...tpl.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

  it("zh-CN 与 en-US：三键齐备且插值变量集一致；降级键无 read、引用式键带", () => {
    for (const key of REF_KEYS) {
      expect(chatTexts("zh-CN")[key]).toBeTruthy();
      expect(chatTexts("en-US")[key]).toBeTruthy();
      expect(varsOf(chatTexts("zh-CN")[key])).toEqual(
        varsOf(chatTexts("en-US")[key]),
      );
    }
    // 引用式键带 read 指示（挂绑定空间才渲染该前缀）
    expect(chatTexts("zh-CN").injectPrefixLibraryRef).toContain("read");
    expect(chatTexts("en-US").injectPrefixLibraryRef).toContain("read");
    // 降级全文键不带 read——挂未绑定空间文件四件不注入，指示是死指令
    expect(chatTexts("zh-CN").injectPrefixLibrary).not.toContain("read");
    expect(chatTexts("en-US").injectPrefixLibrary).not.toContain("read");
  });
});
