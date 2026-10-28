# 天枢移动端遥控 app 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机（Expo iOS/Android）遥控天枢无头服务端或桌面端：连接管理、会话列表/历史/流式回显/发送/中止、审批应答、模型选择、图片只读。

**Architecture:** 移动端是第三个控制端，消费既有双承载同构协议（direct HTTP+SSE / relay WS 隧道），不新造协议。新仓 `tianshu-mobile` 经 `file:` 依赖 `@tianshu/protocol`（tianshu-server 同款）。mirror 与 tianshu-server 各补小端点（approve / provider-query / image）打通审批闭环与模型/图片面。

**Tech Stack:** Expo（最新稳定 SDK）+ expo-router + NativeWind 4 + zustand + react-i18next + vitest（纯函数层）；mirror 侧 vitest；tianshu-server 侧 jest。

**Spec:** `docs/superpowers/specs/2026-10-17-tianshu-mobile-design.md`（mirror 仓）——计划从 spec 立论，执行者两份都读。

## Global Constraints

- 三仓路径：mirror = `/Users/hjx/workspace/mirror`；tianshu-server = `/Users/hjx/workspace/tianshu-server`；移动端新仓 = `/Users/hjx/workspace/tianshu-mobile`。
- 协议包改源码后必须 `npm --prefix packages/tianshu-protocol run build` 重建 dist，tianshu-server 侧 `file:` symlink 直读（重启生效），移动端同款消费。
- 业务错判定：**查 `body.success` 勿只看 HTTP status**（HTTP 200 + `code:"4040"/"5000"` 包装）；成功包装 `{code:"2000",success:true,data,message:"success"}`。
- 事件 payload 的 `updatedAt` 一律 ISO 字符串（wire 口径，勿 `new Date(str)` 假设时区）。
- mirror 代码风格：双引号、分号、tabWidth=2、printWidth=80、无尾随逗号、生产环境禁 console；文件名 kebab-case；UI 文案走 i18n（zh-CN/en-US 双份 key），禁止硬编码用户可见文本。
- relay 接入：`<relayUrl>?role=client&token=<relayToken>`，`open` 帧带目标 `connectionId`（= 被控端 instanceId）。
- 被控端 approve 不匹配 pending 返回业务错 4040（幂等口径）。
- 移动端只依赖 `@tianshu/protocol`，**禁止**引入 `@tianshu/core`（LangChain peer 链）。
- 镜像语义蓝本：移动端 transport 状态机对照 mirror `electron/domains/server/{transport,direct-transport,relay-transport}.ts`，逻辑层纯函数对照 mirror `src-react/domains/ai/chat/lib/` 与 `src-react/domains/ai/server/lib/remote-stream.ts`。

---

### Task 1: 协议包扩展（approve + image 契约）

**Files:**
- Modify: `packages/tianshu-protocol/src/chat-contract.ts`（mirror 仓）
- Modify: `packages/tianshu-protocol/src/server-event.ts`（mirror 仓）

**Interfaces:**
- Produces: `ApproveParams`、`ImagePayload` 类型；`ENDPOINTS.session.approve = "session/approve"`、`ENDPOINTS.image = "image"`。Task 3/4（服务端）与 Task 12+（移动端）消费。

- [ ] **Step 1: 加类型与端点常量**

`chat-contract.ts` 末尾追加（与现有 `ChatSendParams` 同风格）：

```typescript
/** 审批应答（移动端 spec §4.1）：批准/拒绝挂起的 write 工具调用 */
export interface ApproveParams {
  sessionId: number;
  toolCallId: string;
  approved: boolean;
}

/** 图片读取响应（移动端 spec §4.2）：base64 单一形态，direct/relay 同构 */
export interface ImagePayload {
  mime: string;
  dataBase64: string;
}
```

`server-event.ts` 的 `ENDPOINTS` 中 `session` 组加一行、顶层加 `image`：

```typescript
export const ENDPOINTS = {
  info: "info",
  session: {
    create: "session/create",
    query: "session/query",
    getById: "session/getById",
    delete: "session/delete",
    send: "session/send",
    abort: "session/abort",
    approve: "session/approve",
  },
  provider: {
    query: "provider/query",
    save: "provider/save",
  },
  image: "image",
} as const;
```

- [ ] **Step 2: 类型检查 + 重建 dist**

Run: `npm run typecheck && npm --prefix packages/tianshu-protocol run build`
Expected: 两命令均 0 error，`packages/tianshu-protocol/dist/chat-contract.d.ts` 含 `ApproveParams`。

- [ ] **Step 3: 确认下游零破坏**

Run: `npm run typecheck && npm run test -- --run tests/ai/server-face`
Expected: typecheck 过、server-face 既有测试全绿（只加键不改旧键，应零影响）。

- [ ] **Step 4: Commit**

```bash
git add packages/tianshu-protocol
git commit -m "feat(protocol): session/approve 与 image 端点契约（移动端 spec §4.1）"
```

---

### Task 2: mirror 审批超时 + ChatService 应答公开包装

**Files:**
- Modify: `electron/domains/ai/agent/approval.ts`
- Modify: `electron/domains/ai/chat/chat.service.ts`（约 L331 附近加公开方法）
- Test: `tests/ai/agent/approval-timeout.test.ts`（新建）

**Interfaces:**
- Produces: `ApprovalCoordinator.request(toolCallId, argSummary, timeoutMs?)`（新增可选超时，缺省 10 分钟自动 deny）；`ChatService.respondApproval(toolCallId, approved): boolean`（Task 3 的 face deps 消费）。
- Consumes: 既有 `respond/voidAll` 签名不变。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/ai/agent/approval-timeout.test.ts
import { describe, expect, it, vi } from "vitest";
import { ApprovalCoordinator } from "../../../../electron/domains/ai/agent/approval";

describe("ApprovalCoordinator 超时", () => {
  it("超时自动 deny（缺省 10 分钟）", async () => {
    vi.useFakeTimers();
    const c = new ApprovalCoordinator();
    const p = c.request("tc1", "摘要");
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await expect(p).resolves.toBe(false);
    expect(c.pendingCount).toBe(0);
    vi.useRealTimers();
  });

  it("respond 清理定时器，不重复触发", async () => {
    vi.useFakeTimers();
    const c = new ApprovalCoordinator();
    const p = c.request("tc2", "摘要");
    expect(c.respond("tc2", true)).toBe(true);
    await expect(p).resolves.toBe(true);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(c.respond("tc2", true)).toBe(false); // 已决议，二次应答 false
    vi.useRealTimers();
  });

  it("自定义超时可立即到期", async () => {
    vi.useFakeTimers();
    const c = new ApprovalCoordinator();
    const p = c.request("tc3", "摘要", 50);
    vi.advanceTimersByTime(51);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- --run tests/ai/agent/approval-timeout`
Expected: FAIL（`request` 无第三参、超时不生效）。

- [ ] **Step 3: 实现**

`approval.ts` 全量替换为：

```typescript
/**
 * 审批协调器：write 工具挂起等待渲染层决议（P1 spec §1 审批挂起）。
 * 超时自动 deny（移动端 spec §4.2：远控应答方不在线时防永久挂死，
 * 桌面远控台同受益）；缺省 10 分钟，request 可按需覆盖。
 */
type Resolver = (approved: boolean) => void;

/** 缺省审批挂起上限：10 分钟无应答自动拒绝 */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingEntry {
  resolve: Resolver;
  timer: NodeJS.Timeout;
}

export class ApprovalCoordinator {
  private pending = new Map<string, PendingEntry>();

  get pendingCount(): number {
    return this.pending.size;
  }

  request(
    toolCallId: string,
    _argSummary: string,
    timeoutMs: number = APPROVAL_TIMEOUT_MS,
  ): Promise<boolean> {
    // _argSummary 供后续渲染层审批弹窗展示，协调器自身不存储
    void _argSummary;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(toolCallId, false), timeoutMs);
      // promise resolve 后不保活进程（远控长挂起场景不阻退出）
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(toolCallId, { resolve, timer });
    });
  }

  respond(toolCallId: string, approved: boolean): boolean {
    return this.settle(toolCallId, approved);
  }

  /** 决议单一出口：命中即清定时器并出队，未命中返回 false */
  private settle(toolCallId: string, approved: boolean): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(toolCallId);
    entry.resolve(approved);
    return true;
  }

  /** 中断/窗口销毁：作废全部（resolve false），返回作废数量 */
  voidAll(): number {
    const count = this.pending.size;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
    return count;
  }
}
```

`chat.service.ts`：`private approvals = new ApprovalCoordinator();`（L331 附近）之后加公开方法（放类的公开方法区，`stop` 之类附近）：

```typescript
  /** 远控审批应答（server-face session/approve 转发；不匹配 pending 返 false） */
  respondApproval(toolCallId: string, approved: boolean): boolean {
    return this.approvals.respond(toolCallId, approved);
  }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npm run test -- --run tests/ai/agent && npm run typecheck`
Expected: 新测试 3 个全过、agent 域既有测试无回归、typecheck 过。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/agent/approval.ts electron/domains/ai/chat/chat.service.ts tests/ai/agent/approval-timeout.test.ts
git commit -m "feat(approval): 审批挂起 10 分钟超时自动 deny + ChatService.respondApproval 公开包装"
```

