# 远程文件面（FA 批）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 远程主机会话的 @ 文件联想、文件内容注入、图片多模态与本地体验拉平。

**Architecture:** 被控端三端点（files/list、files/read、files/uploadImage，无头 server + 桌面 face 双侧同构）+ capabilities 协商 `"files"` + 控制端 api 双路由（本地逐字 / 远程适配）；图片上传后走被控端数据根相对路径进 ImageBlock，远端引擎回喂链零改动。

**Tech Stack:** NestJS（server）/ node:http face 桥（mirror）/ @tianshu/protocol + @tianshu/core / React routeInvoke 模式 / Vitest + Jest。

**Spec:** `docs/superpowers/specs/2026-10-20-remote-files-design.md`

## Global Constraints

- 图片上传上限 3MB（base64 前）——relay 单帧 4MiB 余量；本地粘贴链 10MB 保持
- files/read 文本上限 512KB、NUL 二进制判定——与本地 `file:readExternalFile` 同口径
- @ 联想清单口径：排除 `node_modules`/`.git`/`dist` 与点开头、上限 2000 条、相对路径 `/` 分隔——抽 `@tianshu/core` 共享纯函数（spec 假设 2 裁定：收编 core，防双份漂移）
- capabilities 旧端不上报 `"files"` → caps.files=false 门控照旧，零迁移
- `ImageBlock` 契约：`{ type: "image"; imagePath: string; mime: string; name?: string }`（`@tianshu/protocol` chat-contract）
- server 仓 Prettier 单引号；mirror 仓双引号——各按各仓规范
- 每任务收尾：对应仓测试绿 + mirror 全量 3825 基线零新增失败

---

### Task 1: core 共享纯函数收编（清单扫描 + 守卫读取）

**Files:**
- Create: `packages/tianshu-core/src/workspace-files-scan.ts`
- Modify: `packages/tianshu-core/src/index.ts`（barrel 登记——注意仅主进程/服务端消费，渲染层禁裸引 barrel）
- Modify: `electron/domains/ai/chat/chat.service.ts`（`file:listWorkspaceFiles` 处理器换 core 实现，删本地 walk）
- Test: `packages/tianshu-core/test/workspace-files-scan.test.ts`（core 包测试目录若不存在则建 `packages/tianshu-core/test/`）

**Interfaces:**
- Produces:
  - `listWorkspaceFiles(root: string, opts?: { maxEntries?: number }): Promise<string[]>`（相对路径 `/` 分隔；排除 node_modules/.git/dist 与点开头；默认上限 2000）
  - `readTextFileGuarded(absPath: string, maxBytes?: number): Promise<{ ok: true; content: string } | { ok: false; reason: "too-large" | "binary" | "read-failed" }>`（默认 512*1024；NUL 判二进制）

- [ ] **Step 1: 写失败测试**（真实 fs，mkdtemp 隔离；目录结构：a.ts、sub/b.md、node_modules/skip.js、.hidden、dist/x.js）

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listWorkspaceFiles, readTextFileGuarded } from "../src/workspace-files-scan";

describe("listWorkspaceFiles", () => {
  it("相对路径枚举：排除 node_modules/dist/点开头；上限可注", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wfscan-"));
    writeFileSync(path.join(root, "a.ts"), "x");
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "sub", "b.md"), "y");
    mkdirSync(path.join(root, "node_modules"));
    writeFileSync(path.join(root, "node_modules", "skip.js"), "x");
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "x.js"), "x");
    writeFileSync(path.join(root, ".hidden"), "x");
    expect(await listWorkspaceFiles(root)).toEqual(["a.ts", "sub/b.md"]);
  });
});

