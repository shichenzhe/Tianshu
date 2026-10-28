# 天枢服务端（客户端-服务端模式）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec 建成「天枢桌面端（控制端）↔ 被控端（其它桌面端 / tianshu-server 无头端）」chat 遥控闭环，含 relay 中继全链路。

**Architecture:** 三角色：tianshu-server 新仓（NestJS 无头 chat 核心 + relay 第二形态）、mirror 桌面端被控面（node:http 桥现有 chat.service + tap 点）、mirror 桌面端控制端（Transport 抽象 + Supervisor + 控制台页）。逻辑协议（端点+事件）与承载（直连 HTTP+SSE / relay WS 帧）解耦。

**Tech Stack:** NestJS 11 + Fastify 5 + Prisma（starter 继承）；Node `node:http` + `ws`（relay 与被控面）；mirror 侧 Vitest / server 侧 Jest。

**Spec:** `docs/superpowers/specs/2026-10-16-tianshu-server-design.md`（本计划从 spec 立论，执行者须同时阅读）

## Global Constraints

- **两仓**：mirror = `/Users/hjx/workspace/mirror`（当前仓）；tianshu-server = `/Users/hjx/workspace/tianshu-server`（新仓）。任务中所有 `git`/`npm` 命令须在指定仓根执行。
- mirror 遵守其 CLAUDE.md：文件名 kebab-case、i18n 双语（禁止硬编码用户可见文案）、主题色变量（禁 `bg-blue-*` 等）、弹层 `border-border/50 rounded-lg shadow-lg`、Prettier 双引号分号 printWidth 80。
- tianshu-server 遵守 starter CLAUDE.md：业务错误抛 `BusinessException` + `ErrorCode`；POST 风格路由；Prettier 单引号 trailingComma all。
- 协议常量（双仓各持同构副本，改动必须双改）：端点表见 spec §3.1；事件 `server.connected` / `session.updated` / `message.chunk` / `session.error`；帧 `req`/`res`/`event`/`open`/`close`。
- 认证统一 `Authorization: Bearer <token>`；relay 握手 token 走 query `?token=`。
- 无头端高危工具默认禁用（config `chat.allowDangerousTools: false` 默认）。
- mirror 的 `send(params, userId, sender?)` 中 `sender` 已可选——被控面/无头端复用此入口，**不改签名**。

---

## Phase A：tianshu-server 新仓基建

### Task 1: 脚手架落地与数据模型

**Files:**
- Create: `/Users/hjx/workspace/tianshu-server/`（整仓，degit 自 shu-nestjs-starter）
- Modify: `prisma/schema.prisma`（摘表）、`src/config/config.yml`

**Interfaces:**
- Produces: 可 `npm run start:dev` 启动的空壳服务；Prisma models `Provider/Model/Assistant/Workspace/SessionRecord/MessageRecord`（供 T4/T6 使用）

- [ ] **Step 1: degit 脚手架并初始化**

```bash
cd /Users/hjx/workspace
npx degit /Users/hjx/workspace/shu-nestjs-starter tianshu-server --force
cd tianshu-server && git init && npm install
npm run init -- --name tianshu-server 2>/dev/null || node scripts/init.mjs
# init 交互输入 APP_NAME=tianshu-server，JWT_SECRET 留空自动生成，AUTHOR/REPO_URL 留空
```

- [ ] **Step 2: 摘取 Prisma 表（自 mirror `prisma/schema.prisma` 复制并重命名）**

`prisma/schema.prisma` 中 starter 的 `user/option/operation_log` 保留，追加（字段从 mirror 同名 model 原样复制，外键引用改为本仓 user）：

```prisma
model Provider { /* 自 mirror 原样：id userId name type baseUrl enabled apiKey createdAt updatedAt */ }
model Model    { /* 自 mirror model：id userId providerId name displayName ... */ }
model Assistant{ /* 自 mirror assistant：id userId name prompt systemPrompt params ... */ }
model Workspace{ /* 自 mirror workspace：id userId name directory ... */ }
model SessionRecord {
  // mirror 的 session 表改名（避开 starter 语义）：id userId workspaceId assistantId modelId title summary pinned archived createdAt updatedAt
}
model MessageRecord {
  // mirror 的 message 表改名：id sessionId role blocks error createdAt
}
```

