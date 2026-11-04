// @vitest-environment jsdom
/**
 * WorkspaceFileTree：根失败内联重试 / 目录加载中禁点 / 点击文件上抛
 * onOpenFile（WorkBuddy 对齐：内嵌预览形态移除，file tab 由 DetailPanel
 * 开）。WorkspaceApi 全 mock（照 changes-panel-tab 先例，t 返回 key）。
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listDir: vi.fn() }));
const t = vi.hoisted(() => (key: string) => key);
const toast = vi.hoisted(() => ({ error: vi.fn() }));
// WorkspaceFileTree 走具名 WorkspaceApi 导入，default 同对象一并给
vi.mock("../../src-react/domains/ai/api/workspace.api", () => ({
  default: api,
  WorkspaceApi: api,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../src-react/domains/ai/chat/lib/error-message", () => ({
  mapIpcError: (e: unknown) => String(e),
}));

import WorkspaceFileTree from "../../src-react/domains/ai/chat/components/detail-panel/WorkspaceFileTree";
import type {
  DirEntry,
  WorkspaceRecord,
} from "../../src-react/domains/ai/api/workspace.api";

const WS = { id: 1, name: "ws", directoryPath: "/ws" } as WorkspaceRecord;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("WorkspaceFileTree", () => {
  it("根拉取失败：错误行 + 重试（toast 保留）；重试成功清错误行出树", async () => {
    api.listDir.mockRejectedValueOnce(new Error("boom"));
    render(<WorkspaceFileTree workspace={WS} onOpenFile={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("chat:workspace.rootFailed")).toBeTruthy();
    });
    expect(toast.error).toHaveBeenCalled();
    const retry = screen.getByRole("button", {
      name: "chat:workspace.retryRoot",
    });
    api.listDir.mockResolvedValue([{ name: "a.ts", isDir: false } as DirEntry]);
    fireEvent.click(retry);
    await waitFor(() => {
      expect(screen.getByText("a.ts")).toBeTruthy();
    });
    expect(screen.queryByText("chat:workspace.rootFailed")).toBeNull();
  });

  it("目录加载中禁点，加载完恢复", async () => {
    let resolveSub!: (entries: DirEntry[]) => void;
    api.listDir.mockImplementation((_wsId: number, rel: string) =>
      rel === ""
        ? Promise.resolve([{ name: "docs", isDir: true } as DirEntry])
        : new Promise<DirEntry[]>((resolve) => {
            resolveSub = resolve;
          }),
    );
    render(<WorkspaceFileTree workspace={WS} onOpenFile={() => {}} />);
    const dirBtn = (await screen.findByRole("button", {
      name: /docs/,
    })) as HTMLButtonElement;
    fireEvent.click(dirBtn);
    // 仓库无 jest-dom，disabled 用原生属性断言（同 detail-tab-bar 先例）
    await waitFor(() => {
      expect(dirBtn.disabled).toBe(true);
    });
    resolveSub([]);
    await waitFor(() => {
      expect(dirBtn.disabled).toBe(false);
    });
  });

  it("点击文件上抛 onOpenFile：根级 basename、嵌套目录带父级前缀", async () => {
    api.listDir.mockImplementation((_wsId: number, rel: string) =>
      rel === ""
        ? Promise.resolve([
            { name: "a.ts", isDir: false } as DirEntry,
            { name: "docs", isDir: true } as DirEntry,
          ])
        : Promise.resolve([{ name: "b.md", isDir: false } as DirEntry]),
    );
    const onOpenFile = vi.fn();
    render(<WorkspaceFileTree workspace={WS} onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByText("a.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("a.ts");
    // 展开目录后点嵌套文件：相对工作空间根的路径（file tab 复用判据）
    fireEvent.click(screen.getByRole("button", { name: /docs/ }));
    fireEvent.click(await screen.findByText("b.md"));
    expect(onOpenFile).toHaveBeenLastCalledWith("docs/b.md");
  });
});
