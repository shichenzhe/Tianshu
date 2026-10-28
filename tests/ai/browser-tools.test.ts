import { describe, expect, it, vi } from "vitest";
import { makeBrowserTools } from "../../electron/domains/ai/agent/browser-tools";
import type { ToolContext } from "../../electron/domains/ai/agent/file-tools";

function fakeControl() {
  const exec = vi.fn(async (code: string) => {
    if (code.includes("SNAPSHOT_MARKER")) {
      return JSON.stringify({
        title: "示例页",
        url: "https://example.com/",
        items: [{ idx: 3, tag: "a", text: "关于我们", href: "/about" }],
        body: "页面正文摘要",
      });
    }
    return "OK";
  });
  const loadURL = vi.fn(async () => {});
  return { exec, loadURL, control: { executeJavaScript: exec, loadURL } };
}

const ctx = { workspacePath: "/tmp", sessionId: 7 } as ToolContext;

describe("browser_snapshot", () => {
  it("无绑定返回引导文案；有绑定返回快照结构", async () => {
    const tools = makeBrowserTools(() => null);
    const out = await tools[0].execute(ctx, {});
    expect(out).toMatch(/open_browser/);
    const { exec, control } = fakeControl();
    const tools2 = makeBrowserTools(() => control);
    const out2 = await tools2[0].execute(ctx, {});
    expect(out2).toContain("示例页");
    expect(out2).toContain("关于我们");
    expect(out2).toContain("idx: 3");
    expect(exec.mock.calls[0][0]).toContain("SNAPSHOT_MARKER");
  });

  it("脚本失败回 fail 不抛", async () => {
    const tools = makeBrowserTools(() => ({
      executeJavaScript: async () => {
        throw new Error("page gone");
      },
      loadURL: async () => {},
    }));
    const out = await tools[0].execute(ctx, {});
    expect(out).toMatch(/失败|错误/);
  });

  it("空 items 渲染「（无）」（无元素可交互页）", async () => {
    const { exec, control } = fakeControl();
    exec.mockResolvedValue(
      JSON.stringify({
        title: "空页",
        url: "https://x/",
        items: [],
        body: "b",
      }),
    );
    const tools = makeBrowserTools(() => control);
    const out = await tools[0].execute(ctx, {});
    expect(out).toContain("（无）");
  });

  it("快照返回非字符串（undefined）走「页面快照返回异常」分支", async () => {
    const { exec, control } = fakeControl();
    exec.mockResolvedValue(undefined);
    const tools = makeBrowserTools(() => control);
    const out = await tools[0].execute(ctx, {});
    expect(out).toContain("页面快照返回异常");
  });
});

describe("browser_click / browser_type", () => {
  it("write 工具按序号定位；脚本经 JSON.stringify 注入序号", async () => {
    const { exec, control } = fakeControl();
    const tools = makeBrowserTools(() => control);
    const click = tools.find((t) => t.name === "browser_click")!;
    expect(click.kind).toBe("write");
    const out = await click.execute(ctx, { idx: 3 });
    expect(out).toBe("OK");
    expect(exec.mock.calls[0][0]).toContain('data-ts-ai="3"');
  });

  it("type 携带 text 注入；NOT_FOUND 提示重新快照", async () => {
    const { exec, control } = fakeControl();
    exec.mockResolvedValue("NOT_FOUND");
    const tools = makeBrowserTools(() => control);
    const type = tools.find((t) => t.name === "browser_type")!;
    expect(type.kind).toBe("write");
    const out = await type.execute(ctx, { idx: 5, text: 'a"b\\c' });
    expect(out).toMatch(/重新|snapshot|快照/);
    expect(exec.mock.calls[0][0]).toContain('"5"');
    expect(exec.mock.calls[0][0]).toContain(JSON.stringify('a"b\\c'));
  });

  it("非整数 idx 抛错走外层 fail（selectorExpr 守卫：zod 缺席路径也拦）", async () => {
    const { exec, control } = fakeControl();
    const tools = makeBrowserTools(() => control);
    const click = tools.find((t) => t.name === "browser_click")!;
    const out = await click.execute(ctx, { idx: 1.5 });
    expect(out).toMatch(/序号必须为整数/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("click NOT_FOUND 提示重新快照", async () => {
    const { exec, control } = fakeControl();
    exec.mockResolvedValue("NOT_FOUND");
    const tools = makeBrowserTools(() => control);
    const click = tools.find((t) => t.name === "browser_click")!;
    const out = await click.execute(ctx, { idx: 9 });
    expect(out).toMatch(/重新|snapshot|快照/);
  });
});

describe("browser_navigate", () => {
  it("校验协议与 SSRF；合法 url 走 loadURL", async () => {
    const { loadURL, control } = fakeControl();
    const tools = makeBrowserTools(() => control);
    const nav = tools.find((t) => t.name === "browser_navigate")!;
    expect(nav.kind).toBe("read");
    const bad = await nav.execute(ctx, { url: "http://169.254.169.254/x" });
    expect(bad).toMatch(/内网|metadata/i);
    expect(loadURL).not.toHaveBeenCalled();
    const bad2 = await nav.execute(ctx, { url: "file:///etc" });
    expect(bad2).toMatch(/http/i);
    const ok = await nav.execute(ctx, { url: "https://example.com/" });
    expect(ok).toMatch(/https:\/\/example.com\//);
    expect(loadURL).toHaveBeenCalledWith("https://example.com/");
  });

  it("无效 URL（new URL 抛错路径）拒绝且不触达 loadURL", async () => {
    const { loadURL, control } = fakeControl();
    const tools = makeBrowserTools(() => control);
    const nav = tools.find((t) => t.name === "browser_navigate")!;
    const out = await nav.execute(ctx, { url: "not a url" });
    expect(out).toContain("无效 URL");
    expect(loadURL).not.toHaveBeenCalled();
  });
});