注意 mirror schema 的字段以 `prisma/schema.prisma` 实际内容为准逐字段复制，不要凭记忆重写；去掉 mirror 特有且本仓不用的关联列可保留为普通列。

- [ ] **Step 3: config.yml 增加段**

```yaml
tianshu:
  dataRoot: ~/.tianshu-server
  chat:
    allowDangerousTools: false
  handshake: true
```

`src/commons/config/configuration.ts` 已递归加载 yml，无需改解析；新增 `src/commons/config/tianshu-config.entity.ts` 读 `tianshu` 段（照抄 `app-config.entity.ts` 的静态默认值模式）。

- [ ] **Step 4: 建库验证**

```bash
npm run prisma:generate
npx prisma db push
npm run start:dev &
sleep 8 && curl -s http://localhost:3000/actuator/health
```
Expected: `{"status":"up",...}`（或统一包装格式）后 `kill %1`

- [ ] **Step 5: Commit（tianshu-server 仓）**

```bash
git add -A && git commit -m "chore: degit shu-nestjs-starter + 摘表 Prisma schema + tianshu 配置段"
```

### Task 2: 协议事件总线与静态 token guard

**Files:**
- Create: `src/commons/event-bus/event-bus.service.ts`、`src/commons/event-bus/event-bus.module.ts`、`src/commons/auth/token.guard.ts`、`src/protocol/server-event.ts`
- Test: `test/commons/event-bus.spec.ts`、`test/commons/token-guard.spec.ts`

**Interfaces:**
- Produces: `EventBusService.publish(event: ServerEvent): void`、`subscribe(fn: (e: ServerEvent) => void): () => void`
- Produces: `ServerEvent`（判别联合，见 Step 1）、`StaticTokenGuard`（`@Public` 之外的全局 guard，校验 Bearer/env token）

- [ ] **Step 1: 定义协议事件类型 `src/protocol/server-event.ts`**

```typescript
export type ServerEvent =
  | { type: "server.connected"; payload: { instanceId: string; capabilities: string[] } }
  | { type: "session.updated"; payload: { id: number; title: string | null; updatedAt: Date } }
  | {
      type: "message.chunk";
      payload: { sessionId: number; chunk: unknown }; // chunk=天枢 onChunk 协议，T5 移植后收紧类型
    }
  | { type: "session.error"; payload: { sessionId: number; code: string; message: string } };

export const CAPABILITIES = ["chat", "provider"] as const;
```

- [ ] **Step 2: 写失败测试（EventBus 同步扇出/退订）**

`test/commons/event-bus.spec.ts`：

```typescript
import { EventBusService } from 'src/commons/event-bus/event-bus.service';

describe('EventBusService', () => {
  it('publish 扇出到所有订阅者，退订后不再收到', () => {
    const bus = new EventBusService();
    const got: string[] = [];
    const off = bus.subscribe((e) => got.push(e.type));
    const off2 = bus.subscribe((e) => got.push(e.type + '2'));
    bus.publish({ type: 'session.updated', payload: { id: 1, title: null, updatedAt: new Date() } });
    off2();
    bus.publish({ type: 'session.updated', payload: { id: 2, title: null, updatedAt: new Date() } });
    expect(got).toEqual(['session.updated', 'session.updated2', 'session.updated']);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -- event-bus`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `EventBusService`（Node EventEmitter 包装）与 `StaticTokenGuard`**

guard 语义：环境变量 `TIANSHU_TOKEN` 设置时，全局校验 `Authorization: Bearer <token>`（401 否则）；未设置时放行（dev）。SSE 场景允许 `?token=` query 等效。挂载：`src/app.module.ts` `APP_GUARD`，并在 controller 用 `@Public()` 豁免 `/info` 与 `/event` 的 JWT（token guard 对 `/event` 生效）。

- [ ] **Step 5: 跑测试通过并 Commit（tianshu-server 仓）**

```bash
npm test -- event-bus && npm test -- token-guard
git add -A && git commit -m "feat: 协议事件类型 + EventBus + 静态 token guard"
```

### Task 3: info 端点与启动握手行

**Files:**
- Create: `src/modules/info/info.controller.ts`、`src/modules/info/info.module.ts`
- Modify: `src/main.ts`（握手行输出）