describe("readTextFileGuarded", () => {
  it("文本读取 ok；超限 too-large；NUL binary；不存在 read-failed", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wfread-"));
    const p = path.join(root, "t.txt");
    writeFileSync(p, "hello");
    expect(await readTextFileGuarded(p)).toEqual({ ok: true, content: "hello" });
    expect(await readTextFileGuarded(p, 2)).toEqual({ ok: false, reason: "too-large" });
    const bin = path.join(root, "b.bin");
    writeFileSync(bin, Buffer.from([0x01, 0x00, 0x02]));
    expect(await readTextFileGuarded(bin)).toEqual({ ok: false, reason: "binary" });
    expect(await readTextFileGuarded(path.join(root, "none"))).toEqual({
      ok: false, reason: "read-failed",
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`npx vitest run packages/tianshu-core/test/workspace-files-scan.test.ts`（若 core 无 vitest 配置，用 mirror 根 vitest 直跑该路径——根配置 alias 已覆盖）
- [ ] **Step 3: 实现 `packages/tianshu-core/src/workspace-files-scan.ts`**（逻辑自 chat.service `listWorkspaceFiles` 的 walk 与 readExternalFile 512KB/NUL 口径逐字迁移；纯 node:fs，零 electron 依赖）

```ts
import fs from "node:fs/promises";
import path from "node:path";

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist"]);
const DEFAULT_MAX_ENTRIES = 2000;

export async function listWorkspaceFiles(
  root: string,
  opts: { maxEntries?: number } = {},
): Promise<string[]> {
  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const files: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (files.length >= max) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= max) return;
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  try {
    await walk(root, "");
  } catch {
    return files;
  }
  return files;
}

const DEFAULT_MAX_BYTES = 512 * 1024;

export async function readTextFileGuarded(
  absPath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<
  { ok: true; content: string } | { ok: false; reason: "too-large" | "binary" | "read-failed" }
> {
  let buf: Buffer;
  try {
    const stat = await fs.stat(absPath);
    if (stat.size > maxBytes) return { ok: false, reason: "too-large" };
    buf = await fs.readFile(absPath);
  } catch {
    return { ok: false, reason: "read-failed" };
  }
  if (buf.length > maxBytes) return { ok: false, reason: "too-large" };
  if (buf.includes(0)) return { ok: false, reason: "binary" };
  return { ok: true, content: buf.toString("utf8") };
}
```

- [ ] **Step 4: barrel 登记 + mirror 消费切换**：core `index.ts` 加 `export * from "./workspace-files-scan";`；chat.service `file:listWorkspaceFiles` 处理器内 walk 段替换为 `return listWorkspaceFiles(root)`（import 自 `@tianshu/core`；归属/根空判定逻辑保留原地）；`file:readExternalFile` 的读取段（512KB/NUL 分支）换 `readTextFileGuarded`（保持错误返回形状——现有处理器返回 `{ filePath, error: "超过 512KB 上限" }` 等结构，按 reason 映射）
- [ ] **Step 5: 测试过 + 全量回归**：`npx vitest run packages/tianshu-core/test/workspace-files-scan.test.ts` PASS；`npm run test` 3825 基线
- [ ] **Step 6: 重建 core dist + 提交**：`npm --prefix packages/tianshu-core run build`；commit `feat(core): workspace 文件扫描/守卫读取纯函数收编（FA-T1）`

---

### Task 2: protocol 扩（capabilities + files 端点类型）

**Files:**
- Modify: `packages/tianshu-protocol/src/server-event.ts`（CAPABILITIES 增 "files"；新类型 FilesListResult 等）

**Interfaces:**
- Produces:
  - `CAPABILITIES = ["chat", "provider", "graph", "files"]`、`DESKTOP_CAPABILITIES = ["chat", "provider", "ui-drive", "files"]`
  - `RemoteFileReadResult = { content: string }`
  - `RemoteFileUploadResult = { imagePath: string }`（被控端数据根相对路径）
  - `RemoteFileUploadInput = { workspaceId?: number; name: string; base64: string }`

- [ ] **Step 1: 改常量与类型**（server-event.ts；两类被控端能力清单同加 `"files"`——face 断言与包常量同引用自动跟随）
- [ ] **Step 2: 确认消费方快照**：grep `CAPABILITIES`/`DESKTOP_CAPABILITIES` 的既有断言测试（server-face/routes.test 等），能力面变化导致的断言更新就地修（预期 +1 项）
- [ ] **Step 3: 测试 + 提交**：跑受影响面（`npx vitest run tests/ai/server-face/` 与 server 侧 `npm run test -w apps/tianshu-server`）；重建 protocol dist；commit `feat(protocol): capabilities 增 files + 远程文件端点类型（FA-T1）`

---

### Task 3: 无头端 files 模块

**Files:**
- Create: `apps/tianshu-server/src/modules/files/files.controller.ts`、`files.service.ts`、`files.module.ts`
- Modify: `apps/tianshu-server/src/app.module.ts`（模块登记）
- Test: `apps/tianshu-server/test/modules/files.spec.ts`

**Interfaces:**
- Consumes: Task 1 `listWorkspaceFiles`/`readTextFileGuarded`（`@tianshu/core`，注意先 `npm run sync:core` 或重建 dist）；Task 2 类型
- Produces: HTTP `POST /files/list`、`/files/read`、`/files/uploadImage`（starter 包装体 `{code, success, data}`）

- [ ] **Step 1: 写失败测试**（Jest；临时目录真 fs；service 直测不经 HTTP——controller 薄）

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilesService } from 'src/modules/files/files.service';
import { PrismaService } from 'src/commons/database/prisma.service';

// PrismaService 桩：workspace 表按 directoryPath 返回
const prismaStub = {
  workspace: { findFirst: jest.fn() },
};
jest.mock('src/commons/database/prisma.service', () => ({
  PrismaService: jest.fn(() => prismaStub),
}));

describe('FilesService', () => {
  const svc = () => new FilesService(prismaStub as unknown as PrismaService);

  it('list：workspace.directoryPath 相对路径清单', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'srv-files-'));
    writeFileSync(path.join(root, 'a.ts'), 'x');
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 1, directoryPath: root, userId: null });
    expect(await svc().list(1)).toEqual(['a.ts']);
  });

  it('list：workspace 不存在/无目录 → FILES_NO_WORKSPACE', async () => {
    prismaStub.workspace.findFirst.mockResolvedValue(null);
    await expect(svc().list(99)).rejects.toThrow('FILES_NO_WORKSPACE');
  });

  it('read：文本 ok；越界路径拒 FILES_PATH_ESCAPE', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'srv-read-'));
    writeFileSync(path.join(root, 't.txt'), 'hi');
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 1, directoryPath: root, userId: null });
    expect(await svc().read(1, 't.txt')).toEqual({ content: 'hi' });
    await expect(svc().read(1, '../../etc/passwd')).rejects.toThrow('FILES_PATH_ESCAPE');
  });

  it('uploadImage：base64 落数据根 attachments，返回相对路径', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'srv-up-'));
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 1, directoryPath: root, userId: null });
    // dataRoot 经构造注入或 env——按 service 实现口径（FA-T3 落地时若经
    // ChatRunnerConfig 同源 config，测试注入 tmp 根）
    const result = await svc().uploadImage({ workspaceId: 1, name: 'p.png', base64: Buffer.from('png').toString('base64') });
    expect(result.imagePath).toMatch(/^attachments\//);
  });

  it('uploadImage：超 3MB 拒 FILES_IMAGE_TOO_LARGE', async () => {
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 1, directoryPath: '/tmp', userId: null });
    const big = Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64');
    await expect(svc().uploadImage({ workspaceId: 1, name: 'p.png', base64: big })).rejects.toThrow('FILES_IMAGE_TOO_LARGE');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`cd apps/tianshu-server && npx jest test/modules/files.spec.ts`
