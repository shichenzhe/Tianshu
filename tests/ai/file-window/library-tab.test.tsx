// @vitest-environment jsdom
/**
 * library tab（T14）：条目（library:tree find id）→ contentKind 细化 +
 * title 落库 → md/text CM6 编辑（FileWindowMdEditor/FileWindowEditor，
 * MarkdownView 轻桩）/csv 网格（LibraryCsvEditor 桩）→ 保存走
 * library:writeFileContent（updatedAt 基线：保存前重取比对，不符弹
 * 冲突条——overwrite 直写 / reload 弃草稿重读）；只读类 hidden 徽标；
 * flush 注册表覆盖（关闭确认「保存并关闭」）；卸载触发 revokeSession
 * （library 会话路径授权回收）；条目缺失/无 storagePath → itemMissing。
 * CM6 输入模拟经 view.dispatch+userEvent 注解（jsdom 无真实击键，见
 * cm-test-utils）；mock 骨架同 file-tab-content.test.tsx（部分 mock i18n、
 * t 返回 key）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("../../../src-react/domains/ai/chat/components/MarkdownView", () => ({
  default: ({ text }: { text: string }) => (
    <div data-testid="md-preview">{text}</div>
  ),
}));

vi.mock(
  "../../../src-react/domains/ai/library/components/LibraryCsvEditor",
  () => ({
    default: ({
      rows,
      onChange,
    }: {
      rows: string[][];
      onChange: (rows: string[][]) => void;
    }) => (
      <input
        aria-label="cell-0-0"
        value={rows[0]?.[0] ?? ""}
        onChange={(e) =>
          onChange([
            [e.target.value, ...(rows[0]?.slice(1) ?? [])],
            ...rows.slice(1),
          ])
        }
      />
    ),
  }),
);

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import LibraryTabBody from "../../../src-react/domains/ai/file-window/components/LibraryTabBody";
import { flushTabSave } from "../../../src-react/domains/ai/file-window/lib/tab-save-flush";
import { serializeCsv } from "../../../src-react/domains/ai/library/lib/library-view-model";
import { cmDocOf, cmType, cmViewOf } from "./cm-test-utils";

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  useFileWindowStore.getState().reset();
});

const ITEM = {
  id: 3,
  parentId: null,
  name: "note.md",
  kind: "file",
  fileType: "text/markdown",
  mimeType: "text/markdown",
  size: 12,
  originalPath: null,
  url: null,
  favorite: false,
  lastViewedAt: null,
  location: [],
  storagePath: "/root/library/3.md",
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
};

/** md 编辑器（.cm-content，aria-label=t key：chat:library.editContent） */
const MD_BOX = { name: "chat:library.editContent" };

function mockIpc(
  items: unknown[],
  read: unknown,
  write: unknown = {
    ...ITEM,
    updatedAt: "2026-10-14T01:00:00.000Z",
  },
) {
  invokeMock.mockImplementation((ch: string) => {
    if (ch === "library:tree") return items;
    if (ch === "file:readExternalFile") return read;
    if (ch === "library:writeFileContent") return write;
    // revealItem 须回 Promise（FileTabHeader 走 .catch 兜底，null 会在
    // 点击时同步抛 unhandled TypeError——同 file-tab-content 修法）
    if (ch === "library:revealItem") return Promise.resolve(null);
    if (ch === "fileWindow:revokeSession") return Promise.resolve(null);
    return null;
  });
}

/** 打 library tab 再渲染内容体（含 FileTabHeader 工具行） */
function renderLibraryTab(itemId = 3) {
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "library", itemId });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <LibraryTabBody tabId={tabId} />
    </QueryClientProvider>,
  );
  return { tabId, client, view };
}

const tabOf = (tabId: string) =>
  useFileWindowStore.getState().tabs.find((t) => t.id === tabId);

/** md 编辑器就位 + 内容到位（doc=expect），并返回编辑函数 */
async function awaitMdContent(content: string) {
  await screen.findByRole("textbox", MD_BOX);
  await waitFor(() => expect(cmDocOf()).toBe(content));
}
const mdType = (text: string) => act(() => cmType(cmViewOf(), text));