---

### Task 3: mirror server-face 三端点（approve / provider-query / image）

**Files:**
- Modify: `electron/domains/server-face/deps.ts`
- Modify: `electron/domains/server-face/routes.ts`
- Modify: `electron/domains/server-face/ipc.ts`（attachServerFace 注入）
- Modify: `electron/Application.ts:415`（调用处增传）
- Test: `tests/ai/server-face/server-face.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `ApproveParams`/`ImagePayload`；Task 2 的 `ChatService.respondApproval`；既有 `ProviderRepository.list(userId)`、`ModelRepository.listAll(userId)`、`appDataHome()`（`electron/commons/paths.ts`）。
- Produces: `POST session/approve`、`POST provider/query`、`POST image` 三个路由（HTTP 面与 relay 帧共用）；`ServerFaceDeps` 增 `approvals`/`providers`/`images` 三依赖（测试替身接口）。

- [ ] **Step 1: 写失败测试（先看既有替身模式）**

先读 `tests/ai/server-face/server-face.test.ts` 头部（setServerFaceDeps 内存替身 + handleRoute 直调模式），按同款追加 describe 块：

```typescript
describe("approve / provider / image 三新端点", () => {
  it("session/approve 转发应答，未命中 pending 返回 4040", async () => {
    const res = await handleRoute("POST", "session/approve", {
      sessionId: 1,
      toolCallId: "tc-x",
      approved: true,
    });
    expect(res.body).toMatchObject({ code: "4040", success: false });
    // 替身 respond 返回 false → 4040；命中时返回 2000（见下一断言组）
  });

  it("session/approve 参数不合法返回 5000", async () => {
    const res = await handleRoute("POST", "session/approve", { approved: 1 });
    expect(res.body).toMatchObject({ code: "5000", success: false });
  });

  it("provider/query 返回 providers+models 全量", async () => {
    const res = await handleRoute("POST", "provider/query", null);
    expect(res.body).toMatchObject({
      success: true,
      data: { providers: expect.any(Array), models: expect.any(Array) },
    });
  });

  it("image 路径逃逸数据根返回 4040", async () => {
    const res = await handleRoute("POST", "image", { path: "../../etc/passwd" });
    expect(res.body).toMatchObject({ code: "4040", success: false });
  });

  it("image 白名单外扩展名返回 4040", async () => {
    const res = await handleRoute("POST", "image", { path: "logs/x.txt" });
    expect(res.body).toMatchObject({ code: "4040", success: false });
  });
});
```

替身注入（在该测试文件的 deps 组装处扩展——照既有 setServerFaceDeps 调用样例加三个键）：

```typescript
    approvals: {
      respond: (toolCallId: string, _approved: boolean) => toolCallId === "tc-hit",
    },
    providers: {
      listBundle: async () => ({ providers: [], models: [] }),
    },
    images: {
      readImage: async () => null,
    },
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- --run tests/ai/server-face`
Expected: 新用例 FAIL（路由不存在 → 4040「接口不存在」，与期望断言不符）。

- [ ] **Step 3: deps.ts 扩展**

`ServerFaceDeps` 接口追加（import 处补 `ApproveParams, ImagePayload` from `@tianshu/protocol`——mirror 内 alias 已覆盖 `packages/tianshu-protocol/src`，与 server-event 同款 import 路径 `@tianshu/protocol`）：

```typescript
/** 审批应答桥（ChatService.respondApproval 满足） */
export interface ServerFaceApprovals {
  respond(toolCallId: string, approved: boolean): boolean;
}

/** 模型配置查询桥（provider/query 数据源） */
export interface ServerFaceProviders {
  listBundle(userId: number): Promise<{
    providers: unknown[];
    models: unknown[];
  }>;
}

/** 图片读取桥（image 端点数据源；不可读返回 null） */
export interface ServerFaceImages {
  readImage(imagePath: string): Promise<ImagePayload | null>;
}
```

`ServerFaceDeps` 加三成员：`approvals: ServerFaceApprovals; providers: ServerFaceProviders; images: ServerFaceImages;`

- [ ] **Step 4: routes.ts 加三 handler + 注册 ROUTES**

```typescript
import {
  ApproveParams,
  ImagePayload,
} from "@tianshu/protocol";
```

（放在既有 import 区；若 routes.ts 现 import 走相对路径到 protocol 包，按仓库现状统一。）handler 实现：

```typescript
async function handleApprove(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Partial<ApproveParams>;
  if (
    typeof p.sessionId !== "number" ||
    typeof p.toolCallId !== "string" ||
    typeof p.approved !== "boolean"
  ) {
    return bizError("5000", "sessionId/toolCallId/approved 参数不合法");
  }
  // 会话归属不校验（审批卡产生于已校验归属的会话流内，toolCallId
  // 一次性；与渲染层 agent:approve 同口径——chat.service.ts L408 注记）
  const hit = faceDeps().approvals.respond(p.toolCallId, p.approved);
  if (!hit) {
    return bizError("4040", "审批不存在或已应答");
  }
  return ok({ responded: true });
}

async function handleProviderQuery(): Promise<RouteResult> {
  return withUserId(async (userId) =>
    ok(await faceDeps().providers.listBundle(userId)),
  );
}

/** 图片扩展名 → mime 白名单（其余一律拒绝） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function handleImage(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { path?: unknown };
  if (typeof p.path !== "string" || p.path === "") {
    return bizError("5000", "path 参数不合法");
  }
  const payload = await faceDeps().images.readImage(p.path);
  if (!payload) {
    return bizError("4040", "图片不存在或不可读");
  }
  return ok(payload);
}
```

ROUTES 表追加：

```typescript
  "POST session/approve": handleApprove,
  "POST provider/query": handleProviderQuery,
  "POST image": handleImage,
```

- [ ] **Step 5: 路径安全读取实现（workspace-files.ts）+ 装配**

`electron/domains/ai/chat/workspace-files.ts` 追加导出（文件已 import path/fs 与 root 解析，同款风格；`appDataHome` 从 `../../commons/paths` import）：

```typescript
/** 防穿越图片读取（server-face image 端点）：resolve 后必须落在数据根
 * 分组内 + 扩展名 mime 白名单；≤10MB；不可读返回 null（4040 由调用方包装） */
