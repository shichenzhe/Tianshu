// @vitest-environment jsdom
/**
 * FileTabContent 路由：md/text 判定复用 chat 域 previewModeOfPath、image
 * dataUrl 直渲 / webview file:// 由后端 readFile 返回 kind 驱动、
 * 后端 kind 与路径不一致回 <pre> 只读兜底、
 * workspace 读失败 → 空态 + Finder 兜底（对齐 FilePreview 语义）。
 * md/text 载 FileTabEditor（本处桩化受控协议，编辑器行为由
 * file-tab-editor.test.tsx 直测）：加载成功落 baselineMtime（回传 mtime），
 * 编辑→保存走 useSaveTab 完整流（invoke workspace:writeFile 带基线）。
 * mock 骨架同 tests/ai/chat/file-preview.test.tsx（部分 mock i18n、t 返回
 * key）；file-window store 真实落地，afterEach reset。
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
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const readFileMock = vi.hoisted(() => vi.fn());
// revealFile 桩须回 Promise（组件 reveal 走 .catch 兜底，undefined 会在
// 点击时同步抛 unhandled TypeError——基线遗留的 1 个 unhandled error 根因）
const revealFileMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../../../src-react/domains/ai/api/artifact.api", () => ({
  default: {
    readFile: readFileMock,
    revealFile: revealFileMock,
    exportFile: vi.fn(),
  },
}));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));

vi.mock(
  "../../../src-react/domains/ai/file-window/components/FileTabEditor",
  () => ({
    default: ({
      value,
      onChange,
      onSave,
    }: {
      value: string;
      onChange: (v: string) => void;
      onSave: () => void;
    }) => (
      <div data-testid="editor-stub">
        <input
          aria-label="draft"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" onClick={onSave}>
          save
        </button>
        {/* 同一处理器内 onChange+onSave 连发：钉 handleDraftChange 同步
            valueRef（不经 effect 刷新的残余窗口） */}
        <button
          type="button"
          onClick={() => {
            onChange("batch");
            onSave();
          }}
        >
          batch
        </button>
      </div>
    ),
  }),
);

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import FileTabContent from "../../../src-react/domains/ai/file-window/components/FileTabContent";
import { flushTabSave } from "../../../src-react/domains/ai/file-window/lib/tab-save-flush";
import type { FileWindowResource } from "../../../src-react/domains/ai/file-window/model/resource";

afterEach(() => {
  cleanup();
  readFileMock.mockReset();
  // mockClear 保留 async 实现：mockReset 清实现会回 undefined-returning，
  // reveal .catch 再抛 unhandled error
  revealFileMock.mockClear();
  invokeMock.mockReset();
  useFileWindowStore.getState().reset();
});

/** 经 store 打 tab 再渲染内容区（组件按 tabId 反查 resource）；返回 client 供主动 invalidate 模拟重取 */
function renderTab(resource: FileWindowResource) {
  const { tabId } = useFileWindowStore.getState().openTab(resource);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <FileTabContent tabId={tabId} />
    </QueryClientProvider>,
  );
  return { tabId, client };
}

const tabOf = (tabId: string) =>
  useFileWindowStore.getState().tabs.find((t) => t.id === tabId);