**Interfaces:**
- Produces: `GET /info` → `{code:0,data:{name:"tianshu-server",version,instanceId,capabilities:["chat","provider"]}}`；启动 stdout 一行 `TIANSHU_HANDSHAKE {"port":3000,"token":"...","instanceId":"..."}`

- [ ] **Step 1: 写失败测试**（`test/modules/info.spec.ts`，用 `@nestjs/testing` 创建 app + supertest GET `/info`，断言 `data.capabilities` 含 `chat`；`@Public()` 路由免 JWT）

- [ ] **Step 2: 跑测试确认失败**（`npm test -- info`）

- [ ] **Step 3: 实现**——controller 返回 `{name: 'tianshu-server', version: appConfig.version, instanceId, capabilities: [...CAPABILITIES]}`；instanceId 用启动时 `randomUUID()` 存模块级单例。`main.ts` 在 `app.listen` 后 `console.log(\`TIANSHU_HANDSHAKE ${JSON.stringify({port, token: process.env.TIANSHU_TOKEN ?? '', instanceId})}\`)`。

- [ ] **Step 4: 跑测试通过；手动验证握手行**：`TIANSHU_TOKEN=abc npm run start:dev` 后首屏 stdout 含 `TIANSHU_HANDSHAKE {"port":3000,"token":"abc",...}`

- [ ] **Step 5: Commit（tianshu-server 仓）**：`feat: /info capability 协商 + stdout 握手行`

### Task 4: session/provider 模块（CRUD，无 chat）

**Files:**
- Create: `src/modules/session/session.module.ts`、`session.controller.ts`、`session.service.ts`、`session.repository.ts`、`dto/session-create.dto.ts`、`dto/session-query.dto.ts`
- Create: `src/modules/provider/`（同构：module/controller/service/repository + dto）
- Test: `test/modules/session.spec.ts`

**Interfaces:**
- Produces: `POST session/create|query|getById|delete`、`POST provider/query|save`（starter 统一包装）。`session/getById` 返回 `{session, messages: {id, role, blocks}[]}`。
- Consumes: Task 1 的 Prisma models；starter QueryFilter。

- [ ] **Step 1: 写失败测试**——`session/create` 建行返回 id；`session/query` 分页列表；`session/getById` 带空 messages；`session/delete` 后 query 为空（supertest + 测试库 `TIANSHU_DATA_ROOT` 指临时目录）

- [ ] **Step 2: 确认失败**（`npm test -- session`）

- [ ] **Step 3: 实现**——repository 直接 `prisma.sessionRecord.*`（类名以生成客户端为准）；controller 全 `@Public()` + token guard 生效；query 继承 starter `QueryFilter`（照抄 user 模块 querydecoder 写法）

- [ ] **Step 4: 跑测试通过**

- [ ] **Step 5: Commit（tianshu-server 仓）**：`feat: session/provider 模块 CRUD`

## Phase B：无头 chat 核心

### Task 5: 移植纯逻辑层（blocks/截断/参数/错误）

**Files:**
- Create: `src/core/chat/blocks.ts`、`history-truncate.ts`、`tool-output-trim.ts`、`param-merge.ts`、`error-classify.ts`、`context-usage.ts`、`time-context.ts`、`scenario-prompt.ts`、`expert-catalog.ts`
- Test: `test/core/blocks.spec.ts`、`test/core/history-truncate.spec.ts`

**Interfaces:**
- Produces: 与 mirror 同名导出（`blocksToModelMessages`/`parseBlocks`/`serializeBlocks`/`truncateHistory`/`trimHistoryToolOutputs`/`mergeParams`/`classifyError` 等），供 T6 消费。

- [ ] **Step 1: 复制源文件**——从 mirror `electron/domains/ai/chat/` 逐文件复制，剔除 electron import（这些文件本就是纯逻辑，预期零改动）；在仓 README「来源追踪」表登记每个文件的 mirror commit（`cd /Users/hjx/workspace/mirror && git log -1 --format=%h -- <file>`）。

- [ ] **Step 2: 失败测试先行**——从 mirror `tests/ai/chat/` 复制对应纯逻辑单测（blocks 序列化往返、truncate 边界），路径调整后运行确认 FAIL（模块缺失）。

- [ ] **Step 3: 复制实现后测试转 PASS**（`npm test -- core`）