export async function readImageWithinRoot(
  imagePath: string,
): Promise<{ mime: string; dataBase64: string } | null> {
  const root = appDataHome();
  const abs = path.resolve(root, imagePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return null;
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (!mime) {
    return null;
  }
  try {
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) {
      return null;
    }
    const buf = await fs.promises.readFile(abs);
    return { mime, dataBase64: buf.toString("base64") };
  } catch {
    return null;
  }
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
```

（若该文件已有同名白名单常量则复用不重定义；`IMAGE_MIME_BY_EXT` 在两文件重复时留在 workspace-files.ts 一份，routes.ts 不再定义。）

`ipc.ts` 的 `attachServerFace`：`setServerFaceDeps({...})` 增三键（import 补 `readImageWithinRoot`、`appDataHome`）：

```typescript
    approvals: {
      respond: (toolCallId, approved) =>
        deps.chatService.respondApproval(toolCallId, approved),
    },
    providers: {
      listBundle: async (userId) => ({
        providers: await deps.providerRepo.list(userId),
        models: await deps.modelRepo.listAll(userId),
      }),
    },
    images: {
      readImage: (imagePath) => readImageWithinRoot(imagePath),
    },
```

`attachServerFace` 签名加 `providerRepo: ProviderRepository; modelRepo: ModelRepository;`；`Application.ts:415` 调用处改为：

```typescript
  attachServerFace({
    sessions: sessionRepo,
    chatService,
    providerRepo,
    modelRepo,
  });
```

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `npm run test -- --run tests/ai/server-face tests/ai/server && npm run typecheck && npm run lint`
Expected: 全绿（含既有用例零回归）。

- [ ] **Step 7: Commit**

```bash
git add electron/domains/server-face electron/domains/ai/chat/workspace-files.ts electron/Application.ts tests/ai/server-face
git commit -m "feat(server-face): approve/provider-query/image 三端点（审批闭环+模型面+图片只读）"
```

---

### Task 4: tianshu-server manual 审批模式 + approve 端点

**Files:**
- Modify: `src/commons/config/tianshu-config.entity.ts`（tianshu-server 仓；`ChatAccessMode` 加 `'manual'`、加 `approvalTimeoutMs`）
- Modify: `src/core/tools/approval.ts`（request 加超时）
- Modify: `src/core/chat-runner.service.ts`（L505-513 分支 manual）
- Modify: `src/modules/session/session.controller.ts` + 新建 `src/modules/session/dto/session-approve.dto.ts`
- Test: `test/core/approval.spec.ts`（追加）、`test/modules/session-approve.spec.ts`（新建，若 modules 下无该文件模式则照 `test/modules/` 既有 spec 风格）

**Interfaces:**
- Consumes: Task 1 的 `ApproveParams`（`@tianshu/protocol` 需先 `npm run sync:core` 同步 dist——见 Step 1）；既有 `ChatRunnerService.approve(toolCallId, approved): boolean`（L297，零改动）。
- Produces: `POST session/approve`；`accessMode: 'manual'`（挂起等应答，超时自动 deny）。

- [ ] **Step 1: 同步协议包 dist**

Run: `npm run sync:core`
Expected: `@tianshu/protocol` 新 dist（含 ApproveParams）装入 node_modules symlink。

- [ ] **Step 2: 写失败测试**

`test/core/approval.spec.ts` 追加（照该文件既有 jest 风格）：

```typescript
describe("request 超时", () => {
  it("超时自动 deny 并清理 pending", async () => {
    jest.useFakeTimers();
    const c = new ApprovalCoordinator();
    const p = c.request("tc1", "s");
    jest.advanceTimersByTime(300_001);
    await expect(p).resolves.toBe(false);
    expect(c.pendingCount).toBe(0);
    jest.useRealTimers();
  });
});
```

`test/modules/session-approve.spec.ts` 骨架（照 modules 下既有 controller spec 的注入模式；无现成模式则直测 ChatRunnerService.approve 经 controller 的薄转发用 supertest——**优先**照 `test/modules/` 任一现存 spec 抄装配）：

```typescript
// 核心断言（装配照抄同目录既有 spec）：
// 1. POST session/approve {sessionId:1, toolCallId:"tc-x", approved:true}
//    → 2000 成功（替身 approve 返回 true）
// 2. 同参再发一次 → 4040 业务错（approve 返回 false，包装 success:false）
// 3. 缺 toolCallId → 400 校验错
```

manual 模式测试（`test/core/chat-runner.spec.ts` 追加，照既有 runChatStream mock 模式）：

```typescript
it("manual 模式 requestApproval 挂起等待 approvals.request，autoDenyApprovals=false", async () => {
  // config.accessMode='manual' 时：agent.requestApproval('tc1','摘要') 的
  // 返回 === approvals.request 同一 Promise（ spyOn approvals.request 透传），
  // 且传给 runChatStream 的 autoDenyApprovals === false；
  // accessMode='default' 时 requestApproval resolve(false) 且 autoDenyApprovals=true
  // （断言 assembleContext 产出的 agent 参数对象——照既有用例对 ctx 的取法）
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -- approval session-approve chat-runner`
Expected: 新用例 FAIL。

- [ ] **Step 4: 实现**

`tianshu-config.entity.ts`：`ChatAccessMode` 联合类型加 `| 'manual'`；tianshu.chat 配置段加 `approvalTimeoutMs?: number`（缺省 300_000，读处 `?? 300_000`）。

`src/core/tools/approval.ts`：request 加缺省超时参数（与 mirror Task 2 同构实现——pending 存 `{resolve, timer}`，settle 单一出口清 timer；缺省 `300_000`，由 chat-runner 传 config 值）。

`chat-runner.service.ts` L510-513 处（真实参数名以 `src/core/tools/tool-gate.ts:62` 接口为准——`requestApproval: (toolCallId, argSummary) => Promise<boolean>`，现传少参箭头函数是 TS 兼容写法；挂起时 tool-gate L164-185 已自动推 `awaiting-approval` 与 `approval-request` 两 chunk）改为：

```typescript
        // manual 模式挂起等远程应答（session/approve），超时自动 deny
        requestApproval: (toolCallId, argSummary) =>
          config.accessMode === 'auto-approve'
            ? Promise.resolve(true)
            : config.accessMode === 'manual'
              ? this.approvals.request(
                  toolCallId,
                  argSummary,
                  config.approvalTimeoutMs ?? 300_000,
                )
              : Promise.resolve(false),
        autoDenyApprovals: !(
          config.accessMode === 'auto-approve' || config.accessMode === 'manual'
        ),
```

`dto/session-approve.dto.ts`：

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsString } from 'class-validator';

export class SessionApproveDto {
  @ApiProperty({ description: '会话 id' })
  @IsInt()
  sessionId: number;

  @ApiProperty({ description: '待应答工具调用 id' })
  @IsString()
  toolCallId: string;

  @ApiProperty({ description: '批准与否' })
  @IsBoolean()
  approved: boolean;
}
```

`session.controller.ts` 追加（照既有 @Public + @Post 风格，注入 ChatRunnerService——module providers 里已注册则直注，否则 session.module.ts 补 import）：

```typescript
  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '审批应答（manual 模式挂起流的远程决议）' })
  async approve(@Body() dto: SessionApproveDto): Promise<{ responded: boolean }> {
    // 不匹配 pending（已应答/不存在）→ 4040 业务错，与 mirror face 口径对齐
    // （BusinessException 抛法照 session.service.ts L104 同款）
    if (!this.chatRunner.approve(dto.toolCallId, dto.approved)) {
      throw new BusinessException('审批不存在或已应答', ErrorCodeEnum.NOT_FOUND);
    }
    return { responded: true };
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test`
Expected: 全量绿（含既有 chat-runner/approval/spec 零回归）。

- [ ] **Step 6: Commit（tianshu-server 仓）**

```bash
git add src test
git commit -m "feat(session): session/approve 端点 + accessMode manual 挂起应答（超时自动 deny）"
```

---

### Task 5: 移动端仓脚手架 + expo/fetch SSE 技术验证

**Files:**
- Create: `/Users/hjx/workspace/tianshu-mobile/`（create-expo-app 生成后改造）
- Create: `app/_layout.tsx`、`app/index.tsx`、`src/transport/smoke.md`（验证记录）

**Interfaces:**
- Produces: 可运行的 Expo app 骨架（expo-router + NativeWind + zustand + i18n 装配）、`file:` 依赖 `@tianshu/protocol`、vitest 基建（`npm test` 可跑）。验证结论决定 Task 6 的 SSE 载体（expo/fetch vs react-native-sse）。

- [ ] **Step 1: 生成项目 + 装依赖**

```bash
cd /Users/hjx/workspace
npx create-expo-app@latest tianshu-mobile --template default
cd tianshu-mobile
npx expo install nativewind tailwindcss react-native-svg lucide-react-native @react-native-async-storage/async-storage
npm i zustand i18next react-i18next
npm i -D vitest
npm i ../mirror/packages/tianshu-protocol
```

- [ ] **Step 2: NativeWind 4 接线**

按 `https://www.nativewind.dev/quick-starts/expo` 当前版步骤：`npx tailwindcss init`、`tailwind.config.js` 的 content 加 `./app/**/*.{ts,tsx}` 与 `./src/**/*.{ts,tsx}`、新建 `global.css`（`@import "tailwindcss";`）、`babel.config.js` 加 `nativewind/babel` plugin（或 preset 按 quick-start）、`metro.config.js` 用 `withNativeWind` 包裹并 `input: "./global.css"`、根 `_layout.tsx` `import "../global.css"`。

- [ ] **Step 3: vitest 基建**

`vitest.config.ts`：

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

`package.json` scripts 加 `"test": "vitest run"`。冒烟：`src/smoke.test.ts` 断言 `import { ENDPOINTS } from "@tianshu/protocol"; expect(ENDPOINTS.session.approve).toBe("session/approve");` → `npm test` 过（同时验证 Metro 无关的 node 侧 file: 依赖可用）。

- [ ] **Step 4: expo/fetch SSE 验证（本计划唯一技术风险点）**

`app/index.tsx` 暂时替换为验证页：一个按钮，点按后 `import fetch from "expo/fetch"`，请求本地 SSE 源（先用 `npx tsx` 在桌面端跑 10 行 http server 每秒推一行 `data: {"i":N}`，或直接 `npx expo start` 连真机后访问局域网内任意 SSE——最简：`node -e` 起在 `http://<电脑IP>:18080/`），把收到的行 append 到页面 `<Text>`。**验收标准：真机 Expo Go 中逐秒看到新行出现（流式生效）**。若 expo/fetch 不可流式：`npm i react-native-sse`，Task 6 的 direct-transport 换 EventSource 实现（接口不变，只动内部）。验证页同时 `import { ENDPOINTS } from "@tianshu/protocol"` 把 `ENDPOINTS.session.approve` 渲染到界面——真机可见即验证 **Metro 吃 file: symlink CJS** 无障碍（本计划第二个技术验证点）。

把验证结论（成功/失败 + 所用载体）写进 `src/transport/smoke.md`。

- [ ] **Step 5: 路由骨架 + 主题色基建**

`app/_layout.tsx`（Stack）+ `app/index.tsx`（占位「会话列表」）+ `app/connections.tsx`（占位）+ `app/session/[id].tsx`（占位）。`src/theme/colors.ts`：

```typescript
/** 四主题色（对齐桌面 globals.css 的 --primary 系；移动端 MVP 以蓝为
 * 缺省，其余三色后续接 NativeWind vars() 切换） */
export const THEME_PRESETS = {
  blue: { primary: "#3b82f6", primaryActive: "#1d4ed8", subtle: "#eff6ff" },
  red: { primary: "#ef4444", primaryActive: "#b91c1c", subtle: "#fef2f2" },
  green: { primary: "#22c55e", primaryActive: "#15803d", subtle: "#f0fdf4" },
  orange: { primary: "#f97316", primaryActive: "#c2410c", subtle: "#fff7ed" },
} as const;

export type ThemeName = keyof typeof THEME_PRESETS;
```

（色值以桌面 `src-react/styles/globals.css` 实际值为准回填——执行时打开该文件抄当前四主题变量，勿凭空。）

- [ ] **Step 6: git init + Commit**

```bash
git init && git add -A && git commit -m "chore: Expo 脚手架 + NativeWind/vitest/i18n 基建 + protocol file: 依赖 + SSE 技术验证"
```

---

### Task 6: sse-parser 纯函数（TDD）

**Files:**
- Create: `src/transport/sse-parser.ts`
- Test: `src/transport/sse-parser.test.ts`

**Interfaces:**
- Produces: `createSseParser(onData: (data: string) => void): (chunk: string) => void`——吃任意切分的文本块（含半包行、`\r\n`/`\n`、`:` 心跳注释行、多 `data:` 行拼接），吐完整 event data。Task 7 的 DirectTransport 消费。

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, expect, it, vi } from "vitest";
import { createSseParser } from "./sse-parser";

describe("createSseParser", () => {
  it("完整事件一次吐出", () => {
    const onData = vi.fn();
    const p = createSseParser(onData);
    p('data: {"a":1}\n\n');
    expect(onData).toHaveBeenCalledWith('{"a":1}');
  });

  it("半包行跨 chunk 拼接", () => {
    const onData = vi.fn();
    const p = createSseParser(onData);
    p('data: {"a"');
    p(':1}\n\n');
    expect(onData).toHaveBeenCalledExactlyOnceWith('{"a":1}');
  });

  it("多 data: 行以 \\n 拼接（SSE 规范）", () => {
    const onData = vi.fn();
    const p = createSseParser(onData);
    p("data: line1\ndata: line2\n\n");
    expect(onData).toHaveBeenCalledWith("line1\nline2");
  });

  it("注释心跳行与空行不打扰", () => {
    const onData = vi.fn();
    const p = createSseParser(onData);
    p(": ping\n\n");
    expect(onData).not.toHaveBeenCalled();
  });

  it("CRLF 行尾归一", () => {
    const onData = vi.fn();
    const p = createSseParser(onData);
    p('data: {"a":1}\r\n\r\n');
    expect(onData).toHaveBeenCalledWith('{"a":1}');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```typescript
/**
 * SSE 流解析器（DirectTransport 事件通道）：吃任意切分文本块，吐完整
 * event data（多 data: 行按规范 \n 拼接；`:` 注释行即心跳，忽略；
 * 其余字段 event:/id:/retry: 本协议不用，同样忽略）。
 * 对照 mirror direct-transport.ts 手写流解析语义。
 */
export function createSseParser(onData: (data: string) => void) {
  let buffer = "";
  let dataLines: string[] = [];
  const dispatch = () => {
    if (dataLines.length > 0) {
      onData(dataLines.join("\n"));
      dataLines = [];
    }
  };
  return (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer[idx] === "\r" ? 2 : 1));
      if (line === "") {
        dispatch(); // 空行 = 事件边界
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // `:` 注释与其余字段忽略
    }
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: 5 用例全绿。

- [ ] **Step 5: Commit**

```bash
git add src/transport
git commit -m "feat(transport): SSE 流解析纯函数（半包/心跳/多行 data）"
```

---

### Task 7: Transport 接口 + DirectTransport + 退避纯函数

**Files:**
- Create: `src/transport/types.ts`、`src/transport/backoff.ts`、`src/transport/direct-transport.ts`
- Test: `src/transport/backoff.test.ts`

**Interfaces:**
- Consumes: Task 6 `createSseParser`；`@tianshu/protocol` 的 `ServerEvent`/`ENDPOINTS`。
- Produces:
  - `TransportState = "idle" | "connecting" | "connected" | "reconnecting" | "invalid-token" | "closed"`；`TransportRequestResult { status: number; body: unknown }`；
  - `interface Transport { request(method: "GET" | "POST", path: string, body?: unknown): Promise<TransportRequestResult>; onEvent(cb: (e: ServerEvent) => void): () => void; onState(cb: (s: TransportState) => void): () => void; close(): void; }`
  - `nextBackoffMs(attempt: number): number`（1s×2ⁿ 封顶 30s）
  - `createDirectTransport(config: { baseUrl: string; token: string }): Transport`

- [ ] **Step 1: 退避函数失败测试**

```typescript
import { describe, expect, it } from "vitest";
import { nextBackoffMs } from "./backoff";

describe("nextBackoffMs", () => {
  it("1s 起步指数增长封顶 30s", () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(4)).toBe(16000);
    expect(nextBackoffMs(5)).toBe(30000);
    expect(nextBackoffMs(20)).toBe(30000);
  });
});
```

Run: `npm test` → FAIL。

- [ ] **Step 2: 实现 backoff + types**

`src/transport/backoff.ts`：

```typescript
/** 指数退避：1s × 2^attempt，封顶 30s（mirror transports 同款语义） */
export function nextBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}
```

`src/transport/types.ts`：

```typescript
import type { ServerEvent } from "@tianshu/protocol";

export type TransportState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "invalid-token"
  | "closed";

export interface TransportRequestResult {
  status: number;
  body: unknown;
}

export interface Transport {
  request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<TransportRequestResult>;
  onEvent(cb: (e: ServerEvent) => void): () => void;
  onState(cb: (s: TransportState) => void): () => void;
  close(): void;
}

/** 事件/状态订阅扇出基座（TransportBase 同构） */
export class Emitter<T> {
  private cbs = new Set<(v: T) => void>();
  on(cb: (v: T) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  emit(v: T): void {
    for (const cb of this.cbs) cb(v);
  }
}
```

Run: `npm test` → backoff 过。

- [ ] **Step 3: DirectTransport 实现**

`src/transport/direct-transport.ts`（语义对照 mirror `electron/domains/server/direct-transport.ts`；fetch 用 expo/fetch——若 Task 5 验证失败换 react-native-sse，仅改 `startEventStream` 内部）：

```typescript
import fetch from "expo/fetch";
import type { ServerEvent } from "@tianshu/protocol";
import { createSseParser } from "./sse-parser";
import { nextBackoffMs } from "./backoff";
import { Emitter, type Transport, type TransportRequestResult, type TransportState } from "./types";

export interface DirectConfig {
  baseUrl: string;
  token: string;
}

export function createDirectTransport(config: DirectConfig): Transport {
  const events = new Emitter<ServerEvent>();
  const states = new Emitter<TransportState>();
  let state: TransportState = "idle";
  let closed = false;
  let attempt = 0;
  let lastByteAt = 0;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;

  const setState = (s: TransportState) => {
    state = s;
    states.emit(s);
  };
  const headers = () => ({
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  });

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<TransportRequestResult> {
    const res = await fetch(`${config.baseUrl}/${path.replace(/^\//, "")}`, {
      method,
      headers: headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: await res.json() };
  }

  async function startEventStream(): Promise<void> {
    if (closed) return;
    setState(state === "idle" ? "connecting" : "reconnecting");
    try {
      // SSE 事件端点 "/event"（GET 资源不在 ENDPOINTS 表，spec §4.1 注记）
      const res = await fetch(`${config.baseUrl}/event?token=${encodeURIComponent(config.token)}`, {
        headers: headers(),
      });
      if (res.status === 401) {
        setState("invalid-token"); // 粘滞：停止重连，等用户改配置
        return;
      }
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      setState("connected");
      attempt = 0;
      lastByteAt = Date.now();
      // 60s 无入站字节判死（mirror 同款）：cancel reader 触发重连
      if (livenessTimer) clearInterval(livenessTimer);
      livenessTimer = setInterval(() => {
        if (Date.now() - lastByteAt > 60_000) {
          if (livenessTimer) clearInterval(livenessTimer);
          livenessTimer = null;
          void reader?.cancel();
        }
      }, 5_000);
      const parser = createSseParser((data) => {
        lastByteAt = Date.now();
        try {
          events.emit(JSON.parse(data) as ServerEvent);
        } catch {
          // 非业务帧（理论上不会出现）：丢弃不崩连接
        }
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser(decoder.decode(value, { stream: true }));
      }
      throw new Error("SSE ended"); // 服务端正常关流也走重连
    } catch {
      if (closed) return;
      const delay = nextBackoffMs(attempt++);
      setTimeout(startEventStream, delay);
    }
  }

  void startEventStream();

  return {
    request,
    onEvent: (cb) => events.on(cb),
    onState: (cb) => states.on(cb),
    close() {
      closed = true;
      if (livenessTimer) clearInterval(livenessTimer);
      setState("closed");
    },
  };
}
```

- [ ] **Step 4: typecheck + 手动冒烟**

Run: `npx tsc --noEmit`
Expected: 0 error。Expo Go 真机：临时在 index 页连本地 face（`npm run dev` 桌面端开启 server-face）`createDirectTransport({ baseUrl: "http://<电脑IP>:18411", token: "<face token>" })`，console 观察 `server.connected` 事件与 connected 态。

- [ ] **Step 5: Commit**

```bash
git add src/transport
git commit -m "feat(transport): Transport 接口 + DirectTransport（SSE 事件流/退避重连/invalid-token 粘滞）"
```

---

### Task 8: RelayTransport

**Files:**
- Create: `src/transport/relay-transport.ts`

**Interfaces:**
- Consumes: Task 7 types/backoff；`@tianshu/protocol` `RelayFrame`。
- Produces: `createRelayTransport(config: { relayUrl: string; relayToken: string; connectionId: string }): Transport`（req/res 按 id 配对 10s 超时；open 帧配对；连上自动 GET info 合成 `server.connected`；应用层 ping 25s/60s 判死）。

- [ ] **Step 1: 实现**

```typescript
import { ENDPOINTS, type RelayFrame, type ServerEvent } from "@tianshu/protocol";
import { nextBackoffMs } from "./backoff";
import { Emitter, type Transport, type TransportRequestResult, type TransportState } from "./types";

export interface RelayConfig {
  relayUrl: string;
  relayToken: string;
  /** 目标被控端 instanceId（带外获取：桌面端关于页/无头端 handshake 日志） */
  connectionId: string;
}

const REQ_TIMEOUT_MS = 10_000;

export function createRelayTransport(config: RelayConfig): Transport {
  const events = new Emitter<ServerEvent>();
  const states = new Emitter<TransportState>();
  let state: TransportState = "idle";
  let closed = false;
  let attempt = 0;
  let ws: WebSocket | null = null;
  let nextId = 1;
  let lastInboundAt = 0;
  let paired = false;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  const pending = new Map<
    number,
    { resolve: (r: TransportRequestResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const setState = (s: TransportState) => {
    state = s;
    states.emit(s);
  };
  const send = (frame: RelayFrame) => ws?.send(JSON.stringify(frame));
  const failPending = () => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ status: 0, body: null });
    }
    pending.clear();
  };

  /** 连上且 open 帧被 relay 接受（收到任意入站帧）后的一次性初始化 */
  function onPaired(): void {
    paired = true;
    setState("connected");
    attempt = 0;
    void synthConnected();
    if (livenessTimer) clearInterval(livenessTimer);
    livenessTimer = setInterval(() => {
      if (Date.now() - lastInboundAt > 60_000) {
        ws?.close(); // 无入站判死，onclose 兜底走重连
        return;
      }
      send({ kind: "ping" });
    }, 25_000);
  }

  /** relay 无 SSE：连上后自动 GET info 合成 server.connected（协议注记语义） */
  async function synthConnected(): Promise<void> {
    const res = await request("GET", ENDPOINTS.info);
    const body = res.body as {
      data?: { instanceId?: string; capabilities?: string[] };
    } | null;
    if (body?.data?.instanceId) {
      events.emit({
        type: "server.connected",
        payload: {
          instanceId: body.data.instanceId,
          capabilities: body.data.capabilities ?? [],
        },
      });
    }
  }

  function connect(): void {
    if (closed) return;
    setState(state === "idle" ? "connecting" : "reconnecting");
    paired = false;
    lastInboundAt = Date.now();
    const url = `${config.relayUrl}?role=client&token=${encodeURIComponent(config.relayToken)}`;
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      send({ kind: "open", connectionId: config.connectionId });
    };
    socket.onmessage = (ev) => {
      lastInboundAt = Date.now();
      if (!paired) onPaired();
      let frame: RelayFrame;
      try {
        frame = JSON.parse(ev.data as string) as RelayFrame;
      } catch {
        return;
      }
      if (frame.kind === "pong") return;
      if (frame.kind === "event") {
        events.emit(frame.payload as ServerEvent);
      } else if (frame.kind === "res") {
        const p = pending.get(frame.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(frame.id);
          p.resolve({ status: frame.status, body: frame.body });
        }
      } else if (frame.kind === "close") {
        // server-gone/not-found：目标不在线，按断线退避重连
        scheduleReconnect();
      }
    };
    socket.onclose = (ev) => {
      if (closed) return;
      if (ev.code === 4001) {
        setState("invalid-token");
        return;
      }
      scheduleReconnect();
    };
    socket.onerror = () => {
      /* onclose 兜底重连 */
    };
  }

  function scheduleReconnect(): void {
    failPending();
    if (livenessTimer) clearInterval(livenessTimer);
    livenessTimer = null;
    if (closed) return;
    const delay = nextBackoffMs(attempt++);
    setTimeout(connect, delay);
  }

  function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<TransportRequestResult> {
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ status: 0, body: null }); // 超时=不可达语义
      }, REQ_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      send({
        kind: "req",
        id,
        method,
        path: path.replace(/^\//, ""),
        ...(body !== undefined ? { body } : {}),
      });
    });
  }

  connect();

  return {
    request,
    onEvent: (cb) => events.on(cb),
    onState: (cb) => states.on(cb),
    close() {
      closed = true;
      failPending();
      if (livenessTimer) clearInterval(livenessTimer);
      ws?.close();
      setState("closed");
    },
  };
}
```

- [ ] **Step 2: typecheck + 手动冒烟（relay 全链路）**

Run: `npx tsc --noEmit` → 0 error。
本地起 relay：`cd /Users/hjx/workspace/tianshu-server && npm run build && node dist/src/relay/relay-main.js --port 8411 --token test-relay`；桌面端 server-face 配置 relay 指向它；Expo Go 里 `createRelayTransport({ relayUrl: "ws://<电脑IP>:8411/ws", relayToken: "test-relay", connectionId: "<face instanceId>" })`——观察 connected 态 + `server.connected` + `request("POST", "session/query", {page:1})` 返回数据。

- [ ] **Step 3: Commit**

```bash
git add src/transport
git commit -m "feat(transport): RelayTransport（open 配对/req-res id 配对/应用层 ping/退避重连）"
```

---

### Task 9: 连接注册表 + 持久化

**Files:**
- Create: `src/transport/connection.ts`、`src/store/connections.store.ts`
- Test: `src/store/connections.store.test.ts`

**Interfaces:**
- Consumes: Task 7/8 两 Transport 工厂。
- Produces:
  - `ConnectionConfig { id: string; name: string; mode: "direct" | "relay"; baseUrl?: string; token?: string; relayUrl?: string; relayToken?: string; connectionId?: string }`
  - connections store（zustand）：`list()`、`save(cfg)`、`remove(id)`、`activate(id)`、`activeTransport(): Transport | null`、`activeConnId`、`states: Record<id, TransportState>`、`testConnection(cfg): Promise<TestResult>`；AsyncStorage 持久化（key `tianshu-mobile.connections`，形状 `{ connections: ConnectionConfig[]; activeConnId: string | null }`——对齐桌面 option 表存档）。
  - `TestResult = { ok: true; info: { instanceId: string; capabilities: string[] } } | { ok: false; reason: "invalid-config" | "invalid-token" | "unreachable" | "timeout" }`

- [ ] **Step 1: 写失败测试（testConnection 归因）**

```typescript
import { describe, expect, it, vi } from "vitest";
// AsyncStorage mock 为内存 Map；transport 工厂 mock：按 baseUrl 返回不同行为
import { classifyTestFailure } from "../transport/connection";

