// 被控面路由表（server-face spec §3.1 / T11）：逻辑协议单一分发点，
// HTTP 面（server-face.ts）与 relay 客户端（relay-client.ts）共用同一张表。
// 响应包装与 tianshu-server starter 同构（双仓协议契约）：
// - 成功：{code:"2000", success:true, data, message:"success"}
// - 业务错：HTTP 200 + {code:"4005"|"4040"|"5000", success:false, data:null, message}
//   （控制端查 body.success 勿只看 res.ok——T3/T4 契约注记）
//   错误码表：4005 参数错（ui/openRoute 白名单外/穿越段，UD-T3 上提）；
//   4040 资源不存在或路由未登记；5000 参数畸形/未初始化/内部错误
// path 口径：表内键不带前导斜杠（"session/query"），handleRoute 归一 HTTP
// 侧 "/session/query" 与 relay 帧侧 "session/query" 等价。
import { BrowserWindow } from "electron";
import { faceDeps, type ServerFaceDeps } from "./deps";
import type { ServerFaceAutomation } from "./deps";
import { FaceFilesError } from "./files-tap";
import { FaceArtifactError } from "./artifact-tap";
import { FaceExpertError } from "./expert-tap";
import { FaceLibraryError } from "./library-tap";
import { FaceMcpError } from "./mcp-tap";
import { FacePermissionError } from "./permission-tap";
import { FaceProjectError } from "./project-tap";
import { FaceSkillError } from "./skills-tap";
import { FaceSkillHubError } from "./skillhub-tap";
import { FaceWorkspaceError } from "./workspace-tap";
import path from "node:path";
import { appDataHome } from "../../commons/paths";
import { publishFaceEvent } from "./face-events";
import { ENDPOINTS } from "@tianshu/protocol";
import type {
  ApproveParams,
  AssistantSavePayload,
  ExpertImportPayload,
  ImagePayload,
  McpSavePayload,
  MonitorScene,
  PlanItemCreatePayload,
  PlanItemMovePayload,
  PlanItemUpdatePayload,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProviderSavePayload,
  SkillHubListPayload,
  SkillScenario,
  UiNotifyParams,
  UiOpenRouteParams,
  WorkspaceSavePayload,
  AutomationRunRecord,
} from "@tianshu/protocol";
import type { ChatSendParams } from "../../../src-react/domains/ai/api/chat.api";
import type { MessageRecord } from "../../../src-react/domains/ai/api/session.api";

export interface RouteResult {
  status: number;
  body: unknown;
}

type RouteHandler = (body: unknown) => Promise<RouteResult>;

/** 成功包装（starter ResponseInterceptor 同构；202 受理等状态码透传） */
function ok(data: unknown, status = 200): RouteResult {
  return {
    status,
    body: { code: "2000", success: true, data, message: "success" },
  };
}

/** 业务错包装（starter HttpExceptionFilter 同构：HTTP 200 + 4xxx/5xxx） */
function bizError(code: string, message: string): RouteResult {
  return { status: 200, body: { code, success: false, data: null, message } };
}

/** 仓储已知错误码 → 业务错映射；未知错误 5000 兜底不裸抛 */
const REPO_ERROR_MESSAGES: Record<string, string> = {
  SESSION_NOT_FOUND: "会话不存在",
  WORKSPACE_NOT_FOUND: "工作空间不存在",
  PROJECT_NOT_FOUND: "项目不存在",
  PROJECT_NAME_EXISTS: "项目名已存在",
  PLAN_ITEM_NOT_FOUND: "计划事项不存在",
  PLAN_VIEW_LAST_ONE: "项目至少保留一个视图",
  ASSET_PATH_ESCAPE: "非法路径",
  ASSET_NOT_FOUND: "资产不存在",
  ASSET_NAME_INVALID: "名称无效",
  // A4 阶段 0：McpRepository.assertOwned 不存在/越权错误映射（旧裸
  // updateMany 路径静默成功属 bug，修正后经此返回 4040 而非 5000）
  MCP_SERVER_MISSING: "连接器不存在",
};

function bizErrorFrom(error: unknown): RouteResult {
  const raw = error instanceof Error ? error.message : String(error);
  const message = REPO_ERROR_MESSAGES[raw];
  if (message) return bizError("4040", message);
  return bizError("5000", raw || "内部错误");
}

/** 请求体取正整数 id/number（缺省/畸形 → null，调用方决定业务错） */
function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** 单用户解析失败统一口径：无用户 = 被控端未初始化（5000，非存在性泄露） */
async function withUserId(
  fn: (userId: number) => Promise<RouteResult>,
): Promise<RouteResult> {
  const userId = await faceDeps().resolveUserId();
  if (userId == null) {
    return bizError("5000", "被控端尚未初始化用户");
  }
  return fn(userId);
}

async function handleInfo(): Promise<RouteResult> {
  return ok(await faceDeps().info());
}

/** MCP 批：连接器列表（敏感字段 env/headers 不透出——裁剪在装配层） */

// ===== 移动端 CRUD 批（2026-10-27）：automation 五端点 + graph/query
// 只读（桌面本地 repo 单源桥——automation-tap；与无头端
// AutomationController 同构，save 全量 upsert/runPage 剔 graphTrace） =====

// ===== 记忆进化批（2026-10-27）：memory 五端点——桌面被控面专属（option
// 表 app 级配置无 userId 语义，不挂 withUserId；AI 操作错误码透传协议包
// MemoryErrorCode 五值） =====
// ===== 备份面批（2026-10-27）：backup 三端点——桌面被控面专属（遥控
// 桌面备份客户端；create 202 受理+事件流推进度） =====
async function handleBackupList(): Promise<RouteResult> {
  const backup = faceDeps().backup;
  if (!backup) return bizError("5000", "备份面未装配");
  return backup.list().then(ok).catch(bizErrorFrom);
}

async function handleBackupCreate(body: unknown): Promise<RouteResult> {
  const backup = faceDeps().backup;
  if (!backup) return bizError("5000", "备份面未装配");
  const b = (body ?? {}) as { note?: unknown };
  if (b.note !== undefined && typeof b.note !== "string") {
    return bizError("5000", "note 必须为字符串");
  }
  return backup
    .create(
      typeof b.note === "string" && b.note.trim() ? b.note.trim() : undefined,
    )
    .then((result) => ok(result, 202))
    .catch(bizErrorFrom);
}

async function handleBackupDelete(body: unknown): Promise<RouteResult> {
  const backup = faceDeps().backup;
  if (!backup) return bizError("5000", "备份面未装配");
  const b = (body ?? {}) as { id?: unknown };
  if (typeof b.id !== "string" || !b.id) {
    return bizError("5000", "id 必填");
  }
  return backup
    .delete(b.id)
    .then(() => ok({ deleted: true }))
    .catch(bizErrorFrom);
}

async function handleMemoryGet(): Promise<RouteResult> {
  const memory = faceDeps().memory;
  if (!memory) return bizError("5000", "记忆面未装配");
  return memory.get().then(ok).catch(bizErrorFrom);
}

async function handleMemorySaveConfig(body: unknown): Promise<RouteResult> {
  const memory = faceDeps().memory;
  if (!memory) return bizError("5000", "记忆面未装配");
  const b = (body ?? {}) as { enabled?: unknown; modelId?: unknown };
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    return bizError("5000", "enabled 必须为布尔");
  }
  if (
    b.modelId !== undefined &&
    b.modelId !== null &&
    typeof b.modelId !== "number"
  ) {
    return bizError("5000", "modelId 必须为数字或 null");
  }
  return memory
    .saveConfig(b as { enabled?: boolean; modelId?: number | null })
    .then(ok)
    .catch(bizErrorFrom);
}

async function handleMemorySaveProfile(body: unknown): Promise<RouteResult> {
  const memory = faceDeps().memory;
  if (!memory) return bizError("5000", "记忆面未装配");
  const b = (body ?? {}) as { profile?: unknown };
  if (typeof b.profile !== "string") {
    return bizError("5000", "profile 必须为字符串");
  }
  return memory.saveProfile(b.profile).then(ok).catch(bizErrorFrom);
}

async function handleMemoryApplyInstruction(
  body: unknown,
): Promise<RouteResult> {
  const memory = faceDeps().memory;
  if (!memory) return bizError("5000", "记忆面未装配");
  const b = (body ?? {}) as { instruction?: unknown };
  if (typeof b.instruction !== "string" || !b.instruction.trim()) {
    return bizError("5000", "instruction 必填");
  }
  return memory.applyInstruction(b.instruction).then(ok).catch(bizErrorFrom);
}

async function handleMemoryCompile(): Promise<RouteResult> {
  const memory = faceDeps().memory;
  if (!memory) return bizError("5000", "记忆面未装配");
  return memory.compile().then(ok).catch(bizErrorFrom);
}

async function handleAutomationQuery(body: unknown): Promise<RouteResult> {
  const face = faceDeps().automation;
  if (!face) return bizError("5000", "自动化面未装配");
  const b = (body ?? {}) as {
    page?: number;
    pageSize?: number;
    keyword?: string;
  };
  return withUserId((userId) =>
    face
      .query(b.page ?? 1, b.pageSize ?? 20, b.keyword, userId)
      .then(ok)
      .catch(bizErrorFrom),
  );
}

async function handleAutomationSave(body: unknown): Promise<RouteResult> {
  const face = faceDeps().automation;
  if (!face) return bizError("5000", "自动化面未装配");
  return withUserId((userId) =>
    face
      .save(body as Parameters<ServerFaceAutomation["save"]>[0], userId)
      .then(ok)
      .catch((error: unknown) =>
        bizError(
          "5000",
          error instanceof Error ? error.message : "任务保存失败",
        ),
      ),
  );
}

async function handleAutomationDelete(body: unknown): Promise<RouteResult> {
  const face = faceDeps().automation;
  if (!face) return bizError("5000", "自动化面未装配");
  const b = (body ?? {}) as { ids?: unknown };
  if (!Array.isArray(b.ids)) return bizError("5000", "ids 必须为数组");
  return withUserId((userId) =>
    face
      .delete(b.ids as number[], userId)
      .then(() => ok(null))
      .catch(bizErrorFrom),
  );
}

async function handleAutomationRunNow(body: unknown): Promise<RouteResult> {
  const face = faceDeps().automation;
  if (!face) return bizError("5000", "自动化面未装配");
  const b = (body ?? {}) as { taskId?: unknown };
  const taskId = b.taskId;
  if (typeof taskId !== "number") return bizError("5000", "taskId 必填");
  return withUserId((userId) =>
    face
      .runNow(taskId, userId)
      .then(() => ok({ accepted: true }))
      .catch(bizErrorFrom),
  );
}

async function handleAutomationRunPage(body: unknown): Promise<RouteResult> {
  const face = faceDeps().automation;
  if (!face) return bizError("5000", "自动化面未装配");
  const b = (body ?? {}) as {
    page?: unknown;
    taskId?: unknown;
    status?: unknown;
  };
  if (typeof b.page !== "number") return bizError("5000", "page 必填");
  if (b.taskId !== undefined && typeof b.taskId !== "number") {
    return bizError("5000", "taskId 必须为数字");
  }
  return withUserId((userId) =>
    face
      .runPage(
        b.page as number,
        b.taskId as number | undefined,
        b.status as AutomationRunRecord["status"] | undefined,
        userId,
      )
      .then(ok)
      .catch(bizErrorFrom),
  );
}

/** 运行节点详情（执行详情批）：桥桌面 GraphRepository.listRunNodes
 *  单源；空集语义同无头端（不符/prompt run/老 run 无节点行） */
async function handleAutomationRunNodes(body: unknown): Promise<RouteResult> {
  const face = faceDeps().automation;
  if (!face) return bizError("5000", "自动化面未装配");
  const b = (body ?? {}) as { runId?: unknown };
  if (typeof b.runId !== "number") return bizError("5000", "runId 必填");
  return withUserId((userId) =>
    face
      .runNodes(b.runId as number, userId)
      .then(ok)
      .catch(bizErrorFrom),
  );
}

async function handleGraphQueryReadonly(body: unknown): Promise<RouteResult> {
  const face = faceDeps().graphsReadonly;
  if (!face) return bizError("5000", "图面未装配");
  const b = (body ?? {}) as {
    page?: number;
    pageSize?: number;
    keyword?: string;
  };
  return withUserId((userId) =>
    face
      .query(b.page ?? 1, b.pageSize ?? 20, b.keyword, userId)
      .then(ok)
      .catch(bizErrorFrom),
  );
}

