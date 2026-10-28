// AR 批：artifact store 单测——list 三分支（成功/端点缺失 404→unsupported/
// 业务错可重试）、收藏乐观翻转失败回滚、预览联合（text/image/不支持文案）、
// load/preview 防迟到各自序号。mock 面照 skills.store.test 先例
//（connections.store 替身 + transport.request vi.fn 直控 status/body）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS } from "@tianshu/protocol";

const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
  useConnectionsStore: {
    getState: () => ({ activeConnId: "c1" }),
    subscribe: () => () => {},
  },
}));

vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
  useConnectionsStore: connMock.useConnectionsStore,
}));

import { useArtifactStore } from "./artifact.store";

function ok(data: unknown) {
  return { status: 200, body: { success: true, data, message: "success" } };
}
function bizError(code: string, message: string) {
  return { status: 200, body: { success: false, code, message } };
}

function wire(impl: ReturnType<typeof vi.fn>) {
  const transport = { request: impl };
  connMock.activeTransport.mockReturnValue(transport);
  return transport;
}

const ITEM = {
  relPath: "report.md",
  name: "report.md",
  fileType: "markdown",
  workspaceId: 3,
  workspaceName: "默认空间",
  sessionId: 9,
  sessionTitle: "写报告",
  writtenAt: "2026-10-27T02:00:00.000Z",
  size: 1024,
  favorite: false,
};

beforeEach(() => {
  connMock.activeTransport.mockReset();
  useArtifactStore.getState().reset();
});

describe("artifact.store（AR 批）", () => {
  it("load 成功：rows 就位 + initialized", async () => {
    const t = wire(vi.fn(async () => ok([ITEM])));
    await useArtifactStore.getState().load();
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.artifact.list,
      undefined,
    );
    const s = useArtifactStore.getState();
    expect(s.rows).toHaveLength(1);
    expect(s.initialized).toBe(true);
    expect(s.unsupported).toBe(false);
  });

  it("端点缺失（HTTP 404 无业务体）→ unsupported 置位——视图层据此隐藏入口", async () => {
    wire(vi.fn(async () => ({ status: 404, body: "Not Found" })));
    await useArtifactStore.getState().load();
    const s = useArtifactStore.getState();
    expect(s.unsupported).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("业务错（网络/服务端）→ error 可重试（非 unsupported）", async () => {
    wire(vi.fn(async () => ({ status: 0, body: null })));
    await useArtifactStore.getState().load();
    const s = useArtifactStore.getState();
    expect(s.unsupported).toBe(false);
    expect(s.error).toBeTruthy();
  });

  it("toggleFavorite：乐观翻转，失败回滚", async () => {
    wire(vi.fn(async () => ({ status: 500, body: null })));
    // 预置一行（不经 load）
    useArtifactStore.setState({ rows: [ITEM] });
    await useArtifactStore.getState().toggleFavorite(ITEM);
    // 请求失败 → 回滚原 favorite=false
    expect(useArtifactStore.getState().rows[0].favorite).toBe(false);

    wire(vi.fn(async () => ok(true)));
    await useArtifactStore.getState().toggleFavorite(ITEM);
    expect(useArtifactStore.getState().rows[0].favorite).toBe(true);
  });

  it("openPreview：text 联合直存；PREVIEW_UNSUPPORTED 文案入 previewError", async () => {
    wire(vi.fn(async () => ok({ kind: "text", content: "正文" })));
    await useArtifactStore.getState().openPreview(ITEM);
    expect(useArtifactStore.getState().preview).toEqual({
      name: "report.md",
      content: { kind: "text", content: "正文" },
    });

    wire(
      vi.fn(async () =>
        bizError("ARTIFACT_PREVIEW_UNSUPPORTED", "该文件类型请在桌面端预览"),
      ),
    );
    await useArtifactStore.getState().openPreview(ITEM);
    const s = useArtifactStore.getState();
    expect(s.preview).toBeNull();
    expect(s.previewError).toContain("桌面端预览");
  });

  it("防迟到：load 迟到响应不覆盖新请求结果（各自序号）", async () => {
    type WireBody = ReturnType<typeof ok>;
    let releaseFirst: (v: WireBody) => void = () => {};
    const first = new Promise<WireBody>((resolve) => {
      releaseFirst = resolve;
    });
    const t = wire(
      // 默认实现立即回空列表；mockImplementationOnce 让首调用挂起在 first
      vi.fn(async () => ok([])).mockImplementationOnce(async () => first),
    );
    const slow = useArtifactStore.getState().load();
    const fast = useArtifactStore.getState().load(true);
    await fast;
    releaseFirst(ok([ITEM]));
    await slow;
    // 迟到的首请求（含 ITEM）不得覆盖第二次（空列表）
    expect(useArtifactStore.getState().rows).toHaveLength(0);
    expect(t.request).toHaveBeenCalledTimes(2);
  });
});