- [ ] **Step 4: lint**（`npm run lint`）

- [ ] **Step 5: Commit（tianshu-server 仓）**：`feat: 移植 chat 纯逻辑层（blocks/截断/参数/错误）`

### Task 6: 移植 runChatStream 与无头工具集

**Files:**
- Create: `src/core/chat/run-chat-stream.ts`（自 mirror `chat.service.ts` 的 `runChatStream`+`consumeAgentStream` 依赖闭包抽出）、`src/core/chat/chat-runner.service.ts`
- Create: `src/core/tools/`（file/command/web/plan/skill 工具的自 mirror `agent/` 摘取改造版，`tool-gate` 高危项按 config 裁剪）
- Create: `src/core/provider/model-factory.ts`（自 mirror `provider/` 摘取 LangChain 工厂）
- Test: `test/core/run-chat-stream.spec.ts`

**Interfaces:**
- Produces: `runChatStream(options: ChatStreamOptions): Promise<ChatStreamResult>`（签名同 mirror）；`ChatRunnerService.run({sessionId, content, assistantId?, userId, onChunk})`——T7 的 send 端点调它。

- [ ] **Step 1: 失败测试**——fake `BaseChatModel`（`_stream` 返回固定文本 delta），断言 `onChunk` 依次收到 text 增量、usage、finish（自 mirror `tests/ai/chat/agent-loop.test.ts` 的 fake model 手法移植）

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现移植**——`runChatStream` 主体照抄 mirror 394-560 行区间逻辑；工具注册表仅收无头集；`commandGate/fileGate` 保留但 `allowDangerousTools=false` 时 command/批量删除工具直接拒绝（返回拒绝 chunk）

- [ ] **Step 4: 跑测试通过**（含 T5 回归：`npm test`）

- [ ] **Step 5: Commit（tianshu-server 仓）**：`feat: 移植 runChatStream + 无头工具集 + model 工厂`

### Task 7: send/abort 端点 + SSE 事件桥

**Files:**
- Modify: `src/modules/session/session.controller.ts`、`session.service.ts`
- Create: `src/modules/event/event.controller.ts`（`GET /event` SSE）
- Test: `test/modules/session-send.spec.ts`

**Interfaces:**
- Produces: `POST session/send` → 202 `{data:{accepted:true}}`，流经 `message.chunk`/`session.error` 事件；`POST session/abort` → 200。SSE：`GET /event`（query token），首帧 `server.connected`，之后逐事件 `event: <type>\ndata: <json>\n\n`。

- [ ] **Step 1: 失败测试**——supertest POST `session/send`（fake model 经 T6 注入点），再 GET `/event` 收集 5s 内帧序列：`server.connected` → ≥1 个 `message.chunk` → finish chunk（用 `EventBusService` 直接订阅断言 publish 序列亦可，SSE 编码层另测首帧格式）

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**——`send` 用 `setImmediate` 异步启动 `ChatRunnerService.run`，`onChunk` → `bus.publish({type:'message.chunk',...})`；abort 维护 `Map<sessionId, AbortController>`；SSE controller 用 Fastify `reply.raw` 写流（`Content-Type: text/event-stream`），订阅 bus 转发、`onClose` 退订

- [ ] **Step 4: 跑全量测试通过**

- [ ] **Step 5: 手动冒烟**：dev 起服务 → curl 建会话 → 配一个真实模型 → `curl -N "...event?token=..."` 挂着 → POST send → 观察 SSE 帧流。完成后 Commit：`feat: session send/abort + SSE 事件桥（chat 遥控服务端闭环）`

## Phase C：relay 本体

### Task 8: relay 配对转发核心

**Files:**
- Create: `src/relay/relay-main.ts`、`src/relay/registry.ts`
- Modify: `package.json`（scripts 增加 `"start:relay": "node dist/relay/relay-main.js"`；dependencies 增加 `ws` 与 dev `@types/ws`）
- Test: `test/relay/relay.spec.ts`

**Interfaces:**
- Produces: `startRelay({port, token}): Promise<void>`；WS 端点 `GET /ws?role=server|client&token=&connectionId=`；帧 `{kind:'req'|'res'|'event'|'open'|'close', ...}`；`GET /health`。
- 注册表：`Registry`——`registerServer(connectionId, ws)`、`attachClient(connectionId, ws)`、`notifyOpen/notifyClose`。