async function handleMcpQuery(): Promise<RouteResult> {
  const mcps = faceDeps().mcps;
  if (!mcps) return bizError("5000", "连接器面未装配");
  return withUserId((userId) =>
    mcps
      .list(userId)
      .then((rows) => ok(rows))
      .catch((error: unknown) => bizErrorFrom(error)),
  );
}

/** MCP 批：连接器启停（归属校验在装配层 repo） */
async function handleMcpSetEnabled(body: unknown): Promise<RouteResult> {
  const mcps = faceDeps().mcps;
  if (!mcps) return bizError("5000", "连接器面未装配");
  const id = asInt((body as { id?: unknown } | null)?.id);
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (id === null || typeof enabled !== "boolean") {
    return bizError("5000", "参数不合法");
  }
  return withUserId((userId) =>
    mcps
      .setEnabled(id, enabled, userId)
      .then(() => ok(null))
      .catch((error: unknown) => bizErrorFrom(error)),
  );
}

/** A6 监控读面：scene 白名单（非法/缺省归 undefined，对齐桌面 IPC 口径） */
const SCENE_LIST = ["chat", "graph", "automation"] as const;

/** monitor/stats：用量监控只读聚合 */
async function handleMonitorStats(body: unknown): Promise<RouteResult> {
  const scene = (body as { scene?: unknown })?.scene;
  const monitor = faceDeps().monitor;
  if (!monitor) return bizError("5000", "monitor 面未装配");
  return withUserId(async (userId) =>
    ok(
      await monitor.stats(
        userId,
        SCENE_LIST.includes(scene as never)
          ? (scene as MonitorScene)
          : undefined,
      ),
    ),
  );
}

async function handleCreate(body: unknown): Promise<RouteResult> {
  const params = (body ?? {}) as {
    title?: string;
    workspaceId?: number;
    assistantId?: number;
  };
  return withUserId(async (userId) => {
    const deps = faceDeps();
    // workspaceId 缺省挂默认空间（用户最新一个；无空间即业务错，不自建
    // ——桌面端工作空间带目录语义，被控面不可替用户拍板目录）
    const workspaceId =
      asInt(params.workspaceId) ??
      (await deps.resolveDefaultWorkspaceId(userId));
    if (workspaceId == null) {
      return bizError("4040", "工作空间不存在");
    }
    const session = await deps.sessions.createSession(
      {
        workspaceId,
        title: params.title,
        ...(params.assistantId != null
          ? { assistantId: params.assistantId }
          : {}),
      },
      userId,
    );
    return ok(session);
  });
}

/** 会话分页查询（starter QueryResult 同构：{page,pageSize,records,total}）；
 * 过滤 keyword contains / workspaceId / archived 布尔 / activityAfter 时间窗
 * （tianshu-server session.querydecoder 同口径）。face 全表扫描优化批：数据
 * 源切换 querySessions（条件下推 + DB 分页仅当前页 enrich，不再全量聚合后
 * 内存过滤切片）；分页钳制（page>=1、pageSize 1~500）内聚 repo，协议不变 */
async function handleQuery(body: unknown): Promise<RouteResult> {
  const params = (body ?? {}) as {
    page?: number;
    pageSize?: number;
    keyword?: string;
    workspaceId?: number;
    archived?: boolean;
    activityAfter?: string;
  };
  // A11 时间筛选批：畸形时间串按 5000 参数不合法拒（跟随本 handler
  // 参数错误惯例）；阈值由客户端按本机时区算好上送（被控端时区不可信）
  let since: Date | null = null;
  if (typeof params.activityAfter === "string") {
    const parsed = new Date(params.activityAfter).getTime();
    if (Number.isNaN(parsed)) {
      return bizError("5000", "activityAfter 参数不合法");
    }
    since = new Date(parsed);
  }
  return withUserId(async (userId) => {
    const data = await faceDeps().sessions.querySessions(
      {
        page: asInt(params.page) ?? undefined,
        pageSize: asInt(params.pageSize) ?? undefined,
        // 空串 keyword 历史上等同不过滤（falsy 短路），保持兼容不传
        ...(typeof params.keyword === "string" && params.keyword
          ? { keyword: params.keyword }
          : {}),
        ...(params.workspaceId != null
          ? { workspaceId: params.workspaceId }
          : {}),
        ...(typeof params.archived === "boolean"
          ? { archived: params.archived }
          : {}),
        ...(since !== null ? { activityAfter: since } : {}),
      },
      userId,
    );
    return ok(data);
  });
}

/** 会话详情：会话 + 消息历史（blocks 原样字符串，按 id 升序）。
 * listMessages 为游标分页（H6，页内时间正序、游标自新向旧翻页），此处翻页
 * 拉全量后按 id 升序整体排序——直接拼接会以 500 条/块整块倒序（终审
 * Issue 2：长会话远控历史渲染错乱） */
async function handleGetById(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id == null) {
    return bizError("4040", "会话不存在");
  }
  return withUserId(async (userId) => {
    const deps = faceDeps();
    const session = await deps.sessions.getSessionById(id, userId);
    const messages: MessageRecord[] = [];
    let beforeId: number | undefined;
    // 安全上限 200 页 × 500 条（10 万条）防畸形数据死循环
    for (let i = 0; i < 200; i += 1) {
      const page = await deps.sessions.listMessages(id, userId, {
        ...(beforeId !== undefined ? { beforeId } : {}),
        limit: 500,
      });
      messages.push(...page.items);
      if (!page.hasMore || page.nextBeforeId == null) break;
      beforeId = page.nextBeforeId;
    }
    // 页块间按 id 升序收口（id 单调递增，等价时间正序）
    messages.sort((a, b) => a.id - b.id);
    return ok({
      session,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        blocks: m.blocks,
        // 时间/模型管道（CU 批）：本地 MessageRecord.createdAt 已 ISO 字符串
        createdAt: m.createdAt,
        modelId: m.modelId ?? null,
        // 耗时管道（durationMs 批）：message 表列透传（v9 round 计时落库；
        // user 行/旧库缺省 null——控制端不展示）
        durationMs: m.durationMs ?? null,
      })),
    });
  });
}

async function handleDelete(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id == null) {
    return bizError("4040", "会话不存在");
  }
  return withUserId((userId) =>
    faceDeps()
      .sessions.deleteSession(id, userId)
      .then(() => ok(null)),
  );
}

// —— send 桥（T12）：预检（sessionId 不存在/他人会话 → 4040 业务错）→
// 202 受理即返回；轮次 setImmediate 异步走 chat.send(params, userId,
// undefined)（无渲染层 sender），chunk 流经 tap 桥到 SSE/relay，收尾经
// face 事件总线回传 session.updated / session.error（tianshu-server T7
// dispatchRound 同构语义）——
/** chat 层已知错误码 → session.error 事件的用户可读文案（tianshu-server
 * SessionService.SEND_ERROR_MESSAGES 同构副本） */
const SEND_ERROR_MESSAGES: Record<string, string> = {
  NO_MODEL: "未选择模型：请先在该会话选择模型再发送",
  MODEL_OR_PROVIDER_MISSING: "模型或服务商配置缺失",
  SESSION_NOT_FOUND: "会话不存在",
  ARCHIVED_SESSION: "会话已归档",
  CONCURRENT_REQUEST: "会话已有进行中的请求",
  MESSAGE_NOT_FOUND: "消息不存在或不是助手消息",
  NOTHING_TO_REGENERATE: "没有可重新生成的回复",
};

function describeSendError(sessionId: number, error: unknown): void {
  const code = error instanceof Error ? error.message : String(error);
  publishFaceEvent({
    type: "session.error",
    payload: {
      sessionId,
      code,
      message: SEND_ERROR_MESSAGES[code] ?? `会话执行失败: ${code}`,
    },
  });
}

/** P1 未读角标批：轮次收尾/读毕统一发布 enriched session.updated——
 *  getSessionSummary 一次取回（末条摘要 + 未读数 + updatedAt 库值，绝不
 *  伪造时间戳）；会话已删/无归属静默跳过（事件无消费者可作用对象） */
async function publishSessionUpdated(
  sessionId: number,
  userId: number,
): Promise<void> {
  const summary = await faceDeps().sessions.getSessionSummary(
    sessionId,
    userId,
  );
  if (!summary) {
    return;
  }
  publishFaceEvent({
    type: "session.updated",
    payload: {
      id: summary.id,
      title: summary.title,
      updatedAt: summary.updatedAt,
      unreadCount: summary.unreadCount,
      lastMessage: summary.lastMessage,
    },
  });
}

async function handleSend(body: unknown): Promise<RouteResult> {
  const params = (body ?? {}) as {
    sessionId?: unknown;
    content?: unknown;
    modelId?: number;
    assistantId?: number;
    /** FA 批：图片附件（数据根相对路径——files/uploadImage 返回值）。
     *  face 桥此前静默丢弃该字段（移动端发图「消失」的根因），现转为
     *  ChatSendParams.images 的 {absPath}（join appDataHome） */
    images?: unknown;
  };
  const sessionId = asInt(params.sessionId);
  const content = params.content;
  if (sessionId == null || typeof content !== "string" || content === "") {
    return bizError("5000", "sessionId/content 参数不合法");
  }
  // images 形态校验：string[]（相对路径）→ 绝对路径；attachs 前缀外拒收
  const sendImages =
    Array.isArray(params.images) &&
    params.images.every(
      (p) => typeof p === "string" && p.startsWith("attachments/"),
    )
      ? (params.images as string[]).map((p) => ({
          absPath: path.join(appDataHome(), p),
        }))
      : undefined;
  if (params.images != null && sendImages == null) {
    return bizError("5000", "images 须为 attachments/ 相对路径数组");
  }
  return withUserId(async (userId) => {
    // 预检：不存在与他人会话同报错（存在性不泄露口径与 repo 一致）
    const session = await faceDeps().sessions.getSession(sessionId);
    if (!session || session.userId !== userId) {
      return bizError("4040", "会话不存在");
    }
    // 归档只读：同步拒绝（渲染层同款语义；错误码走业务错非事件）
    if (session.archivedAt) {
      return bizError("5000", "会话已归档");
    }
    const sendParams: ChatSendParams = {
      sessionId,
      content,
      ...(params.modelId != null ? { modelId: params.modelId } : {}),
      // 专家选择（FA 批）：send DTO 同款透传，ChatService 持久会话当前值
      ...(params.assistantId != null
        ? { assistantId: params.assistantId }
        : {}),
      ...(sendImages != null ? { images: sendImages } : {}),
    };
    setImmediate(() => {
      faceDeps()
        .chat.send(sendParams, userId, undefined)
        // 正常收尾（含 stop 中止）：enriched session.updated（P1 批）
        .then(() => publishSessionUpdated(sessionId, userId))
        .catch((error: unknown) => describeSendError(sessionId, error));
    });
    return ok({ accepted: true }, 202);
  });
}

/** session/regenerate 桥：定位/截断/重跑全在 ChatService.regenerate；
 * 收尾事件与 send 同口径（updated / error） */
async function handleRegenerate(body: unknown): Promise<RouteResult> {
  const params = (body ?? {}) as {
    sessionId?: unknown;
    messageId?: unknown;
  };
  const sessionId = asInt(params.sessionId);
  if (sessionId == null) {
    return bizError("4040", "会话不存在");
  }
  const messageId = asInt(params.messageId) ?? undefined;
  return withUserId(async (userId) => {
    const session = await faceDeps().sessions.getSession(sessionId);
    if (!session || session.userId !== userId) {
      return bizError("4040", "会话不存在");
    }
    if (session.archivedAt) {
      return bizError("5000", "会话已归档");
    }
    setImmediate(() => {
      faceDeps()
        .chat.regenerate(sessionId, userId, messageId, undefined)
        .then(() => publishSessionUpdated(sessionId, userId))
        .catch((error: unknown) => describeSendError(sessionId, error));
    });
    return ok({ accepted: true }, 202);
  });
}

