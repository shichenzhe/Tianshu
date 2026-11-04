// @vitest-environment jsdom
/**
 * ChangesPanelTab：列表/进 diff/三空态/刷新。WorkspaceApi 全 mock，
 * react-i18next 返回 key（照 detail-panel-init 先例）。
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 工厂在 import 期执行，外置 const 需 vi.hoisted（裸 const 会 TDZ）
const api = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
}));
// t 须稳定引用（组件 load/useEffect 依赖 t，每次渲染新建会反复触发拉取）
const t = vi.hoisted(() => (key: string) => key);
vi.mock("../../src-react/domains/ai/api/workspace.api", () => ({
  default: api,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t }),
  // tooltip import 链拉入 @/lib/utils → i18n（use initReactI18next）
  initReactI18next: { type: "3rd-party", init: () => {} },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/domains/ai/chat/lib/error-message", () => ({
  mapIpcError: (e: unknown) => String(e),
}));

import ChangesPanelTab from "../../src-react/domains/ai/chat/components/detail-panel/ChangesPanelTab";
import type { WorkspaceRecord } from "../../src-react/domains/ai/api/workspace.api";

const WS = { id: 1, name: "ws", directoryPath: "/ws" } as WorkspaceRecord;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("ChangesPanelTab", () => {
  it("渲染变更列表并点击进入 diff 视图", async () => {
    api.gitStatus.mockResolvedValue({
      kind: "ok",
      files: [
        { path: "a.ts", status: "modified", staged: true },
        { path: "b.ts", status: "untracked", staged: false },
      ],
      truncated: false,
    });
    api.gitDiff.mockResolvedValue({
      kind: "diff",
      text: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new",
      truncated: false,
    });
    render(<ChangesPanelTab workspace={WS} />);
    await waitFor(() => {
      expect(screen.getByText("a.ts")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() => {
      expect(screen.getByText("+new")).toBeTruthy();
      expect(screen.getByText("-old")).toBeTruthy();
    });
  });

  it("非 git 目录与无变更空态", async () => {
    api.gitStatus.mockResolvedValue({ kind: "not-git" });
    const { rerender } = render(<ChangesPanelTab workspace={WS} />);
    await waitFor(() => {
      expect(screen.getByText("chat:changes.notGit")).toBeTruthy();
    });
    api.gitStatus.mockResolvedValue({
      kind: "ok",
      files: [],
      truncated: false,
    });
    rerender(<ChangesPanelTab workspace={{ ...WS, id: 2 }} />);
    await waitFor(() => {
      expect(screen.getByText("chat:changes.empty")).toBeTruthy();
    });
  });

  it("未绑定目录空态（不发请求）", () => {
    render(<ChangesPanelTab workspace={{ ...WS, directoryPath: undefined }} />);
    expect(screen.getByText("chat:changes.noDirectory")).toBeTruthy();
    expect(api.gitStatus).not.toHaveBeenCalled();
  });

  it("刷新按钮重新拉取", async () => {
    api.gitStatus.mockResolvedValue({
      kind: "ok",
      files: [],
      truncated: false,
    });
    render(<ChangesPanelTab workspace={WS} />);
    await waitFor(() => {
      expect(api.gitStatus).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "chat:changes.refresh" }),
    );
    await waitFor(() => {
      expect(api.gitStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("staged 徽标仅渲染在已暂存文件上；列表截断提示随 truncated 渲染", async () => {
    api.gitStatus.mockResolvedValue({
      kind: "ok",
      files: [
        { path: "a.ts", status: "modified", staged: true },
        { path: "b.ts", status: "modified", staged: false },
      ],
      truncated: true,
    });
    render(<ChangesPanelTab workspace={WS} />);
    await waitFor(() => {
      expect(screen.getByText("chat:changes.staged")).toBeTruthy();
      expect(screen.getByText("chat:changes.listTruncated")).toBeTruthy();
    });
    expect(screen.getAllByText("chat:changes.staged")).toHaveLength(1);
  });

  it("diff 截断提示随 gitDiff truncated 渲染", async () => {
    api.gitStatus.mockResolvedValue({
      kind: "ok",
      files: [{ path: "a.ts", status: "modified", staged: false }],
      truncated: false,
    });
    api.gitDiff.mockResolvedValue({
      kind: "diff",
      text: "+new",
      truncated: true,
    });
    render(<ChangesPanelTab workspace={WS} />);
    await waitFor(() => screen.getByText("a.ts"));
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() => {
      expect(screen.getByText("chat:changes.diffTruncated")).toBeTruthy();
    });
  });

  it("diff 视图返回按钮回到列表（列表态徽标复现、diff 不重复拉取）", async () => {
    api.gitStatus.mockResolvedValue({
      kind: "ok",
      files: [{ path: "a.ts", status: "modified", staged: false }],
      truncated: false,
    });
    api.gitDiff.mockResolvedValue({
      kind: "diff",
      text: "+new",
      truncated: false,
    });
    render(<ChangesPanelTab workspace={WS} />);
    await waitFor(() => screen.getByText("a.ts"));
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "chat:changes.back" }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "chat:changes.back" }));
    // 状态徽标是列表态独有标记（diff 头也会显示文件名，不能拿文件名判）
    await waitFor(() => {
      expect(screen.getByText("chat:changes.modified")).toBeTruthy();
    });
    expect(api.gitDiff).toHaveBeenCalledTimes(1);
  });

  it("untracked 文件点击进 diff 视图提示无 diff（不请求着色渲染）", async () => {
    api.gitStatus.mockResolvedValue({
      kind: "ok",
      files: [{ path: "new.ts", status: "untracked", staged: false }],
      truncated: false,
    });
    api.gitDiff.mockResolvedValue({ kind: "untracked" });
    render(<ChangesPanelTab workspace={WS} />);
    await waitFor(() => screen.getByText("new.ts"));
    fireEvent.click(screen.getByText("new.ts"));
    await waitFor(() => {
      expect(screen.getByText("chat:changes.untrackedNoDiff")).toBeTruthy();
    });
  });
});