describe("classifyTestFailure", () => {
  it("401/4010 → invalid-token", () => {
    expect(classifyTestFailure({ status: 200, body: { code: "4010" } })).toBe("invalid-token");
    expect(classifyTestFailure({ status: 401, body: null })).toBe("invalid-token");
  });
  it("status 0 → timeout/unreachable 归 timeout", () => {
    expect(classifyTestFailure({ status: 0, body: null })).toBe("timeout");
  });
  it("其余 → unreachable", () => {
    expect(classifyTestFailure({ status: 200, body: { code: "2000", success: true, data: { capabilities: ["chat"] } } })).toBe("unreachable"); // 成功不该进此函数，防御口径
    expect(classifyTestFailure({ status: 500, body: null })).toBe("unreachable");
  });
});
```

Run: `npm test` → FAIL。

- [ ] **Step 2: 实现**

`src/transport/connection.ts`：

```typescript
import { ENDPOINTS } from "@tianshu/protocol";
import { createDirectTransport } from "./direct-transport";
import { createRelayTransport } from "./relay-transport";
import type { Transport, TransportRequestResult } from "./types";

export interface ConnectionConfig {
  id: string;
  name: string;
  mode: "direct" | "relay";
  baseUrl?: string;
  token?: string;
  relayUrl?: string;
  relayToken?: string;
  connectionId?: string;
}

