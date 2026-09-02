import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlaceholders } from "./replace.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "init-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("applyPlaceholders", () => {
  it("替换文件中的占位符", async () => {
    writeFileSync(join(dir, "package.json"), '{\n  "name": "{{APP_NAME}}"\n}\n');
    const changed = await applyPlaceholders(dir, { APP_NAME: "my-app" });
    expect(changed).toContain(join(dir, "package.json"));
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain('"my-app"');
  });

  it("幂等：对已替换过的值再次运行会覆盖为新值", async () => {
    writeFileSync(join(dir, "a.txt"), "{{APP_NAME}}");
    await applyPlaceholders(dir, { APP_NAME: "first-app" });
    const changed = await applyPlaceholders(dir, { APP_NAME: "second-app" });
    expect(changed).toContain(join(dir, "a.txt"));
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("second-app");
  });

  it("无占位符也无旧值的文件不被修改、不列入返回", async () => {
    writeFileSync(join(dir, "b.txt"), "hello");
    const changed = await applyPlaceholders(dir, { APP_NAME: "x" });
    expect(changed).not.toContain(join(dir, "b.txt"));
  });

  it("空值占位符（如未填更新源）替换为空字符串", async () => {
    writeFileSync(join(dir, "c.txt"), "url={{UPDATE_SERVER_URL}}");
    await applyPlaceholders(dir, { APP_NAME: "x", UPDATE_SERVER_URL: "" });
    expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("url=");
  });

  it("替换嵌套目录中的目标文件", async () => {
    const sub = join(dir, "electron");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "main.ts"), 'title: "{{APP_NAME}}"');
    const changed = await applyPlaceholders(dir, { APP_NAME: "x" });
    expect(changed).toContain(join(sub, "main.ts"));
  });
});