- [ ] **Step 1: 失败测试**——本机起 relay（随机端口），用两个 ws 客户端：server 端（role=server）注册 id=s1；client 端发 `{kind:'open',connectionId:'s1'}` 后发 `{kind:'req',id:1,...}`，断言 server 端收到 req 帧，回 `{kind:'res',id:1,...}`，client 端收到；再发 `{kind:'event'...}` 由 server→client 透传。

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**——`node:http` + `ws` 单文件 ≤200 行：role=server 的 ws 收到即注册（首消息 `{kind:'register', instanceId, capabilities, name}` 可选）；client 的 `open` 帧触发 registry 配对，此后双向 `ws.send` 直转；token 不符 close(4001)；心跳 ping 30s/超时 60s 剔除。

- [ ] **Step 4: 跑测试通过**

- [ ] **Step 5: Commit（tianshu-server 仓）**：`feat: relay 中继核心（role 配对 + 帧转发 + token + 心跳）`

### Task 9: relay 健壮性与部署文档

**Files:**
- Modify: `src/relay/relay-main.ts`（CLI 参数、有界缓冲）
- Create: `README-relay.md`（部署：Docker/systemd/nginx TLS 示例）

**Interfaces:**
- Produces: CLI `node dist/relay/relay-main.js --port 8411 --token <t> --max-buffer-frames 200`

- [ ] **Step 1: 失败测试**——client 在 server 端未注册时 open → 收 `{kind:'close', reason:'not-found'}`；server 端掉线 → 已配对 client 收 close 帧；缓冲超限断开。

- [ ] **Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过**

- [ ] **Step 5: Commit（tianshu-server 仓）**：`feat: relay 健壮性（not-found/close 通知/背压）+ 部署文档`

## Phase D：mirror 被控面

