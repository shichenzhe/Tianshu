// @vitest-environment jsdom
// new-task 附件链主机路由（挂账收口批 2026-11-10）：本地 pill 维持
// readExternalFile 直读（零行为变化）；远程资料库 pill（带 id）文本走
// 远端 read 注入内容、图片走 readImage→base64 随行 image part（FA-T3 通道）。
import { describe, expect, it, vi, beforeEach } from "vitest";

const attach = vi.hoisted(() => ({ readExternalFile: vi.fn() }));
vi.mock("../../src-react/domains/ai/new-task/lib/attach", () => attach);

const remoteCatalog = vi.hoisted(() => ({
  remoteLibraryText: vi.fn(),
  remoteLibraryImage: vi.fn(),
}));
vi.mock("../../src-react/domains/ai/data-source/remote-catalog", () => ({
  ...remoteCatalog,
}));
// host-route 不 mock：remoteConnId 真实现读 host.store（setState 驱动）

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(), on: () => () => {} }));

import {
  useHostStore,
  LOCAL_HOST_CAPS,
} from "../../src-react/domains/ai/data-source/host.store";
import { readPendingRef } from "../../src-react/domains/ai/new-task/lib/dispatch";

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});

describe("new-task 附件链本地主机（零行为变化）", () => {
  it("localFile 文本 pill：readExternalFile 直读注入", async () => {
    attach.readExternalFile.mockResolvedValue({ content: "本地内容" });
    const file = await readPendingRef({
      label: "a.md",
      ref: "/tmp/a.md",
      kind: "localFile",
    });
    expect(file).toEqual({
      path: "/tmp/a.md",
      content: "本地内容",
      kind: "localFile",
    });
    expect(remoteCatalog.remoteLibraryText).not.toHaveBeenCalled();
  });

  it("localFile 图片 pill：分流 image part 不读内容", async () => {
    const file = await readPendingRef({
      label: "x.png",
      ref: "/tmp/x.png",
      kind: "localFile",
    });
    expect(file).toEqual({
      path: "/tmp/x.png",
      content: "",
      kind: "localFile",
      image: true,
    });
  });
});

describe("new-task 远程资料库 pill（按 id 远端读取）", () => {
  beforeEach(() => {
    useHostStore.setState({
      activeHost: { kind: "remote", connId: "conn-x" },
      caps: LOCAL_HOST_CAPS,
    });
  });

  it("文本：远端 read 按 id 读内容注入（label 为路径显示）", async () => {
    remoteCatalog.remoteLibraryText.mockResolvedValue("远端资料内容");
    const file = await readPendingRef({
      label: "远程笔记.md",
      ref: "远程笔记.md",
      kind: "localFile",
      id: 2,
    });
    expect(remoteCatalog.remoteLibraryText).toHaveBeenCalledWith(2, "conn-x");
    expect(file).toEqual({
      path: "远程笔记.md",
      content: "远端资料内容",
      kind: "localFile",
    });
    expect(attach.readExternalFile).not.toHaveBeenCalled();
  });

  it("图片：readImage→base64 随行 image part（FA-T3 通道）", async () => {
    remoteCatalog.remoteLibraryImage.mockResolvedValue(
      "data:image/png;base64,aGk=",
    );
    const file = await readPendingRef({
      label: "远图.png",
      ref: "远图.png",
      kind: "localFile",
      id: 5,
    });
    expect(remoteCatalog.remoteLibraryImage).toHaveBeenCalledWith(5, "conn-x");
    expect(file).toMatchObject({
      image: true,
      base64: "aGk=",
      path: "远图.png",
    });
  });

  it("无 id 的本地路径 pill 远程主机下保持本地链（选择器附件语义）", async () => {
    attach.readExternalFile.mockResolvedValue({ content: "本地路径内容" });
    const file = await readPendingRef({
      label: "b.md",
      ref: "/tmp/b.md",
      kind: "localFile",
    });
    expect(file.content).toBe("本地路径内容");
  });
});
