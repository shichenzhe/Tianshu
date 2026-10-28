# 自动化任务输入区对齐会话输入框实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动化任务创建/编辑弹框的提示词区重构为会话输入框同款卡片（@文件/⚡技能引用、+菜单、只读权限胶囊、模型选择），runner 触发时同构注入引用内容并聚焦技能。

**Architecture:** 方案 B 并行新建——TaskPromptInput/TaskPlusMenu/TaskModelPicker 三个无会话态组件（不碰 ChatInput），复用 inline-tokens 纯函数与 PermissionCapsule/SkillSubMenu；后端新建 resolve-attachments 模块（触发时读最新内容、格式与 ChatView.handleSend 逐字同构），runner 接线。零 DB 迁移（prompt 存 token 原样）。

**Tech Stack:** React 19 / TypeScript 5.9 / Vitest / 既有 inline-tokens·workspace-files·skill-loader。

**Spec:** `docs/superpowers/specs/2026-09-07-automation-prompt-composer-design.md`

## Global Constraints

- 文案全走 `t()`，zh-CN 与 en-US 同任务内同步添加；禁止硬编码。
- 主题变量（无 bg-blue 等硬编码）；弹出层 `border-border/50 rounded-lg shadow-lg`。
- Prettier printWidth=80（eslint error 级，超行会被拦）；文件 kebab-case。
- 测试放 `tests/ai/automation-*.test.ts`；跑 `npx vitest run tests/ai/<file>`。
- 后端可 import 前端纯类型/纯函数（先例：chat.service 引 workspace.api；本计划 runner 引 inline-tokens）。
- 不实例化 SessionRepository/ChatService（构造注册 IPC 有副作用）。
- 引用注入格式与 `ChatView.handleSend`（src-react/domains/ai/chat/views/ChatView.tsx:229-238）逐字一致：`[引用文件 <path>]\n<内容>` / `[引用技能 <name>]\n<内容>`，块间 `\n\n`，整体后接 `\n\n` + 正文。
- 提交信息 conventional commit 中文（`feat(automation): ...`）。
- 每任务完成跑 `npm run typecheck`。

---

### Task 1: resolve-attachments（后端引用解析与注入纯模块）

**Files:**
- Create: `electron/domains/ai/automation/resolve-attachments.ts`
- Test: `tests/ai/automation-resolve-attachments.test.ts`

**Interfaces:**
- Consumes: `parseInlineTokens`（`src-react/domains/ai/chat/lib/inline-tokens.ts`，返回 `{ text; fileTokens; skillTokens; commands }`）、`replaceVariables`（automation-runner.ts）、`readWorkspaceFile`/`resolveFilePath`（`../chat/workspace-files`，`WorkspaceFileContent = { kind: "text"|"image"; content?: string; dataUrl?: string; size }`）、`loadSkills`（`../agent/skill-loader`，`SkillInfo` 含 `name/description/dir`）、`buildSystemPrompt` 的 skills 参数形状
- Produces（Task 2 消费，签名不得偏离）:
  - `export interface ResolveDeps { readWorkspaceFile: typeof readWorkspaceFile; loadSkills: typeof loadSkills; readSkillFile: (dir: string) => Promise<string>; skillsRootDir: () => string }`
  - `export const defaultResolveDeps: ResolveDeps`
  - `export function composeInjectedPrompt(userText: string, blocks: Array<{ kind: "file" | "skill"; path: string; content: string }>): string`（纯函数，与 ChatView.handleSend 逐字同构）
  - `export async function resolveAttachments(prompt: string, workspacePath: string | undefined, now: Date, deps: ResolveDeps = defaultResolveDeps): Promise<{ injected: string; skills: SkillInfo[]; referenced: boolean } | { error: string }>`

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/automation-resolve-attachments.test.ts
import { describe, expect, it, vi } from "vitest";

// 模块顶层 import electron(app.getPath),node 环境必 mock(先例:
// automation-runner.test.ts / automation-repo.test.ts 三件套)
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp") },
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