- [ ] **Step 3: 实现 service/controller/module**（service：workspace 查findFirst（多用户归属语义与 session 模块同口径——被控端 userId 隔离弱化，对齐现有 session.query 不强制）；list 走 core `listWorkspaceFiles`；read 走 `readTextFileGuarded` + 越界前缀校验（`path.resolve(root, rel)` 必须以 `root + path.sep` 开头，否则 FILES_PATH_ESCAPE）；uploadImage 校验 base64 解码后 ≤3MB → 写 `dataRoot/attachments/<uuid>-<name>`（dataRoot 从 config.yml tianshu 段 dataRoot 同源 ChatRunnerConfig）→ 返回 `attachments/<file>` 相对路径；controller 三 POST 端点 DTO 校验（`@IsString`/`@IsOptional`/`@MaxLength`，skills.controller 模式）；module 注册 providers/imports PrismaModule）
- [ ] **Step 4: 测试过 + server 全量**：`npm run test -w apps/tianshu-server`
- [ ] **Step 5: 提交**：`feat(server): files 三端点——list/read/uploadImage（FA-T1）`

---

### Task 4: 无头端 send images（落 ImageBlock）

**Files:**
- Modify: `apps/tianshu-server/src/modules/session/dto/session-send.dto.ts`（增 `images?: string[]`）
- Modify: `apps/tianshu-server/src/core/chat-runner.service.ts`（send 链落 ImageBlock）
- Test: `apps/tianshu-server/test/modules/session.spec.ts`（扩用例）

