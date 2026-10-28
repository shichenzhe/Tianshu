# 移动端能力对齐（MB 批）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移动端接上桌面单 UI 的三项核心能力——图片多模态发送、会话列表 workspace 分组、消息重生成。

**Architecture:** 全部走既有远控协议端点（files/uploadImage、workspace/query、session/regenerate）与既有 store/transport 分层；capabilities 协商门禁复用 `useConnectionCapabilities`；渲染侧零改动（MessageImage 已闭环）。

**Tech Stack:** Expo SDK 57（React Native + expo-router + zustand + NativeWind）、expo-image-picker + expo-file-system（base64）、@tianshu/protocol ENDPOINTS。

**Spec:** `docs/superpowers/specs/2026-10-20-mobile-align-design.md`

## Global Constraints

- 图片链上限 3MB（base64 前，relay 4MiB 余量——与桌面/被控端同值）；选图压缩 quality 0.7
- capabilities 无 `files` 时附件按钮不渲染（旧被控端零迁移）
- mobile 测试：`npm run test -w apps/tianshu-mobile`（vitest）+ `npm run typecheck -w apps/tianshu-mobile`
- mobile i18n：`src/i18n/locales/` 双语同步（zh-CN/en-US）
- 协议端点常量用 `@tianshu/protocol` 的 `ENDPOINTS`（改协议源码后先重建 dist）

---

### Task 1: 图片发送链（选图 → 上传 → send images）

