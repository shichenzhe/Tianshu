/**
 * skill-archive 单测:zip 条目安全校验 / 技能根定位 / SKILL.md 元数据校验
 * 纯函数(仅 node:path + skill-loader),参照 skill-loader.test.ts 模式
 */
import { describe, expect, it } from "vitest";
import {
  locateSkillRoot,
  validateArchiveEntries,
  validateSkillMd,
} from "../../electron/domains/ai/skill/skill-archive";

describe("validateArchiveEntries 条目安全校验", () => {
  it("合法清单通过", () => {
    expect(
      validateArchiveEntries(["SKILL.md", "assets/a.png", "scripts/run.py"]),
    ).toEqual({ ok: true });
  });

  it("zip-slip 路径 ../a 拒绝", () => {
    const res = validateArchiveEntries(["../a"]);
    expect(res).toEqual({
      ok: false,
      reason: expect.stringContaining("../a"),
    });
  });

  it("绝对路径 /etc/x 拒绝", () => {
    expect(validateArchiveEntries(["/etc/x"]).ok).toBe(false);
  });

  it("a/../../b 归一化后越界拒绝", () => {
    expect(validateArchiveEntries(["a/../../b"]).ok).toBe(false);
  });

  it("Windows 反斜杠分隔的 ../ 同样拒绝", () => {
    expect(validateArchiveEntries(["..\\a"]).ok).toBe(false);
  });

  it("可执行扩展 .sh/.exe/.dll/.bat/.command/.app 全部拒绝", () => {
    for (const ext of [".sh", ".exe", ".dll", ".bat", ".command", ".app"]) {
      expect(validateArchiveEntries([`tool${ext}`]).ok, ext).toBe(false);
    }
  });

  it("扩展判定小写归一(.EXE 亦拒);条目无目录语义,dir.exe/ 同按扩展拒", () => {
    expect(validateArchiveEntries(["x.EXE"]).ok).toBe(false);
    expect(validateArchiveEntries(["dir.exe/"]).ok).toBe(false);
  });

  it("条目数 501 超默认上限 500 拒绝", () => {
    const entries = Array.from({ length: 501 }, (_, i) => `f${i}.txt`);
    const res = validateArchiveEntries(entries);
    expect(res).toEqual({
      ok: false,
      reason: expect.stringContaining("500"),
    });
  });

  it("opts.maxCount 可收紧上限", () => {
    expect(validateArchiveEntries(["a.txt", "b.txt"], { maxCount: 2 }).ok).toBe(
      true,
    );
    expect(
      validateArchiveEntries(["a.txt", "b.txt", "c.txt"], { maxCount: 2 }).ok,
    ).toBe(false);
  });

  it("空压缩包拒绝", () => {
    expect(validateArchiveEntries([]).ok).toBe(false);
  });
});

describe("locateSkillRoot 技能根定位", () => {
  it("根 SKILL.md → root 为空串", () => {
    expect(locateSkillRoot(["SKILL.md", "assets/a.png"])).toEqual({
      ok: true,
      root: "",
    });
  });

  it("唯一一级子目录含 SKILL.md → root 为该子目录", () => {
    expect(locateSkillRoot(["pkg/SKILL.md", "pkg/a.txt"])).toEqual({
      ok: true,
      root: "pkg",
    });
  });

  it("无 SKILL.md → 错误", () => {
    expect(locateSkillRoot(["README.md", "LICENSE"]).ok).toBe(false);
  });

  it("两个子目录都有 SKILL.md → 按多顶层目录拒绝", () => {
    const res = locateSkillRoot(["a/SKILL.md", "b/SKILL.md"]);
    expect(res).toEqual({
      ok: false,
      reason: expect.stringContaining("多个顶层目录"),
    });
  });

  it("多顶层目录仅其一含 SKILL.md → 仍按多顶层目录拒绝", () => {
    expect(locateSkillRoot(["a/SKILL.md", "b/other.txt"]).ok).toBe(false);
  });

  it("唯一子目录但其中无 SKILL.md → 错误", () => {
    const res = locateSkillRoot(["pkg/README.md"]);
    expect(res).toEqual({
      ok: false,
      reason: expect.stringContaining("SKILL.md"),
    });
  });
});

describe("validateSkillMd 元数据校验", () => {
  it("合法 frontmatter 返回 name 与 description", () => {
    expect(
      validateSkillMd("---\nname: demo\ndescription: 示例\n---\n正文"),
    ).toEqual({ ok: true, name: "demo", description: "示例" });
  });

  it("缺 name 拒绝", () => {
    const res = validateSkillMd("---\ndescription: 只有描述\n---\n正文");
    expect(res).toEqual({
      ok: false,
      reason: expect.stringContaining("name"),
    });
  });

  it("缺 description 拒绝", () => {
    expect(validateSkillMd("---\nname: demo\n---\n正文").ok).toBe(false);
  });

  it("无 frontmatter 拒绝", () => {
    expect(validateSkillMd("普通正文没有 frontmatter").ok).toBe(false);
  });
});
