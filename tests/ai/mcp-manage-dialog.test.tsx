// @vitest-environment jsdom
/**
 * McpManageDialog 测试：空态渲染与引导、配置按钮进编辑态、
 * 非法 JSON 保存不调 sync、合法 JSON 调 sync 并回列表态；
 * list pending/error 门禁（防打开瞬间空基线导致保存全量误删）与
 * 基线懒计算（进编辑态瞬间以最新已就绪数据为源）。
 * useQuery mock 为可控数据；McpServerApi 模块级 mock
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";

afterEach(cleanup);

const state = {
  servers: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<Record<string, unknown>>,
  // mcpServers 查询态注入：pending/error 时 data 置 undefined（贴近真实 useQuery）
  serversPending: false,
  serversError: false,
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: vi.fn(({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] !== "mcpServers") {
      return { data: state.statuses };
    }
    if (state.serversPending || state.serversError) {
      return {
        data: undefined,
        isPending: state.serversPending,
        isError: state.serversError,
      };
    }
    return { data: state.servers, isPending: false, isError: false };
  }),
}));
vi.mock("@/domains/ai/chat/components/CodeBlock", () => ({
  getHighlighter: vi.fn(async () => null),
}));

// vi.mock 工厂被提升到文件顶部，普通 const 会 ReferenceError——经 vi.hoisted
// 预建 mock（同 tests/ai/skill-import-dialog.test.tsx 的 invokeMock 惯例）
const { syncMock, openHubMock } = vi.hoisted(() => ({
  syncMock: vi.fn(),
  openHubMock: vi.fn(),
}));
vi.mock("@/domains/ai/api/mcp.api", () => ({
  default: {
    list: vi.fn(),
    sync: syncMock,
    openHub: openHubMock,
    setEnabled: vi.fn(),
    reconnect: vi.fn(),
    delete: vi.fn(),
  },
}));

import McpManageDialog from "@/domains/ai/mcp/components/McpManageDialog";

beforeEach(() => {
  state.servers = [];
  state.statuses = [];
  state.serversPending = false;
  state.serversError = false;
  vi.clearAllMocks();
});

function open() {
  render(<McpManageDialog open onOpenChange={vi.fn()} />);
}

describe("McpManageDialog", () => {
  it("空态：显示空文案与引导配置按钮，点击进入编辑态显示默认骨架", () => {
    open();
    expect(screen.getByText("ai:mcp.manage.empty")).toBeTruthy();
    // 空态下标题区与中央引导各有一个「配置」按钮，取第一个（标题区）
    const [configureBtn] = screen.getAllByRole("button", {
      name: "ai:mcp.manage.configure",
    });
    fireEvent.click(configureBtn);
    // 仓库未装 @testing-library/jest-dom，直读 textarea.value（同 json-config-editor.test.tsx）
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      '{\n  "mcpServers": {}\n}',
    );
  });

  it("列表态：已有服务器显示行（名称可见）", () => {
    state.servers = [
      {
        id: 1,
        name: "feishu",
        transport: "stdio",
        command: "npx",
        enabled: true,
      },
    ];
    open();
    expect(screen.getByText("feishu")).toBeTruthy();
  });

  it("非法 JSON：保存不调 sync 并 toast 错误", async () => {
    syncMock.mockResolvedValue({ created: 0, updated: 0, deleted: 0 });
    open();
    const [configureBtn] = screen.getAllByRole("button", {
      name: "ai:mcp.manage.configure",
    });
    fireEvent.click(configureBtn);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "{ broken" } });
    fireEvent.click(screen.getByRole("button", { name: "ai:mcp.manage.save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("合法 JSON：调 sync、toast 成功并回列表态", async () => {
    syncMock.mockResolvedValue({ created: 1, updated: 0, deleted: 0 });
    open();
    const [configureBtn] = screen.getAllByRole("button", {
      name: "ai:mcp.manage.configure",
    });
    fireEvent.click(configureBtn);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: '{"mcpServers":{"a":{"command":"npx"}}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "ai:mcp.manage.save" }));
    await waitFor(() =>
      expect(syncMock).toHaveBeenCalledWith({
        a: {
          transport: "stdio",
          command: "npx",
          args: undefined,
          env: undefined,
          url: undefined,
          headers: undefined,
        },
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // 回列表态：编辑器消失、标题回到 manage.title
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("isError：渲染加载失败文案而非空态（防失败伪装空态引导进编辑器）", () => {
    state.serversError = true;
    open();
    expect(screen.getByText("ai:mcp.manage.loadError")).toBeTruthy();
    expect(screen.queryByText("ai:mcp.manage.empty")).toBeNull();
  });

  it("isError：配置按钮禁用，点击不进入编辑态", () => {
    state.serversError = true;
    open();
    const configureBtn = screen.getByRole("button", {
      name: "ai:mcp.manage.configure",
    }) as HTMLButtonElement;
    expect(configureBtn.disabled).toBe(true);
    fireEvent.click(configureBtn);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("isPending：配置按钮禁用，点击不进入编辑态", () => {
    state.serversPending = true;
    open();
    expect(screen.getByText("common:loading")).toBeTruthy();
    const configureBtn = screen.getByRole("button", {
      name: "ai:mcp.manage.configure",
    }) as HTMLButtonElement;
    expect(configureBtn.disabled).toBe(true);
    fireEvent.click(configureBtn);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("数据就绪时带模板打开：直入编辑态并合入模板（同 key 保留原值）", () => {
    state.servers = [
      {
        id: 1,
        name: "existing",
        transport: "stdio",
        command: "node",
        enabled: true,
      },
    ];
    render(
      <McpManageDialog
        open
        onOpenChange={vi.fn()}
        initialTemplate={{
          feishu: { command: "npx" },
          existing: { command: "keep-original" },
        }}
      />,
    );
    const value = (screen.getByRole("textbox") as HTMLTextAreaElement).value;
    expect(JSON.parse(value)).toEqual({
      mcpServers: {
        existing: { command: "node" },
        feishu: { command: "npx" },
      },
    });
  });

  it("打开瞬间 pending、就绪后再配置：基线含已就绪数据（防全量误删）", () => {
    state.serversPending = true;
    state.servers = [
      {
        id: 1,
        name: "feishu",
        transport: "stdio",
        command: "npx",
        enabled: true,
      },
    ];
    const view = render(<McpManageDialog open onOpenChange={vi.fn()} />);
    // 打开瞬间未就绪：进不了编辑态
    expect(screen.queryByRole("textbox")).toBeNull();
    state.serversPending = false;
    view.rerender(<McpManageDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "ai:mcp.manage.configure" }),
    );
    // 基线以就绪数据懒计算，而非打开瞬间的空骨架 {"mcpServers": {}}
    const value = (screen.getByRole("textbox") as HTMLTextAreaElement).value;
    expect(JSON.parse(value)).toEqual({
      mcpServers: { feishu: { command: "npx" } },
    });
  });

  it("带模板打开但 pending：先落列表态，就绪后直入编辑态并合入模板", () => {
    state.serversPending = true;
    state.servers = [
      {
        id: 1,
        name: "existing",
        transport: "stdio",
        command: "node",
        enabled: true,
      },
    ];
    const template = { feishu: { command: "npx" } };
    const view = render(
      <McpManageDialog
        open
        onOpenChange={vi.fn()}
        initialTemplate={template}
      />,
    );
    // 未就绪不直入编辑态（空基线合模板会丢库内已有服务）
    expect(screen.queryByRole("textbox")).toBeNull();
    state.serversPending = false;
    view.rerender(
      <McpManageDialog
        open
        onOpenChange={vi.fn()}
        initialTemplate={template}
      />,
    );
    const value = (screen.getByRole("textbox") as HTMLTextAreaElement).value;
    expect(JSON.parse(value)).toEqual({
      mcpServers: {
        existing: { command: "node" },
        feishu: { command: "npx" },
      },
    });
  });
});