async function handleAbort(body: unknown): Promise<RouteResult> {
  const sessionId = asInt((body as { sessionId?: unknown } | null)?.sessionId);
  if (sessionId == null) {
    return bizError("4040", "会话不存在");
  }
  return withUserId(async (userId) => {
    const session = await faceDeps().sessions.getSession(sessionId);
    if (!session || session.userId !== userId) {
      return bizError("4040", "会话不存在");
    }
    // mirror ChatService.stop 无返回值：受理即视为已中止（无进行中流为空操作）
    faceDeps().chat.stop(sessionId);
    return ok({ aborted: true });
  });
}

// —— 审批应答 / 模型面 / 图片只读（移动端 Task 3）：approve 转发
// ChatService.respondApproval（T2），provider/query 聚合两仓储，image 经
// deps 桥读盘（防穿越/白名单/≤10MB 在 readImageWithinRoot 收口）——
async function handleApprove(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Partial<ApproveParams>;
  if (
    typeof p.sessionId !== "number" ||
    typeof p.toolCallId !== "string" ||
    typeof p.approved !== "boolean" ||
    (p.remember !== undefined && typeof p.remember !== "boolean") ||
    (p.toolName !== undefined && typeof p.toolName !== "string")
  ) {
    return bizError("5000", "sessionId/toolCallId/approved 参数不合法");
  }
  // 纯应答不校验归属（审批卡产生于已校验归属的会话流内，toolCallId
  // 一次性；与渲染层 agent:approve 同口径——chat.service.ts L408 注记）；
  // remember 是持久权限行写入——升格 withUserId，会话归属校验在
  // respondApprovalRemember 内 assert（同 permission:rememberTool 口径）
  return withUserId(async (userId) => {
    const r = await faceDeps().approvals.respondRemember(
      p.sessionId!,
      p.toolCallId!,
      p.approved!,
      userId,
      p.remember === true,
      p.toolName ?? null,
    );
    if (!r.hit) {
      return bizError("4040", "审批不存在或已应答");
    }
    return ok({ responded: true, remembered: r.remembered });
  });
}

async function handleProviderQuery(): Promise<RouteResult> {
  return withUserId(async (userId) =>
    ok(await faceDeps().providers.listBundle(userId)),
  );
}

/** provider/save：批量 upsert（providers→models 顺序应用无事务——spec §1.2
 * 差异声明；任一项失败即停返回该项错误；成功后回脱敏 bundle） */
async function handleProviderSave(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { providers?: unknown; models?: unknown };
  if (!Array.isArray(p.providers) && !Array.isArray(p.models)) {
    return bizError("5000", "providers/models 至少一项为数组");
  }
  return withUserId(async (userId) => {
    try {
      return ok(
        await faceDeps().providers.save(p as ProviderSavePayload, userId),
      );
    } catch (e) {
      return bizError(
        "5000",
        e instanceof Error ? `保存失败：${e.message}` : "保存失败",
      );
    }
  });
}

/** provider/delete：批量删除（providerIds 级联 / modelIds 单删——桥本地
 * repo，归属校验在 repo；返回删除后全量） */
async function handleProviderDelete(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { providerIds?: unknown; modelIds?: unknown };
  const providerIds = Array.isArray(p.providerIds)
    ? p.providerIds.filter((v): v is number => typeof v === "number")
    : [];
  const modelIds = Array.isArray(p.modelIds)
    ? p.modelIds.filter((v): v is number => typeof v === "number")
    : [];
  if (providerIds.length === 0 && modelIds.length === 0) {
    return bizError("5000", "providerIds/modelIds 至少一项非空");
  }
  return withUserId(async (userId) => {
    await faceDeps().providers.deleteProviders(providerIds, userId);
    await faceDeps().providers.deleteModels(modelIds, userId);
    return ok(await faceDeps().providers.listBundle(userId));
  });
}

/** provider/test：轻探上游模型清单（与 headless 同口径——结构化结果转
 * ok/message；不发起对话计费） */
async function handleProviderTest(body: unknown): Promise<RouteResult> {
  const providerId = (body as { providerId?: unknown } | null)?.providerId;
  if (typeof providerId !== "number") {
    return bizError("5000", "providerId 参数不合法");
  }
  return withUserId(async (userId) => {
    const result = await faceDeps().providers.listRemote(providerId, userId);
    return ok({ ok: result.success, message: result.message });
  });
}

/** provider/fetchModels：上游模型清单拉取（连通失败结构化非异常） */
async function handleProviderFetchModels(body: unknown): Promise<RouteResult> {
  const providerId = (body as { providerId?: unknown } | null)?.providerId;
  if (typeof providerId !== "number") {
    return bizError("5000", "providerId 参数不合法");
  }
  return withUserId((userId) =>
    faceDeps()
      .providers.listRemote(providerId, userId)
      .then((result) => ok(result)),
  );
}

/** session/update：重命名（桥本地 renameSession——归属/空标题校验同款） */
async function handleSessionUpdate(body: unknown): Promise<RouteResult> {
  const params = (body ?? {}) as {
    sessionId?: unknown;
    title?: unknown;
    mode?: unknown;
    archived?: unknown;
    pinned?: unknown;
    assistantId?: unknown;
    currentModelId?: unknown;
  };
  const sessionId = params.sessionId;
  const title = typeof params.title === "string" ? params.title.trim() : "";
  const mode =
    params.mode === "agent" || params.mode === "ask" || params.mode === "plan"
      ? params.mode
      : null;
  const archived =
    params.archived === true ? true : params.archived === false ? false : null;
  const pinned =
    params.pinned === true ? true : params.pinned === false ? false : null;
  const assistantId =
    typeof params.assistantId === "number"
      ? params.assistantId
      : params.assistantId === null
        ? null
        : undefined;
  const currentModelId =
    typeof params.currentModelId === "number"
      ? params.currentModelId
      : params.currentModelId === null
        ? null
        : undefined;
  if (
    typeof sessionId !== "number" ||
    (title === "" &&
      mode === null &&
      archived === null &&
      pinned === null &&
      assistantId === undefined &&
      currentModelId === undefined)
  ) {
    return bizError(
      "5000",
      "sessionId/title/mode/archived/pinned/assistantId/currentModelId 参数不合法",
    );
  }
  return withUserId(async (userId) => {
    if (title !== "") {
      await faceDeps().sessions.renameSession(sessionId, title, userId);
    }
    if (mode !== null) {
      await faceDeps().sessions.setMode(sessionId, mode, userId);
    }
    if (archived !== null) {
      await faceDeps().sessions.archiveSession(sessionId, archived, userId);
    }
    if (pinned !== null) {
      await faceDeps().sessions.pinSession(sessionId, pinned, userId);
    }
    if (assistantId !== undefined) {
      await faceDeps().sessions.setSessionAssistant(
        sessionId,
        assistantId,
        userId,
      );
    }
    if (currentModelId !== undefined) {
      await faceDeps().sessions.setSessionModel(
        sessionId,
        currentModelId,
        userId,
      );
    }
    return ok({ updated: true });
  });
}

/** session/editAndResend 桥：改写 user 消息+截断+重跑全在
 * ChatService.editAndResend；收尾事件与 send 同口径 */
async function handleEditAndResend(body: unknown): Promise<RouteResult> {
  const params = (body ?? {}) as {
    sessionId?: unknown;
    messageId?: unknown;
    content?: unknown;
  };
  const sessionId = asInt(params.sessionId);
  const messageId = asInt(params.messageId);
  const content = params.content;
  if (
    sessionId == null ||
    messageId == null ||
    typeof content !== "string" ||
    content === ""
  ) {
    return bizError("5000", "sessionId/messageId/content 参数不合法");
  }
  return withUserId(async (userId) => {
    const session = await faceDeps().sessions.getSession(sessionId);
    if (!session || session.userId !== userId) {
      return bizError("4040", "会话不存在");
    }
    if (session.archivedAt) {
      return bizError("5000", "会话已归档");
    }
    setImmediate(() => {
      faceDeps()
        .chat.editAndResend(sessionId, userId, messageId, content, undefined)
        .then(() => publishSessionUpdated(sessionId, userId))
        .catch((error: unknown) => describeSendError(sessionId, error));
    });
    return ok({ accepted: true }, 202);
  });
}

/** session/usage 桥（chat:usage 同口径五类估算；未配模型 null） */
async function handleSessionUsage(body: unknown): Promise<RouteResult> {
  const sessionId = asInt((body as { sessionId?: unknown } | null)?.sessionId);
  if (sessionId == null) {
    return bizError("4040", "会话不存在");
  }
  return withUserId(async (userId) => {
    const session = await faceDeps().sessions.getSession(sessionId);
    if (!session || session.userId !== userId) {
      return bizError("4040", "会话不存在");
    }
    return ok(await faceDeps().chat.getUsageBreakdown(sessionId, userId));
  });
}

/** session/compact 桥（A9 批）：异步语义对齐 send 先例——预检（归属/归档）
 *  后 202 受理即返回；setImmediate 后台执行 chat.compact，正常收尾（含
 *  中止）publish enriched session.updated，异常经 session.error 回传——
 *  移动端订阅事件后重拉 getById 刷新压缩态 */
async function handleCompact(body: unknown): Promise<RouteResult> {
  const sessionId = asInt((body as { sessionId?: unknown } | null)?.sessionId);
  if (sessionId == null) {
    return bizError("5000", "sessionId 参数不合法");
  }
  return withUserId(async (userId) => {
    const session = await faceDeps().sessions.getSession(sessionId);
    if (!session || session.userId !== userId) {
      return bizError("4040", "会话不存在");
    }
    if (session.archivedAt) {
      return bizError("5000", "会话已归档");
    }
    setImmediate(() => {
      faceDeps()
        .chat.compact(sessionId, userId)
        .then(() => publishSessionUpdated(sessionId, userId))
        .catch((error: unknown) => describeSendError(sessionId, error));
    });
    return ok({ accepted: true }, 202);
  });
}

/** session/polish 桥（A9 批）：同步 await 包装 chat.polish（30s 超时语义在
 *  service 内 AbortSignal.timeout(30_000)，超时/无模型走 5000 业务错）；
 * workspaceId 缺省解析用户默认工作空间；style 缺省/未知回退 professional
 * （与桌面 STYLE_PROMPTS 缺省口径一致） */
async function handlePolish(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as {
    workspaceId?: unknown;
    text?: unknown;
    style?: unknown;
  };
  if (typeof p.text !== "string" || p.text === "") {
    return bizError("5000", "text 参数不合法");
  }
  const style =
    p.style === "professional" ||
    p.style === "concise" ||
    p.style === "translate-en"
      ? p.style
      : "professional";
  return withUserId(async (userId) => {
    const workspaceId =
      asInt(p.workspaceId) ??
      (await faceDeps().resolveDefaultWorkspaceId(userId));
    if (workspaceId == null) {
      return bizError("4040", "工作空间不存在");
    }
    try {
      return ok(
        await faceDeps().chat.polish(
          { workspaceId, text: p.text as string, style },
          userId,
        ),
      );
    } catch (error: unknown) {
      return bizErrorFrom(error);
    }
  });
}

/** P1 未读角标批 session/read：已读游标单调推进（归属/message 属会话校验
 *  在 repo 层，同报 SESSION_NOT_FOUND → 4040 存在性不泄露；单调/并发安全
 *  updateMany 条件写在 repo 层）。成功后按新游标现算 unreadCount 并复用
 *  enriched session.updated 事件清远端角标（updatedAt 保持库值） */
async function handleSessionRead(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { sessionId?: unknown; messageId?: unknown };
  const sessionId = asInt(p.sessionId);
  const messageId = asInt(p.messageId);
  if (sessionId == null || messageId == null) {
    return bizError("5000", "sessionId/messageId 参数不合法");
  }
  return withUserId(async (userId) => {
    const result = await faceDeps().sessions.markSessionRead(
      sessionId,
      messageId,
      userId,
    );
    await publishSessionUpdated(sessionId, userId);
    return ok(result);
  });
}

/** skills/query|read 桥（AL 批：联想候选+读全文） */
async function handleSkillsQuery(): Promise<RouteResult> {
  return withUserId((userId) =>
    faceDeps()
      .skills.list(userId)
      .then((skills) => ok(skills)),
  );
}

/** skills/setEnabled 桥（PM 批：＋菜单技能启停多选） */
async function handleSkillsSetEnabled(body: unknown): Promise<RouteResult> {
  const params = (body ?? {}) as { name?: unknown; enabled?: unknown };
  if (
    typeof params.name !== "string" ||
    params.name === "" ||
    typeof params.enabled !== "boolean"
  ) {
    return bizError("5000", "name/enabled 参数不合法");
  }
  return withUserId((userId) =>
    faceDeps()
      .skills.setEnabled(
        userId,
        params.name as string,
        params.enabled as boolean,
      )
      .then(() => ok({ updated: true }))
      .catch((error: unknown) => bizErrorFrom(error)),
  );
}