**Interfaces:**
- Consumes: `ImageBlock`（protocol）
- Produces: `POST /session/send` 可选 `images: string[]`（被控端数据根相对路径，uploadImage 返回值）；消息落库 blocks 含 image 块；引擎回喂走现有 `loadImage` 链（无头端已按数据根读盘）

- [ ] **Step 1: DTO 扩**（`@IsArray() @IsOptional() @IsString({ each: true }) images?: string[]`）
- [ ] **Step 2: chat-runner 落块**：`ChatRunnerRunOptions` 增 `images?: string[]`；本轮 user 消息 blocks = `[text 块, ...images.map(p => ({ type: 'image', imagePath: p, mime: mimeOf(p) }))]`（`mimeOf` 按扩展名 png/jpeg/gif/webp，与 mirror `IMAGE_MIME` 口径一致——core 若无则 service 内私有小函数）；发送校验路径必在 `attachments/` 前缀下（防任意路径注入引用越界图）
- [ ] **Step 3: 测试**：session.spec 增「send 带 images → 消息 blocks 含 image 块（imagePath 原样）；越界前缀拒」；`npm run test -w apps/tianshu-server`
- [ ] **Step 4: 提交**：`feat(server): sessionSend 扩 images——ImageBlock 落库与回喂（FA-T1）`

---

### Task 5: face 桥三端点

**Files:**
- Modify: `electron/domains/server-face/routes.ts`（路由表三端点）
- Modify: `electron/domains/ai/chat/pasted-image-store.ts` 或新增 `electron/domains/server-face/files-tap.ts`（uploadImage 落盘复用 attachmentsDir）
- Test: `tests/ai/server-face/routes.test.ts`（扩用例）

**Interfaces:**
- Consumes: core `listWorkspaceFiles`/`readTextFileGuarded`；Task 2 capabilities
- Produces: face 面 `files/list|read|uploadImage`（与无头端同 DTO/错误码语义）

- [ ] **Step 1: 写失败测试**（routes.test 模式——vi.mock 三桩先例；临时目录 workspace）
- [ ] **Step 2: 实现**：路由表三键（`files/list`、`files/read`、`files/uploadImage`）；list/read 走 core 共享函数（workspace 查 prisma stub 面同现有 session 桥的 workspace 读取口径）；uploadImage 落 `attachmentsDir()`（electron paths）+ 3MB 上限 + 返回相对路径（`path.relative(appDataHome(), abs)`——face 的数据根即本机 appDataHome）；错误码 bizError 同无头端（FILES_NO_WORKSPACE/FILES_PATH_ESCAPE/FILES_IMAGE_TOO_LARGE）
- [ ] **Step 3: capabilities 断言随 Task 2 已跟随**；测试过：`npx vitest run tests/ai/server-face/`
- [ ] **Step 4: 提交**：`feat(server-face): files 三端点桥——桌面被控面文件能力（FA-T2）`

---

### Task 6: 渲染层 caps 动态 + remote-files 适配器

**Files:**
- Modify: `src-react/domains/ai/data-source/host.store.ts`（`capsOfCapabilities` files 推导）
- Create: `src-react/domains/ai/data-source/remote-files.ts`
- Modify: `src-react/domains/ai/server/api/server.api.ts`（ServerApi 三方法）
- Test: `tests/ai/data-source/files-route.test.ts`

**Interfaces:**
- Produces:
  - `capsOfCapabilities` 中 `files: has("files")`
  - `remoteFiles.list(connId): Promise<string[] | null>`、`remoteFiles.read(relPath, connId): Promise<{ filePath: string; content?: string; error?: string }>`、`remoteFiles.uploadImage(input, connId): Promise<{ imagePath: string }>`
  - `ServerApi.filesList(workspaceId, connId)`、`ServerApi.filesRead(workspaceId, path, connId)`、`ServerApi.filesUploadImage(input, connId)`

