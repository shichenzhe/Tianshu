import { describe, expect, it, vi } from "vitest";

import {
  SkillHubClient,
  shuffleTop,
} from "../../electron/domains/ai/skill/skillhub-client";

// Key 不依赖 env/真实 Constants:注入假 Key 断言鉴权头
vi.mock("../../electron/Constants", () => ({
  Constants: { SKILLHUB_API_KEY: "test-key" },
}));

/** 构造 fake fetch:按调用序返回 Response,记录请求 URL 与 init */
function fakeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("SkillHubClient", () => {
  it("信封接口(/api/skills)解包 data", async () => {
    const { fn } = fakeFetch([
      json({
        code: 0,
        message: "ok",
        data: { total: 1, skills: [{ slug: "a" }] },
      }),
    ]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    const page = await client.listSkills({ keyword: "文档" });
    expect(page).toEqual({ total: 1, skills: [{ slug: "a" }] });
  });

  it("裸对象接口(/api/v1/categories)直接返回", async () => {
    const { fn } = fakeFetch([
      json({ items: [{ key: "office-efficiency" }], count: 1 }),
    ]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    expect(await client.listCategories()).toEqual([
      { key: "office-efficiency" },
    ]);
  });

  it("请求头带 X-API-Key 与 X-Client-User-Id;query 正确序列化", async () => {
    const { fn, calls } = fakeFetch([
      json({ code: 0, data: { total: 0, skills: [] } }),
    ]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    await client.listSkills({ keyword: "a b", category: "dev", pageSize: 24 });
    const { url, init } = calls[0]!;
    expect(url).toContain("keyword=a%20b&category=dev&pageSize=24");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("test-key");
    expect(headers["X-Client-User-Id"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("HTTP 错误抛 {error} 文案", async () => {
    const { fn } = fakeFetch([json({ error: "skill not found" }, 404)]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    await expect(client.listTop()).rejects.toThrow("skill not found");
  });

  it("信封非 0 code 抛 message", async () => {
    const { fn } = fakeFetch([
      json({ code: 500, message: "boom", data: null }),
    ]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    await expect(client.listSkills({})).rejects.toThrow("boom");
  });

  it("429/网络错误退避重试,第三次成功", async () => {
    vi.useFakeTimers();
    try {
      const { fn } = fakeFetch([
        json({ error: "rate" }, 429),
        new Error("ECONNRESET"),
        json({ code: 0, data: { total: 0, skills: [] } }),
      ]);
      const client = new SkillHubClient(fn as unknown as typeof fetch);
      const promise = client.listSkills({});
      const settled = Promise.race([
        promise,
        vi.advanceTimersByTimeAsync(4000),
      ]);
      await expect(settled).resolves.toEqual({ total: 0, skills: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("重试耗尽抛最后一错", async () => {
    vi.useFakeTimers();
    try {
      const { fn } = fakeFetch([
        new Error("down1"),
        new Error("down2"),
        new Error("down3"),
      ]);
      const client = new SkillHubClient(fn as unknown as typeof fetch);
      const promise = client.listTop();
      const settled = Promise.race([
        promise.catch((e: Error) => {
          throw e;
        }),
        vi.advanceTimersByTimeAsync(4000),
      ]);
      await expect(settled).rejects.toThrow("down");
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SkillHubClient.getDetail / downloadZip(P-C Task 3)", () => {
  it("getDetail:裸对象接口直接返回,URL 指向详情路径", async () => {
    const detail = {
      skill: { slug: "doc-writer", version: "1.0.0" },
      latestVersion: { version: "1.1.0" },
    };
    const { fn, calls } = fakeFetch([json(detail)]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    await expect(client.getDetail("doc-writer")).resolves.toEqual(detail);
    expect(calls[0]!.url).toContain("/api/v1/skills/doc-writer");
  });

  it("downloadZip:200 返回 zip 二进制,URL 含下载查询串且带鉴权头", async () => {
    const bytes = [0x50, 0x4b, 0x05, 0x06]; // PK\x05\x06:空 zip EOCD
    const { fn, calls } = fakeFetch([
      new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-type": "application/zip" },
      }),
    ]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    const buf = await client.downloadZip("hello-world");
    expect(new Uint8Array(buf)).toEqual(new Uint8Array(bytes));
    expect(calls[0]!.url).toContain("/api/v1/download?slug=hello-world");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("test-key");
    expect(headers["X-Client-User-Id"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("downloadZip:非 2xx 抛 {error} 文案", async () => {
    const { fn } = fakeFetch([json({ error: "skill not found" }, 404)]);
    const client = new SkillHubClient(fn as unknown as typeof fetch);
    await expect(client.downloadZip("gone")).rejects.toThrow("skill not found");
  });

  it("downloadZip:5xx 按同策略退避重试,第二次成功", async () => {
    vi.useFakeTimers();
    try {
      const { fn } = fakeFetch([
        new Response(new Uint8Array([1]), { status: 502 }),
        new Response(new Uint8Array([9]), { status: 200 }),
      ]);
      const client = new SkillHubClient(fn as unknown as typeof fetch);
      const promise = client.downloadZip("retry-me");
      const settled = Promise.race([
        promise,
        vi.advanceTimersByTimeAsync(4000),
      ]);
      const buf = await settled;
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([9]));
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shuffleTop 洗牌", () => {
  it("集合不变、顺序受随机源影响", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    // Fisher-Yates 从后往前:j = floor(random() * (i + 1))
    // 恒 0 → 每轮 j=0,原首元素一路换到尾部 → 整体左移一位
    expect(shuffleTop(input, () => 0)).toEqual([2, 3, 4, 5, 6, 7, 8, 1]);
    // 恒 0.99 → 每轮 j=i(自交换)→ 保持原序
    expect(shuffleTop(input, () => 0.99)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const shuffled = shuffleTop(input);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
  });

  it("不修改原数组", () => {
    const input = [1, 2, 3];
    shuffleTop(input, () => 0.5);
    expect(input).toEqual([1, 2, 3]);
  });
});