async function handleSkillsRead(body: unknown): Promise<RouteResult> {
  const name = (body as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || name === "") {
    return bizError("5000", "name 参数不合法");
  }
  return withUserId((userId) =>
    faceDeps()
      .skills.read(userId, name)
      .then((result) => ok(result))
      .catch((error: unknown) => bizErrorFrom(error)),
  );
}

/** session/accessMode 桥（get/set 合一：mode 缺省查询） */
async function handleAccessMode(body: unknown): Promise<RouteResult> {
  const sessionId = asInt((body as { sessionId?: unknown } | null)?.sessionId);
  const rawMode = (body as { mode?: unknown } | null)?.mode;
  if (sessionId == null) {
    return bizError("4040", "会话不存在");
  }
  const mode = rawMode === "default" || rawMode === "full" ? rawMode : null;
  return withUserId(async (userId) => {
    const session = await faceDeps().sessions.getSession(sessionId);
    if (!session || session.userId !== userId) {
      return bizError("4040", "会话不存在");
    }
    if (mode !== null) {
      await faceDeps().chat.setAccessMode(sessionId, mode, userId);
    }
    return ok({ mode: await faceDeps().chat.getAccessMode(sessionId, userId) });
  });
}

/** assistant/query：专家概要列表（远控台会话选专家） */
async function handleAssistantQuery(): Promise<RouteResult> {
  return withUserId(async (userId) =>
    ok(await faceDeps().assistants.list(userId)),
  );
}

// —— A2 专家写面五端点（spec 2026-10-26 §1.2）：FaceExpertError 稳定码透传
// 信封，控制端判 ASSISTANT_* / EXPERT_MARKET_NOT_FOUND 勿落 5000 兜底——
/** 专家面通用桥：调用/错误信封同 libraryHandler 口径 */
async function expertHandler(
  call: (
    experts: ServerFaceDeps["assistants"],
    userId: number,
  ) => Promise<unknown>,
): Promise<RouteResult> {
  return withUserId(async (userId) => {
    try {
      return ok(await call(faceDeps().assistants, userId));
    } catch (error) {
      if (error instanceof FaceExpertError) {
        return bizError(error.code, error.message);
      }
      return bizErrorFrom(error);
    }
  });
}

/** assistant/detail：{id} → 归属校验完整记录（systemPrompt/专家团全量） */
function handleAssistantDetail(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) {
    return Promise.resolve(bizError("4040", "专家不存在"));
  }
  return expertHandler((experts, userId) => experts.detail(userId, id));
}

/** assistant/save 载荷：对象 + id/name/systemPrompt 形态校验（字段三态在
 *  tap——undefined 保留/null 清空；不传 members/expertType 保留原值） */
function parseAssistantSavePayload(body: unknown): AssistantSavePayload | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const p = body as Record<string, unknown>;
  if (p.id !== undefined && !Number.isInteger(p.id)) return null;
  if (p.name !== undefined && typeof p.name !== "string") return null;
  if (p.systemPrompt !== undefined && typeof p.systemPrompt !== "string") {
    return null;
  }
  return body as AssistantSavePayload;
}

function handleAssistantSave(body: unknown): Promise<RouteResult> {
  const payload = parseAssistantSavePayload(body);
  if (!payload) {
    return Promise.resolve(bizError("5000", "save 载荷不合法"));
  }
  return expertHandler((experts, userId) => experts.save(userId, payload));
}

function handleAssistantDelete(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) {
    return Promise.resolve(bizError("4040", "专家不存在"));
  }
  return expertHandler((experts, userId) =>
    experts.remove(userId, id).then(() => null),
  );
}

/** assistant/marketList：市场概要（无 systemPrompt，静态数据无需用户态） */
function handleAssistantMarketList(): Promise<RouteResult> {
  return expertHandler((experts) => experts.marketList());
}

function handleAssistantMarketDetail(body: unknown): Promise<RouteResult> {
  const slug = (body as { slug?: unknown } | null)?.slug;
  if (typeof slug !== "string" || slug === "") {
    return Promise.resolve(bizError("5000", "slug 参数不合法"));
  }
  return expertHandler((experts) => experts.marketDetail(slug));
}

/** assistant/export：{id} → 归属校验导出 JSON 文本（builtin 同样可导） */
function handleAssistantExport(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) {
    return Promise.resolve(bizError("4040", "专家不存在"));
  }
  return expertHandler((experts, userId) => experts.export(userId, id));
}

/** assistant/import：{json} → parse 校验新建（ASSISTANT_INVALID 带原因） */
function handleAssistantImport(body: unknown): Promise<RouteResult> {
  const json = (body as { json?: unknown } | null)?.json;
  if (typeof json !== "string" || json === "") {
    return Promise.resolve(bizError("5000", "json 参数不合法"));
  }
  return expertHandler((experts, userId) =>
    experts.import(userId, { json } as ExpertImportPayload),
  );
}

// —— A3 技能管理扩 + skillhub 市场四端点（spec 2026-10-26 §1.3）——
/** 技能面通用桥：FaceSkillError 稳定码透传信封 */
async function skillsHandler(
  call: (
    skills: NonNullable<ServerFaceDeps["skills"]>,
    userId: number,
  ) => Promise<unknown>,
): Promise<RouteResult> {
  return withUserId(async (userId) => {
    try {
      return ok(await call(faceDeps().skills, userId));
    } catch (error) {
      if (error instanceof FaceSkillError) {
        return bizError(error.code, error.message);
      }
      return bizErrorFrom(error);
    }
  });
}

/** skills/setScenarios 载荷：name 非空串 + scenarios 字符串数组 */
function parseSetScenariosPayload(
  body: unknown,
): { name: string; scenarios: string[] } | null {
  const p = (body ?? {}) as { name?: unknown; scenarios?: unknown };
  if (typeof p.name !== "string" || p.name === "") return null;
  if (!Array.isArray(p.scenarios)) return null;
  const scenarios = p.scenarios.filter(
    (s): s is string => typeof s === "string",
  );
  return { name: p.name, scenarios };
}

function handleSkillsSetScenarios(body: unknown): Promise<RouteResult> {
  const parsed = parseSetScenariosPayload(body);
  if (!parsed) {
    return Promise.resolve(bizError("5000", "name/scenarios 参数不合法"));
  }
  return skillsHandler((skills, userId) =>
    skills
      .setScenarios(userId, parsed.name, parsed.scenarios as SkillScenario[])
      .then(() => null),
  );
}

function handleSkillsUninstall(body: unknown): Promise<RouteResult> {
  const name = (body as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || name === "") {
    return Promise.resolve(bizError("5000", "name 参数不合法"));
  }
  return skillsHandler((skills, userId) =>
    skills.uninstall(userId, name).then(() => null),
  );
}

/** skills/installUpload 载荷：name 非空串 + base64 非空串（≤3MB 校验在
 *  tap——解码后字节数判定，同 files/uploadImage 口径） */
function parseInstallUploadPayload(
  body: unknown,
): { name: string; base64: string } | null {
  const p = (body ?? {}) as { name?: unknown; base64?: unknown };
  if (typeof p.name !== "string" || p.name === "") return null;
  if (typeof p.base64 !== "string" || p.base64 === "") return null;
  return { name: p.name, base64: p.base64 };
}

function handleSkillsInstallUpload(body: unknown): Promise<RouteResult> {
  const parsed = parseInstallUploadPayload(body);
  if (!parsed) {
    return Promise.resolve(bizError("5000", "name/base64 参数不合法"));
  }
  return skillsHandler((skills, userId) =>
    skills.installUpload(userId, parsed),
  );
}

/** skills/stats：skillStat 事件表聚合（无入参面） */
function handleSkillsStats(): Promise<RouteResult> {
  return skillsHandler((skills, userId) => skills.stats(userId));
}

/** skillhub 面通用桥：未装配/调用/错误信封（SKILLHUB_UNAVAILABLE 透传） */
async function skillhubHandler(
  call: (hub: NonNullable<ServerFaceDeps["skillhub"]>) => Promise<unknown>,
): Promise<RouteResult> {
  const hub = faceDeps().skillhub;
  if (!hub) {
    return bizError("5000", "skillhub 面未装配");
  }
  return withUserId(async () => {
    try {
      return ok(await call(hub));
    } catch (error) {
      if (error instanceof FaceSkillHubError) {
        return bizError(error.code, error.message);
      }
      return bizErrorFrom(error);
    }
  });
}

/** skillhub/list 载荷：可选 keyword/category/sortBy 字符串 + page/pageSize
 *  正整数 + order asc|desc（缺省/畸形项省略，宿主侧默认值兜底） */
function parseSkillHubListPayload(body: unknown): SkillHubListPayload {
  const p = (body ?? {}) as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof p[key] === "string" ? (p[key] as string) : undefined;
  const int = (key: string): number | undefined => {
    const value = p[key];
    return typeof value === "number" && Number.isInteger(value)
      ? value
      : undefined;
  };
  return {
    ...(str("keyword") ? { keyword: str("keyword") } : {}),
    ...(str("category") ? { category: str("category") } : {}),
    ...(int("page") ? { page: int("page") } : {}),
    ...(int("pageSize") ? { pageSize: int("pageSize") } : {}),
    ...(str("sortBy") ? { sortBy: str("sortBy") } : {}),
    ...(p.order === "asc" || p.order === "desc"
      ? { order: p.order as "asc" | "desc" }
      : {}),
  };
}

function handleSkillHubList(body: unknown): Promise<RouteResult> {
  return skillhubHandler((hub) => hub.list(parseSkillHubListPayload(body)));
}

function handleSkillHubTop(): Promise<RouteResult> {
  return skillhubHandler((hub) => hub.top());
}

function handleSkillHubCategories(): Promise<RouteResult> {
  return skillhubHandler((hub) => hub.categories());
}

function handleSkillHubInstall(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { slug?: unknown; overwrite?: unknown };
  if (typeof p.slug !== "string" || p.slug === "") {
    return Promise.resolve(bizError("5000", "slug 参数不合法"));
  }
  const overwrite = p.overwrite === true;
  return skillhubHandler((hub) => hub.install(p.slug as string, overwrite));
}

/** skillhub/detail（detail 批）：slug 校验同 install 口径 */
function handleSkillHubDetail(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { slug?: unknown };
  if (typeof p.slug !== "string" || p.slug === "") {
    return Promise.resolve(bizError("5000", "slug 参数不合法"));
  }
  return skillhubHandler((hub) => hub.detail(p.slug as string));
}

// —— A4 MCP 五端点（spec 2026-10-26 §1.4）：FaceMcpError 稳定码透传信封
//  （query/setEnabled 阶段 0 语义不动，见上方 handleMcpQuery/SetEnabled）——
/** MCP 面通用桥：未装配/调用/错误信封 */
async function mcpHandler(
  call: (
    mcps: NonNullable<ServerFaceDeps["mcps"]>,
    userId: number,
  ) => Promise<unknown>,
): Promise<RouteResult> {
  const mcps = faceDeps().mcps;
  if (!mcps) return bizError("5000", "连接器面未装配");
  return withUserId(async (userId) => {
    try {
      return ok(await call(mcps, userId));
    } catch (error) {
      if (error instanceof FaceMcpError) {
        return bizError(error.code, error.message);
      }
      return bizErrorFrom(error);
    }
  });
}

function handleMcpStatuses(): Promise<RouteResult> {
  return mcpHandler((mcps, userId) => mcps.statuses(userId));
}

/** mcp/save 载荷：name/url 必填字符串；id 可选正整数；headers 键值全字符
 *  串对象|null；enabled 可选布尔（字段三态/stdio 拒/url 校验在 tap——
 *  MCP_* 稳定码） */
function parseMcpSavePayload(body: unknown): McpSavePayload | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const p = body as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name === "") return null;
  if (typeof p.url !== "string" || p.url === "") return null;
  if (p.id !== undefined && !Number.isInteger(p.id)) return null;
  if (
    p.headers !== undefined &&
    p.headers !== null &&
    (typeof p.headers !== "object" ||
      Array.isArray(p.headers) ||
      Object.values(p.headers).some((v) => typeof v !== "string"))
  ) {
    return null;
  }
  if (p.enabled !== undefined && typeof p.enabled !== "boolean") return null;
  return body as McpSavePayload;
}

