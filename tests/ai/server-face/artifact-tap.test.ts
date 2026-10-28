// AR 批：桌面被控面 artifact 三端点单测——tap 层直测（createArtifactFace
// 注入 sessions 替身；routes 层由 routes.test 钉测试全表覆盖注册面）。
// 重点：list 剔 path（DTO 不泄本机路径——JSON.stringify 全文不含 "path"钉
// 断言）、read 三分支（text 直传/image dataUrl 拆解/webview 拒稳定码）、
// toggle 收藏透传。
import { describe, expect, it, vi } from "vitest";
import { createArtifactFace } from "../../../electron/domains/server-face/artifact-tap";
import type { ServerFaceArtifact } from "../../../electron/domains/server-face/deps";

/** sessions 替身（listArtifacts 返回桌面 ArtifactListItem 全形含 path） */
function sessionsStub(overrides: Partial<ServerFaceArtifact> = {}) {
  return {
    listArtifacts: vi.fn(async () => [
      {
        path: "/Users/secret/workspace/report.md",
        relPath: "report.md",
        name: "report.md",
        fileType: "markdown",
        workspaceId: 3,
        workspaceName: "默认空间",
        sessionId: 9,
        sessionTitle: "写报告",
        writtenAt: "2026-10-27T02:00:00.000Z",
        size: 1024,
        favorite: true,
      },
    ]),
    toggleArtifactFavorite: vi.fn(async () => true),
    readWorkspaceFileById: vi.fn(async () => ({
      kind: "text",
      content: "正文",
    })),
    ...overrides,
  } as unknown as ServerFaceArtifact;
}

describe("artifact-tap（AR 批本地产物三端点）", () => {
  it("list：行形透出且剔 path——wire 序列化不含绝对路径（DTO 不泄本机路径钉）", async () => {
    const face = createArtifactFace(sessionsStub());
    const rows = await face.list(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      relPath: "report.md",
      name: "report.md",
      fileType: "markdown",
      workspaceId: 3,
      workspaceName: "默认空间",
      sessionId: 9,
      sessionTitle: "写报告",
      writtenAt: "2026-10-27T02:00:00.000Z",
      size: 1024,
      favorite: true,
    });
    expect(JSON.stringify(rows)).not.toContain('"path":');
    expect(JSON.stringify(rows)).not.toContain("/Users/secret");
  });

  it("toggleFavorite：参数透传（userId/workspaceId/relPath），返回收藏态", async () => {
    const stub = sessionsStub();
    const face = createArtifactFace(stub);
    await expect(face.toggleFavorite(1, 3, "report.md")).resolves.toBe(true);
    expect(stub.toggleArtifactFavorite).toHaveBeenCalledWith(1, 3, "report.md");
  });

  it("read text：kind/content 直传", async () => {
    const face = createArtifactFace(sessionsStub());
    await expect(face.read(1, 3, "report.md")).resolves.toEqual({
      kind: "text",
      content: "正文",
    });
  });

  it("read image：dataUrl 拆解为 mime + dataBase64", async () => {
    const face = createArtifactFace(
      sessionsStub({
        readWorkspaceFileById: vi.fn(async () => ({
          kind: "image",
          dataUrl: "data:image/png;base64,aGVsbG8=",
        })),
      }) as Partial<ServerFaceArtifact>,
    );
    await expect(face.read(1, 3, "shot.png")).resolves.toEqual({
      kind: "image",
      mime: "image/png",
      dataBase64: "aGVsbG8=",
    });
  });

  it("read webview 类：拒 ARTIFACT_PREVIEW_UNSUPPORTED（移动端提示桌面端预览）", async () => {
    const face = createArtifactFace(
      sessionsStub({
        readWorkspaceFileById: vi.fn(async () => ({
          kind: "webview",
          absPath: "/tmp/x.html",
          size: 10,
        })),
      }) as Partial<ServerFaceArtifact>,
    );
    await expect(face.read(1, 3, "page.html")).rejects.toMatchObject({
      code: "ARTIFACT_PREVIEW_UNSUPPORTED",
    });
  });

  it("read dataUrl 坏形：拒 ARTIFACT_NOT_FOUND（不透内部细节）", async () => {
    const face = createArtifactFace(
      sessionsStub({
        readWorkspaceFileById: vi.fn(async () => ({
          kind: "image",
          dataUrl: "not-a-data-url",
        })),
      }) as Partial<ServerFaceArtifact>,
    );
    await expect(face.read(1, 3, "bad.png")).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  });
});
