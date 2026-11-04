// backup-client 单测：fetch 替身注入（序列断言/重试/进度/starter 包装体判错）。
// import 相对路径形态照 tests/ai/backup/ustar-tar.test.ts（../../../electron）。
// 替身路由按含 id 真实 URL（/backup/:id/chunk 等）匹配，failOnce 键从 URL
// 解 id（chunk 请求体不带 id——协议里 id 在路径）。
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BackupClient } from "../../../electron/domains/backup/backup-client";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const json200 = (data: unknown) =>
  new Response(
    JSON.stringify({ code: "0", success: true, data, message: "ok" }),
    { status: 200 },
  );

function makeFetch(seqs: { calls: string[]; failOnce?: Map<string, number> }) {
  return (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    seqs.calls.push(`${init?.method ?? "POST"} ${url}`);
    if (url.endsWith("/backup/create")) {
      return json200({ id: "b1" });
    }
    if (url.endsWith("/chunk")) {
      const id = url.match(/\/backup\/([^/]+)\/chunk$/)?.[1] ?? "?";
      const key = `/backup/chunk:${id}:${body.seq}`;
      const fails = seqs.failOnce?.get(key) ?? 0;
      if (fails > 0) {
        seqs.failOnce?.set(key, fails - 1);
        return new Response(
          JSON.stringify({ code: "5000", success: false, message: "boom" }),
          { status: 500 },
        );
      }
      return json200({ received: body.seq });
    }
    if (url.endsWith("/commit")) {
      return json200({ fileSize: 5, sha256: body.sha256 ?? "x" });
    }
    if (url.endsWith("/backup/list")) {
      return json200({ backups: [{ id: "b1", status: "ready" }] });
    }
    if (url.includes("/download")) {
      return json200({
        data: Buffer.from("hello").toString("base64"),
        totalChunks: 1,
      });
    }
    if (url.includes("/delete")) return json200({ deleted: true });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("BackupClient", () => {
  it("uploadArchive：create→按序 chunk→commit，携带 Bearer token 与 base64 块", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bc-"));
    const payload = Buffer.from("hello");
    const archive = path.join(tmp, "a.tar.gz");
    writeFileSync(archive, payload);
    const calls: string[] = [];
    const client = new BackupClient({
      baseUrl: "http://x/api",
      token: "t1",
      fetchImpl: makeFetch({ calls }),
    });
    const progress: number[] = [];
    const r = await client.uploadArchive(
      archive,
      {
        appVersion: "1",
        schemaVersion: 1,
        fileSize: 5,
        sha256: sha256(payload),
        chunkCount: 1,
      },
      (u, t) => progress.push(u / t),
    );
    expect(r.sha256).toBe(sha256(payload));
    expect(calls[0]).toContain("http://x/api/backup/create");
    expect(calls.some((c) => c.includes("/backup/b1/chunk"))).toBe(true);
    expect(calls[calls.length - 1]).toContain("commit");
    expect(progress.at(-1)).toBe(1);
  });

  it("单块 500 重试≤3 后成功", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bc-"));
    const payload = Buffer.from("hello");
    const archive = path.join(tmp, "a.tar.gz");
    writeFileSync(archive, payload);
    const failOnce = new Map([["/backup/chunk:b1:0", 1]]);
    const client = new BackupClient({
      baseUrl: "http://x",
      fetchImpl: makeFetch({ calls: [], failOnce }),
    });
    const r = await client.uploadArchive(archive, {
      appVersion: "1",
      schemaVersion: 1,
      fileSize: 5,
      sha256: sha256(payload),
      chunkCount: 1,
    });
    expect(r.fileSize).toBe(5);
  });

  it("连续 3 次失败抛错（不无限重试）", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bc-"));
    const payload = Buffer.alloc(4 * 1024 * 1024 + 1, 1); // 2 块
    const archive = path.join(tmp, "a.tar.gz");
    writeFileSync(archive, payload);
    const failOnce = new Map([
      ["/backup/chunk:b1:0", 99],
      ["/backup/chunk:b1:1", 99],
    ]);
    const client = new BackupClient({
      baseUrl: "http://x",
      fetchImpl: makeFetch({ calls: [], failOnce }),
    });
    await expect(
      client.uploadArchive(archive, {
        appVersion: "1",
        schemaVersion: 1,
        fileSize: payload.length,
        sha256: sha256(payload),
        chunkCount: 2,
      }),
    ).rejects.toThrow();
  });

  it("downloadArchive：拼块落盘 + 全量 sha256 复核", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "bc-"));
    const dest = path.join(tmp, "down.tar.gz");
    const client = new BackupClient({
      baseUrl: "http://x",
      fetchImpl: makeFetch({ calls: [] }),
    });
    const r = await client.downloadArchive("b1", dest);
    expect(readFileSync(dest).toString()).toBe("hello");
    expect(r.sha256).toBe(sha256(Buffer.from("hello")));
  });

  it("starter 包装体判错：success=false 抛错（HTTP 200 也是错）", async () => {
    const json200Fail = () =>
      new Response(
        JSON.stringify({
          code: "4001",
          success: false,
          message: "无效的备份 token",
        }),
        { status: 200 },
      );
    const fail = (async () => json200Fail()) as unknown as typeof fetch;
    const client = new BackupClient({ baseUrl: "http://x", fetchImpl: fail });
    await expect(client.list()).rejects.toThrow(/备份 token|4001/);
  });
});
