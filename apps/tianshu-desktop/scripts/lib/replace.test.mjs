import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
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
    writeFileSync(
      join(dir, "package.json"),
      '{\n  "name": "{{APP_NAME}}"\n}\n',
    );
    const changed = await applyPlaceholders(dir, { APP_NAME: "my-app" });
    expect(changed).toContain(join(dir, "package.json"));
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain(
      '"my-app"',
    );
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

  it("处理无扩展名文件（如 LICENSE）", async () => {
    writeFileSync(join(dir, "LICENSE"), "Copyright (c) 2026 {{AUTHOR}}");
    const changed = await applyPlaceholders(dir, { AUTHOR: "Tester" });
    expect(changed).toContain(join(dir, "LICENSE"));
    expect(readFileSync(join(dir, "LICENSE"), "utf8")).toBe(
      "Copyright (c) 2026 Tester",
    );
  });

  it("忽略 scripts 目录（脚本内占位符字面量不被替换）", async () => {
    const sub = join(dir, "scripts");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "tool.mjs"), 'const t = "{{APP_NAME}}";');
    const changed = await applyPlaceholders(dir, { APP_NAME: "x" });
    expect(changed).not.toContain(join(sub, "tool.mjs"));
    expect(readFileSync(join(sub, "tool.mjs"), "utf8")).toContain(
      "{{APP_NAME}}",
    );
  });

  it("忽略 superpowers / .superpowers 目录（git 跟踪文档中的哨兵不被替换）", async () => {
    for (const name of ["superpowers", ".superpowers"]) {
      const sub = join(dir, name);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "x.ts"), 'key = "skh-your-api-key";\n');
    }
    const changed = await applyPlaceholders(dir, {
      SKILLHUB_API_KEY: "skh-real-abc",
    });
    for (const name of ["superpowers", ".superpowers"]) {
      const file = join(dir, name, "x.ts");
      expect(changed).not.toContain(file);
      expect(readFileSync(file, "utf8")).toBe('key = "skh-your-api-key";\n');
    }
  });

  it("字面量占位符（非 {{}} 模板）替换；重复 init 自然跳过", async () => {
    const file = join(dir, "Constants.ts");
    writeFileSync(file, 'key = "skh-your-api-key";\n');
    await applyPlaceholders(dir, { SKILLHUB_API_KEY: "skh-real-abc" });
    expect(readFileSync(file, "utf8")).toBe('key = "skh-real-abc";\n');
    // 敏感键在 shu-init.json 无明文记录，哨兵已消失 → 重复 init 不改文件
    const changed = await applyPlaceholders(dir, {
      SKILLHUB_API_KEY: "skh-real-xyz",
    });
    expect(changed).not.toContain(file);
    expect(readFileSync(file, "utf8")).toBe('key = "skh-real-abc";\n');
  });

  it("字面量占位符留空替换为空串（不带 Key）", async () => {
    const file = join(dir, "Constants.ts");
    writeFileSync(file, 'key = "skh-your-api-key";\n');
    await applyPlaceholders(dir, { SKILLHUB_API_KEY: "" });
    expect(readFileSync(file, "utf8")).toBe('key = "";\n');
  });

  it("敏感键不落 shu-init.json 明文（只记 <KEY>_SET 布尔）", async () => {
    const file = join(dir, "Constants.ts");
    writeFileSync(file, 'key = "skh-your-api-key";\n');
    await applyPlaceholders(dir, { SKILLHUB_API_KEY: "skh-real-secret" });
    // 目标文件正常写入真实值（真实值只进源码文件）
    expect(readFileSync(file, "utf8")).toBe('key = "skh-real-secret";\n');
    // init 记录文件永不包含明文 Key（该文件被 git 跟踪，防 add -A 泄漏）
    const raw = readFileSync(join(dir, "shu-init.json"), "utf8");
    expect(raw).not.toContain("skh-real-secret");
    expect(JSON.parse(raw)).toEqual({ SKILLHUB_API_KEY_SET: true });
  });

  it("敏感键留空记录 <KEY>_SET 为 false", async () => {
    const file = join(dir, "Constants.ts");
    writeFileSync(file, 'key = "skh-your-api-key";\n');
    await applyPlaceholders(dir, { SKILLHUB_API_KEY: "" });
    expect(
      JSON.parse(readFileSync(join(dir, "shu-init.json"), "utf8")),
    ).toEqual({ SKILLHUB_API_KEY_SET: false });
  });
});