const fileDeps = (files: Record<string, string>): ResolveDeps => ({
  readWorkspaceFile: async (abs: string) => ({
    kind: "text" as const,
    content: files[abs.split("/").pop()!],
    size: 3,
  }),
  loadSkills: () => [
    {
      name: "日报技能",
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
      "@daily.md 汇总 ⚡日报技能 今天 {{date}}",
      "/ws",
      new Date(2026, 8, 7, 9, 0),
      fileDeps({ "daily.md": "FILE" }),
    );
    expect(result).toEqual({
      injected: `[引用文件 daily.md]\nFILE\n\n[引用技能 日报技能]\nSKILL CONTENT\n\n汇总 今天 2026-09-07`,
      skills: [expect.objectContaining({ name: "日报技能" })],
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
      skills: [expect.objectContaining({ name: "日报技能" })],
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
      "⚡不存在 汇总",
      undefined,
      new Date(),
      fileDeps({}),
    );
    expect(result).toEqual({ error: "attachment_missing: skill 不存在" });
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/automation-resolve-attachments.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// electron/domains/ai/automation/resolve-attachments.ts
/**
 * 任务引用解析与注入(spec §2):触发时读工作空间文件/技能最新内容,
 * 按会话同构格式([引用文件 <path>]\n<内容>)前缀注入——会话回看与
 * 产物面板解析天然兼容;技能聚焦(引用了只注入这些);变量替换仅作用
 * 于用户正文段,引用内容原样。deps 全注入可测。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { app } from "electron";
import {
  parseInlineTokens,
} from "../../../../src-react/domains/ai/chat/lib/inline-tokens";
import {
  readWorkspaceFile,
  resolveFilePath,
} from "../chat/workspace-files";
import { loadSkills, type SkillInfo } from "../agent/skill-loader";
import { replaceVariables } from "./automation-runner";

export interface AttachmentBlock {
  kind: "file" | "skill";
  path: string;
  content: string;
}

export interface ResolveDeps {
  readWorkspaceFile: typeof readWorkspaceFile;
  loadSkills: typeof loadSkills;
  readSkillFile: (dir: string) => Promise<string>;
  skillsRootDir: () => string;
}

export const defaultResolveDeps: ResolveDeps = {
  readWorkspaceFile,
  loadSkills,
  readSkillFile: (dir) => fs.readFile(path.join(dir, "SKILL.md"), "utf8"),
  skillsRootDir: () => app.getPath("userData"),
};

/** 与 ChatView.handleSend 逐字同构:块间 \n\n,整体后接 \n\n + 正文 */
export function composeInjectedPrompt(
  userText: string,
  blocks: AttachmentBlock[],
): string {
  if (blocks.length === 0) {
    return userText;
  }
  return `${blocks
    .map((b) =>
      b.kind === "skill"
        ? `[引用技能 ${b.path}]\n${b.content}`
        : `[引用文件 ${b.path}]\n${b.content}`,
    )
    .join("\n\n")}\n\n${userText}`;
}

export type AttachmentsResolution =
  | { injected: string; skills: SkillInfo[]; referenced: boolean }
  | { error: string };

export async function resolveAttachments(
  prompt: string,
  workspacePath: string | undefined,
  now: Date,
  deps: ResolveDeps = defaultResolveDeps,
): Promise<AttachmentsResolution> {
  const { text, fileTokens, skillTokens } = parseInlineTokens(prompt);
  const blocks: AttachmentBlock[] = [];
  try {
    for (const filePath of new Set(fileTokens)) {
      if (!workspacePath) {
        return { error: `attachment_missing: ${filePath}` };
      }
      const abs = resolveFilePath(workspacePath, filePath);
      const result = await deps.readWorkspaceFile(abs);
      if (result.kind !== "text" || result.content === undefined) {
        return { error: `attachment_missing: ${filePath}` };
      }
      blocks.push({ kind: "file", path: filePath, content: result.content });
    }
    const allSkills = deps.loadSkills([
      { dir: path.join(deps.skillsRootDir(), "skills"), source: "user" },
      ...(workspacePath
        ? [
            {
              dir: path.join(workspacePath, ".mirror", "skills"),
              source: "user" as const,
            },
          ]
        : []),
    ]);
    for (const name of new Set(skillTokens)) {
      const skill = allSkills.find((s) => s.name === name);
      if (!skill || !skill.dir) {
        return { error: `attachment_missing: skill ${name}` };
      }
      blocks.push({
        kind: "skill",
        path: name,
        content: await deps.readSkillFile(skill.dir),
      });
    }
    const referenced = skillTokens.length > 0;
    const skills = referenced
      ? allSkills.filter((s) => new Set(skillTokens).has(s.name))
      : allSkills;
    return {
      injected: composeInjectedPrompt(replaceVariables(text, now), blocks),
      skills,
      referenced,
    };
  } catch {
    return { error: "attachment_missing: read failed" };
  }
}
```

注（实现时以此为准，允许微调但不改签名）：
- `loadSkills` 的 dirs 参数以 runner 现状（automation-runner.ts 的 streamAndRecord 内 loadSkills 调用）为准照搬——`source` 取值看 skill-loader 类型（runner 现码为 "user"，若类型是联合按 runner 现码）。`skillsRootDir` 为第四注入点（default 走 `app.getPath("userData")`，顶部 `import { app } from "electron"`；测试 deps 全注入不触发）。
  `export interface ResolveDeps { readWorkspaceFile; loadSkills; readSkillFile; skillsRootDir: () => string }`，`defaultResolveDeps.skillsRootDir = () => app.getPath("userData")`（顶部 `import { app } from "electron"`，测试里 deps 全注入不触发）。
- `resolveFilePath` 若与假设（`(workspacePath, relPath) => absPath`）不符，以 workspace-files.ts 实际导出为准适配（chat.service 读文件处有用法参照）。

- [ ] **Step 4: 运行测试至通过**

Run: `npx vitest run tests/ai/automation-resolve-attachments.test.ts`
Expected: PASS（7 用例）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/automation/resolve-attachments.ts tests/ai/automation-resolve-attachments.test.ts
git commit -m "feat(automation): 引用解析与同构注入纯模块"
```

---

### Task 2: runner 接线（注入 + 技能聚焦）

**Files:**
- Modify: `electron/domains/ai/automation/automation-runner.ts`（streamAndRecord）
- Test: `tests/ai/automation-runner.test.ts`（增 3 用例）

**Interfaces:**
- Consumes: `resolveAttachments/defaultResolveDeps`（Task 1）
- Produces: streamAndRecord 内 `userText` 变为注入后的 `injected`；skills 来自 resolveAttachments（聚焦）；不变更 executeTask/advanceTask/failRun 签名。

- [ ] **Step 1: 增失败测试（追加到既有 describe 之后）**

```ts
describe("executeTask 引用注入", () => {
  const wsTask = {
    ...taskRow,
    id: 2,
    prompt: "@daily.md 汇总",
    workspaceId: 9,
  };

  function stubOkWorkspace() {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      id: 9, name: "ws", directoryPath: "/ws",
    } as never);
    vi.mocked(prisma.model.findUnique).mockResolvedValue({
      id: 1, providerId: 1, modelId: "m",
    } as never);
    vi.mocked(prisma.provider.findUnique).mockResolvedValue({
      id: 1, type: "openai", baseUrl: "http://x", apiKey: "k", extraHeaders: null,
    } as never);
    vi.mocked(prisma.session.create).mockResolvedValue({ id: 77 } as never);
  }

  it("带文件引用的任务:user 消息含 [引用文件] 前缀块", async () => {
    stubOkWorkspace();
    vi.mocked(runChatStream).mockResolvedValue({
      blocks: [{ type: "text", text: "ok" }],
    } as never);
    await executeTask(wsTask as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "user",
          blocks: expect.stringContaining("[引用文件 daily.md]"),
        }),
      }),
    );
  });

  it("引用文件缺失 → run failed(attachment_missing)", async () => {
    stubOkWorkspace();
    await executeTask(wsTask as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    expect(prisma.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", error: expect.stringContaining("attachment_missing") }),
      }),
    );
  });

  it("技能聚焦:⚡引用 → system 只含引用技能", async () => {
    stubOkWorkspace();
    vi.mocked(runChatStream).mockResolvedValue({
      blocks: [{ type: "text", text: "ok" }],
    } as never);
    await executeTask({ ...wsTask, prompt: "⚡A 汇总" } as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    const call = vi.mocked(runChatStream).mock.calls[0][0];
    expect(call.system).not.toContain("B 技能");
  });
});
```

注（测试基建，实现者按此落定，断言语义不变）：
- 三个用例都要 `vi.mock("../../electron/domains/ai/chat/workspace-files", ...)` 提供 `resolveFilePath/readWorkspaceFile` stub（file:1 成功返回 text 内容 / file:2 抛错 / 技能用例无需文件）与 `vi.mock("electron", { app: { getPath } })`（resolve-attachments 的 skillsRootDir）。loadSkills 走 `vi.mock("../../electron/domains/ai/agent/skill-loader")` 返回 `[{ name: "A 技能", dir: "/s/a" }, { name: "B 技能", dir: "/s/b" }]`，readSkillFile 在 resolve-attachments 测试侧无法注入（runner 走 defaultResolveDeps）——**因此 runner 接线采用可注入形态**：`streamAndRecord` 内 `resolveAttachments(..., resolveDeps)` 的 `resolveDeps` 为模块级可覆写变量 `export let runnerResolveDeps = defaultResolveDeps`（测试 `vi.mock` 后或直接 import 改写），或更简单——测试用例 3 通过 spy `vi.spyOn(automation-runner 模块内部引用)` 不可行时，改为 mock `node:fs/promises` 的 readFile 返回技能内容。**采用 fs mock 方案**（readSkillFile 走 fs.readFile，vi.mock("node:fs/promises") 一并覆盖 workspace-files 内部 fs——注意该 mock 需兼容 readWorkspaceFile 的 stat；为此 file 用例直接 mock workspace-files 模块整模块，技能用例只 mock fs/promises 的 readFile）。实现时以断言通过为准调整 mock 组合，断言文本不变。
- 文件顶部既有 mock 块保持不动。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ai/automation-runner.test.ts`
Expected: 新增用例 FAIL（user 消息无前缀块 / error 无 attachment_missing）

- [ ] **Step 3: 实现（streamAndRecord 内改动，其余不动）**

原：
```ts
const userText = replaceVariables(task.prompt, new Date());
await prisma.message.create({ data: { sessionId: ctx.sessionId, role: "user", blocks: serializeBlocks([{ type: "text", text: userText }]) } });
const skills = loadSkills([...]);
```
改为：
```ts
// 引用解析(spec §2):失败短路 failRun;成功取注入文本与聚焦技能清单
const resolution = await resolveAttachments(
  task.prompt,
  ctx.workspacePath,
  new Date(),
);
if ("error" in resolution) {
  return await failRun(ctx.runId, task, resolution.error, ctx.startedAt, ctx.sessionId);
}
const userText = resolution.injected;
await prisma.message.create({ data: { sessionId: ctx.sessionId, role: "user", blocks: serializeBlocks([{ type: "text", text: userText }]) } });
const skills = resolution.skills;
```
（随后的 `buildSystemPrompt(undefined, skills)`、`collectTools(ctx.workspacePath, skills)`、history 的 user blocks 全部自动消费聚焦后的清单与注入文本——代码不用改这三处引用，只删原 loadSkills 调用与原 userText 行。）顶部 import 增 `import { resolveAttachments } from "./resolve-attachments";`，删除不再使用的 `loadSkills` import（若 replaceVariables 移到 Task 1 模块使用则 runner 保留导出——保留，别动）。

- [ ] **Step 4: 运行全部 runner 用例至通过**

Run: `npx vitest run tests/ai/automation-runner.test.ts`
Expected: PASS（既有 5+ 新 3）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/automation/automation-runner.ts tests/ai/automation-runner.test.ts
git commit -m "feat(automation): runner 触发时注入引用并聚焦技能"
```

---

### Task 3: TaskModelPicker 与 TaskPlusMenu

**Files:**
- Create: `src-react/domains/ai/automation/components/TaskModelPicker.tsx`
- Create: `src-react/domains/ai/automation/components/TaskPlusMenu.tsx`

**Interfaces:**
- Produces（Task 4 消费）:
  - `TaskModelPickerProps = { modelId?: number; onChange: (modelId: number) => void }`，默认导出
  - `TaskPlusMenuProps = { onPickPaths: (paths: string[]) => void; onOpenMcp: () => void; onInsertVariable: (token: string) => void }`，默认导出

- [ ] **Step 1: TaskModelPicker.tsx（视觉照抄 ModelPicker，改受控）**

```tsx
// src-react/domains/ai/automation/components/TaskModelPicker.tsx
/**
 * 任务模型选择器:ModelPicker 的无会话态变体——同款 providers/models
 * 分组视觉,受控 props(不写会话 IPC),保留「配置模型」跳转。
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown, Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProviderApi } from "../../api/provider.api";
import ModelApi from "../../api/model.api";

const PROVIDERS_ROUTE = "/module/ai/providers";

export interface TaskModelPickerProps {
  modelId?: number;
  onChange: (modelId: number) => void;
}

export default function TaskModelPicker({
  modelId,
  onChange,
}: TaskModelPickerProps) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();

  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: ["models", "all"],
    queryFn: () => ModelApi.listAll(),
  });

  const groups = useMemo(() => {
    const providers = providersQuery.data ?? [];
    const models = (modelsQuery.data ?? []).filter((model) => model.enabled);
    return providers
      .map((provider) => ({
        provider,
        models: models.filter((model) => model.providerId === provider.id),
      }))
      .filter((group) => group.models.length > 0);
  }, [providersQuery.data, modelsQuery.data]);

  const currentModel = (modelsQuery.data ?? []).find((m) => m.id === modelId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-44 shrink-0 border-0 hover:bg-primary-subtle hover:text-primary"
          title={currentModel?.modelId}
        >
          <span className="truncate">
            {currentModel
              ? currentModel.name || currentModel.modelId
              : t("chat:input.selectModel")}
          </span>
          <ChevronDown className="ml-1 h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-72 w-56 overflow-y-auto border border-border/50 rounded-lg shadow-lg"
      >
        {groups.length === 0 && (
          <DropdownMenuLabel>{t("chat:input.modelRequired")}</DropdownMenuLabel>
        )}
        {groups.map((group, index) => (
          <div key={group.provider.id}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{group.provider.name}</DropdownMenuLabel>
            {group.models.map((model) => (
              <DropdownMenuItem
                key={model.id}
                onClick={() => onChange(model.id)}
              >
                <span className="truncate" title={model.modelId}>
                  {model.name || model.modelId}
                </span>
                {model.id === modelId && (
                  <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate(PROVIDERS_ROUTE)}>
          <Server />
          {t("chat:settings.configureModels")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: TaskPlusMenu.tsx（PlusMenu 子集 + 插入变量）**

```tsx
// src-react/domains/ai/automation/components/TaskPlusMenu.tsx
/**
 * 任务输入卡 +菜单:PlusMenu 子集——文件/技能/MCP + 插入变量;
 * 剔除模式三态与专家项(会话语义)。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Braces, FilePlus, Plug, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { invoke } from "@/lib/ipc";
import SkillImportDialog from "../../skills/components/SkillImportDialog";
import SkillSubMenu from "../../chat/components/skill-sub-menu";

interface PickedFile {
  path: string;
  content?: string;
  error?: string;
}

export interface TaskPlusMenuProps {
  onPickPaths: (paths: string[]) => void;
  onOpenMcp: () => void;
  onInsertVariable: (token: string) => void;
}

const VARIABLES = ["{{date}}", "{{weekday}}", "{{time}}"] as const;

export default function TaskPlusMenu({
  onPickPaths,
  onOpenMcp,
  onInsertVariable,
}: TaskPlusMenuProps) {
  const { t } = useTranslation(["chat"]);
  const [importOpen, setImportOpen] = useState(false);

  const handleAddFile = async () => {
    let picked: PickedFile[];
    try {
      picked = await invoke<PickedFile[]>("file:pickAndRead");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }
    const paths: string[] = [];
    for (const file of picked) {
      if (file.error !== undefined) {
        toast.error(
          t("chat:attach.readFailed", { path: file.path, reason: file.error }),
        );
      } else {
        paths.push(file.path);
      }
    }
    if (paths.length > 0) {
      onPickPaths(paths);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("chat:plus.title")}
            className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-52 border border-border/50 rounded-lg shadow-lg"
        >
          <DropdownMenuItem onClick={() => void handleAddFile()}>
            <FilePlus />
            {t("chat:plus.addFile")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <SkillSubMenu onImport={() => setImportOpen(true)} />
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          {VARIABLES.map((token) => (
            <DropdownMenuItem
              key={token}
              onClick={() => onInsertVariable(token)}
            >
              <Braces />
              {t(`chat:automation.create.var${labelOf(token)}`, { token })}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenMcp}>
            <Plug />
            {t("chat:plus.connector")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SkillImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}

function labelOf(token: string): "Date" | "Weekday" | "Time" {
  return token === "{{date}}"
    ? "Date"
    : token === "{{weekday}}"
      ? "Weekday"
      : "Time";
}
```

注：`SkillSubMenu` 是否需要外层 `DropdownMenuSub` 包裹——看 skill-sub-menu.tsx 自身导出形态：它内部已含 `DropdownMenuSub`（从其 import 列表可见）。**若内部已包，直接 `<SkillSubMenu onImport={...} />` 不再外套**——以实际代码为准（Step 2 写前先读该文件确认）。变量项插值用现有键 `chat:automation.create.varDate/varWeekday/varTime`（值形如「日期 {{token}}」，其插值变量名是 `date/weekday/time`——**核对键的插值名**，若为 `{ date: ... }` 则传 `{ date: token }`；按 Task 11 的键定义 `varDate: "日期 {{date}}"`，故插值传 `{ date: token }` 而非 `{ token }`——实现时以 locale 文件实际键为准修正传参）。

- [ ] **Step 3: typecheck + Commit**

Run: `npm run typecheck`
Expected: 通过。

```bash
git add src-react/domains/ai/automation/components/TaskModelPicker.tsx src-react/domains/ai/automation/components/TaskPlusMenu.tsx
git commit -m "feat(automation): 任务模型选择器与+菜单变体"
```

---

### Task 4: TaskPromptInput 卡片组件

**Files:**
- Create: `src-react/domains/ai/automation/components/TaskPromptInput.tsx`

**Interfaces:**
- Consumes: `renderTokenSegments/detectSlash/parseInlineTokens`（inline-tokens）、`TaskModelPicker/TaskPlusMenu`（Task 3）、`PermissionCapsule`（chat/components，props `{ sessionId; accessMode; onChange }`）
- Produces（Task 5 消费）: `export interface TaskPromptInputProps { value: string; onChange: (v: string) => void; workspaceId: number | null; modelId?: number; onModelChange: (id: number) => void; onOpenMcp: () => void; placeholder: string; }`，默认导出。

- [ ] **Step 1: 实现（ChatInput 骨架的表单态变体）**

```tsx
// src-react/domains/ai/automation/components/TaskPromptInput.tsx
/**
 * 任务提示词输入卡(spec §1):ChatInput 交互骨架的无会话态变体——
 * textarea + 镜像层 pill(@文件/⚡技能 token)、@/⚡ 联想面板
 * (不支持 / 命令)、下行 +菜单/只读权限胶囊/模型选择。
 * 受控组件;Enter 换行(联想激活时 Enter 选中候选)。
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { Sparkles } from "lucide-react";
import { renderTokenSegments } from "../../chat/lib/inline-tokens";
import PermissionCapsule from "../../chat/components/PermissionCapsule";
import TaskModelPicker from "./TaskModelPicker";
import TaskPlusMenu from "./TaskPlusMenu";

/** @token 允许字符(照 ChatInput) */
const MENTION_TOKEN_RE = /[\w\-./]/;
const MENTION_LIMIT = 8;

type SuggestCandidate =
  | { kind: "skill"; name: string }
  | { kind: "file"; path: string };

function detectMention(
  value: string,
  caret: number,
): { startIndex: number; query: string } | null {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) {
    return null;
  }
  const token = upto.slice(at + 1);
  if (token.length > 0 && ![...token].every((ch) => MENTION_TOKEN_RE.test(ch))) {
    return null;
  }
  const prev = at > 0 ? upto[at - 1] : "";
  if (prev && !/\s/.test(prev)) {
    return null;
  }
  return { startIndex: at, query: token };
}

/** ⚡ 触发检测(光标前最近,前须行首/空白) */
function detectSkillTrigger(
  value: string,
  caret: number,
): { startIndex: number; query: string } | null {
  const upto = value.slice(0, caret);
  const idx = upto.lastIndexOf("⚡");
  if (idx === -1) {
    return null;
  }
  const token = upto.slice(idx + 1);
  if (token.length > 0 && !/^[\w-]*$/.test(token)) {
    return null;
  }
  const prev = idx > 0 ? upto[idx - 1] : "";
  if (prev && !/\s/.test(prev)) {
    return null;
  }
  return { startIndex: idx, query: token };
}

export interface TaskPromptInputProps {
  value: string;
  onChange: (v: string) => void;
  workspaceId: number | null;
  modelId?: number;
  onModelChange: (id: number) => void;
  onOpenMcp: () => void;
  placeholder: string;
}

export default function TaskPromptInput({
  value,
  onChange,
  workspaceId,
  modelId,
  onModelChange,
  onOpenMcp,
  placeholder,
}: TaskPromptInputProps) {
  const [suggest, setSuggest] = useState<{
    type: "at" | "skill";
    startIndex: number;
    query: string;
  } | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  const workspaceFilesQuery = useQuery({
    queryKey: ["workspace-files", workspaceId],
    queryFn: () => invoke<string[] | null>("file:listWorkspaceFiles", workspaceId),
    enabled: workspaceId !== null && suggest?.type === "at",
    staleTime: 300_000,
  });
  const skillsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
    staleTime: 60_000,
  });

  const suggestCandidates = useMemo<SuggestCandidate[]>(() => {
    if (!suggest) {
      return [];
    }
    const query = suggest.query.toLowerCase();
    if (suggest.type === "skill") {
      return (skillsQuery.data ?? [])
        .filter((r) => r.enabled)
        .filter((r) => !query || r.name.toLowerCase().includes(query))
        .slice(0, MENTION_LIMIT)
        .map((r) => ({ kind: "skill" as const, name: r.name }));
    }
    const files = workspaceFilesQuery.data;
    if (!files) {
      return [];
    }
    return (
      query
        ? files.filter((f) => f.toLowerCase().includes(query))
        : [...files].sort((a, b) => a.length - b.length)
    )
      .slice(0, MENTION_LIMIT)
      .map((f) => ({ kind: "file" as const, path: f }));
  }, [suggest, skillsQuery.data, workspaceFilesQuery.data]);

  const activeIndex = Math.min(
    highlightIndex,
    Math.max(suggestCandidates.length - 1, 0),
  );

  /** 在光标处插入 token(替换触发片段),光标落在 token 后 */
  const insertAtCaret = useCallback(
    (token: string) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? value.length;
      const next = `${value.slice(0, caret)}${token}${value.slice(caret)}`;
      onChange(next);
      setSuggest(null);
      requestAnimationFrame(() => {
        const pos = caret + token.length;
        textarea?.focus();
        textarea?.setSelectionRange(pos, pos);
      });
    },
    [value, onChange],
  );

  const selectCandidate = useCallback(
    (candidate: SuggestCandidate) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? value.length;
      const end = suggest
        ? Math.min(caret, suggest.startIndex + 1 + suggest.query.length)
        : caret;
      const token =
        candidate.kind === "file" ? `@${candidate.path} ` : `⚡${candidate.name} `;
      const next =
        value.slice(0, suggest ? suggest.startIndex : caret) +
        token +
        value.slice(end);
      onChange(next);
      setSuggest(null);
      requestAnimationFrame(() => {
        const pos = (suggest ? suggest.startIndex : caret) + token.length;
        textarea?.focus();
        textarea?.setSelectionRange(pos, pos);
      });
    },
    [value, suggest, onChange],
  );

  const syncSuggestFromCaret = (target: HTMLTextAreaElement) => {
    const skill = detectSkillTrigger(target.value, target.selectionStart);
    const mention = skill ? null : detectMention(target.value, target.selectionStart);
    setSuggest(
      skill
        ? { type: "skill", ...skill }
        : mention
          ? { type: "at", ...mention }
          : null,
    );
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = event.target.value;
    onChange(v);
    const caret = event.target.selectionStart;
    const skill = detectSkillTrigger(v, caret);
    const mention = skill ? null : detectMention(v, caret);
    const next = skill
      ? { type: "skill" as const, ...skill }
      : mention
        ? { type: "at" as const, ...mention }
        : null;
    setSuggest(next);
    if (next) {
      setHighlightIndex(0);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex(
          (activeIndex + 1) % Math.max(suggestCandidates.length, 1),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex(
          (activeIndex - 1 + Math.max(suggestCandidates.length, 1)) %
            Math.max(suggestCandidates.length, 1),
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSuggest(null);
        return;
      }
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const candidate = suggestCandidates[activeIndex];
        if (candidate) {
          selectCandidate(candidate);
        }
        return;
      }
    }
    // 表单态:Enter 不提交(Dilog 确定按钮负责),交默认换行
  };

  const segments = useMemo(() => renderTokenSegments(value), [value]);
  const showSuggestList = suggest !== null;
  const noBind = suggest?.type === "at" && workspaceId === null;
  const noCandidates = suggest !== null && suggestCandidates.length === 0;

  return (
    <div className="relative flex flex-col rounded-xl border border-border/50 bg-card px-3 py-2 shadow-sm focus-within:border-primary/40">
      {showSuggestList && (
        <div className="absolute bottom-full left-3 z-10 mb-1 w-72 overflow-hidden rounded-lg border border-border/50 bg-card shadow-lg">
          {noBind ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("chat:mention.needBind")}
            </p>
          ) : noCandidates ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("chat:mention.noFiles")}
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto py-1">
              {suggestCandidates.map((candidate, index) => (
                <li key={`${candidate.kind}:${candidate.kind === "file" ? candidate.path : candidate.name}`}>
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectCandidate(candidate);
                    }}
                    onMouseEnter={() => setHighlightIndex(index)}
                    className={`flex w-full items-center gap-1.5 truncate px-2 py-1.5 text-left text-xs ${
                      index === activeIndex
                        ? "bg-primary-subtle text-primary"
                        : "text-foreground"
                    }`}
                  >
                    {candidate.kind === "skill" ? (
                      <>
                        <Sparkles className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{candidate.name}</span>
                      </>
                    ) : (
                      <span className="truncate">{candidate.path}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="relative mt-2">
        <div
          ref={mirrorRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 max-h-56 overflow-hidden border-0 p-0 whitespace-pre-wrap break-words text-sm leading-relaxed"
        >
          {segments.map((segment, index) =>
            segment.isToken ? (
              <span
                key={index}
                className="rounded-md bg-primary-subtle px-0 py-0.5 text-primary"
              >
                {segment.text}
              </span>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={(e) => syncSuggestFromCaret(e.currentTarget)}
          onKeyUp={(e) => syncSuggestFromCaret(e.currentTarget)}
          onBlur={() => setSuggest(null)}
          onScroll={() => {
            if (mirrorRef.current && textareaRef.current) {
              mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
            }
          }}
          rows={3}
          placeholder={placeholder}
          className="relative min-h-20 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-sm leading-relaxed field-sizing-content max-h-56 outline-none text-transparent caret-foreground placeholder:text-muted-foreground [&::-webkit-scrollbar]:hidden"
        />
      </div>
      <div className="flex items-center pt-2">
        <div className="flex items-center gap-2">
          <TaskPlusMenu
            onPickPaths={(paths) => {
              for (const p of paths) {
                insertAtCaret(`@${p} `);
              }
            }}
            onOpenMcp={onOpenMcp}
            onInsertVariable={(token) => insertAtCaret(token)}
          />
          <PermissionCapsule
            sessionId={-1}
            accessMode="full"
            onChange={() => {
              /* 只读展示:点击弹 FullAccessModal 说明后维持 full */
            }}
          />
        </div>
        <div className="ml-auto">
          <TaskModelPicker modelId={modelId} onChange={onModelChange} />
        </div>
      </div>
    </div>
  );
}
```

注（实现时补齐，代码骨架为准）：
- 顶部需补 `import { useTranslation } from "react-i18next"` 并在组件内 `const { t } = useTranslation(["chat"])`（placeholder 由父级传入已本地化，联想面板两条文案用 t）。
- `SkillApi` import：`import SkillApi from "../../skills/api/skill.api"`。
- `handleKeyUp` 与 `onSelect` 都触发 `syncSuggestFromCaret`（ChatInput 同款拆法可合并为一个 handler 函数）。
- `PermissionCapsule` 的 `AccessMode` 类型 import：`import PermissionCapsule from ...`（默认导出即可，"full" 字面量满足）。

- [ ] **Step 2: typecheck + Commit**

Run: `npm run typecheck`
Expected: 通过。

```bash
git add src-react/domains/ai/automation/components/TaskPromptInput.tsx
git commit -m "feat(automation): 任务提示词输入卡(联想/pill/+菜单/胶囊/模型)"
```

---

### Task 5: CreateTaskDialog 重构接线 + i18n + 冒烟

**Files:**
- Modify: `src-react/domains/ai/automation/components/CreateTaskDialog.tsx`
- Modify: `src-react/i18n/locales/zh-CN/chat.json` / `en-US/chat.json`（automation.create 段增 1 键）
- Test: 无新测试文件（组件无单测口径不变）；验证 = typecheck + 全量 vitest + lint + dev 冒烟

**Interfaces:**
- Consumes: `TaskPromptInput`（Task 4，含全部 props）
- Produces: Dialog 中段新布局；`chat:automation.create.attachmentMissing` 键。

- [ ] **Step 1: i18n 增键（两语言 automation.create 段内）**

zh-CN：
```json
"attachmentMissing": "引用不存在或读取失败：{{name}}"
```
en-US：
```json
"attachmentMissing": "Attachment missing or unreadable: {{name}}"
```

- [ ] **Step 2: Dialog 中段重构**

改动点（其余逻辑——初始化 effect/pickerKey/startAtUnchanged/提交链路——全部不动）：
1. 删除：models query（`["models","all"]` 的 useQuery 与 ModelApi import）、模型 Select 块（`create.model` 那个 Select）、prompt 的 `Textarea` 块及其 import、变量插入 DropdownMenu（ChevronDown/DropdownMenu* 若仅此处使用则连 import 一起删）、红色警示区（`fullAccessWarn` 那段 div 与 TriangleAlert import）。
2. 中段替换为（位于名称行之后、missedPolicy 行之前）：

```tsx
<TaskPromptInput
  value={prompt}
  onChange={setPrompt}
  workspaceId={workspaceId}
  modelId={modelId ?? undefined}
  onModelChange={setModelId}
  onOpenMcp={() => navigate("/module/ai/automation")}
  placeholder={t("chat:automation.create.promptPlaceholder")}
/>
```

注：`onOpenMcp` 的目标路由——项目 MCP 管理页是 `/module/ai/experts?tab=connectors`（以 expert-sub-menu.tsx 的常量为准，读文件确认后填真实路由；不确定时先读 `chat/components/expert-sub-menu.tsx` 顶部的路由常量）。`navigate` 需要 `useNavigate()`（顶部补）。
3. 参数三档行（PARAM_PRESETS）保留原位置不动。
4. 提交时 prompt 校验不变（`prompt.trim()`）；prompt 含 token 原样提交（后端解析）。

- [ ] **Step 3: 三项检查**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: 全绿（461+7 用例）。

- [ ] **Step 4: dev 冒烟**

`npm run dev` 启动，验证（交互项做多少列多少，未完成如实记录）：
1. `/module/ai/automation` → 添加自动化 → 自定义创建：中段为输入卡（textarea+下行 +菜单/胶囊/模型选择）；
2. `@` 联想弹文件面板（选工作空间后）、`⚡` 联想弹技能面板、token 显示 pill；
3. `+` 菜单：文件选择插入 @token、技能子菜单可用、三个变量项插入、MCP 跳转；
4. 权限胶囊显示「完全访问」，点击弹说明弹窗；
5. 模型下拉分组展示、选中回显；
6. 编辑已有任务：prompt 的 token pill 回显；
7. （可选，时间允许）创建一个 1 分钟后触发的任务带 `@某文件` 引用 → 等触发 → 运行记录 success、聊天会话 user 消息含 `[引用文件 ...]` 前缀块。

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/automation/components/CreateTaskDialog.tsx src-react/i18n/locales
git commit -m "feat(automation): 创建/编辑弹框接入输入卡(引用/胶囊/模型)"
```