describe("library tab 渲染/编辑/保存", () => {
  it("md：contentKind 细化 + title 落库 + 基线；编辑→保存 writeFileContent；reveal 走 revealItem", async () => {
    mockIpc([ITEM], { kind: "text", content: "# 库文档" });
    const { tabId } = renderLibraryTab();
    await awaitMdContent("# 库文档");
    // 条目元数据落库：contentKind md（tree 占位 text 细化）/标题/基线
    await waitFor(() => expect(tabOf(tabId)?.contentKind).toBe("md"));
    expect(tabOf(tabId)?.title).toBe("note.md");
    expect(tabOf(tabId)?.saveStatus).toBe("saved");
    await waitFor(() =>
      expect(tabOf(tabId)?.baselineMtime).toBe(Date.parse(ITEM.updatedAt)),
    );
    // 工具行标题 = 条目名；Finder 动作走 library:revealItem
    expect(screen.getByText("note.md")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.reveal" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("library:revealItem", 3),
    );
    // 编辑 → dirty/unsaved；保存 → writeFileContent + 基线随写回 updatedAt
    mdType("# 改");
    expect(tabOf(tabId)?.dirty).toBe(true);
    expect(tabOf(tabId)?.saveStatus).toBe("unsaved");
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.save" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "library:writeFileContent",
        3,
        "# 改",
      ),
    );
    expect(tabOf(tabId)?.dirty).toBe(false);
    expect(tabOf(tabId)?.saveStatus).toBe("saved");
    await waitFor(() =>
      expect(tabOf(tabId)?.baselineMtime).toBe(
        Date.parse("2026-10-14T01:00:00.000Z"),
      ),
    );
  });

  it("保存前 updatedAt 换血 → 冲突条；overwrite 免基线直写", async () => {
    const read = { kind: "text", content: "# 库文档" };
    // 首查（条目+基线落定）返回旧 updatedAt；保存时重取已换血（外部写盘）
    let treeCalls = 0;
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "library:tree") {
        treeCalls += 1;
        return treeCalls === 1
          ? [ITEM]
          : [{ ...ITEM, updatedAt: "2026-10-14T02:00:00.000Z" }];
      }
      if (ch === "file:readExternalFile") return read;
      if (ch === "library:writeFileContent")
        return { ...ITEM, updatedAt: "2026-10-14T03:00:00.000Z" };
      return null;
    });
    const { tabId } = renderLibraryTab();
    await awaitMdContent("# 库文档");
    await waitFor(() =>
      expect(tabOf(tabId)?.baselineMtime).toBe(Date.parse(ITEM.updatedAt)),
    );
    mdType("# 改");
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.save" }),
    );
    // 基线 00:00 ≠ 现值 02:00 → 冲突条，不写盘
    expect(
      await screen.findByText("chat:fileWindow.conflict.title"),
    ).toBeTruthy();
    expect(tabOf(tabId)?.saveStatus).toBe("unsaved");
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "library:writeFileContent"),
    ).toBe(false);
    // overwrite：用户已知外部修改，直接写
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:fileWindow.conflict.overwrite",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "library:writeFileContent",
        3,
        "# 改",
      ),
    );
    await waitFor(() => expect(tabOf(tabId)?.dirty).toBe(false));
    expect(screen.queryByText("chat:fileWindow.conflict.title")).toBeNull();
  });

  it("冲突 reload：弃草稿重读磁盘内容，基线吸收最新 updatedAt", async () => {
    const read = { kind: "text", content: "# 库文档" };
    // 首查旧 updatedAt 落基线；保存时换血 + reload 后磁盘内容已变
    let treeCalls = 0;
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "library:tree") {
        treeCalls += 1;
        return treeCalls === 1
          ? [ITEM]
          : [{ ...ITEM, updatedAt: "2026-10-14T02:00:00.000Z" }];
      }
      if (ch === "file:readExternalFile")
        return treeCalls === 1 ? read : { kind: "text", content: "# 磁盘新" };
      return null;
    });
    const { tabId } = renderLibraryTab();
    await awaitMdContent("# 库文档");
    await waitFor(() =>
      expect(tabOf(tabId)?.baselineMtime).toBe(Date.parse(ITEM.updatedAt)),
    );
    mdType("# 改");
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.save" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "chat:fileWindow.conflict.reload",
      }),
    );
    await waitFor(() => expect(cmDocOf()).toBe("# 磁盘新"));
    await waitFor(() => expect(tabOf(tabId)?.dirty).toBe(false));
    await waitFor(() =>
      expect(tabOf(tabId)?.baselineMtime).toBe(
        Date.parse("2026-10-14T02:00:00.000Z"),
      ),
    );
    expect(screen.queryByText("chat:fileWindow.conflict.title")).toBeNull();
  });

  it("csv：网格编辑（LibraryCsvEditor rows/onChange）→ 保存 serializeCsv 序列化", async () => {
    const csvItem = {
      ...ITEM,
      id: 5,
      name: "t.csv",
      fileType: "text/csv",
      storagePath: "/root/library/5.csv",
    };
    mockIpc([csvItem], { kind: "text", content: "a,b\n1,2" });
    const { tabId } = renderLibraryTab(5);
    const cell = await screen.findByLabelText("cell-0-0");
    await waitFor(() => expect(tabOf(tabId)?.contentKind).toBe("csv"));
    expect((cell as HTMLInputElement).value).toBe("a");
    fireEvent.change(cell, { target: { value: "z" } });
    expect(tabOf(tabId)?.dirty).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.save" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "library:writeFileContent",
        5,
        serializeCsv([
          ["z", "b"],
          ["1", "2"],
        ]),
      ),
    );
  });

  it("text（非 md/csv 文本类）：CM6 承载（语言按条目名扩展映射）→ 编辑保存", async () => {
    const txtItem = {
      ...ITEM,
      id: 8,
      name: "notes.py",
      fileType: "text/x-python",
      storagePath: "/root/library/8.py",
    };
    mockIpc([txtItem], { kind: "text", content: "pass" });
    const { tabId } = renderLibraryTab(8);
    await waitFor(() => expect(tabOf(tabId)?.contentKind).toBe("text"));
    await waitFor(() => expect(cmDocOf()).toBe("pass"));
    mdType("x = 1");
    expect(tabOf(tabId)?.dirty).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.save" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "library:writeFileContent",
        8,
        "x = 1",
      ),
    );
  });

  it("只读类（image）：saveStatus hidden 无徽标；dev dataUrl 内联", async () => {
    const imgItem = {
      ...ITEM,
      id: 6,
      name: "p.png",
      fileType: "image/png",
      storagePath: "/root/library/6.png",
    };
    mockIpc([imgItem], { kind: "image", dataUrl: "data:image/png;base64,x" });
    const { tabId } = renderLibraryTab(6);
    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,x",
      ),
    );
    await waitFor(() => expect(tabOf(tabId)?.contentKind).toBe("image"));
    expect(tabOf(tabId)?.saveStatus).toBe("hidden");
    expect(document.querySelector("span.text-xs")).toBeNull();
  });

  it("webview 类（pdf）：file:// 直开（library-preview partition）", async () => {
    const pdfItem = {
      ...ITEM,
      id: 7,
      name: "r.pdf",
      fileType: "pdf",
      storagePath: "/root/library/7.pdf",
    };
    mockIpc([pdfItem], null);
    renderLibraryTab(7);
    await waitFor(() => expect(document.querySelector("webview")).toBeTruthy());
    const wv = document.querySelector("webview")!;
    expect(wv.getAttribute("src")).toBe("file:///root/library/7.pdf");
    expect(wv.getAttribute("partition")).toBe("library-preview");
  });

  it("条目缺失 / 无 storagePath → itemMissing 提示不渲染编辑器", async () => {
    mockIpc([], null);
    renderLibraryTab(404);
    expect(
      await screen.findByText("chat:fileWindow.chat.itemMissing"),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", MD_BOX)).toBeNull();

    cleanup();
    invokeMock.mockReset();
    useFileWindowStore.getState().reset();
    mockIpc([{ ...ITEM, storagePath: null }], null);
    renderLibraryTab();
    expect(
      await screen.findByText("chat:fileWindow.chat.itemMissing"),
    ).toBeTruthy();
  });

  it("flush 注册表：关闭确认「保存并关闭」经注册表写盘（卸载除名）", async () => {
    mockIpc([ITEM], { kind: "text", content: "# 库文档" });
    const { tabId } = renderLibraryTab();
    await awaitMdContent("# 库文档");
    await waitFor(() =>
      expect(tabOf(tabId)?.baselineMtime).toBe(Date.parse(ITEM.updatedAt)),
    );
    mdType("# 改");
    await act(async () => {
      await flushTabSave(tabId);
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "library:writeFileContent",
      3,
      "# 改",
    );
    await waitFor(() => expect(tabOf(tabId)?.dirty).toBe(false));
  });

  it("卸载（关 tab）触发 fileWindow:revokeSession（会话授权回收）", async () => {
    mockIpc([ITEM], { kind: "text", content: "# 库文档" });
    const { tabId, view } = renderLibraryTab();
    await awaitMdContent("# 库文档");
    // act 内 patch（重渲染冲刷 ref 同步 effect）再卸载
    act(() => {
      useFileWindowStore.getState().patchTab(tabId, { sessionId: 42 });
    });
    view.unmount();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:revokeSession", {
        sessionId: 42,
      }),
    );
    // 无会话绑定的 library tab 卸载不触发 revoke（新 store 会话未建）
    const revokeCalls = () =>
      invokeMock.mock.calls.filter((c) => c[0] === "fileWindow:revokeSession");
    expect(revokeCalls()).toHaveLength(1);
    useFileWindowStore.getState().reset();
    const second = renderLibraryTab();
    await screen.findByRole("textbox", MD_BOX);
    second.view.unmount();
    await waitFor(() => expect(screen.queryByRole("textbox", MD_BOX) === null));
    expect(revokeCalls()).toHaveLength(1);
  });
});
