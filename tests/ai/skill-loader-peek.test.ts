/**
 * M13 性能回归：SKILL.md 扫描只读文件头部（frontmatter 位于头部）——
 * chat:send 热路径每次组装都对全部技能 readFileSync 整份正文（可达
 * 数十 KB/技能）只为解析 frontmatter 两行；超 4KB 未闭合的畸形块回退
 * 全读保解析正确（见性能审查报告 M13）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 包装转发 + 计数：peek 路径不触发 readFileSync，畸形回退时触发 1 次
const readCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped = ((...args: Parameters<typeof actual.readFileSync>) => {
    readCalls.count += 1;
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync: wrapped };
});

import { loadSkills } from "../../electron/domains/ai/agent/skill-loader";

const makeSkill = (root: string, dirName: string, raw: string) => {
  const skillDir = path.join(root, dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), raw);
};

beforeEach(() => {
  readCalls.count = 0;
});

describe("loadSkills 头部读取（M13）", () => {
  it("大正文技能不整读文件（frontmatter 头部闭合即止）", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-peek-"));
    try {
      makeSkill(
        root,
        "my-skill",
        "---\nname: my-skill\ndescription: 测试技能\n---\n" +
          "正文内容".repeat(20000),
      );
      const skills = loadSkills([{ dir: root, source: "user" }]);
      expect(skills[0]?.name).toBe("my-skill");
      expect(skills[0]?.description).toBe("测试技能");
      // peek 路径走 openSync/readSync，不应出现整读
      expect(readCalls.count).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("超 4KB 未闭合的畸形 frontmatter 回退全读仍解析", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-fallback-"));
    try {
      makeSkill(
        root,
        "big",
        "---\nname: big\ndescription: d\n" + "x".repeat(6000) + "\n---\n",
      );
      const skills = loadSkills([{ dir: root, source: "user" }]);
      expect(skills[0]?.name).toBe("big");
      expect(skills[0]?.description).toBe("d");
      expect(readCalls.count).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