### Task 10: chat.service tap 点

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`（`emit` 方法，行 1191 附近）
- Create: `electron/domains/server-face/chat-tap.ts`
- Test: `tests/ai/server-face/chat-tap.test.ts`

**Interfaces:**
- Produces: `onChatChunk(fn: (sessionId: number, chunk: ChatStreamChunk) => void): () => void`（进程级单例订阅）；`chat.service` 的 `emit` 无论 sender 有无都先 `chatTap.emit(...)`。

- [ ] **Step 1: 失败测试**——构造 fake sender（undefined）调私有 emit 不可行，改为集成式：用现有测试手法实例化 ChatService（参考 `tests/ai/chat/agent-loop.test.ts` 的构造方式），`send({...}, userId, undefined)` + fake model，断言 `onChatChunk` 收到 text/finish chunk；退订后不再收。

- [ ] **Step 2: 确认失败**（`npx vitest run tests/ai/server-face/chat-tap.test.ts`）

- [ ] **Step 3: 实现**——`chat-tap.ts`：`const tap = new EventEmitter(); export function emitChatChunk(s,c){tap.emit('chunk',s,c)} export function onChatChunk(fn){tap.on('chunk',fn); return ()=>tap.off('chunk',fn)}`；`emit()` 首行插 `emitChatChunk(sessionId, chunk)`（在 sender 判空前）。

- [ ] **Step 4: 跑 tap 测试 + 全量 chat 回归通过**（`npx vitest run tests/ai/chat`）

- [ ] **Step 5: Commit（mirror 仓）**：`feat(server-face): chat 流 tap 点（渲染层零改动）`

### Task 11: 被控面路由表与查询端点

**Files:**
- Create: `electron/domains/server-face/server-face.ts`、`electron/domains/server-face/routes.ts`
- Test: `tests/ai/server-face/routes.test.ts`

**Interfaces:**
- Produces: `handleRoute(method, path, body): Promise<{status:number; body:unknown}>`——path 分发：`GET /info`、`POST session/create|query|getById|delete|send|abort`（send/abort 本任务先占位 501，T12 接通）；`ensureServerFace(): Promise<number>`、`stopServerFace()`（node:http，`option` 表 `serverFace` 配置 `{enabled,port,token,host}`，默认关）。
- Consumes: T10 `onChatChunk`；`SessionRepository`（`electron/domains/ai/chat/session.repo.ts`：`listSessions/getSessionById/createSession/deleteSession`）；userId 取被控面单用户语义——`handleUser` 现有 token 解析不可用（无渲染层请求），改为读主进程当前登录用户（mirror 单用户桌面形态，取 user 表首个，与 webhook-server 的 workspace 取法同款先例）。

- [ ] **Step 1: 失败测试**——直接调 `handleRoute('GET','/info',null)` 断言 capabilities 含 `chat`；`session/create`+`query`+`getById` 闭环（repo 走测试库，`tests/setup.ts` 已隔离 `TIANSHU_DATA_ROOT`）

- [ ] **Step 2: 确认失败 → Step 3: 实现**（路由表纯函数 + service 桥，`{code:0,data}` 包装与 starter 同构）

- [ ] **Step 4: 通过 → Step 5: Commit（mirror 仓）**：`feat(server-face): 被控面路由表与查询端点`

### Task 12: 被控面 send 桥 + SSE + relay 客户端 + IPC

**Files:**
- Modify: `electron/domains/server-face/server-face.ts`（SSE 出口）
- Create: `electron/domains/server-face/relay-client.ts`
- Modify: `electron/commons/ipc-channels.ts`（INVOKE 加 `serverFace:status`、`serverFace:setEnabled`；`option` 域已有通用 CRUD 可存配置则不加新通道）
- Test: `tests/ai/server-face/server-face.test.ts`

**Interfaces:**
- Produces: `startRelayClient(relayUrl, relayToken): Promise<void>` / `stopRelayClient()`——出站 WS role=server，`req` 帧调 `handleRoute` 回 `res` 帧，`onChatChunk` 驱动 `event` 帧；HTTP 面同时提供 `GET /event` SSE（同 T7 编码）。
- `chat.service` 获取：`Application.ts` 已实例化的单例导出（mirror 现有 Application 持有方式——`handleRoute` 从 `Application` 的 service 注册表取，若为私有则加只读 getter，**不改 send 签名**）。

- [ ] **Step 1: 失败测试**——起 `handleRoute` + 本机 ws server 模拟 relay：`startRelayClient` 注册后收到 `req` 帧（session/query）回 `res`；`emitChatChunk` 后收到 `event` 帧

- [ ] **Step 2: 确认失败 → Step 3: 实现（send 桥：`handleRoute('POST','session/send')` 调 `chatService.send(params, userId, undefined)`）→ Step 4: 通过（含 T10/T11 回归）**

- [ ] **Step 5: 手动冒烟**：dev 起桌面端 → option 开 serverFace → `curl -N localhost:<port>/event?token=...` → 渲染层正常发一条消息 → curl 侧看到 `message.chunk` 流。Commit（mirror 仓）：`feat(server-face): send/SSE/relay 客户端 + IPC 登记`

## Phase E：mirror 控制端

### Task 13: Transport 抽象 + DirectTransport

**Files:**
- Create: `electron/domains/server/transport.ts`、`electron/domains/server/direct-transport.ts`
- Test: `tests/ai/server/direct-transport.test.ts`

**Interfaces:**
- Produces: `interface Transport { request(method: 'GET'|'POST', path: string, body?: unknown): Promise<{status:number; body:any}>; onEvent(fn: (e: ServerEvent) => void): () => void; state: 'connecting'|'connected'|'reconnecting'|'closed'; close(): void }`；`new DirectTransport({baseUrl, token})`——fetch + SSE 流解析（node:http 手写解析，无 EventSource 依赖）+ 指数退避重连（1s 起、上限 30s）。
- `ServerEvent` 类型镜像 tianshu-server 侧（mirror 侧定义放 `electron/domains/server/protocol.ts`，双仓同构）。

- [ ] **Step 1: 失败测试**——本机 node:http 起假被控端（固定 SSE 帧），DirectTransport 连上后 `onEvent` 收到 `server.connected`；`request('POST','session/query')` 拿到包装体；杀掉假服务端断言 state 转 `reconnecting`，重启后回 `connected`

- [ ] **Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过**

- [ ] **Step 5: Commit（mirror 仓）**：`feat(server): Transport 抽象 + 直连承载（fetch+SSE+重连）`

### Task 14: RelayTransport

**Files:**
- Create: `electron/domains/server/relay-transport.ts`
- Test: `tests/ai/server/relay-transport.test.ts`

**Interfaces:**
- Produces: `new RelayTransport({relayUrl, relayToken, connectionId})`——同 `Transport` 接口；内部 ws 连 role=client，`request` 封 `req` 帧按 id 配对 `res`（10s 超时拒绝），`event` 帧回调 `onEvent`。

- [ ] **Step 1: 失败测试**——复用 T8 真 relay（自 tianshu-server 仓 `npm run build` 后 `node dist/relay/relay-main.js` 起本机实例）+ 假 server 端（ws 客户端回 res 帧）：断言 request→res 配对、event 透传、relay 断线重连
- [ ] **Step 2-4: 确认失败 → 实现 → 通过**
- [ ] **Step 5: Commit（mirror 仓）**：`feat(server): relay 承载 Transport`

### Task 15: ServerSupervisor

**Files:**
- Create: `electron/domains/server/supervisor.ts`
- Test: `tests/ai/server/supervisor.test.ts`

**Interfaces:**
- Produces: `class ServerSupervisor { state: 'stopped'|'starting'|'running'|'error'; start(cmd: {command: string; args: string[]; env?: Record<string,string>}): Promise<{port:number; token:string; instanceId:string}>; stop(): Promise<void>; onExit(fn): void }`——spawn 子进程、stdout 逐行扫 `TIANSHU_HANDSHAKE ` 前缀解析 JSON、10s 握手超时 kill+error、退出码非 0 → error。

- [ ] **Step 1: 失败测试**——fake 子进程：`node -e "console.log('TIANSHU_HANDSHAKE {\"port\":3999,...}')"` 断言握手解析；超时路径用 `node -e "setTimeout(()=>{},30000)"` 断言 10s 后 error
- [ ] **Step 2-4: TDD 循环**
- [ ] **Step 5: Commit（mirror 仓）**：`feat(server): 本地无头端 Supervisor（spawn+握手+状态机）`

### Task 16: 连接注册表 + 控制端 IPC 面

**Files:**
- Create: `electron/domains/server/connections.ts`（option 表持久化）、`electron/domains/server/ipc.ts`
- Modify: `electron/commons/ipc-channels.ts`、`electron/Application.ts`（装配）
- Test: `tests/ai/server/connections.test.ts`

**Interfaces:**
- Produces: `ConnectionConfig = {id: string; name: string; mode: 'direct'|'relay'; baseUrl?; token?; relayUrl?; relayToken?; connectionId?; local?: boolean}`；IPC 通道（INVOKE）：`server:connectionList/save/delete/testConnection`、`server:localStart/localStop/localStatus`、`server:sessionList/sessionGet/sessionSend/sessionAbort/sessionCreate`（透传当前活动连接，事件经 EVENT_PREFIXES `server:chunk:` 推渲染层：`server:chunk:<connId>:<sessionId>`）。

- [ ] **Step 1: 失败测试**——连接注册表 CRUD 持久化到 option（测试库）；`testConnection` 对假服务端返回 capabilities
- [ ] **Step 2-4: TDD 循环**
- [ ] **Step 5: Commit（mirror 仓）**：`feat(server): 连接注册表 + 控制端 IPC 面`

## Phase F：前端控制台页

### Task 17: 「服务端」页骨架与连接管理

**Files:**
- Create: `src-react/domains/ai/server/api/server.api.ts`、`views/ServerConsoleView.tsx`、`components/ConnectionList.tsx`、`components/ConnectionDialog.tsx`
- Modify: `src-react/routes/index.tsx`（`/module/ai/server` 路由 + 懒加载）、AI 侧边栏导航（`src-react/domains/ai/layout/`，照 automation 入口样式）、`src-react/i18n/locales/{zh-CN,en-US}/ai.json`
- Test: `tests/ai/server/console-view.test.tsx`

**Interfaces:**
- Consumes: Task 16 IPC 通道。
- Produces: 页面分左右两栏——左连接列表（状态点/增删/测试连接/本地无头端启停卡），右会话遥控区（T18）。i18n keys：`server:pageTitle`、`server:connection.add`、`server:connection.name`、`server:connection.mode`、`server:local.start/stop/status.*` 等全量双语。

- [ ] **Step 1: 失败测试**——渲染 ServerConsoleView（mock ipcRenderer）：显示连接列表空态 + 「添加连接」按钮；添加对话框校验必填
- [ ] **Step 2-4: TDD 循环**（样式守约束：主题变量、`border-border/50 rounded-lg shadow-lg` 弹层）
- [ ] **Step 5: Commit（mirror 仓）**：`feat(server): 控制台页骨架与连接管理（i18n 双语）`

### Task 18: 会话遥控（列表/历史/发消息/流式回显）

**Files:**
- Create: `src-react/domains/ai/server/components/RemoteSessionPanel.tsx`、`RemoteMessageList.tsx`、`RemoteComposer.tsx`
- Modify: `src-react/domains/ai/server/api/server.api.ts`（事件订阅封装：`onRemoteChunk(connId, sessionId, cb)` → `ipcRenderer.on(\`server:chunk:${connId}:${sessionId}\`)`）
- Test: `tests/ai/server/remote-session.test.tsx`

**Interfaces:**
- Consumes: Task 16 `server:session*` IPC + `server:chunk:` 事件；blocks 渲染复用 `src-react/domains/ai/chat/` 现有消息组件（只读模式）。
- Produces: 选连接 → 会话列表 → 打开（历史 blocks 渲染）→ 输入框发消息 → chunk 增量上屏（text/thinking/toolcall/finish 与桌面端同构渲染）。

- [ ] **Step 1: 失败测试**——mock IPC：send 后依次投递 text chunk ×2 + finish，断言消息列表出现拼接文本且状态转完成；abort 按钮调用 `server:sessionAbort`
- [ ] **Step 2-4: TDD 循环**
- [ ] **Step 5: Commit（mirror 仓）**：`feat(server): 远程会话遥控（流式回显复用 blocks 渲染）`

## Phase G：E2E 与收尾

### Task 19: 双链路 E2E 冒烟脚本

**Files:**
- Create: `tests/ai/server/e2e-smoke.ts`（node 脚本，不进 vitest 常规集，`npm run` 手动触发——package.json scripts 加 `test:e2e:server`）

**Interfaces:**
- Consumes: 全链路。

- [ ] **Step 1: 直连链路**——脚本：起 tianshu-server（TIANSHU_TOKEN=e2e）→ Supervisor 式 spawn 或直连 → 建 session → SSE 订阅 → send「回复 pong」→ 断言收到含 finish 的事件序列 → 清理。需真实可用模型（读环境 `E2E_MODEL_*`，未配置则 SKIP 并打印）
- [ ] **Step 2: 中继链路**——起 relay → 起 tianshu-server + RelayClient（被控角色）→ 控制侧 RelayTransport → 同上断言
- [ ] **Step 3: mirror dev 全链路**——`npm run dev` 起桌面端 → option 开 serverFace → 控制台页添加 direct 连接 `localhost:<port>` → UI 发消息看到流式回显（人工验收，截图留档 `docs/superpowers/manual-acceptance-2026-10-17-tianshu-server.md`）
- [ ] **Step 4: 更新 mirror CLAUDE.md 路由表与目录说明（server 域 + server-face 域两行）**
- [ ] **Step 5: Commit（两仓各自）**：mirror `feat(server): E2E 冒烟 + 文档收尾`；tianshu-server `chore: e2e 支持与 README 补全`

---

## Self-Review 结论

- **Spec 覆盖**：§3 协议（T2/T3/T4/T7/T8/T13/T14）、§4 无头核心（T1-T7）、§5 relay（T8/T9）、§6 被控面（T10-T12）、§7 控制端（T13-T18）、§8 错误处理（重连/握手超时/401 分布在 T13/T15/T17）、§9 测试（各任务 TDD + T19）、§12 偏离项已由任务内约束承载（高危工具 T6、双仓同构 T5 登记表）。§11 一期清单全覆盖；ui-drive/graph 等二期不在本计划。
- **类型一致性**：`ServerEvent`/帧 `kind` 两处定义（tianshu-server `src/protocol/`、mirror `electron/domains/server/protocol.ts`）已标注同构双改；`handleRoute`/`Transport`/`onChatChunk` 前后任务签名一致。
- **占位符扫描**：Task 1 Prisma 摘表以「以 mirror 实际 schema 为准逐字段复制」为指令而非凭空造字段；Task 11/12 的 service 获取方式给出 fallback 指令。无 TBD。