**Files:**
- Modify: `apps/tianshu-mobile/package.json`（+expo-image-picker）
- Create: `apps/tianshu-mobile/src/logic/image-pick.ts`（选图+压缩+base64+上限预检纯逻辑封装）
- Test: `apps/tianshu-mobile/src/logic/image-pick.test.ts`
- Modify: `apps/tianshu-mobile/src/components/Composer.tsx`（附件按钮 + 暂存 pill）
- Modify: `apps/tianshu-mobile/src/store/stream.store.ts`（`startSend` 扩 `images`；新增 `uploadAndSend`）
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx`（接线 onSend 携图）
- Modify: i18n `apps/tianshu-mobile/src/i18n/locales/*`

**Interfaces:**
- Consumes: `useConnectionCapabilities(connId): string[] | null`（connections.store 既有）；`request(path, body)`（stream.store 既有私有——上传走 store 内新 action）；`activeTransport()`
- Produces:
  - `pickImageAsBase64(): Promise<{ name: string; base64: string } | null>`（null=取消；超 3MB 抛 `ImageTooLargeError`）
  - `startSend(sessionId: number, content: string, modelId?: number, images?: Array<{ name: string; base64: string }>): Promise<boolean>`（内部逐图 uploadImage 得 imagePath 后随 send 上行）

- [ ] **Step 1: 装依赖**：`npm install expo-image-picker --save -w apps/tianshu-mobile`（SDK 57 配套版本自动解析）
- [ ] **Step 2: 写失败测试**（image-pick.test.ts——picker 模块 mock；纯函数测上限判定与名称派生）

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system", () => ({
  readAsStringAsync: vi.fn(async () => "aGVsbG8="),
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn(),
}));

import { IMAGE_LIMIT_BYTES, assertWithinLimit } from "./image-pick";

describe("image-pick 上限", () => {
  it("3MB 边界：等值过、超一拒", () => {
    expect(IMAGE_LIMIT_BYTES).toBe(3 * 1024 * 1024);
    expect(() => assertWithinLimit(IMAGE_LIMIT_BYTES)).not.toThrow();
    expect(() => assertWithinLimit(IMAGE_LIMIT_BYTES + 1)).toThrowError(/3MB/);
  });
});
```

- [ ] **Step 3: 跑红**：`npm run test -w apps/tianshu-mobile` → image-pick 模块不存在 FAIL
- [ ] **Step 4: 实现 image-pick.ts**

```ts
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

export const IMAGE_LIMIT_BYTES = 3 * 1024 * 1024;

export class ImageTooLargeError extends Error {
  constructor() {
    super("图片超过 3MB 上限（远程主机链路）");
  }
}

/** base64 解码后字节估算（4/3 折算） */
export function decodedBytesOf(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function assertWithinLimit(byteSize: number): void {
  if (byteSize > IMAGE_LIMIT_BYTES) throw new ImageTooLargeError();
}

/** 系统选图（压缩 0.7）→ base64（超限抛 ImageTooLargeError；取消 null） */
export async function pickImageAsBase64(): Promise<{
  name: string;
  base64: string;
} | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.7,
    allowsMultipleSelection: false,
  });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0];
  const base64 = await FileSystem.readAsStringAsync(asset.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  assertWithinLimit(decodedBytesOf(base64));
  const name = asset.fileName ?? asset.uri.split("/").pop() ?? "image.png";
  return { name, base64 };
}
```

- [ ] **Step 5: 测试过 + 提交**：`feat(mobile): 选图链——压缩 base64 与 3MB 预检（MB-T1）`

- [ ] **Step 6: stream.store 扩**：`startSend` 第四参 `images?: Array<{ name: string; base64: string }>`——发送前逐张 `request(ENDPOINTS.files.uploadImage, { name, base64 })` 得 `imagePath`（失败该图跳过不阻断）；send 载荷 `...(imagePaths.length > 0 ? { images: imagePaths } : {})`；startSend 内单测扩 images 载荷断言（store 测试文件已有 mock request 模式）
- [ ] **Step 7: Composer 扩**：props 增 `filesCap: boolean` 与 `onPickImage: () => void`；`filesCap` 时渲染附件按钮（Paperclip）+ 已选图 pill（名称 + 移除）；图片暂存于会话页 state（`pendingImage: { name, base64 } | null`）传 onSend
- [ ] **Step 8: [id].tsx 接线**：`const caps = useConnectionCapabilities(activeConnId)`；`filesCap = caps?.includes("files") ?? false`；onSend 把 pendingImage 组数组传 startSend；发送成功清 pill；ImageTooLargeError toast（i18n `chat:imageTooLargeMobile`）
- [ ] **Step 9: i18n 双语 + 全套测试 + 提交**：`feat(mobile): 图片发送链——uploadImage → sessionSend images（MB-T1）`

---

### Task 2: 会话列表 workspace 分组

**Files:**
- Create: `apps/tianshu-mobile/src/logic/workspace-grouping.ts` + `workspace-grouping.test.ts`
- Modify: `apps/tianshu-mobile/src/store/sessions.store.ts`（SessionRow + workspaceId 字段；加载时并行拉 workspace/query 存 `workspaces`）
- Modify: `apps/tianshu-mobile/src/app/index.tsx`（FlatList → SectionList）

**Interfaces:**
- Produces:
  - `groupSessionsByWorkspace(rows: SessionRow[], workspaces: Array<{ id: number; name: string }>): Array<{ key: string; title: string; data: SessionRow[] }>`（未匹配进「未归属」组；组按 workspace id 升序、未归属沉底；组内保持原排序）

- [ ] **Step 1: 写失败测试**（纯函数：两空间归组/未匹配兜底组/空表）
- [ ] **Step 2: 实现纯函数**（见接口签名；「未归属」标题 i18n key `chat:ungrouped` 由调用侧传 title，函数收 `fallbackTitle` 参数）
- [ ] **Step 3: sessions.store**：SessionRow 增 `workspaceId?: number | null`（query 行透传）；state 增 `workspaces: Array<{ id: number; name: string }>`，`load()` 并行 `request(ENDPOINTS.workspace.query, {})`（失败空表——分组退化为全未归属，不阻断列表）
- [ ] **Step 4: index.tsx 换 SectionList**（组头空间名样式对齐既有组头；`renderItem` 复用 SessionRow 组件）
- [ ] **Step 5: i18n + 测试 + 提交**：`feat(mobile): 会话列表 workspace 分组（MB-T2）`

---

### Task 3: 消息重生成

**Files:**
- Modify: `apps/tianshu-mobile/src/store/stream.store.ts`（新 action `regenerate(sessionId: number): Promise<boolean>`——`request(ENDPOINTS.session.regenerate, { sessionId })`，受理即置 sending/live 复位）
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx`（末条 assistant 长按菜单）
- Test: `apps/tianshu-mobile/src/store/stream.store.test.ts`（regenerate action 用例）

**Interfaces:**
- Consumes: `ENDPOINTS.session.regenerate`（protocol 既有）
- Produces: `useStreamStore.getState().regenerate(sessionId)`（bool=受理）

- [ ] **Step 1: 写失败测试**（mock request ok/失败两态：受理置 sending、失败置 error）
- [ ] **Step 2: 实现 action**（受理由既有 startStream 语义借用：live 复位 + sending true；finish/error chunk 既有链收口）
- [ ] **Step 3: [id].tsx**：FlatList 行 role=assistant 且非流中（`!sending`）时 `onLongPress` 弹 Alert.alert 双按钮（重新生成/取消）→ regenerate；i18n `chat:regenerate`/`common:cancel`
- [ ] **Step 4: 测试 + 提交**：`feat(mobile): 消息重生成——长按菜单（MB-T3）`

---

### Task 4: 回归收尾

- [ ] **Step 1**: `npm run test -w apps/tianshu-mobile` 全绿；`npm run typecheck -w apps/tianshu-mobile` 无错
- [ ] **Step 2**: mirror 全量 `npm run test` 零新增失败（协议包未动——纯消费端改动，基线 3840+）
- [ ] **Step 3**: 提交收尾（若有无谓零散改动归并）