- [ ] **Step 1: 写失败测试**（mock server.api 模式同 chat-route.test.ts：capsOfCapabilities(['chat']) → files false；['chat','files'] → true；适配器三方法映射端点载荷）
- [ ] **Step 2: 实现**（适配器形状转换：filesRead 结果映射本地 readExternalFile 返回形状 `{ filePath, content } | { filePath, error }`——reason 映射错误文案「超过 512KB 上限」/「二进制文件不支持」对齐本地）
- [ ] **Step 3: 测试过 + 提交**：`feat(arch): caps.files 动态化 + remote-files 适配器（FA-T3）`

---

### Task 7: 渲染层三通道调用点路由化

**Files:**
- Modify: `src-react/domains/ai/chat/components/ChatInput.tsx`（workspaceFilesQuery 的 invoke、pasteAttachments 的 readExternalFile/savePastedImage invoke）
- Modify: `src-react/domains/ai/chat/components/ChatPane.tsx`（发送链文件内容注入的 readExternalFile 消费点——grep `readExternalFile` 全部出现处逐一 routeInvoke 化）
- Test: `tests/ai/data-source/files-route.test.ts`（扩调用点用例）

**Interfaces:**
- Consumes: Task 6 适配器；routeInvoke

- [ ] **Step 1: grep 全部 `file:listWorkspaceFiles`/`file:readExternalFile`/`file:savePastedImage` 渲染层 invoke 点，逐处改 `routeInvoke({ ch, args }, remote)` 模式（本地参数逐字）**
- [ ] **Step 2: ChatInput 门控复核**：caps.files 现在 remote 可真——@ 联想/粘贴/compact 门控逻辑不动（值动态化自动跟随）；跑 ChatInput 相关测试
- [ ] **Step 3: 全量回归 + 提交**：`feat(arch): 文件三通道 api 主机路由化（FA-T3）`

---

### Task 8: send images 远程链 + 上限差异化

**Files:**
- Modify: `src-react/domains/ai/chat/components/ChatInput.tsx`（远程态粘贴图片：blobToBase64 暂存 pill 不落盘）
- Modify: `src-react/domains/ai/chat/components/ChatPane.tsx`（发送链远程分支：逐图 uploadImage → sessionSend.images）
- Modify: `src-react/domains/ai/api/chat.api.ts`（send 远程分支携 images）
- Modify: i18n `src-react/i18n/locales/{zh-CN,en-US}/chat.json`（上限 toast 文案）
- Test: `tests/ai/data-source/files-route.test.ts`（扩 send images 用例）

**Interfaces:**
- Consumes: Task 4 send images 端点；Task 6 uploadImage
- Produces: 远程发送带图链路（3MB 预检 → base64 → uploadImage → sessionSend images）

- [ ] **Step 1: 写失败测试**（ChatApi.send 远程分支携 images 参数映射；超限预检 toast 路径）
- [ ] **Step 2: 实现**：`PastedFileEntry` 扩可选 `base64?`（远程态粘贴 blob→base64 暂存）；ChatPane 发送链远程分支逐图 `remoteFiles.uploadImage` → 失败该图 toast 降级（不中断发送，对齐本地「收编失败保留原路径」语义——远程失败则剔除该图并提示）；3MB 预检在挂 pill 时（远程态 `isOverLimit` 换 3MB 阈值 + `chat:paste.remoteImageTooLarge` 文案）
- [ ] **Step 3: 测试 + 全量 + 提交**：`feat(arch): 远程发送图片链——上传远端 attachments 进 ImageBlock（FA-T3）`

---

### Task 9: E2E + 回归收尾（FA-T4）

**Files:**
- Modify: `tests/ai/server/e2e-smoke.ts`（direct + relay 链路各增 files 三端点冒烟：建 workspace（directoryPath=tmp）→ list 断言清单 → read 断言内容 → uploadImage 断言相对路径 → send 带 images 断言消息含 image 块）
- Test: 全量

- [ ] **Step 1: e2e-smoke 扩用例**（真 server 子进程 + relay 子进程既有基建）
- [ ] **Step 2: 跑** `npm run test:e2e:server` 全 PASS（含新 files 段）
- [ ] **Step 3: 全量三端回归**：mirror `npm run test`（3825 基线零新增）；server `npm run test -w apps/tianshu-server`；`npm run check:drift`（core 收编后清单无新增双份）
- [ ] **Step 4: 提交**：`test(e2e): files 端点直连+中继冒烟（FA-T4）`