function handleMcpSave(body: unknown): Promise<RouteResult> {
  const payload = parseMcpSavePayload(body);
  if (!payload) {
    return Promise.resolve(bizError("5000", "save 载荷不合法"));
  }
  return mcpHandler((mcps, userId) => mcps.save(payload, userId));
}

function handleMcpDelete(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) {
    return Promise.resolve(bizError("4040", "连接器不存在"));
  }
  return mcpHandler((mcps, userId) => mcps.remove(id, userId).then(() => null));
}

function handleMcpReconnect(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) {
    return Promise.resolve(bizError("4040", "连接器不存在"));
  }
  return mcpHandler((mcps, userId) =>
    mcps.reconnect(id, userId).then(() => null),
  );
}

function handleMcpDetail(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) {
    return Promise.resolve(bizError("4040", "连接器不存在"));
  }
  return mcpHandler((mcps, userId) => mcps.detail(id, userId));
}

/** workspace/query：工作空间概要列表（HD-A1 单 UI 远程态侧栏分组树） */
async function handleWorkspaceQuery(): Promise<RouteResult> {
  const workspaces = faceDeps().workspaces;
  if (!workspaces) {
    return bizError("5000", "workspace 面未装配");
  }
  return withUserId(async (userId) => ok(await workspaces.list(userId)));
}

// —— A8 工作空间写面三端点（spec 2026-10-26 §1.2）：FaceWorkspaceError 稳定
// 码透传信封（WORKSPACE_NOT_FOUND/WORKSPACE_INVALID）；name 语义守卫在 tap；
// delete 返回 null（硬级联语义 repo 内聚，不删磁盘）——
/** workspace 写面调用信封：FaceWorkspaceError 稳定码透传，未知错误 5000 兜底 */
async function workspaceCall(
  run: (userId: number) => Promise<unknown>,
): Promise<RouteResult> {
  return withUserId(async (userId) => {
    try {
      return ok(await run(userId));
    } catch (error) {
      if (error instanceof FaceWorkspaceError) {
        return bizError(error.code, error.message);
      }
      return bizErrorFrom(error);
    }
  });
}

/** workspace/create|update 载荷形态校验：对象 + id/name/icon/defaultModelId
 *  字段形态（name 空串语义校验在 tap → WORKSPACE_INVALID，与桌面本地同口径） */
function parseWorkspaceSavePayload(body: unknown): WorkspaceSavePayload | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const p = body as Record<string, unknown>;
  if (p.id !== undefined && !Number.isInteger(p.id)) return null;
  if (p.name !== undefined && typeof p.name !== "string") return null;
  if (p.icon !== undefined && typeof p.icon !== "string") return null;
  if (p.defaultModelId !== undefined && !Number.isInteger(p.defaultModelId)) {
    return null;
  }
  return body as WorkspaceSavePayload;
}

function handleWorkspaceCreate(body: unknown): Promise<RouteResult> {
  const payload = parseWorkspaceSavePayload(body);
  if (!payload || typeof payload.name !== "string") {
    return Promise.resolve(bizError("5000", "create 载荷不合法"));
  }
  const create = faceDeps().workspaces?.create;
  if (!create) {
    return Promise.resolve(bizError("5000", "workspace 写面未装配"));
  }
  return workspaceCall((userId) => create(userId, payload));
}

function handleWorkspaceUpdate(body: unknown): Promise<RouteResult> {
  const payload = parseWorkspaceSavePayload(body);
  const id = payload ? asInt(payload.id) : null;
  if (!payload || id === null) {
    return Promise.resolve(bizError("5000", "update 载荷不合法"));
  }
  const update = faceDeps().workspaces?.update;
  if (!update) {
    return Promise.resolve(bizError("5000", "workspace 写面未装配"));
  }
  return workspaceCall((userId) => update(userId, { ...payload, id }));
}

function handleWorkspaceDelete(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) {
    return Promise.resolve(bizError("4040", "工作空间不存在"));
  }
  const remove = faceDeps().workspaces?.remove;
  if (!remove) {
    return Promise.resolve(bizError("5000", "workspace 写面未装配"));
  }
  return workspaceCall((userId) => remove(userId, id).then(() => null));
}

// —— A10 审批记忆五端点（spec 2026-10-26 §1.2）：FacePermissionError 稳定码
//  透传信封（仅 PERMISSION_INVALID——单条撤销幂等 no-op 不报错，桌面既定
//  语义）；形状校验在路由（id 非正整数 → PERMISSION_INVALID，与 tap 守卫
//  同码同语义）——
/** permission 面调用信封：FacePermissionError 稳定码透传，未知错误 5000 兜底 */
async function permissionCall(
  run: (userId: number) => Promise<unknown>,
): Promise<RouteResult> {
  return withUserId(async (userId) => {
    try {
      return ok(await run(userId));
    } catch (error) {
      if (error instanceof FacePermissionError) {
        return bizError(error.code, error.message);
      }
      return bizErrorFrom(error);
    }
  });
}

/** 正整数 id 形态校验（缺省/畸形/非正 → PERMISSION_INVALID 语义拦截） */
function parsePermissionId(body: unknown): number | null {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

function handlePermissionListRemembered(): Promise<RouteResult> {
  const permissions = faceDeps().permissions;
  if (!permissions)
    return Promise.resolve(bizError("5000", "permission 面未装配"));
  return permissionCall((userId) => permissions.listRemembered(userId));
}

function handlePermissionRevokeRemembered(body: unknown): Promise<RouteResult> {
  const permissions = faceDeps().permissions;
  if (!permissions)
    return Promise.resolve(bizError("5000", "permission 面未装配"));
  const id = parsePermissionId(body);
  if (id === null) {
    return Promise.resolve(bizError("PERMISSION_INVALID", "id 必须是正整数"));
  }
  return permissionCall((userId) => permissions.revokeRemembered(userId, id));
}

function handlePermissionRevokeAllRemembered(): Promise<RouteResult> {
  const permissions = faceDeps().permissions;
  if (!permissions)
    return Promise.resolve(bizError("5000", "permission 面未装配"));
  return permissionCall((userId) => permissions.revokeAllRemembered(userId));
}

function handlePermissionListFullGrants(): Promise<RouteResult> {
  const permissions = faceDeps().permissions;
  if (!permissions)
    return Promise.resolve(bizError("5000", "permission 面未装配"));
  return permissionCall((userId) => permissions.listFullGrants(userId));
}

function handlePermissionRevokeAllFull(): Promise<RouteResult> {
  const permissions = faceDeps().permissions;
  if (!permissions)
    return Promise.resolve(bizError("5000", "permission 面未装配"));
  return permissionCall((userId) => permissions.revokeAllFull(userId));
}

/** files 三端点桥（FA-T2，spec §3.1）：FaceFilesError 稳定码透传信封——
 *  控制端判 FILES_* 勿落 5000 兜底 */
async function filesHandler(
  call: (
    files: NonNullable<ServerFaceDeps["files"]>,
    userId: number,
  ) => Promise<unknown>,
): Promise<RouteResult> {
  const files = faceDeps().files;
  if (!files) {
    return bizError("5000", "files 面未装配");
  }
  return withUserId(async (userId) => {
    try {
      return ok(await call(files, userId));
    } catch (error) {
      if (error instanceof FaceFilesError) {
        return bizError(error.code, error.message);
      }
      return bizErrorFrom(error);
    }
  });
}

function handleFilesList(body: unknown): Promise<RouteResult> {
  const workspaceId = asInt(
    (body as { workspaceId?: unknown } | null)?.workspaceId,
  );
  if (workspaceId == null) {
    return Promise.resolve(bizError("5000", "workspaceId 参数不合法"));
  }
  return filesHandler((files, userId) => files.list(userId, workspaceId));
}

async function artifactHandler(
  call: (
    artifact: NonNullable<ServerFaceDeps["artifact"]>,
    userId: number,
  ) => Promise<unknown>,
): Promise<RouteResult> {
  const artifact = faceDeps().artifact;
  if (!artifact) {
    return bizError("5000", "本地产物面未装配");
  }
  return withUserId(async (userId) => {
    try {
      return { status: 200, body: await call(artifact, userId) };
    } catch (e) {
      if (e instanceof FaceArtifactError) {
        return bizError(e.code, e.message);
      }
      return bizError("5000", e instanceof Error ? e.message : String(e));
    }
  });
}

function handleArtifactList(): Promise<RouteResult> {
  return artifactHandler((artifact, userId) => artifact.list(userId));
}

function handleArtifactToggleFavorite(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { workspaceId?: unknown; relPath?: unknown };
  const workspaceId = asInt(p.workspaceId);
  const relPath =
    typeof p.relPath === "string" && p.relPath !== "" ? p.relPath : null;
  if (workspaceId == null || relPath === null) {
    return Promise.resolve(bizError("5000", "workspaceId/relPath 参数不合法"));
  }
  return artifactHandler((artifact, userId) =>
    artifact.toggleFavorite(userId, workspaceId, relPath),
  );
}

function handleArtifactRead(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { workspaceId?: unknown; relPath?: unknown };
  const workspaceId = asInt(p.workspaceId);
  const relPath =
    typeof p.relPath === "string" && p.relPath !== "" ? p.relPath : null;
  if (workspaceId == null || relPath === null) {
    return Promise.resolve(bizError("5000", "workspaceId/relPath 参数不合法"));
  }
  return artifactHandler((artifact, userId) =>
    artifact.read(userId, workspaceId, relPath),
  );
}

function handleFilesRead(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { workspaceId?: unknown; path?: unknown };
  const workspaceId = asInt(p.workspaceId);
  if (workspaceId == null || typeof p.path !== "string" || p.path === "") {
    return Promise.resolve(bizError("5000", "workspaceId/path 参数不合法"));
  }
  return filesHandler((files, userId) =>
    files.read(userId, workspaceId, p.path as string),
  );
}

function handleFilesUploadImage(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { name?: unknown; base64?: unknown };
  if (
    typeof p.name !== "string" ||
    p.name === "" ||
    typeof p.base64 !== "string" ||
    p.base64 === ""
  ) {
    return Promise.resolve(bizError("5000", "name/base64 参数不合法"));
  }
  return filesHandler((files) =>
    files.uploadImage({ name: p.name as string, base64: p.base64 as string }),
  );
}

// —— library 十八端点桥（A5 资料库批 + 资料库编辑批 writeContent + 上传批
// uploadFile）：单端点直映射
// 仓储方法（不做 save 式聚合——各项失败即该项报错，与桌面本地行为一致）；
// FaceLibraryError 稳定码透传信封，控制端判 LIBRARY_* 勿落 5000 兜底——
/** library 面通用桥：未装配/调用/错误信封同 filesHandler 口径 */
async function libraryHandler(
  call: (
    library: NonNullable<ServerFaceDeps["library"]>,
    userId: number,
  ) => Promise<unknown>,
): Promise<RouteResult> {
  const library = faceDeps().library;
  if (!library) {
    return bizError("5000", "library 面未装配");
  }
  return withUserId(async (userId) => {
    try {
      return ok(await call(library, userId));
    } catch (error) {
      if (error instanceof FaceLibraryError) {
        return bizError(error.code, error.message);
      }
      return bizErrorFrom(error);
    }
  });
}

/** name 类载荷：非空字符串 trim 截 255（空/非字符串 → null 参数错） */
function asName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 255);
  return trimmed === "" ? null : trimmed;
}

/** ids 载荷：纯数字数组且非空（过滤数字项；空 → null 参数错） */
function asIdArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter(
    (v): v is number => typeof v === "number" && Number.isInteger(v),
  );
  return ids.length === 0 ? null : ids;
}

/** addLink url 载荷：http/https 开头（桌面 repo 同口径前置守卫） */
function asHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/** parentId/targetParentId 载荷：null/缺省 → 根层；数字直通；其余 → undefined
 *  （与根层 null 区分，调用方判参数错） */
function asParentId(value: unknown): number | null | undefined {
  if (value == null) return null;
  return asInt(value) ?? undefined;
}

