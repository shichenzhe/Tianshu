import { describe, expect, it, vi } from "vitest";
import {
  fetchWithRedirects,
  makeWebTools,
  type WebFetcher,
} from "../../electron/domains/ai/agent/web-tools";
import type { ToolContext } from "../../electron/domains/ai/agent/file-tools";

function fakeFetcher(
  over?: Partial<Awaited<ReturnType<WebFetcher>>>,
): WebFetcher & {
  calls: string[];
} {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () =>
        "<html><head><title>示例</title><style>a{}</style></head><body><h1>标题</h1><script>bad()</script><p>正文 内容</p></body></html>",
      ...over,
    };
  };
  return Object.assign(f, { calls });
}

function ctx(emitPanel?: ToolContext["emitPanel"]): ToolContext {
  return { workspacePath: "/tmp", sessionId: 1, emitPanel };
}

/** 按路由表响应的 fake（重定向测试用）：location 头单独表达 */
function redirectFetcher(
  routes: Record<string, { status: number; location?: string; body?: string }>,
): WebFetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error(`no route: ${url}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location"
            ? (r.location ?? null)
            : "text/html; charset=utf-8",
      },
      text: async () => r.body ?? "<html><body>final</body></html>",
    };
  };
  return Object.assign(f, { calls });
}

/** 照 defaultFetcher 的接线把 fake 包上逐跳校验 */
function withRedirects(f: WebFetcher): WebFetcher {
  return (url, opts) => fetchWithRedirects(f, url, opts);
}

describe("fetch", () => {
  it("提取文本：剥 script/style 与标签、压缩空白、附 url 与标题", async () => {
    const tools = makeWebTools(fakeFetcher());
    const out = await tools[0].execute(ctx(), { url: "https://example.com/a" });
    expect(out).toContain("https://example.com/a");
    expect(out).toContain("示例");
    expect(out).toContain("标题");
    expect(out).toContain("正文 内容");
    expect(out).not.toContain("bad()");
    expect(out).not.toContain("a{}");
    expect(out).not.toContain("<p>");
  });

  it("32KB 截断：超长正文截断并附截断标记", async () => {
    const long = "x".repeat(64 * 1024);
    const tools = makeWebTools(fakeFetcher({ text: async () => long }));
    const out = await tools[0].execute(ctx(), {
      url: "https://example.com/big",
    });
    expect(out.length).toBeLessThan(40 * 1024);
    expect(out).toContain("已截断");
  });

  it("非 html/plain Content-Type 拒绝（json/二进制）", async () => {
    const tools = makeWebTools(
      fakeFetcher({ headers: { get: () => "application/json" } }),
    );
    const out = await tools[0].execute(ctx(), {
      url: "https://example.com/api",
    });
    expect(out).toMatch(/不支持|Content-Type/i);
  });

  it("SSRF 云 metadata 域拒绝", async () => {
    const fetcher = fakeFetcher();
    const tools = makeWebTools(fetcher);
    const out = await tools[0].execute(ctx(), {
      url: "http://169.254.169.254/latest",
    });
    expect(out).toMatch(/内网|SSRF|禁止/i);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("仅 http/https 放行（file:// 拒绝）", async () => {
    const tools = makeWebTools(fakeFetcher());
    const out = await tools[0].execute(ctx(), { url: "file:///etc/passwd" });
    expect(out).toMatch(/http/i);
  });

  it("HTTP 状态非 2xx 报状态码；网络错误回喂不抛", async () => {
    const tools = makeWebTools(fakeFetcher({ ok: false, status: 404 }));
    const out = await tools[0].execute(ctx(), {
      url: "https://example.com/none",
    });
    expect(out).toContain("404");
    const boom = makeWebTools(async () => {
      throw new Error("timeout");
    });
    const out2 = await boom[0].execute(ctx(), { url: "https://example.com/x" });
    expect(out2).toMatch(/失败|错误/);
  });

  it("响应体 1MB 上限：text() 返回超限内容时拒绝", async () => {
    const huge = "y".repeat(1024 * 1024 + 1);
    const tools = makeWebTools(fakeFetcher({ text: async () => huge }));
    const out = await tools[0].execute(ctx(), {
      url: "https://example.com/huge",
    });
    expect(out).toMatch(/过大|1MB/i);
  });

  it("重定向到云 metadata 被拒（第二跳不发生）", async () => {
    const fetcher = redirectFetcher({
      "https://example.com/redirect": {
        status: 302,
        location: "http://169.254.169.254/latest",
      },
    });
    const tools = makeWebTools(withRedirects(fetcher));
    const out = await tools[0].execute(ctx(), {
      url: "https://example.com/redirect",
    });
    expect(out).toMatch(/内网|SSRF|禁止/i);
    expect(fetcher.calls).toEqual(["https://example.com/redirect"]);
  });

  it("正常重定向可达：相对 Location 以当前跳解析，最终内容返回", async () => {
    const fetcher = redirectFetcher({
      "https://example.com/r1": { status: 302, location: "/final" },
      "https://example.com/final": {
        status: 200,
        body: "<html><head><title>到达</title></head><body>终点页</body></html>",
      },
    });
    const tools = makeWebTools(withRedirects(fetcher));
    const out = await tools[0].execute(ctx(), {
      url: "https://example.com/r1",
    });
    expect(fetcher.calls).toEqual([
      "https://example.com/r1",
      "https://example.com/final",
    ]);
    expect(out).toContain("URL: https://example.com/r1");
    expect(out).toContain("到达");
    expect(out).toContain("终点页");
  });

  it("重定向超 5 跳失败（第 6 跳不再请求）", async () => {
    const routes: Record<string, { status: number; location: string }> = {};
    for (let i = 0; i < 8; i++) {
      routes[`https://example.com/loop/${i}`] = {
        status: 302,
        location: `/loop/${i + 1}`,
      };
    }
    const fetcher = redirectFetcher(routes);
    const tools = makeWebTools(withRedirects(fetcher));
    const out = await tools[0].execute(ctx(), {
      url: "https://example.com/loop/0",
    });
    expect(out).toMatch(/超限|失败/);
    expect(fetcher.calls).toHaveLength(5);
  });
});

describe("browse", () => {
  it("emitPanel 推送并返回成功文案", async () => {
    const emitPanel = vi.fn();
    const tools = makeWebTools(fakeFetcher());
    const out = await tools[1].execute(
      ctx(emitPanel as ToolContext["emitPanel"]),
      { url: "https://example.com/doc" },
    );
    expect(emitPanel).toHaveBeenCalledWith("detailPanel:openBrowser", {
      url: "https://example.com/doc",
    });
    expect(out).toContain("https://example.com/doc");
  });

  it("emitPanel 缺省返回无人值守文案（不调 fetch）", async () => {
    const fetcher = fakeFetcher();
    const tools = makeWebTools(fetcher);
    const out = await tools[1].execute(ctx(), { url: "https://example.com" });
    expect(out).toMatch(/无交互面板|不支持 browse/);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("非法 url 同样校验拒绝", async () => {
    const emitPanel = vi.fn();
    const tools = makeWebTools(fakeFetcher());
    const out = await tools[1].execute(
      ctx(emitPanel as ToolContext["emitPanel"]),
      { url: "javascript:alert(1)" },
    );
    expect(emitPanel).not.toHaveBeenCalled();
    expect(out).toMatch(/http/i);
  });
});
