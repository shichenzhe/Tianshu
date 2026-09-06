// tests/ai/automation-resolve-attachments.test.ts
import { describe, expect, it, vi } from "vitest";

// 模块顶层 import electron(app.getPath),node 环境必 mock(先例:
// automation-runner.test.ts / automation-repo.test.ts 三件套)。
// resolve-attachments 静态 import automation-runner(replaceVariables),
// 其传递依赖 prisma-client 顶层即开库(app.getAppPath)/Log 建文件流,
// 照 automation-runner.test.ts 先例一并 mock(断言不涉及,零改动)
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp") },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {},
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/chat/chat.service", () => ({
  runChatStream: vi.fn(),
  normalizeWorkspacePath: (p: string) => p,
}));
vi.mock("../../electron/domains/ai/provider/provider-factory", () => ({
  createLanguageModel: () => ({}),
}));

import {
  composeInjectedPrompt,
  resolveAttachments,
  type ResolveDeps,
} from "../../electron/domains/ai/automation/resolve-attachments";

describe("composeInjectedPrompt(与 ChatView.handleSend 同构)", () => {
  it("文件+技能块前缀拼接,块间空行,后接正文", () => {
    const out = composeInjectedPrompt("总结今天的变化", [
      { kind: "file", path: "docs/daily.md", content: "AAA" },
      { kind: "skill", path: "日报技能", content: "BBB" },
    ]);
    expect(out).toBe(
      "[引用文件 docs/daily.md]\nAAA\n\n[引用技能 日报技能]\nBBB\n\n总结今天的变化",
    );
  });
  it("无引用块原样返回", () => {
    expect(composeInjectedPrompt("正文", [])).toBe("正文");
  });
});

// 技能名用 ASCII:inline-tokens 的 TOKEN_RE 为 ⚡[\w-]+(\w 不含 CJK),
// 中文名不构成 token——与既有 inline-tokens.test.ts 用例口径一致,
// 此处以现有解析器为准适配(brief 原文为中文技能名)
const fileDeps = (files: Record<string, string>): ResolveDeps => ({
  readWorkspaceFile: async (abs: string) => ({
    kind: "text" as const,
    content: files[abs.split("/").pop()!],
    size: 3,
  }),
  loadSkills: () =>
    [
      {
        name: "daily-report",
        description: "d",
        dir: "/skills/daily",
      },
    ] as never,
  readSkillFile: async () => "SKILL CONTENT",
  skillsRootDir: () => "/tmp",
});

describe("resolveAttachments", () => {
  it("文件+技能引用:读取内容,聚焦技能,变量替换仅作用于正文", async () => {
    const result = await resolveAttachments(
      "@daily.md 汇总 ⚡daily-report 今天 {{date}}",
      "/ws",
      new Date(2026, 8, 7, 9, 0),
      fileDeps({ "daily.md": "FILE" }),
    );
    expect(result).toEqual({
      injected:
        "[引用文件 daily.md]\nFILE\n\n[引用技能 daily-report]\nSKILL CONTENT\n\n汇总 今天 2026-09-07",
      skills: [expect.objectContaining({ name: "daily-report" })],
      referenced: true,
    });
  });
  it("无引用:正文变量替换,skills 为全量注入清单,referenced=false", async () => {
    const result = await resolveAttachments(
      "今天 {{time}}",
      undefined,
      new Date(2026, 8, 7, 9, 5),
      fileDeps({}),
    );
    expect(result).toEqual({
      injected: "今天 09:05",
      skills: [expect.objectContaining({ name: "daily-report" })],
      referenced: false,
    });
  });
  it("文件缺失 → { error: 'attachment_missing: daily.md' }", async () => {
    const result = await resolveAttachments(
      "@daily.md 汇总",
      "/ws",
      new Date(),
      fileDeps({}),
    );
    expect(result).toEqual({ error: "attachment_missing: daily.md" });
  });
  it("技能不存在 → error 含技能名", async () => {
    const result = await resolveAttachments(
      "⚡nosuch 汇总",
      undefined,
      new Date(),
      fileDeps({}),
    );
    expect(result).toEqual({ error: "attachment_missing: skill nosuch" });
  });
  it("图片文件 → error(unsupported)", async () => {
    const deps: ResolveDeps = {
      ...fileDeps({}),
      readWorkspaceFile: async () => ({
        kind: "image" as const,
        dataUrl: "data:image/png;base64,x",
        size: 10,
      }),
    };
    const result = await resolveAttachments(
      "@pic.png 汇总",
      "/ws",
      new Date(),
      deps,
    );
    expect(result).toEqual({ error: "attachment_missing: pic.png" });
  });
});