/** 新建类载荷（createFolder/createFile 共用形状）：name + parentId */
function parseCreatePayload(
  body: unknown,
): { name: string; parentId: number | null } | null {
  const p = (body ?? {}) as { name?: unknown; parentId?: unknown };
  const name = asName(p.name);
  const parentId = asParentId(p.parentId);
  if (name === null || parentId === undefined) return null;
  return { name, parentId };
}

function handleLibraryList(body: unknown): Promise<RouteResult> {
  const parentId = asParentId(
    (body as { parentId?: unknown } | null)?.parentId,
  );
  if (parentId === undefined) {
    return Promise.resolve(bizError("5000", "parentId 参数不合法"));
  }
  return libraryHandler((library, userId) => library.list(userId, parentId));
}

function handleLibraryTree(): Promise<RouteResult> {
  return libraryHandler((library, userId) => library.tree(userId));
}

function handleLibrarySearch(body: unknown): Promise<RouteResult> {
  const keyword = (body as { keyword?: unknown } | null)?.keyword;
  if (typeof keyword !== "string") {
    return Promise.resolve(bizError("5000", "keyword 参数不合法"));
  }
  return libraryHandler((library, userId) =>
    library.search(userId, keyword.trim().slice(0, 100)),
  );
}

function handleLibraryListRecent(): Promise<RouteResult> {
  return libraryHandler((library, userId) => library.listRecent(userId));
}

function handleLibraryListFavorites(): Promise<RouteResult> {
  return libraryHandler((library, userId) => library.listFavorites(userId));
}

function handleLibraryCreateFolder(body: unknown): Promise<RouteResult> {
  const parsed = parseCreatePayload(body);
  if (!parsed) {
    return Promise.resolve(bizError("5000", "name/parentId 参数不合法"));
  }
  return libraryHandler((library, userId) =>
    library.createFolder(userId, parsed.name, parsed.parentId),
  );
}

function handleLibraryCreateFile(body: unknown): Promise<RouteResult> {
  const parsed = parseCreatePayload(body);
  if (!parsed) {
    return Promise.resolve(bizError("5000", "name/parentId 参数不合法"));
  }
  return libraryHandler((library, userId) =>
    library.createFile(userId, parsed.name, parsed.parentId),
  );
}

function handleLibraryAddLink(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as {
    url?: unknown;
    title?: unknown;
    parentId?: unknown;
  };
  const url = asHttpUrl(p.url);
  const parentId = asParentId(p.parentId);
  if (url === null || parentId === undefined) {
    return Promise.resolve(bizError("5000", "url/parentId 参数不合法"));
  }
  const title = asName(p.title);
  return libraryHandler((library, userId) =>
    library.addLink(userId, url, title, parentId),
  );
}

function handleLibraryRename(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { id?: unknown; name?: unknown };
  const id = asInt(p.id);
  const name = asName(p.name);
  if (id === null || name === null) {
    return Promise.resolve(bizError("5000", "id/name 参数不合法"));
  }
  return libraryHandler((library, userId) => library.rename(userId, id, name));
}

function handleLibraryMove(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { ids?: unknown; targetParentId?: unknown };
  const ids = asIdArray(p.ids);
  const targetParentId = asParentId(p.targetParentId);
  if (ids === null || targetParentId === undefined) {
    return Promise.resolve(bizError("5000", "ids/targetParentId 参数不合法"));
  }
  return libraryHandler((library, userId) =>
    library.move(userId, ids, targetParentId),
  );
}

function handleLibraryDelete(body: unknown): Promise<RouteResult> {
  const ids = asIdArray((body as { ids?: unknown } | null)?.ids);
  if (ids === null) {
    return Promise.resolve(bizError("5000", "ids 参数不合法"));
  }
  return libraryHandler((library, userId) => library.delete(userId, ids));
}

/** 单 id 载荷端点共用：subtreeCount/toggleFavorite/markViewed/read/readImage */
function handleLibraryId(
  body: unknown,
  call: (
    library: NonNullable<ServerFaceDeps["library"]>,
    userId: number,
    id: number,
  ) => Promise<unknown>,
): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) {
    return Promise.resolve(bizError("5000", "id 参数不合法"));
  }
  return libraryHandler((library, userId) => call(library, userId, id));
}

/** 文本内容覆写载荷：id + content（content 全量覆盖写，非 diff——
 *  大小守卫在 tap，与 read 512KiB 同口径） */
function handleLibraryWriteContent(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { id?: unknown; content?: unknown };
  const id = asInt(p.id);
  if (id === null || typeof p.content !== "string") {
    return Promise.resolve(bizError("5000", "id/content 参数不合法"));
  }
  return libraryHandler((library, userId) =>
    library.writeContent(userId, id, p.content as string),
  );
}

/** 二进制上传载荷：name + base64 + parentId（可空——parentId 缺省/null 均
 *  根层；base64 形状只校验字符串，字符集/3MB 守卫在 tap 同码返回） */
function handleLibraryUploadFile(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as {
    parentId?: unknown;
    name?: unknown;
    base64?: unknown;
  };
  const name = asName(p.name);
  const parentId = asParentId(p.parentId);
  if (name === null || parentId === undefined || typeof p.base64 !== "string") {
    return Promise.resolve(bizError("5000", "name/base64/parentId 参数不合法"));
  }
  return libraryHandler((library, userId) =>
    library.uploadFile(userId, {
      // 协议载荷 parentId?: number 不含 null——asParentId 的 null（根层）
      // 归一 undefined，tap 侧 ?? null 收口
      parentId: parentId ?? undefined,
      name,
      base64: p.base64 as string,
    }),
  );
}

async function handleImage(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as { path?: unknown };
  if (typeof p.path !== "string" || p.path === "") {
    return bizError("5000", "path 参数不合法");
  }
  const payload: ImagePayload | null = await faceDeps().images.readImage(
    p.path,
  );
  if (!payload) {
    return bizError("4040", "图片不存在或不可读");
  }
  return ok(payload);
}

// —— ui-drive 三端点（spec 2026-10-17 §2.1，UD-T1）：控制端驱动被控桌面
// 端 UI——openSession 主窗聚焦+渲染层打开会话、notify toast、openRoute
// 白名单路由跳转。主窗 = BrowserWindow.getAllWindows() 首个（主窗先建
// 不变式，graph-executor notifyNodeStatus 同源取窗口径）；事件经主窗
// webContents.send（isDestroyed 守卫，terminal-ipc 先例）。主窗缺失/已
// 销毁为降级态非错误：返回值如实（opened/notified:false），不抛。——
/** 主窗（getAllWindows 首个）；缺失/已销毁返回 null（调用方降级不抛） */
function findMainWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win : null;
}

/** 主窗聚焦三连（file-window focusMain 同款：最小化先 restore） */
function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function handleUiOpenSession(body: unknown): Promise<RouteResult> {
  const sessionId = asInt((body as { sessionId?: unknown } | null)?.sessionId);
  if (sessionId == null) {
    return bizError("4040", "会话不存在");
  }
  return withUserId(async (userId) => {
    // 归属校验：他人会话/不存在同报 4040（存在性不泄露，abort/send 同
    // 口径）；getSessionById 抛 SESSION_NOT_FOUND 经兜底映射同码
    await faceDeps().sessions.getSessionById(sessionId, userId);
    const win = findMainWindow();
    if (!win) return ok({ opened: false });
    focusWindow(win);
    win.webContents.send("ui:openSession", { sessionId });
    return ok({ opened: true });
  });
}

async function handleUiNotify(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Partial<UiNotifyParams>;
  if (typeof p.title !== "string" || p.title === "") {
    return bizError("5000", "title 参数不合法");
  }
  // 不触用户数据（无 withUserId）；不抢焦点（spec §2.1 仅 openSession 聚焦）
  const win = findMainWindow();
  if (!win) return ok({ notified: false });
  win.webContents.send("ui:notify", {
    title: p.title,
    ...(p.message != null ? { message: p.message } : {}),
  });
  return ok({ notified: true });
}

/** openRoute 白名单（spec §4）：仅 `/module/` 前缀且无穿越段——主进程
 * 第一道校验（非白名单 4005 参数错），渲染层 isSafeModuleRoute（UD-T2）
 * 二次校验双保险，同款语义 UD-T3 上提：裸 startsWith 不够——点段会被
 * 路由器归一（"/module/../login" 归一后 "/login"，前缀穿越）、"//" 空段
 * 归一/协议相对语义歧义，均先拒；".." 段按字面比较（"..foo" 不算）；
 * 查询串（"?" 后）不参与段校验 */
function isAllowedRoute(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/module/")) return false;
  const routePart = path.split("?")[0];
  if (routePart.includes("//")) return false;
  return routePart
    .split("/")
    .every((segment) => segment !== "." && segment !== "..");
}

async function handleUiOpenRoute(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Partial<UiOpenRouteParams>;
  if (!isAllowedRoute(p.path)) {
    return bizError("4005", "path 必须为 /module/ 前缀的应用内路由");
  }
  const win = findMainWindow();
  if (!win) return ok({ opened: false });
  win.webContents.send("ui:openRoute", { path: p.path });
  return ok({ opened: true });
}

// —— A7 项目域 23 端点桥（spec 2026-10-26 §2.2）：project 六段 / planItem
// 十段 / planView 一段 / projectAsset 六段——单端点直映射 tap 方法（Repository
// 级聚合不拆）；FaceProjectError 稳定码透传信封，控制端判 PROJECT_* 码勿落
// 5000 兜底；身份唯一来源 withUserId（载荷剔除 ownerId/createdById）——
/** A7 项目域通用桥：未装配/调用/错误信封同 libraryHandler 口径 */
async function faceHandler<F>(
  pickFace: (deps: ServerFaceDeps) => F | undefined,
  faceName: string,
  call: (face: F, userId: number) => Promise<unknown>,
): Promise<RouteResult> {
  const face = pickFace(faceDeps());
  if (!face) return bizError("5000", `${faceName} 面未装配`);
  return withUserId(async (userId) => {
    try {
      return ok(await call(face, userId));
    } catch (error) {
      if (error instanceof FaceProjectError) {
        return bizError(error.code, error.message);
      }
      return bizErrorFrom(error);
    }
  });
}

/** title 载荷：trim 截 200（空/非字符串 → null 参数错） */
function asTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 200);
  return trimmed === "" ? null : trimmed;
}

/** 字段非法信号（parse 内抛出，handler 口捕获归一为 5000 参数错） */
class InvalidPayloadError extends Error {}

/** 可选字符串载荷：undefined 缺省；字符串直通；其余抛 InvalidPayloadError */
function optString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InvalidPayloadError();
  return value;
}

/** 可空字符串载荷（description/startDate/dueDate 清空语义）：undefined 缺省 /
 *  null 清空 / 字符串直通；畸形抛 InvalidPayloadError */
function optNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new InvalidPayloadError();
  return value;
}

/** 可空 id 载荷（assigneeId 清空语义）：undefined 缺省 / null 清空 /
 *  整数直通；畸形抛 InvalidPayloadError */
function optNullableInt(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const id = asInt(value);
  if (id === null) throw new InvalidPayloadError();
  return id;
}

/** asset 相对路径段：undefined/null/空串 归一根（""）；非字符串或 "/" 开头
 *  （绝对路径/段语义拒） → null 参数错；越界终防在 repo safeJoin */
function asAssetPath(value: unknown): string | null {
  if (value == null || value === "") return "";
  if (typeof value !== "string") return null;
  return value.startsWith("/") ? null : value;
}

/** asset 文件路径（readImage/附件 assetPath）：非空、trim、不以 "/" 开头 */
function asAssetFilePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.startsWith("/") ? null : trimmed;
}

/** 字段写入：undefined 缺省不落键；null（清空语义）与值直写 */
function setField(
  fields: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) fields[key] = value;
}

/** planItem 写面公共字段收集（create/update 共用）：任一字段畸形抛
 *  InvalidPayloadError——枚举值透传（repo 自校验），日期 ISO 串透传 */