export type TestResult =
  | { ok: true; info: { instanceId: string; capabilities: string[] } }
  | { ok: false; reason: "invalid-config" | "invalid-token" | "unreachable" | "timeout" };

export function isValidConfig(c: ConnectionConfig): boolean {
  if (c.mode === "direct") return Boolean(c.baseUrl && c.token);
  return Boolean(c.relayUrl && c.relayToken && c.connectionId);
}

export function createTransport(c: ConnectionConfig): Transport {
  return c.mode === "direct"
    ? createDirectTransport({ baseUrl: c.baseUrl!, token: c.token! })
    : createRelayTransport({ relayUrl: c.relayUrl!, relayToken: c.relayToken!, connectionId: c.connectionId! });
}

export function classifyTestFailure(r: TransportRequestResult): Exclude<TestResult, { ok: true }>["reason"] {
  if (r.status === 401) return "invalid-token";
  const body = r.body as { code?: string } | null;
  if (r.status === 200 && body?.code === "4010") return "invalid-token";
  if (r.status === 0) return "timeout";
  return "unreachable";
}

/** 测试连接：临时 transport GET info，8s 超时，随后关闭 */
export async function testConnection(c: ConnectionConfig): Promise<TestResult> {
  if (!isValidConfig(c)) return { ok: false, reason: "invalid-config" };
  const t = createTransport(c);
  try {
    const res = await Promise.race([
      t.request("GET", ENDPOINTS.info),
      new Promise<TransportRequestResult>((r) => setTimeout(() => r({ status: 0, body: null }), 8_000)),
    ]);
    const body = res.body as { success?: boolean; data?: { instanceId: string; capabilities: string[] } } | null;
    if (res.status === 200 && body?.success && body.data) {
      return { ok: true, info: { instanceId: body.data.instanceId, capabilities: body.data.capabilities } };
    }
    return { ok: false, reason: classifyTestFailure(res) };
  } finally {
    t.close();
  }
}
```

`src/store/connections.store.ts`（zustand + AsyncStorage；state: configs、activeConnId、states、infos；actions: load/save/remove/activate/selectActive；transport 实例表存模块级 Map 不进 state）。测试补 store 用例：save→list 持久化（AsyncStorage mock）、activate 切换 activeTransport 工厂调用。

- [ ] **Step 3: 跑测试确认通过**

Run: `npm test` → 全绿。

- [ ] **Step 4: Commit**

```bash
git add src/transport/connection.ts src/store/connections.store.ts src/store/connections.store.test.ts
git commit -m "feat(connection): 连接注册表（配置持久化/六态/testConnection 四分类归因）"
```

---

### Task 10: logic 层搬迁（纯函数）

**Files:**
- Create: `src/logic/remote-stream.ts`、`src/logic/blocks.ts`、`src/logic/group-blocks.ts`、`src/logic/optimistic-user-message.ts`（自 mirror 原样复制源文件 + 对应 `*.test.ts`）
- 源：`src-react/domains/ai/server/lib/remote-stream.ts`、`src-react/domains/ai/chat/model/blocks.ts`（**注意**：blocks.ts 是 re-export `@tianshu/protocol` + parse/serialize——移动端只需 parseBlocks，把纯函数部分摘出）、`src-react/domains/ai/chat/lib/{group-blocks,optimistic-user-message}.ts`

**Interfaces:**
- Produces: 与 mirror 同名导出（`liveBlocks`、`parseBlocks`、`groupBlocks`、`buildOptimisticUserMessage` 等——以源文件实际导出名为准逐一保留），移动端 UI 任务消费。

- [ ] **Step 1: 复制源文件与其测试**

逐文件复制（去掉 `@/` alias import，改相对路径；去掉 Electron 专属 import——这四个文件探索已确认零依赖纯函数）。测试文件同搬（mirror 内若 `src-react/domains/ai/**/__tests__` 或 tests/ 下有对应测试则一并复制；无则按函数行为补最小用例）。

Run: `npm test` → 搬迁测试全绿（纯函数零改动应直接过）。

- [ ] **Step 2: typecheck**

Run: `npx tsc --noEmit` → 0 error。

- [ ] **Step 3: Commit**

```bash
git add src/logic
git commit -m "feat(logic): 自 mirror 搬迁 remote-stream/blocks/group-blocks/optimistic 纯函数（含测试）"
```

---

### Task 11: i18n 基建 + 根 layout 装配

**Files:**
- Create: `src/i18n/index.ts`、`src/i18n/locales/zh-CN.json`、`src/i18n/locales/en-US.json`
- Modify: `app/_layout.tsx`

**Interfaces:**
- Produces: `t()` 可用；namespace `common`/`connections`/`chat`；后续所有 UI 任务文案走 `t("ns:key")`。

- [ ] **Step 1: i18n 装配**

`src/i18n/index.ts`：

```typescript
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import zhCN from "./locales/zh-CN.json";
import enUS from "./locales/en-US.json";

