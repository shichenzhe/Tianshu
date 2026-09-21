/**
 * 外部文件读授权门单测：库内直通 / 未授权拒绝 / 登记放行 / TTL 过期 /
 * LRU 淘汰。资料库根与 library.repo 同名子目录（library）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/userData") },
}));

import {
  grantExternalPath,
  grantExternalPaths,
  isExternalReadAllowed,
  libraryRootOf,
  resetExternalGrants,
} from "../../electron/domains/ai/chat/external-file-gate";

const LIB = "/userData/library";

beforeEach(() => {
  resetExternalGrants();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isExternalReadAllowed", () => {
  it("资料库根内路径直通（入库即授权）", () => {
    expect(isExternalReadAllowed(`${LIB}/3/report.pdf`)).toBe(true);
    expect(isExternalReadAllowed(`${LIB}/3/../4/x`)).toBe(true); // resolve 归一
  });
  it("库外未授权路径拒绝（含前缀相似的兄弟目录）", () => {
    expect(isExternalReadAllowed("/etc/passwd")).toBe(false);
    expect(isExternalReadAllowed("/Users/x/.ssh/id_rsa")).toBe(false);
    expect(isExternalReadAllowed("/userData/libraryX/secret")).toBe(false);
    expect(isExternalReadAllowed("/userData/library-backup/x")).toBe(false);
  });
  it("选择器/拖拽登记后放行", () => {
    grantExternalPath("/Users/x/notes.md");
    expect(isExternalReadAllowed("/Users/x/notes.md")).toBe(true);
    grantExternalPaths(["/a.txt", "/b.txt"]);
    expect(isExternalReadAllowed("/a.txt")).toBe(true);
    expect(isExternalReadAllowed("/b.txt")).toBe(true);
  });
  it("空串登记幂等且不放行任何路径", () => {
    grantExternalPath("");
    expect(isExternalReadAllowed("")).toBe(false);
    expect(isExternalReadAllowed("/etc/passwd")).toBe(false);
  });
  it("授权 30 分钟后过期失效", () => {
    grantExternalPath("/Users/x/notes.md");
    expect(isExternalReadAllowed("/Users/x/notes.md")).toBe(true);
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    expect(isExternalReadAllowed("/Users/x/notes.md")).toBe(false);
  });
  it("超 200 条淘汰最旧（LRU）", () => {
    grantExternalPath("/oldest.txt");
    for (let i = 0; i < 200; i++) {
      grantExternalPath(`/f${i}.txt`);
    }
    expect(isExternalReadAllowed("/oldest.txt")).toBe(false);
    expect(isExternalReadAllowed("/f199.txt")).toBe(true);
  });
  it("重复授权刷新触碰序（不被后续批次淘汰）", () => {
    grantExternalPath("/touched.txt");
    for (let i = 0; i < 100; i++) {
      grantExternalPath(`/a${i}.txt`);
    }
    grantExternalPath("/touched.txt"); // 重触
    for (let i = 0; i < 100; i++) {
      grantExternalPath(`/b${i}.txt`);
    }
    expect(isExternalReadAllowed("/touched.txt")).toBe(true);
  });
  it("libraryRootOf 与 library.repo 存储根同名子目录", () => {
    expect(libraryRootOf()).toBe(LIB);
  });
});