function collectPlanItemFields(
  p: Record<string, unknown>,
): Omit<PlanItemUpdatePayload, "id"> {
  const fields = {} as Omit<PlanItemUpdatePayload, "id">;
  const record = fields as Record<string, unknown>;
  setField(record, "description", optNullableString(p.description));
  setField(record, "status", optString(p.status));
  setField(record, "priority", optString(p.priority));
  setField(record, "source", optString(p.source));
  setField(record, "startDate", optNullableString(p.startDate));
  setField(record, "dueDate", optNullableString(p.dueDate));
  setField(record, "assigneeId", optNullableInt(p.assigneeId));
  if (p.tags !== undefined) {
    if (!Array.isArray(p.tags) || !p.tags.every((t) => typeof t === "string")) {
      throw new InvalidPayloadError("tags");
    }
    record.tags = p.tags;
  }
  if (p.customFields !== undefined) {
    const cf = p.customFields;
    const valid =
      typeof cf === "object" &&
      cf !== null &&
      !Array.isArray(cf) &&
      Object.values(cf).every(
        (v) => typeof v === "string" || typeof v === "number",
      );
    if (!valid) throw new InvalidPayloadError("customFields");
    record.customFields = cf;
  }
  return fields;
}

function handleProjectQuery(): Promise<RouteResult> {
  return faceHandler(
    (d) => d.project,
    "project",
    (face, userId) => face.query(userId),
  );
}

function handleProjectGetDetail(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) return Promise.resolve(bizError("4040", "项目不存在"));
  return faceHandler(
    (d) => d.project,
    "project",
    (face, userId) => face.getDetail(userId, id),
  );
}

/** project/create：name 必填 trim；systemPrompt/templateKey/welcomeMessage
 *  可选字符串——载荷只含协议键，ownerId 无从混入（身份唯一来源 withUserId） */
function handleProjectCreate(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const name = asName(p.name);
  if (name === null) {
    return Promise.resolve(bizError("5000", "name 参数不合法"));
  }
  try {
    const systemPrompt = optString(p.systemPrompt);
    const templateKey = optString(p.templateKey);
    const welcomeMessage = optString(p.welcomeMessage);
    const payload: ProjectCreatePayload = {
      name,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(templateKey !== undefined ? { templateKey } : {}),
      ...(welcomeMessage !== undefined ? { welcomeMessage } : {}),
    };
    return faceHandler(
      (d) => d.project,
      "project",
      (face, userId) => face.create(userId, payload),
    );
  } catch {
    return Promise.resolve(bizError("5000", "systemPrompt 等参数不合法"));
  }
}

/** project/update：id + name/systemPrompt 至少一项（均缺省 = 无操作属参数错） */
function handleProjectUpdate(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const id = asInt(p.id);
  if (id === null) {
    return Promise.resolve(bizError("5000", "id/name/systemPrompt 参数不合法"));
  }
  try {
    const name = optString(p.name);
    const systemPrompt = optString(p.systemPrompt);
    if (
      (name !== undefined && name.trim() === "") ||
      (name === undefined && systemPrompt === undefined)
    ) {
      return Promise.resolve(
        bizError("5000", "id/name/systemPrompt 参数不合法"),
      );
    }
    const payload: ProjectUpdatePayload = {
      id,
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    };
    return faceHandler(
      (d) => d.project,
      "project",
      (face, userId) => face.update(userId, payload),
    );
  } catch {
    return Promise.resolve(bizError("5000", "id/name/systemPrompt 参数不合法"));
  }
}

function handleProjectDelete(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) return Promise.resolve(bizError("4040", "项目不存在"));
  return faceHandler(
    (d) => d.project,
    "project",
    (face, userId) => face.remove(userId, id).then(() => null),
  );
}

function handleProjectListMembers(body: unknown): Promise<RouteResult> {
  const projectId = asInt((body as { projectId?: unknown } | null)?.projectId);
  if (projectId === null) {
    return Promise.resolve(bizError("4040", "项目不存在"));
  }
  return faceHandler(
    (d) => d.project,
    "project",
    (face, userId) => face.listMembers(userId, projectId),
  );
}

function handlePlanItemList(body: unknown): Promise<RouteResult> {
  const projectId = asInt((body as { projectId?: unknown } | null)?.projectId);
  if (projectId === null) {
    return Promise.resolve(bizError("4040", "项目不存在"));
  }
  return faceHandler(
    (d) => d.planItem,
    "planItem",
    (face, userId) => face.list(userId, projectId),
  );
}

function handlePlanItemListMine(): Promise<RouteResult> {
  return faceHandler(
    (d) => d.planItem,
    "planItem",
    (face, userId) => face.listMine(userId),
  );
}

function handlePlanItemCreate(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const title = asTitle(p.title);
  const projectId = asInt(p.projectId);
  if (title === null || (p.projectId !== undefined && projectId === null)) {
    return Promise.resolve(bizError("5000", "title/projectId 参数不合法"));
  }
  try {
    const payload: PlanItemCreatePayload = {
      title,
      ...(projectId !== null ? { projectId } : {}),
      ...collectPlanItemFields(p),
    };
    return faceHandler(
      (d) => d.planItem,
      "planItem",
      (face, userId) => face.create(userId, payload),
    );
  } catch {
    return Promise.resolve(bizError("5000", "参数字段不合法"));
  }
}

function handlePlanItemUpdate(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const id = asInt(p.id);
  const title = p.title === undefined ? undefined : asTitle(p.title);
  if (id === null || title === null) {
    return Promise.resolve(bizError("5000", "id/title 参数不合法"));
  }
  try {
    const payload: PlanItemUpdatePayload = {
      id,
      ...(title !== undefined ? { title } : {}),
      ...collectPlanItemFields(p),
    };
    return faceHandler(
      (d) => d.planItem,
      "planItem",
      (face, userId) => face.update(userId, payload),
    );
  } catch {
    return Promise.resolve(bizError("5000", "参数字段不合法"));
  }
}

function handlePlanItemDelete(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) {
    return Promise.resolve(bizError("4040", "计划事项不存在"));
  }
  return faceHandler(
    (d) => d.planItem,
    "planItem",
    (face, userId) => face.remove(userId, id).then(() => null),
  );
}

/** planItem/move：状态流转落点（status 枚举 + sortOrder 列内新序，repo 校验） */
function handlePlanItemMove(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const id = asInt(p.id);
  const sortOrder = asInt(p.sortOrder);
  if (id === null || sortOrder === null) {
    return Promise.resolve(bizError("5000", "id/status/sortOrder 参数不合法"));
  }
  try {
    const status = optString(p.status);
    if (status === undefined) throw new InvalidPayloadError();
    // 枚举值 repo 自校验（中文错误 5000 兜底）——形状层只保证字符串
    const payload: PlanItemMovePayload = {
      id,
      status: status as PlanItemMovePayload["status"],
      sortOrder,
    };
    return faceHandler(
      (d) => d.planItem,
      "planItem",
      (face, userId) => face.move(userId, payload).then(() => null),
    );
  } catch {
    return Promise.resolve(bizError("5000", "id/status/sortOrder 参数不合法"));
  }
}

function handlePlanItemFieldsList(body: unknown): Promise<RouteResult> {
  const projectId = asInt((body as { projectId?: unknown } | null)?.projectId);
  if (projectId === null) {
    return Promise.resolve(bizError("4040", "项目不存在"));
  }
  return faceHandler(
    (d) => d.planItem,
    "planItem",
    (face, userId) => face.listFields(userId, projectId),
  );
}

function handlePlanItemAttachmentList(body: unknown): Promise<RouteResult> {
  const planItemId = asInt(
    (body as { planItemId?: unknown } | null)?.planItemId,
  );
  if (planItemId === null) {
    return Promise.resolve(bizError("4040", "计划事项不存在"));
  }
  return faceHandler(
    (d) => d.planItem,
    "planItem",
    (face, userId) => face.listAttachments(userId, planItemId),
  );
}

/** attachmentCreate：fileName/assetPath 非空（assetPath 为资产树相对路径） */
function handlePlanItemAttachmentCreate(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const planItemId = asInt(p.planItemId);
  const fileName = asName(p.fileName);
  const assetPath = asAssetFilePath(p.assetPath);
  if (planItemId === null || fileName === null || assetPath === null) {
    return Promise.resolve(
      bizError("5000", "planItemId/fileName/assetPath 参数不合法"),
    );
  }
  return faceHandler(
    (d) => d.planItem,
    "planItem",
    (face, userId) =>
      face.createAttachment(userId, planItemId, { fileName, assetPath }),
  );
}

function handlePlanItemAttachmentDelete(body: unknown): Promise<RouteResult> {
  const id = asInt((body as { id?: unknown } | null)?.id);
  if (id === null) {
    return Promise.resolve(bizError("4040", "计划事项不存在"));
  }
  return faceHandler(
    (d) => d.planItem,
    "planItem",
    (face, userId) => face.removeAttachment(userId, id).then(() => null),
  );
}

function handlePlanViewList(body: unknown): Promise<RouteResult> {
  const projectId = asInt((body as { projectId?: unknown } | null)?.projectId);
  if (projectId === null) {
    return Promise.resolve(bizError("4040", "项目不存在"));
  }
  return faceHandler(
    (d) => d.planView,
    "planView",
    (face, userId) => face.list(userId, projectId),
  );
}

function handleProjectAssetList(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const projectId = asInt(p.projectId);
  const folderPath = p.path === undefined ? "" : asAssetPath(p.path);
  if (projectId === null || folderPath === null) {
    return Promise.resolve(bizError("5000", "projectId/path 参数不合法"));
  }
  return faceHandler(
    (d) => d.projectAsset,
    "projectAsset",
    (face, userId) =>
      face.list(userId, projectId, folderPath === "" ? undefined : folderPath),
  );
}

function handleProjectAssetCreateFolder(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const projectId = asInt(p.projectId);
  const parentPath = asAssetPath(p.parentPath);
  const name = asName(p.name);
  if (projectId === null || parentPath === null || name === null) {
    return Promise.resolve(
      bizError("5000", "projectId/parentPath/name 参数不合法"),
    );
  }
  return faceHandler(
    (d) => d.projectAsset,
    "projectAsset",
    (face, userId) => face.createFolder(userId, projectId, parentPath, name),
  );
}

function handleProjectAssetRename(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const projectId = asInt(p.projectId);
  const relPath = asAssetPath(p.path);
  const newName = asName(p.newName);
  if (projectId === null || relPath === null || newName === null) {
    return Promise.resolve(
      bizError("5000", "projectId/path/newName 参数不合法"),
    );
  }
  return faceHandler(
    (d) => d.projectAsset,
    "projectAsset",
    (face, userId) => face.rename(userId, projectId, relPath, newName),
  );
}

function handleProjectAssetDelete(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const projectId = asInt(p.projectId);
  const relPath = asAssetPath(p.path);
  if (projectId === null || relPath === null) {
    return Promise.resolve(bizError("5000", "projectId/path 参数不合法"));
  }
  return faceHandler(
    (d) => d.projectAsset,
    "projectAsset",
    (face, userId) => face.remove(userId, projectId, relPath).then(() => null),
  );
}

function handleProjectAssetStorage(body: unknown): Promise<RouteResult> {
  const projectId = asInt((body as { projectId?: unknown } | null)?.projectId);
  if (projectId === null) {
    return Promise.resolve(bizError("5000", "projectId 参数不合法"));
  }
  return faceHandler(
    (d) => d.projectAsset,
    "projectAsset",
    (face, userId) => face.storage(userId, projectId),
  );
}

function handleProjectAssetReadImage(body: unknown): Promise<RouteResult> {
  const p = (body ?? {}) as Record<string, unknown>;
  const projectId = asInt(p.projectId);
  const relPath = asAssetFilePath(p.path);
  if (projectId === null || relPath === null) {
    return Promise.resolve(bizError("5000", "projectId/path 参数不合法"));
  }
  return faceHandler(
    (d) => d.projectAsset,
    "projectAsset",
    (face, userId) => face.readImage(userId, projectId, relPath),
  );
}