describe("FileTabContent 路由", () => {
  it("md → 载 FileTabEditor（编辑器行为由 file-tab-editor 直测）", async () => {
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "# 你好",
      mtime: 1,
    });
    renderTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    expect(await screen.findByTestId("editor-stub")).toBeTruthy();
  });

  it("纯文本/代码 → 载 FileTabEditor（previewModeOfPath 非 md 同走编辑器）", async () => {
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "const a = 1;",
      mtime: 1,
    });
    renderTab({ kind: "workspace", workspaceId: 7, path: "main.ts" });
    expect(await screen.findByTestId("editor-stub")).toBeTruthy();
  });

  it("加载成功 → baselineMtime 落回传 mtime；编辑→保存完整流（基线随写回更新）", async () => {
    readFileMock
      .mockResolvedValueOnce({ kind: "text", content: "x", mtime: 100 })
      // 写回后重取（write 内 invalidate）：真实 readFile 回写后文件的
      // 新 mtime——防「draft 非空+mtime 换血」守卫误判自身写回
      .mockResolvedValue({ kind: "text", content: "改", mtime: 300 });
    invokeMock.mockResolvedValue({ absPath: "/x/a.txt", mtime: 300 });
    const { tabId } = renderTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.txt",
    });
    // 未脏时基线落库（工具行徽标随 dirty 走 unsaved）
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(100));
    // 编辑（受控 onChange）：dirty/unsaved 进 store
    fireEvent.change(await screen.findByLabelText("draft"), {
      target: { value: "改" },
    });
    expect(tabOf(tabId)?.dirty).toBe(true);
    expect(tabOf(tabId)?.saveStatus).toBe("unsaved");
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => {
      expect(tabOf(tabId)?.saveStatus).toBe("saved");
    });
    expect(invokeMock).toHaveBeenCalledWith("workspace:writeFile", {
      workspaceId: 7,
      path: "a.txt",
      content: "改",
      baselineMtime: 100,
    });
    expect(tabOf(tabId)?.dirty).toBe(false);
    expect(tabOf(tabId)?.baselineMtime).toBe(300);
  });

  it("保存在飞期间继续编辑 → 完成后 dirty 回补（草稿新于磁盘不误判净）", async () => {
    readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 100 });
    let resolveWrite: (v: { absPath: string; mtime: number }) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveWrite = res;
        }),
    );
    const { tabId } = renderTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.txt",
    });
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(100));
    fireEvent.change(await screen.findByLabelText("draft"), {
      target: { value: "v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(tabOf(tabId)?.saveStatus).toBe("saving");
    // invoke 未决期间继续击键（草稿 v2 未落盘）
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "v2" },
    });
    expect(tabOf(tabId)?.dirty).toBe(true);
    await act(async () => {
      resolveWrite!({ absPath: "/x/a.txt", mtime: 300 });
    });
    // write 成功先落 saved/dirty:false，快照比对后回补 unsaved/dirty:true
    await waitFor(() => expect(tabOf(tabId)?.saveStatus).toBe("unsaved"));
    expect(tabOf(tabId)?.dirty).toBe(true);
    // 写盘内容取保存时快照 v1；基线仍更新（磁盘即 v1）
    expect(invokeMock).toHaveBeenCalledWith("workspace:writeFile", {
      workspaceId: 7,
      path: "a.txt",
      content: "v1",
      baselineMtime: 100,
    });
    expect(tabOf(tabId)?.baselineMtime).toBe(300);
  });

  it("冲突 overwrite 在飞期间继续编辑 → 完成后同样回补 dirty", async () => {
    readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 100 });
    invokeMock.mockRejectedValueOnce(new Error("FILE_CONFLICT"));
    let resolveWrite: (v: { absPath: string; mtime: number }) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveWrite = res;
        }),
    );
    const { tabId } = renderTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.txt",
    });
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(100));
    fireEvent.change(await screen.findByLabelText("draft"), {
      target: { value: "v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    // 冲突 → overwrite（此时草稿 v1）
    fireEvent.click(
      await screen.findByRole("button", {
        name: "chat:fileWindow.conflict.overwrite",
      }),
    );
    // overwrite 写盘在飞期间继续击键
    fireEvent.change(await screen.findByLabelText("draft"), {
      target: { value: "v2" },
    });
    await act(async () => {
      resolveWrite!({ absPath: "/x/a.txt", mtime: 300 });
    });
    await waitFor(() => expect(tabOf(tabId)?.saveStatus).toBe("unsaved"));
    expect(tabOf(tabId)?.dirty).toBe(true);
  });

  it("脏期间重取不覆盖基线（外部重取不得吞编辑保存基线）", async () => {
    readFileMock
      .mockResolvedValueOnce({ kind: "text", content: "v1", mtime: 100 })
      .mockResolvedValue({ kind: "text", content: "v2", mtime: 200 });
    const { tabId, client } = renderTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.txt",
    });
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(100));
    fireEvent.change(await screen.findByLabelText("draft"), {
      target: { value: "改" },
    });
    expect(tabOf(tabId)?.dirty).toBe(true);
    // 同键重取（reload/外部 invalidate 同机制）新数据到达——脏态下基线保持 100
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["fw-file"] });
    });
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe(
      "改",
    );
    expect(tabOf(tabId)?.baselineMtime).toBe(100);
  });

  it("onChange/onSave 同处理器连发 → 保存取同步 valueRef（不经 effect 刷新）", async () => {
    readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 100 });
    invokeMock.mockResolvedValue({ absPath: "/x/a.txt", mtime: 300 });
    renderTab({ kind: "workspace", workspaceId: 7, path: "a.txt" });
    await screen.findByTestId("editor-stub");
    // batch 按钮一次点击内 onChange("batch")+onSave()：valueRef 须已同步
    // 为 "batch"（否则写盘旧值 ""——effect-lag 残余窗口）
    fireEvent.click(screen.getByRole("button", { name: "batch" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("workspace:writeFile", {
        workspaceId: 7,
        path: "a.txt",
        content: "batch",
        baselineMtime: 100,
      }),
    );
  });

  it("已保存（draft 非空非脏）外部重取换血 → externalChanged 且基线不吸收；keepMine 后保存 FILE_CONFLICT 兜底", async () => {
    readFileMock
      .mockResolvedValueOnce({ kind: "text", content: "v1", mtime: 100 })
      // 写回后重取（write 内 invalidate）：写回内容+新 mtime
      .mockResolvedValueOnce({ kind: "text", content: "改", mtime: 300 })
      // 外部写盘后的静默重取（useFileChanged 非脏路径 invalidate）
      .mockResolvedValue({ kind: "text", content: "v2-外部", mtime: 400 });
    invokeMock
      .mockResolvedValueOnce({ absPath: "/x/a.txt", mtime: 300 })
      // keepMine 后再保存：基线 300 ≠ 磁盘 400 → FILE_CONFLICT 兜底
      .mockRejectedValueOnce(new Error("FILE_CONFLICT"))
      .mockResolvedValue({ absPath: "/x/a.txt", mtime: 500 });
    const { tabId, client } = renderTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.txt",
    });
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(100));
    // 编辑并保存：draft 保留、dirty 清、基线/lastSeen 吸收写回 300
    fireEvent.change(await screen.findByLabelText("draft"), {
      target: { value: "改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(tabOf(tabId)?.dirty).toBe(false));
    await waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2));
    expect(tabOf(tabId)?.baselineMtime).toBe(300);
    expect(tabOf(tabId)?.externalChanged).toBeFalsy();
    // 外部写盘：非脏 → 静默 invalidate 重取（useFileChanged 语义，此处直演）
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["fw-file"] });
    });
    // draft 非空+mtime 换血 → externalChanged 标记；基线不吸收 400
    await waitFor(() => expect(tabOf(tabId)?.externalChanged).toBe(true));
    expect(tabOf(tabId)?.baselineMtime).toBe(300);
    // 冲突条（external 场景变体按钮：保留我的修改/重载磁盘版本）
    expect(
      await screen.findByText("chat:fileWindow.conflict.title"),
    ).toBeTruthy();
    // keepMine：仅撤条幅，草稿/基线保留
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.conflict.keepMine" }),
    );
    await waitFor(() => expect(tabOf(tabId)?.externalChanged).toBeFalsy());
    expect(tabOf(tabId)?.baselineMtime).toBe(300);
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe(
      "改",
    );
    // 再编辑 → 保存：基线 300 ≠ 磁盘 400 → FILE_CONFLICT（防免检覆盖兜底）
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "再改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(
      await screen.findByText("chat:fileWindow.conflict.title"),
    ).toBeTruthy();
    // 保存冲突场景按钮（overwrite/reload）：reload 弃草稿重读磁盘版本
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "v2-外部",
      mtime: 400,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.conflict.reload" }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe(
        "v2-外部",
      ),
    );
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(400));
    expect(tabOf(tabId)?.externalChanged).toBeFalsy();
    expect(screen.queryByText("chat:fileWindow.conflict.title")).toBeNull();
  });

  it("external 场景「重载磁盘版本」：非脏换血条幅 → invalidate 清草稿/条幅重读", async () => {
    readFileMock
      .mockResolvedValueOnce({ kind: "text", content: "v1", mtime: 100 })
      .mockResolvedValueOnce({ kind: "text", content: "改", mtime: 300 })
      .mockResolvedValue({ kind: "text", content: "v2-外部", mtime: 400 });
    invokeMock.mockResolvedValue({ absPath: "/x/a.txt", mtime: 300 });
    const { tabId, client } = renderTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.txt",
    });
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(100));
    fireEvent.change(await screen.findByLabelText("draft"), {
      target: { value: "改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(tabOf(tabId)?.dirty).toBe(false));
    await waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["fw-file"] });
    });
    await waitFor(() => expect(tabOf(tabId)?.externalChanged).toBe(true));
    // 重载磁盘版本：弃草稿展示磁盘内容、撤条幅、基线吸收 400
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:fileWindow.conflict.reloadDisk",
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe(
        "v2-外部",
      ),
    );
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(400));
    expect(tabOf(tabId)?.externalChanged).toBeFalsy();
    expect(screen.queryByText("chat:fileWindow.conflict.title")).toBeNull();
  });

  it("keepMine 后同 mtime 重取不重弹条幅、基线不吸收（兜底保持）", async () => {
    readFileMock
      .mockResolvedValueOnce({ kind: "text", content: "v1", mtime: 100 })
      .mockResolvedValueOnce({ kind: "text", content: "改", mtime: 300 })
      .mockResolvedValue({ kind: "text", content: "v2-外部", mtime: 400 });
    invokeMock.mockResolvedValue({ absPath: "/x/a.txt", mtime: 300 });
    const { tabId, client } = renderTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.txt",
    });
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(100));
    fireEvent.change(await screen.findByLabelText("draft"), {
      target: { value: "改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(tabOf(tabId)?.dirty).toBe(false));
    await waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["fw-file"] });
    });
    await waitFor(() => expect(tabOf(tabId)?.externalChanged).toBe(true));
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.conflict.keepMine" }),
    );
    await waitFor(() => expect(tabOf(tabId)?.externalChanged).toBeFalsy());
    // 再次重取同一磁盘版本（聚焦刷新等）：不重弹条幅，基线仍指 draft 所据 300
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["fw-file"] });
    });
    await waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(4));
    await new Promise((r) => setTimeout(r, 20));
    expect(tabOf(tabId)?.externalChanged).toBeFalsy();
    expect(tabOf(tabId)?.baselineMtime).toBe(300);
    expect(screen.queryByText("chat:fileWindow.conflict.title")).toBeNull();
  });

  it("保存冲突 → 工具行弹冲突条；reload 清草稿重读", async () => {
    readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 100 });
    invokeMock
      .mockRejectedValueOnce(new Error("FILE_CONFLICT"))
      .mockResolvedValue({ absPath: "/x/a.txt", mtime: 300 });
    const { tabId } = renderTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.txt",
    });
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(100));
    fireEvent.change(await screen.findByLabelText("draft"), {
      target: { value: "改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    // 冲突条出现（工具行内嵌）
    expect(
      await screen.findByText("chat:fileWindow.conflict.title"),
    ).toBeTruthy();
    // reload：放弃本地修改 → dirty 清 + 草稿丢弃展示磁盘内容
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "磁盘新",
      mtime: 200,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.conflict.reload" }),
    );
    await waitFor(() => expect(tabOf(tabId)?.dirty).toBe(false));
    await waitFor(() =>
      expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe(
        "磁盘新",
      ),
    );
    // 重读数据到达且未脏 → 新基线落库
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(200));
    expect(screen.queryByText("chat:fileWindow.conflict.title")).toBeNull();
  });

  it("保存流注册 flush：CloseConfirmBar「保存并关闭」经注册表写盘（卸载除名）", async () => {
    readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 100 });
    invokeMock.mockResolvedValue({ absPath: "/x/a.txt", mtime: 300 });
    const { tabId } = renderTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.txt",
    });
    await waitFor(() => expect(tabOf(tabId)?.baselineMtime).toBe(100));
    fireEvent.change(await screen.findByLabelText("draft"), {
      target: { value: "改" },
    });
    await act(async () => {
      await flushTabSave(tabId);
    });
    expect(invokeMock).toHaveBeenCalledWith("workspace:writeFile", {
      workspaceId: 7,
      path: "a.txt",
      content: "改",
      baselineMtime: 100,
    });
    await waitFor(() => expect(tabOf(tabId)?.dirty).toBe(false));
    // 卸载除名：flush 退化为 no-op 不再触写盘
    cleanup();
    const callsBefore = invokeMock.mock.calls.length;
    await act(async () => {
      await flushTabSave(tabId);
    });
    expect(invokeMock.mock.calls.length).toBe(callsBefore);
  });

  it("image → dataUrl img（后端 kind 驱动）", async () => {
    readFileMock.mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,x",
      mtime: 1,
    });
    renderTab({ kind: "workspace", workspaceId: 7, path: "a.png" });
    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,x",
      ),
    );
  });

  it("bmp（未收录图片格式）对齐 chat 口径 text：编辑器渲染，不走 <img>/<pre>（终审 I3）", async () => {
    // previewModeOfPath 无 bmp（chat 域 IMAGE_EXTS 同款）、后端 IMAGE_MIME
    // 亦无 bmp → kind text：与 contentKind=text 一致，编辑器承载
    readFileMock.mockResolvedValue({ kind: "text", content: "RAW", mtime: 5 });
    renderTab({ kind: "workspace", workspaceId: 7, path: "x.bmp" });
    expect(await screen.findByTestId("editor-stub")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    // <pre> 兜底（后端 kind 与路径模式不一致）仍由 png→text 用例覆盖
    expect(document.querySelector("pre")).toBeNull();
  });

  it("后端 kind 与路径模式不一致（png 回 text）→ 原文只读 <pre> 兜底", async () => {
    readFileMock.mockResolvedValue({ kind: "text", content: "RAW", mtime: 5 });
    renderTab({ kind: "workspace", workspaceId: 7, path: "a.png" });
    await waitFor(() =>
      expect(document.querySelector("pre")?.textContent).toBe("RAW"),
    );
  });

  it("workspace webview 类 → <webview file:// partition=artifact-preview>", async () => {
    readFileMock.mockResolvedValue({
      kind: "webview",
      absPath: "/tmp/ws/r.pdf",
      mtime: 1,
    });
    renderTab({ kind: "workspace", workspaceId: 7, path: "r.pdf" });
    await waitFor(() => expect(document.querySelector("webview")).toBeTruthy());
    const wv = document.querySelector("webview")!;
    expect(wv.getAttribute("src")).toBe("file:///tmp/ws/r.pdf");
    expect(wv.getAttribute("partition")).toBe("artifact-preview");
  });

  it("读失败 → 空态 + 在 Finder 中显示兜底（对齐 FilePreview 语义）", async () => {
    readFileMock.mockRejectedValue(new Error("文件超过 512KB 预览上限"));
    renderTab({ kind: "workspace", workspaceId: 7, path: "big.log" });
    const reveal = await screen.findByRole("button", {
      name: "chat:artifacts.actionReveal",
    });
    fireEvent.click(reveal);
    await waitFor(() =>
      expect(revealFileMock).toHaveBeenCalledWith(7, "big.log"),
    );
    expect(
      await screen.findByText("chat:artifacts.previewFailed"),
    ).toBeTruthy();
  });
});