export const LOCALE_KEY = "tianshu-mobile-locale";

void i18n.use(initReactI18next).init({
  resources: { "zh-CN": { translation: zhCN }, "en-US": { translation: enUS } },
  lng: "zh-CN",
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

// 语言持久化（异步恢复，首帧中文兜底）
void AsyncStorage.getItem(LOCALE_KEY).then((saved) => {
  if (saved === "en-US" || saved === "zh-CN") i18n.changeLanguage(saved);
});

export function setLocale(locale: "zh-CN" | "en-US"): void {
  void i18n.changeLanguage(locale);
  void AsyncStorage.setItem(LOCALE_KEY, locale);
}

export default i18n;
```

两份 JSON 初始 key（后续任务追加）：

```json
{
  "common": { "confirm": "确定", "cancel": "取消", "delete": "删除", "retry": "重试", "loading": "加载中…" },
  "connections": { "title": "连接管理", "addDirect": "添加直连", "addRelay": "添加中继", "test": "测试连接", "name": "名称", "baseUrl": "地址", "token": "访问令牌", "relayUrl": "中继地址", "relayToken": "中继令牌", "connectionId": "目标实例 ID", "reasonInvalidConfig": "配置不完整", "reasonInvalidToken": "令牌无效", "reasonUnreachable": "无法连接", "reasonTimeout": "连接超时" },
  "chat": { "sessions": "会话", "newSession": "新建会话", "send": "发送", "stop": "中止", "placeholder": "输入消息…", "approve": "批准", "reject": "拒绝", "approvalTitle": "工具执行申请审批", "model": "模型", "noModel": "未选择模型", "imageFailed": "图片加载失败" }
}
```

en-US 同构英文翻译。`app/_layout.tsx` 顶部 `import "../src/i18n"`。

- [ ] **Step 2: 冒烟 + Commit**

`npx expo start` 真机看首页无报错（t 可用）。

```bash
git add src/i18n app/_layout.tsx
git commit -m "feat(i18n): react-i18next 双语基建（zh-CN/en-US）"
```

---

### Task 12: 连接管理页

**Files:**
- Create: `app/connections.tsx`（实现替换占位）、`src/components/ConnectionCard.tsx`、`src/components/ConnectionForm.tsx`

**Interfaces:**
- Consumes: Task 9 connections store（save/remove/test/activate/states）、Task 11 `t()`。
- Produces: 可用连接管理 UI（列表 + direct/relay 双模式表单 + 测试反馈 + 激活切换 + 六态徽章）。

- [ ] **Step 1: 实现**

`ConnectionCard`：名称 + mode 标签 + 六态色点（`states[id]`，映射：connected=绿/reconnecting=黄/invalid-token=红/idle/connecting=灰/closed=灰）+「使用」按钮（activate）+「测试」按钮（结果 toast/内联文案用 `t("connections.reasonXxx")`）+「删除」。`ConnectionForm`：mode 切换两套字段（direct: name/baseUrl/token；relay: name/relayUrl/relayToken/connectionId），保存前 `isValidConfig` 校验，token 用 `secureTextEntry`。`connections.tsx`：`FlatList` + 顶部「添加」打开 Form（Modal）。

`ConnectionForm` 核心结构（约 120 行，样式 NativeWind 极简）：

```tsx
export function ConnectionForm({ initial, onDone }: {
  initial?: ConnectionConfig;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useConnectionsStore((s) => s.save);
  const test = testConnection;
  const [mode, setMode] = useState<"direct" | "relay">(initial?.mode ?? "direct");
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [relayUrl, setRelayUrl] = useState(initial?.relayUrl ?? "");
  const [relayToken, setRelayToken] = useState(initial?.relayToken ?? "");
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? "");
  const [result, setResult] = useState<string | null>(null);

  const asConfig = (): ConnectionConfig => ({
    id: initial?.id ?? Math.random().toString(36).slice(2),
    name: name || (mode === "direct" ? baseUrl : relayUrl),
    mode,
    ...(mode === "direct"
      ? { baseUrl: baseUrl.trim(), token: token.trim() }
      : {
          relayUrl: relayUrl.trim(),
          relayToken: relayToken.trim(),
          connectionId: connectionId.trim(),
        }),
  });

  // 测试按钮：testConnection(asConfig()) → ok ? instanceId 文案
  //   : t(`connections.reason${cap(reason)}`)（reasonInvalidConfig 等 key
  //   首字母大写映射）；保存按钮：isValidConfig 通过才 save + onDone。
  // direct 表单字段 name/baseUrl/token；relay 表单字段 name/relayUrl/
  // relayToken/connectionId；token 类输入 secureTextEntry。
}
```

（`cap` 为 3 行工具函数 `s[0].toUpperCase()+s.slice(1)`，放 `src/lib/str.ts`。）`ConnectionCard` 与 `connections.tsx` 页面按 Step 1 首段行为描述实现（列表 FlatList + Modal 表单 + 六态色点映射），文案全部 `t()`。

- [ ] **Step 2: 手动冒烟**

桌面端起 face + tianshu-server 起无头端：添加两条连接（direct→face、direct→无头端），测试均 ok，激活切换，错误 token 场景看 invalid-token 文案。

- [ ] **Step 3: Commit**

```bash
git add app/connections.tsx src/components/ConnectionCard.tsx src/components/ConnectionForm.tsx src/i18n
git commit -m "feat(ui): 连接管理页（双模式表单/测试归因/六态徽章/激活切换）"
```

---

### Task 13: 会话列表页

**Files:**
- Create: `src/store/sessions.store.ts`、`src/components/SessionRow.tsx`
- Modify: `app/index.tsx`（实现替换占位）

**Interfaces:**
- Consumes: `activeTransport()`、`ENDPOINTS.session.query/getById/create/delete`、Task 11 `t()`。
- Produces: 会话列表（分页上拉 + keyword 搜索 + 新建 + 删除 + 点击进 `session/[id]`）；`session.updated`/`server.connected` 事件触发列表刷新（挂经 store 的事件订阅）。

- [ ] **Step 1: sessions.store 实现**

state: `items: SessionBrief[]`（`{id,title,updatedAt,archivedAt?}` 子集）、`total/page/keyword`、`loading`；actions: `loadFirst()`（page=1）、`loadMore()`（+1 拼接）、`search(kw)`（防抖 400ms 重置加载）、`create(title?)`、`remove(id)`、`bindEvents(transport)`——订阅 `session.updated`（原地更新 title/updatedAt）与 `server.connected`（loadFirst 全量刷新）。请求经 `activeTransport().request("POST", ENDPOINTS.session.query, { page, pageSize: 50, keyword })`，判 `body.success`，data 形状 `{page,pageSize,records,total}`。

- [ ] **Step 2: UI 实现**

`index.tsx`：顶部连接切换器（当前活动连接名，点击跳 connections 页）+ 搜索框 + `FlatList`（`onEndReached` loadMore、下拉 loadFirst）+ 右下「新建」FAB（create 后跳新会话页）+ 行**长按弹删除确认**（`Alert.alert` + `remove(id)`——最简方案，不引 swipeable 依赖）。`SessionRow`：标题 + 相对时间（自写 `formatRelative(iso)` 纯函数进 `src/logic/time.ts`，带单测——「刚刚/N 分钟前/N 小时前/昨天/MM-DD」）。

- [ ] **Step 3: time 纯函数 TDD + 手动冒烟**

`src/logic/time.test.ts` 先行（5 用例：0s/5min/3h/昨天/跨年），再实现。真机：两个目标各刷出列表、搜索过滤、新建跳转、删除生效、桌面端改名后列表自动更新（session.updated 推送）。

- [ ] **Step 4: Commit**

```bash
git add src/store/sessions.store.ts src/components/SessionRow.tsx src/logic/time.ts app/index.tsx src/i18n
git commit -m "feat(ui): 会话列表（分页/搜索/新建/删除/事件驱动刷新）"
```

---

### Task 14: 会话流页（历史 + 流式 + 发送/中止 + 自写 markdown）

**Files:**
- Create: `src/store/stream.store.ts`、`src/components/MessageItem.tsx`、`src/components/ToolCallCard.tsx`、`src/components/ThinkingPanel.tsx`、`src/components/MarkdownLite.tsx`、`src/components/Composer.tsx`
- Modify: `app/session/[id].tsx`

**Interfaces:**
- Consumes: `ENDPOINTS.session.{getById,send,abort}`、Task 10 `parseBlocks/liveBlocks/groupBlocks/buildOptimisticUserMessage`、`message.chunk` 事件（按 sessionId 过滤）。
- Produces: 完整会话遥控 UI；`MessageItem` 可被 Task 15 复用（blocks 分发签名 `MessageItem({ role, blocks }: { role: string; blocks: MessageBlock[] })`）。

- [ ] **Step 1: stream.store 实现**

state: `bySession: Record<number, { history: MessageRecord[]; live: LiveStreamState }>`（LiveStreamState 即 `remote-stream` 的归并输入：`{thinking,tools,text,title}` 或源文件实际形状）；actions: `loadHistory(sessionId, transport)`（getById 全量 → parseBlocks）、`startSend(sessionId, content, modelId?)`（optimistic 用户块追加 + `send` 202 + 记 `sending:true`）、`applyChunk(sessionId, chunk)`（`message.chunk` 事件分发，经 remote-stream 归并进 live）、`finish(sessionId)`（`finish`/`session.error` chunk 或 `session.updated` 后：sending=false——**history 定稿以重拉 getById 为准**（简化：finish 后 loadHistory 覆盖，live 清空）、`abort(sessionId)`。

- [ ] **Step 2: MarkdownLite 实现（自写子集渲染器）**

支持：`# ## ###` 标题、``` 围栏代码块（等宽字体深底圆角，不高亮）、`- /1.` 列表、`> ` 引用、行内 `**bold**` `*italic*` `` `code` ``、段落文本、链接文本（不内嵌打开，长按复制）。约 120 行：`parseMarkdown(text): Block[]` 纯函数（**进 src/logic/markdown.ts，TDD：8 用例覆盖上述语法**）+ `<MarkdownLite text>` 组件渲染。

- [ ] **Step 3: 组件实现**

`MessageItem`：role=user 右侧气泡 / assistant 全宽；blocks 分发：text→MarkdownLite、thinking→ThinkingPanel（折叠，默认收起，流式中有内容时展开）、tool_call→ToolCallCard（工具名 + state 徽章 + 参数摘要 + 输出折叠）、usage→小字角标 `in/out tokens`、image→Task 15 实现（本任务先占位灰块）。`ToolCallCard` 态色映射（state 枚举值即 `@tianshu/protocol` `ToolCallBlock.state` 六值）：`running`=蓝 / `done`=绿 / `error`=红 / `denied`=橙 / `ready`/`awaiting-approval`=灰。`Composer`：多行输入 + 发送键（sending 时变「中止」调 abort）+ 会话锁（sending=true 禁输入——CONCURRENT_REQUEST 守卫客户端侧配合）。`session/[id].tsx`：挂载时 loadHistory + 订阅 chunk（`transport.onEvent` 过滤 `payload.sessionId === id`）+ FlatList 倒置（`inverted` 流式自底向上）+ 卸载退订。

- [ ] **Step 4: 手动冒烟（核心链路）**

真机 → 无头端会话：发「用 run_command 执行 echo hi」类消息，观察 thinking/tool/text 流式逐块出现、finish 后 history 定稿；中止按钮中途生效；桌面端同时打开该会话验证 chunk 双端同推。

- [ ] **Step 5: Commit**

```bash
git add src/store/stream.store.ts src/components app/session src/logic/markdown.ts src/i18n
git commit -m "feat(ui): 会话流页（历史/流式归并/发送中止/自写 markdown 子集渲染）"
```

---

### Task 15: 审批 Banner + 模型选择 + 图片渲染

**Files:**
- Create: `src/components/ApprovalBanner.tsx`、`src/components/ModelPicker.tsx`、`src/components/MessageImage.tsx`
- Modify: `app/session/[id].tsx`、`src/components/MessageItem.tsx`（image 分发接 MessageImage）

**Interfaces:**
- Consumes: `ENDPOINTS.session.approve`、`ENDPOINTS.image`、`ENDPOINTS.provider.query`、`approval-request` chunk、`/info` capabilities（Task 9 testConnection 已存 infos）。
- Produces: 审批闭环 UI；模型选择（capability 含 `provider` 才显示）；图片 base64 渲染。

- [ ] **Step 1: ApprovalBanner**

stream.store 增 `approvals: Record<sessionKey, {toolCallId, toolName, argSummary}[]>`（`approval-request` chunk 入队；`tool-update` 到终态或 finish 出队）。Banner 固定 composer 上方：工具名 + argSummary 截断 + 批准/拒绝两键 → `request("POST", ENDPOINTS.session.approve, {sessionId, toolCallId, approved})`；响应 `code:"4040"` → toast「被控端版本过旧不支持远端审批」（`t("chat.approveUnsupported")`，两语言文件补 key）。

- [ ] **Step 2: ModelPicker**

会话页头部模型名胶囊：capabilities 含 `"provider"` 才可点；点击拉 `provider/query`（缓存进 stream.store 一次/会话页生命周期）；列表展示 `models[].name`（带 `providers[].name` 分组前缀）；选中存会话级 state，`startSend` 带上 `modelId`。无 provider 能力显示 `t("chat.noModel")` 不可点。

- [ ] **Step 3: MessageImage**

`MessageItem` image 分支：`request("POST", ENDPOINTS.image, { path: block.imagePath })` → `{mime, dataBase64}` → `<Image source={{ uri: \`data:${mime};base64,${dataBase64}\` }} style={{ width: "70%", maxHeight: 320, resizeMode: "contain", borderRadius: 8 }}>`（缓存 Map<imagePath, dataUrl> 模块级，会话内不重拉）；失败/4040 → 占位「图片加载失败」。

- [ ] **Step 4: 手动冒烟（审批全链路）**

无头端 `config.yml` 置 `tianshu.chat.accessMode: manual` 重启 → 真机会话触发 write 工具 → Banner 出现 → 批准后工具继续；拒绝后 denied chunk；放任 5 分钟（临时把 approvalTimeoutMs 调小验证）自动 deny。桌面端 face 走 `default` 模式 + 触发桌面审批场景双端应答竞速（先到先得，后到 4040）。图片：桌面端会话发图后真机加载。

- [ ] **Step 5: Commit**

```bash
git add src/components src/store app/session src/i18n
git commit -m "feat(ui): 审批 Banner + 模型选择 + 图片 base64 渲染（审批闭环收口）"
```

---

### Task 16: 手动验收清单 + 收尾

**Files:**
- Create: `docs/manual-acceptance-2026-10-17-tianshu-mobile.md`（mirror 仓，对齐 `manual-acceptance-*` 习惯）

- [ ] **Step 1: 写验收矩阵并执行**

矩阵：被控端（桌面 face / tianshu-server 无头端）× 承载（direct / relay）× 场景（连接管理/列表/历史/流式/发送/中止/审批/模型/图片/弱网切换/token 错误/超时）。逐项打勾记录结果（含环境：Expo Go 版本、SDK 版本、手机型号）。已知限制复核清单：多控制端串流表现、长会话 getById 时长记录、relay instanceId 带外获取路径可用性。

- [ ] **Step 2: 遗留记录**

在验收文档尾节记录：markdown 自写渲染器的裁定（spec §8 预留项）、expo/fetch 验证结论（Task 5 的 smoke.md 摘要）、后续迭代清单（推送/语音/自动化遥控/图片发送/设备配对——spec §3「不做」同款）。

- [ ] **Step 3: Commit（两仓）**

```bash
# mirror 仓
git add docs/manual-acceptance-2026-10-17-tianshu-mobile.md
git commit -m "docs: 移动端手动验收清单与结果（矩阵+已知限制复核）"
# tianshu-mobile 仓若有收尾改动（版本号/readme）一并提交
```

---

### Task 17（可选）: 桌面远控台 ApprovalBanner

**Files:**
- Create: `src-react/domains/ai/server/components/RemoteApprovalBanner.tsx`
- Modify: `src-react/domains/ai/server/components/RemoteSessionPanel.tsx`（或会话流容器组件——以实际挂载点为准，`server/components` 内复用 `MessageItem` 的那个容器）
- Test: `src-react/domains/ai/server/components/RemoteApprovalBanner.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `POST session/approve`（经 `server.api.ts` 新增 `approveSession(connId, sessionId, toolCallId, approved)`——照既有 `server:sessionSend` 通道同款 IPC 透传；若 ipc.ts 需加白名单通道 `server:sessionApprove` 则同步登记）。
- Produces: 桌面远控台审批应答 UI（与移动端同协议，spec §4.2「顺带补」承诺）。

- [ ] **Step 1: IPC 通道 + api 封装**

`electron/domains/server/ipc.ts` 照 `server:sessionAbort` 同款加：

```typescript
registerHandle(
  "server:sessionApprove",
  (body: { sessionId: number; toolCallId: string; approved: boolean }, connId: string | null) =>
    serverConnections.request(connId, "POST", "session/approve", body),
);
```

（`registerHandle`/签名以 ipc.ts 既有透传写法为准照抄；`ipc-channels.ts` 白名单同步。）`server.api.ts` 加 `approveSession`。vitest：`tests/ai/server/` 照既有 IPC 测试模式补一例（透传路径与参数）。

- [ ] **Step 2: 组件 + 挂载**

`RemoteApprovalBanner`：props `{connId, sessionId, item: {toolCallId, toolName, argSummary}, onResponded}`；两键调 `approveSession`；4040 → toast「被控端版本过旧」。挂载点：远控会话流容器订阅 `server:chunk:<connId>:<sessionId>` 通道，`chunk.type === "approval-request"` 时置队列渲染 Banner（`tool-update` 到 `denied/done/error` 终态出队——队列逻辑可提纯函数 `src-react/domains/ai/server/lib/approval-queue.ts` + 单测）。文案进 `src-react/i18n/locales/*/ai.json`（`ai:serverChat.approve` 等）。

- [ ] **Step 3: 测试与冒烟**

Run: `npm run test -- --run tests/ai/server && npm run typecheck`
手动：桌面远控台连无头端（manual 模式）触发 write 工具 → Banner → 批准/拒绝生效；与移动端同挂一个会话时双端竞速应答（先到者生效、后到 4040 toast）。

- [ ] **Step 4: Commit**

```bash
git add electron/domains/server src-react/domains/ai/server src-react/i18n tests/ai/server
git commit -m "feat(server-console): 远控台审批 Banner（session/approve 消费，移动端同协议）"
```