const ROUTES: Record<string, RouteHandler> = {
  "GET info": handleInfo,
  "POST session/create": handleCreate,
  "POST session/query": handleQuery,
  "POST session/getById": handleGetById,
  "POST session/delete": handleDelete,
  "POST session/update": handleSessionUpdate,
  "POST session/send": handleSend,
  "POST session/regenerate": handleRegenerate,
  "POST session/editAndResend": handleEditAndResend,
  "POST session/accessMode": handleAccessMode,
  "POST session/usage": handleSessionUsage,
  // P1 未读角标批：已读游标单调推进（响应 SessionReadResult）
  "POST session/read": handleSessionRead,
  // A9 会话内工具批（ENDPOINTS 协议常量直引——键漂移即测试红）
  [`POST ${ENDPOINTS.session.compact}`]: handleCompact,
  [`POST ${ENDPOINTS.session.polish}`]: handlePolish,
  "POST skills/query": handleSkillsQuery,
  "POST skills/read": handleSkillsRead,
  "POST skills/setEnabled": handleSkillsSetEnabled,
  // A3 技能管理扩 + skillhub 市场四端点（ENDPOINTS 协议常量直引）
  [`POST ${ENDPOINTS.skills.setScenarios}`]: handleSkillsSetScenarios,
  [`POST ${ENDPOINTS.skills.uninstall}`]: handleSkillsUninstall,
  // A3 尾：base64 zip 直装（≤3MB）/ 事件表聚合统计
  [`POST ${ENDPOINTS.skills.installUpload}`]: handleSkillsInstallUpload,
  [`POST ${ENDPOINTS.skills.stats}`]: handleSkillsStats,
  [`POST ${ENDPOINTS.skillhub.list}`]: handleSkillHubList,
  [`POST ${ENDPOINTS.skillhub.top}`]: handleSkillHubTop,
  [`POST ${ENDPOINTS.skillhub.categories}`]: handleSkillHubCategories,
  [`POST ${ENDPOINTS.skillhub.install}`]: handleSkillHubInstall,
  // detail 批：hub 详情透传（正文/统计/作者/安全归一）
  [`POST ${ENDPOINTS.skillhub.detail}`]: handleSkillHubDetail,
  "POST mcp/query": handleMcpQuery,
  "POST mcp/setEnabled": handleMcpSetEnabled,
  // A4 MCP 五端点（ENDPOINTS.mcp 协议常量直引）
  [`POST ${ENDPOINTS.mcp.statuses}`]: handleMcpStatuses,
  [`POST ${ENDPOINTS.mcp.save}`]: handleMcpSave,
  [`POST ${ENDPOINTS.mcp.delete}`]: handleMcpDelete,
  [`POST ${ENDPOINTS.mcp.reconnect}`]: handleMcpReconnect,
  [`POST ${ENDPOINTS.mcp.detail}`]: handleMcpDetail,
  // 移动端 CRUD 批：automation 五端点 + graph/query 只读（ENDPOINTS 直引）；
  // 执行详情批：automation/runNodes 节点详情（桥桌面 GraphRepository 单源）
  [`POST ${ENDPOINTS.automation.query}`]: handleAutomationQuery,
  [`POST ${ENDPOINTS.automation.save}`]: handleAutomationSave,
  [`POST ${ENDPOINTS.automation.delete}`]: handleAutomationDelete,
  [`POST ${ENDPOINTS.automation.runNow}`]: handleAutomationRunNow,
  [`POST ${ENDPOINTS.automation.runPage}`]: handleAutomationRunPage,
  [`POST ${ENDPOINTS.automation.runNodes}`]: handleAutomationRunNodes,
  [`POST ${ENDPOINTS.graph.query}`]: handleGraphQueryReadonly,
  // 记忆进化批：memory 五端点（ENDPOINTS 直引；桌面被控面专属）
  [`POST ${ENDPOINTS.memory.get}`]: handleMemoryGet,
  [`POST ${ENDPOINTS.memory.saveConfig}`]: handleMemorySaveConfig,
  [`POST ${ENDPOINTS.memory.saveProfile}`]: handleMemorySaveProfile,
  [`POST ${ENDPOINTS.memory.applyInstruction}`]: handleMemoryApplyInstruction,
  [`POST ${ENDPOINTS.memory.compile}`]: handleMemoryCompile,
  // 备份面批：backup 三端点（ENDPOINTS 直引；桌面被控面专属）
  [`POST ${ENDPOINTS.backup.list}`]: handleBackupList,
  [`POST ${ENDPOINTS.backup.create}`]: handleBackupCreate,
  [`POST ${ENDPOINTS.backup.delete}`]: handleBackupDelete,
  "POST monitor/stats": handleMonitorStats,
  "POST session/abort": handleAbort,
  "POST session/approve": handleApprove,
  "POST provider/query": handleProviderQuery,
  "POST provider/save": handleProviderSave,
  "POST provider/delete": handleProviderDelete,
  "POST provider/test": handleProviderTest,
  "POST provider/fetchModels": handleProviderFetchModels,
  "POST assistant/query": handleAssistantQuery,
  // A2 专家写面五端点（ENDPOINTS.assistant 协议常量直引——键漂移即测试红）
  [`POST ${ENDPOINTS.assistant.detail}`]: handleAssistantDetail,
  [`POST ${ENDPOINTS.assistant.save}`]: handleAssistantSave,
  [`POST ${ENDPOINTS.assistant.delete}`]: handleAssistantDelete,
  [`POST ${ENDPOINTS.assistant.marketList}`]: handleAssistantMarketList,
  [`POST ${ENDPOINTS.assistant.marketDetail}`]: handleAssistantMarketDetail,
  // A2 尾导入导出（ENDPOINTS 协议常量直引——键漂移即测试红）
  [`POST ${ENDPOINTS.assistant.export}`]: handleAssistantExport,
  [`POST ${ENDPOINTS.assistant.import}`]: handleAssistantImport,
  "POST workspace/query": handleWorkspaceQuery,
  // A8 写面三端点（ENDPOINTS.workspace 协议常量直引——键漂移即测试红；
  // 无 bindDirectory——绑定目录留桌面端，spec §1.4）
  [`POST ${ENDPOINTS.workspace.create}`]: handleWorkspaceCreate,
  [`POST ${ENDPOINTS.workspace.update}`]: handleWorkspaceUpdate,
  [`POST ${ENDPOINTS.workspace.delete}`]: handleWorkspaceDelete,
  // A10 审批记忆五端点（ENDPOINTS.permission 协议常量直引——键漂移即测试红；
  // remembered 面幂等 no-op，full 面全局运行态，spec §1.1）
  [`POST ${ENDPOINTS.permission.listRemembered}`]:
    handlePermissionListRemembered,
  [`POST ${ENDPOINTS.permission.revokeRemembered}`]:
    handlePermissionRevokeRemembered,
  [`POST ${ENDPOINTS.permission.revokeAllRemembered}`]:
    handlePermissionRevokeAllRemembered,
  [`POST ${ENDPOINTS.permission.listFullGrants}`]:
    handlePermissionListFullGrants,
  [`POST ${ENDPOINTS.permission.revokeAllFull}`]: handlePermissionRevokeAllFull,
  "POST files/list": handleFilesList,
  "POST files/read": handleFilesRead,
  "POST files/uploadImage": handleFilesUploadImage,
  // AR 批本地产物三端点（桌面被控面专属——artifact 表只在桌面端）
  [`POST ${ENDPOINTS.artifact.list}`]: handleArtifactList,
  [`POST ${ENDPOINTS.artifact.toggleFavorite}`]: handleArtifactToggleFavorite,
  [`POST ${ENDPOINTS.artifact.read}`]: handleArtifactRead,
  // A5 资料库十八端点（ENDPOINTS.library 协议常量直引——键漂移即测试红；
  // 末段 writeContent/uploadFile 为资料库编辑批内容写面与上传批二进制入库）
  [`POST ${ENDPOINTS.library.list}`]: handleLibraryList,
  [`POST ${ENDPOINTS.library.tree}`]: handleLibraryTree,
  [`POST ${ENDPOINTS.library.search}`]: handleLibrarySearch,
  [`POST ${ENDPOINTS.library.listRecent}`]: handleLibraryListRecent,
  [`POST ${ENDPOINTS.library.listFavorites}`]: handleLibraryListFavorites,
  [`POST ${ENDPOINTS.library.createFolder}`]: handleLibraryCreateFolder,
  [`POST ${ENDPOINTS.library.createFile}`]: handleLibraryCreateFile,
  [`POST ${ENDPOINTS.library.addLink}`]: handleLibraryAddLink,
  [`POST ${ENDPOINTS.library.rename}`]: handleLibraryRename,
  [`POST ${ENDPOINTS.library.move}`]: handleLibraryMove,
  [`POST ${ENDPOINTS.library.delete}`]: handleLibraryDelete,
  [`POST ${ENDPOINTS.library.subtreeCount}`]: (body: unknown) =>
    handleLibraryId(body, (library, userId, id) =>
      library.subtreeCount(userId, id).then((count) => count),
    ),
  [`POST ${ENDPOINTS.library.toggleFavorite}`]: (body: unknown) =>
    handleLibraryId(body, (library, userId, id) =>
      library.toggleFavorite(userId, id),
    ),
  [`POST ${ENDPOINTS.library.markViewed}`]: (body: unknown) =>
    handleLibraryId(body, (library, userId, id) =>
      library.markViewed(userId, id),
    ),
  [`POST ${ENDPOINTS.library.read}`]: (body: unknown) =>
    handleLibraryId(body, (library, userId, id) => library.read(userId, id)),
  [`POST ${ENDPOINTS.library.readImage}`]: (body: unknown) =>
    handleLibraryId(body, (library, userId, id) =>
      library.readImage(userId, id),
    ),
  [`POST ${ENDPOINTS.library.writeContent}`]: handleLibraryWriteContent,
  [`POST ${ENDPOINTS.library.uploadFile}`]: handleLibraryUploadFile,
  // A7 项目域 23 端点（ENDPOINTS.project/planItem/planView/projectAsset 协议
  // 常量直引——键漂移即测试红）
  [`POST ${ENDPOINTS.project.query}`]: handleProjectQuery,
  [`POST ${ENDPOINTS.project.getDetail}`]: handleProjectGetDetail,
  [`POST ${ENDPOINTS.project.create}`]: handleProjectCreate,
  [`POST ${ENDPOINTS.project.update}`]: handleProjectUpdate,
  [`POST ${ENDPOINTS.project.delete}`]: handleProjectDelete,
  [`POST ${ENDPOINTS.project.listMembers}`]: handleProjectListMembers,
  [`POST ${ENDPOINTS.planItem.list}`]: handlePlanItemList,
  [`POST ${ENDPOINTS.planItem.listMine}`]: handlePlanItemListMine,
  [`POST ${ENDPOINTS.planItem.create}`]: handlePlanItemCreate,
  [`POST ${ENDPOINTS.planItem.update}`]: handlePlanItemUpdate,
  [`POST ${ENDPOINTS.planItem.delete}`]: handlePlanItemDelete,
  [`POST ${ENDPOINTS.planItem.move}`]: handlePlanItemMove,
  [`POST ${ENDPOINTS.planItem.fieldsList}`]: handlePlanItemFieldsList,
  [`POST ${ENDPOINTS.planItem.attachmentList}`]: handlePlanItemAttachmentList,
  [`POST ${ENDPOINTS.planItem.attachmentCreate}`]:
    handlePlanItemAttachmentCreate,
  [`POST ${ENDPOINTS.planItem.attachmentDelete}`]:
    handlePlanItemAttachmentDelete,
  [`POST ${ENDPOINTS.planView.list}`]: handlePlanViewList,
  [`POST ${ENDPOINTS.projectAsset.list}`]: handleProjectAssetList,
  [`POST ${ENDPOINTS.projectAsset.createFolder}`]:
    handleProjectAssetCreateFolder,
  [`POST ${ENDPOINTS.projectAsset.rename}`]: handleProjectAssetRename,
  [`POST ${ENDPOINTS.projectAsset.delete}`]: handleProjectAssetDelete,
  [`POST ${ENDPOINTS.projectAsset.storage}`]: handleProjectAssetStorage,
  [`POST ${ENDPOINTS.projectAsset.readImage}`]: handleProjectAssetReadImage,
  "POST image": handleImage,
  "POST ui/openSession": handleUiOpenSession,
  "POST ui/notify": handleUiNotify,
  "POST ui/openRoute": handleUiOpenRoute,
};

/**
 * 路由分发（HTTP 面与 relay req 帧共用）。
 * @param method GET | POST
 * @param path 逻辑路径（前导斜杠归一；"session/query" 或 "/session/query"）
 * @param body JSON 载荷（GET 传 null）
 */
export async function handleRoute(
  method: "GET" | "POST",
  path: string,
  body: unknown,
): Promise<RouteResult> {
  const handler = ROUTES[`${method} ${path.replace(/^\//, "")}`];
  if (!handler) {
    return bizError("4040", "接口不存在");
  }
  try {
    return await handler(body);
  } catch (error) {
    return bizErrorFrom(error);
  }
}
