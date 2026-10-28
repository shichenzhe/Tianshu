/**
 * 控制端 API（T17/T18）：server:* IPC 通道封装 + 事件订阅。
 * 消费契约（T15/T16 移交）：
 * - session 类通道返回 {status, body} 完整信封，body 为 starter 包装体
 *   {code, success, data, message}——判错查 success/code 勿只看 status
 *   （业务错 = HTTP 200 + 4xxx；send 受理是 202 也是成功）
 * - 事件：server:chunk:<connId>:<sessionId>（chunk 载荷原样）与合并通道
 *   server:event:<connId>（{type, payload}，message.chunk 以外的事件——
 *   含 server.connected 重连全量刷新信号，spec §13 项 2）
 * - 连接 id 生成避开 ":"（server:chunk: 动态通道按 ":" 拆段会歧义）
 */
import { invoke, on, type IPCChannel } from "@/lib/ipc";
import type { ChatStreamChunk } from "@/domains/ai/api/chat.api";
import type {
  RemoteFileUploadInput,
  RemoteWorkspaceBrief,
  SessionReadResult,
  SessionUsageBreakdown,
  ToolRequestPayload,
} from "@tianshu/protocol";
import type { SessionLastMessage } from "@tianshu/protocol";

/** workspace/query 列表行（HD-A1：单 UI 远程态侧栏分组树；protocol
 *  RemoteWorkspaceBrief 同构，此处 re-export 老消费链） */
export type { RemoteWorkspaceBrief };

export type ConnectionMode = "direct" | "relay";

export type ConnectionRuntimeState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "invalid-token"
  | "closed";

/** 连接级 E2E 模式（仅 relay；缺省 auto。required=握手无 ack 拒降级断开
 * ——spec §2.4 控制端配置级开关，E2E-T4/T3 审查；无 off：不建连接即得） */
export type ConnectionE2eMode = "auto" | "required";

export interface ConnectionConfig {
  id: string;
  name: string;
  mode: ConnectionMode;
  baseUrl?: string;
  token?: string;
  /** 备份专用 token（多用户批）：申领所得 clientToken；缺省回落 token
   *  （单用户语义）。仅 direct 形态；save 白名单透传（validateConfig 收口） */
  backupToken?: string;
  relayUrl?: string;
  relayToken?: string;
  connectionId?: string;
  /** 被控端 E2E 指纹（hex16；空=TOFU 首连回填。仅 relay 模式） */
  fingerprint?: string;
  /** 连接级 E2E 模式（ConnectionE2eMode；仅 relay 模式） */
  e2eMode?: ConnectionE2eMode;
  local?: boolean;
}

/** 连接 E2E 承载状态（E2E-T3，主进程同款）：unsupported=direct 不适用；
 * plaintext=明文中继（降级警示）；encrypted=加密会话；mitm-suspect=指纹
 * 不匹配断开（红色警示）；required-failed=连接级 required 拒降级断开 */
export type ConnectionE2eState =
  | "unsupported"
  | "plaintext"
  | "encrypted"
  | "mitm-suspect"
  | "required-failed";

/** 注册表对外视图：配置 + 运行态 + 协商到的能力清单 + E2E 承载态
 * （relay 会话加密徽标数据；direct 恒 unsupported、idle 无值） */
export interface ConnectionView extends ConnectionConfig {
  state: ConnectionRuntimeState;
  e2e?: ConnectionE2eState;
  capabilities: string[];
}

export interface ConnectionListResult {
  activeConnId: string | null;
  connections: ConnectionView[];
}

/** 本地无头端固定连接 id（localStart upsert 复用，主进程同款） */
export const LOCAL_CONNECTION_ID = "local";

export type TestConnectionResult =
  | { ok: true; instanceId: string; capabilities: string[] }
  | {
      ok: false;
      reason: "invalid-config" | "invalid-token" | "unreachable" | "timeout";
      message: string;
    };

export interface LocalServerStatus {
  running: boolean;
  state: "stopped" | "starting" | "running" | "error";
  port: number | null;
  instanceId: string | null;
}

/** relay E2E 模式（E2E-T2；主进程同款三值） */
export type FaceE2eMode = "auto" | "required" | "off";

/** 本机被控面状态快照（serverFace:status；port 在运行中为实听端口，
 * 未运行为配置端口——0 = 随机端口语义仅测试态出现） */
export interface FaceStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  host: string;
  token: string;
  relayUrl: string;
  relayToken: string;
  relayConnected: boolean;
  instanceId: string;
  /** E2E：配置模式 / 静态公钥（base64，未生成为空串）/ 指纹（hex16）/
   * 当前 relay 连接是否已建立加密会话 */
  e2eMode: FaceE2eMode;
  e2ePublicKey: string;
  e2eFingerprint: string;
  e2eActive: boolean;
}

/** setEnabled 载荷（spec §13 项 1）：enabled 必填，其余可选合并；
 * UI 侧每次携全量当前表单值（status 已回传 relayToken，无覆盖丢失） */
export interface FaceUpdate {
  enabled: boolean;
  port?: number;
  host?: string;
  relayUrl?: string;
  relayToken?: string;
  e2e?: FaceE2eMode;
  regenerateToken?: boolean;
}

/** 连接 id 生成：避开 ":"（T16 minor 注记——server:chunk:<connId>:<sessionId>
 * 动态通道按 ":" 拆段，含冒号的 id 会产生歧义） */
export function newConnectionId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `conn-${Date.now().toString(36)}-${rand}`;
}

/** 被控端 starter 包装体（判错查 success） */
interface WireEnvelope {
  code?: string;
  success: boolean;
  data: unknown;
  message: string;
}

/** session 类请求业务错（success=false 时抛出；code 为被控端 4xxx） */
export class RemoteRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 远程透传请求（session/graph/automation 通用）：{status, body} 全信封 →
 * 判错查 body.success（业务错 200+4xxx / 受理 202 均可能在，勿只看 status；
 * GA-T8 起 graph.api.ts 复用同款信封语义） */
export async function requestRemote<T>(
  channel: IPCChannel,
  body: unknown,
  connId: string,
): Promise<T> {
  const envelope = await invoke<{ status: number; body: WireEnvelope }>(
    channel,
    body,
    connId,
  );
  const wire = envelope?.body;
  if (
    !wire ||
    typeof wire !== "object" ||
    typeof (wire as WireEnvelope).success !== "boolean"
  ) {
    throw new RemoteRequestError("PROTOCOL", "被控端响应不符合协议");
  }
  if (!(wire as WireEnvelope).success) {
    throw new RemoteRequestError(
      String((wire as WireEnvelope).code ?? "UNKNOWN"),
      String((wire as WireEnvelope).message ?? "请求失败"),
    );
  }
  return (wire as WireEnvelope).data as T;
}

/** 远程会话行（两被控端通用字段——排序/keyword 语义两被控端有差， * UI 勿依赖：只显 id/title/时间字符串，时间按字符串展示勿 new Date） */
export interface RemoteSessionRow {
  id: number;
  title: string | null;
  /** 归属工作空间（库内行 id——HD-A2 远端树分组；列表行可缺省） */
  workspaceId?: number;
  updatedAt?: string;
  lastMessageAt?: string | null;
  /** 会话当前模型（库内行 id；getById 详情透出，列表行可缺省） */
  currentModelId?: number | null;
  /** 会话当前专家（getById 详情透出，列表行可缺省） */
  assistantId?: number | null;
  /** 会话模式 agent|ask|plan（详情透出；模式切换显示） */
  mode?: string;
  /** 归档时间（详情透出；归档只读态判定——列表行也透出用于分组沉底） */
  archivedAt?: string | null;
  /** 置顶时间（列表行透出；置顶排序前置） */
  pinnedAt?: string | null;
  /** P1 未读角标批：未读数（session/query 动态算；角标行渲染） */
  unreadCount?: number;
  /** P1 未读角标批：末条消息摘要（远端无消息为 null） */
  lastMessage?: SessionLastMessage | null;
  /** A9 会话内工具批：压缩摘要（存在即压缩态；会话页提示条/摘要轮数据源） */
  summary?: string | null;
  /** A9 会话内工具批：压缩覆盖点消息 id（历史过滤点，与 summary 成对） */
  compactedUpToId?: number | null;
}

export interface RemoteSessionPage {
  page: number;
  pageSize: number;
  records: RemoteSessionRow[];
  total: number;
}

/** 会话详情消息（blocks 协议 JSON 原样字符串，按 id 升序；createdAt/
 * modelId 为时间戳与模型名显示管道——CU 批透出，旧行可缺省；durationMs
 * 为耗时显示管道——durationMs 批透出（round 计时列），缺省/旧行 null） */
export interface RemoteMessageBrief {
  id: number;
  role: string;
  blocks: string;
  createdAt?: string;
  modelId?: number | null;
  durationMs?: number | null;
}

export interface RemoteSessionDetail {
  session: RemoteSessionRow;
  messages: RemoteMessageBrief[];
}

/** 远端服务商行（provider/query 返回；apiKey/extraHeaders 服务端脱敏
 * 掩码——REDACTED_SECRET 回传，save 时掩码原样回传=不修改该字段） */
export interface RemoteProvider {
  id: number;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string | null;
  /** 额外请求头 JSON 字符串（服务端逐值脱敏；编辑留空/掩码回传=不改） */
  extraHeaders?: string | null;
  enabled: boolean;
}

/** 远端模型行（provider/query 返回；id = 库内行标识，sessionSend 的
 * modelId 即此值；温度等参数字段编辑保存时可选透传） */
export interface RemoteModel {
  id: number;
  providerId: number;
  modelId: string;
  name: string | null;
  type: string;
  enabled: boolean;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
}

export interface RemoteProviderBundle {
  providers: RemoteProvider[];
  models: RemoteModel[];
}

/** provider/save 上行项（upsert 数组：带 id 更新/不带新建） */
export interface RemoteProviderSaveInput {
  providers?: Array<
    Partial<Omit<RemoteProvider, "apiKey">> & {
      apiKey?: string | null;
      extraHeaders?: string | null;
    }
  >;
  models?: Array<Partial<RemoteModel>>;
}

/** server:event:<connId> 合并通道载荷（message.chunk 以外的原始事件）。
 * server.connected 为连接/重连合成帧（spec §13 项 2）：订阅方收到即全量
 * refetch（会话列表/当前会话/连接态），消断流漏事件导致的卡流式态 */
export type RemoteSessionEvent =
  | {
      type: "server.connected";
      payload: { instanceId: string; capabilities: string[] };
    }
  | {
      type: "session.updated";
      payload: {
        id: number;
        title: string | null;
        updatedAt: string;
        /** P1 未读角标批：未读数（角标清/刷新信号同源） */
        unreadCount: number;
        /** P1 未读角标批：末条消息摘要 */
        lastMessage: SessionLastMessage | null;
      };
    }
  | {
      type: "session.error";
      payload: { sessionId: number; code: string; message: string };
    };

export default class ServerApi {
  /** 连接清单（含运行态/能力；activeConnId 为当前粘性活动连接） */
  static async listConnections(): Promise<ConnectionListResult> {
    return invoke<ConnectionListResult>("server:connectionList");
  }

  static async saveConnection(
    config: ConnectionConfig,
  ): Promise<ConnectionListResult> {
    return invoke<ConnectionListResult>("server:connectionSave", config);
  }

  static async deleteConnection(id: string): Promise<ConnectionListResult> {
    return invoke<ConnectionListResult>("server:connectionDelete", id);
  }

  /** 连通性测试（临时 transport → GET info；不落库） */
  static async testConnection(
    config: ConnectionConfig,
  ): Promise<TestConnectionResult> {
    return invoke<TestConnectionResult>("server:testConnection", config);
  }

  static async localStart(
    projectDir: string,
  ): Promise<{ port: number; token: string; instanceId: string }> {
    return invoke<{ port: number; token: string; instanceId: string }>(
      "server:localStart",
      projectDir,
    );
  }

  static async localStop(): Promise<void> {
    return invoke<void>("server:localStop");
  }

  static async localStatus(): Promise<LocalServerStatus> {
    return invoke<LocalServerStatus>("server:localStatus");
  }

  // —— 本机被控面（spec §13 项 1 设置 UI） ——

  static async faceStatus(): Promise<FaceStatus> {
    return invoke<FaceStatus>("serverFace:status");
  }

  /** 启停/配置编辑一体（对象载荷主进程合并落库并应用；返回最新快照） */
  static async faceSetEnabled(update: FaceUpdate): Promise<FaceStatus> {
    return invoke<FaceStatus>("serverFace:setEnabled", update);
  }

  // —— 会话遥控（T18；显式携 connId 透传并粘性切换活动连接） ——

  static async sessionList(
    params: { page?: number; pageSize?: number; keyword?: string },
    connId: string,
  ): Promise<RemoteSessionPage> {
    return requestRemote<RemoteSessionPage>(
      "server:sessionList",
      params,
      connId,
    );
  }

  static async sessionGet(
    id: number,
    connId: string,
  ): Promise<RemoteSessionDetail> {
    return requestRemote<RemoteSessionDetail>(
      "server:sessionGet",
      { id },
      connId,
    );
  }

  /** 发送消息（202 受理；流式结果经 server:chunk:* 事件回传；modelId=
   * 模型行 id 指定本次起会话切至该模型——server 侧持久 currentModelId，
   * 缺省走会话当前值 → workspace 默认 → 首个可用 llm 回退链；assistantId=
   * 专家 id 指定本轮专家——server 侧持久 session.assistantId） */
  static async sessionSend(
    sessionId: number,
    content: string,
    connId: string,
    modelId?: number,
    assistantId?: number,
    /** FA-T3 图片批：被控端数据根相对路径（files/uploadImage 返回值） */
    images?: string[],
  ): Promise<void> {
    await requestRemote(
      "server:sessionSend",
      {
        sessionId,
        content,
        ...(modelId != null ? { modelId } : {}),
        ...(assistantId != null ? { assistantId } : {}),
        ...(images != null ? { images } : {}),
      },
      connId,
    );
  }

  static async sessionAbort(sessionId: number, connId: string): Promise<void> {
    await requestRemote("server:sessionAbort", { sessionId }, connId);
  }

  static async sessionCreate(
    params: { title?: string; workspaceId?: number },
    connId: string,
  ): Promise<RemoteSessionRow> {
    return requestRemote<RemoteSessionRow>(
      "server:sessionCreate",
      params,
      connId,
    );
  }

  /** 删除会话（双端均有 session/delete；headless 级联清消息） */
  static async sessionDelete(sessionId: number, connId: string): Promise<void> {
    await requestRemote("server:sessionDelete", { sessionId }, connId);
  }

  /** 模型配置全量（providers+models；providers 密钥字段脱敏回显） */
  static async providerBundle(connId: string): Promise<RemoteProviderBundle> {
    return requestRemote<RemoteProviderBundle>(
      "server:providerQuery",
      {},
      connId,
    );
  }

  /** 保存模型配置（upsert 数组语义，返回保存后全量；仅无头端有此端点
   * ——desktop 被控面 provider 只读，调用将报 404） */
  static async providerSave(
    input: RemoteProviderSaveInput,
    connId: string,
  ): Promise<RemoteProviderBundle> {
    return requestRemote<RemoteProviderBundle>(
      "server:providerSave",
      input,
      connId,
    );
  }

  /** 批量删除（providerIds 级联清 models / modelIds 单删；双端均有，
   * 归属外 id 幂等跳过），返回删除后全量 */
  static async providerDelete(
    input: { providerIds?: number[]; modelIds?: number[] },
    connId: string,
  ): Promise<RemoteProviderBundle> {
    return requestRemote<RemoteProviderBundle>(
      "server:providerDelete",
      input,
      connId,
    );
  }

  /** 服务商连通测试（双端均轻探上游 /models——不发起对话计费） */
  static async providerTest(
    providerId: number,
    connId: string,
  ): Promise<{ ok: boolean; message: string }> {
    return requestRemote<{ ok: boolean; message: string }>(
      "server:providerTest",
      { providerId },
      connId,
    );
  }

  /** 拉取上游模型清单（连通失败结构化非异常） */
  static async providerFetchModels(
    providerId: number,
    connId: string,
  ): Promise<{
    success: boolean;
    errorCode?: string;
    message: string;
    models: Array<{ modelId: string; name?: string }>;
  }> {
    return requestRemote("server:providerFetchModels", { providerId }, connId);
  }

  /** 会话更新（重命名/模式切换/归档；双端均有） */
  static async sessionUpdate(
    sessionId: number,
    fields: {
      title?: string;
      mode?: "agent" | "ask" | "plan";
      archived?: boolean;
      pinned?: boolean;
      assistantId?: number | null;
    },
    connId: string,
  ): Promise<void> {
    await requestRemote(
      "server:sessionUpdate",
      { sessionId, ...fields },
      connId,
    );
  }

  /** 编辑重发（改写 user 消息+截断其后+原位重跑；202 受理，流经 chunk） */
  static async sessionEditResend(
    sessionId: number,
    messageId: number,
    content: string,
    connId: string,
  ): Promise<void> {
    await requestRemote(
      "server:sessionEditResend",
      { sessionId, messageId, content },
      connId,
    );
  }

  /** P1 尾未读角标：已读游标推进（session/read 透传；响应 SessionReadResult） */
  static async sessionRead(
    sessionId: number,
    messageId: number,
    connId: string,
  ): Promise<SessionReadResult> {
    return requestRemote<SessionReadResult>(
      "server:sessionRead",
      { sessionId, messageId },
      connId,
    );
  }

  /** 上下文用量拆解（五类 token 估算；未配模型 null——UI 灰态） */
  static async sessionUsage(
    sessionId: number,
    connId: string,
  ): Promise<SessionUsageBreakdown | null> {
    return requestRemote("server:sessionUsage", { sessionId }, connId);
  }

  /** 技能清单（联想候选＋启停管理；enabled=全局启停） */
  static async skillsQuery(
    connId: string,
  ): Promise<
    Array<{ name: string; description?: string | null; enabled?: boolean }>
  > {
    return requestRemote("server:skillsQuery", {}, connId);
  }

  /** 读技能全文（发送前并入消息文本——本地 ⚡token 机制同构） */
  static async skillsRead(
    name: string,
    connId: string,
  ): Promise<{ content: string }> {
    return requestRemote("server:skillsRead", { name }, connId);
  }

  /** 技能启停（＋菜单技能子菜单多选——PM 批） */
  static async skillsSetEnabled(
    name: string,
    enabled: boolean,
    connId: string,
  ): Promise<void> {
    await requestRemote("server:skillsSetEnabled", { name, enabled }, connId);
  }

  /** 会话权限模式（get/set 合一：mode 缺省查询） */
  static async sessionAccessMode(
    sessionId: number,
    mode: "default" | "full" | undefined,
    connId: string,
  ): Promise<{ mode: "default" | "full" }> {
    return requestRemote(
      "server:sessionAccessMode",
      { sessionId, ...(mode != null ? { mode } : {}) },
      connId,
    );
  }

  // —— files 三端点（FA-T3，spec 2026-10-20 §3.1）——

  /** 工作空间文件清单（@ 联想；相对路径数组） */
  static async filesList(
    workspaceId: number,
    connId: string,
  ): Promise<string[]> {
    return requestRemote<string[]>("server:filesList", { workspaceId }, connId);
  }

  /** 守卫读取（512KB/NUL；FILES_* 业务错抛 RemoteRequestError 携 code） */
  static async filesRead(
    workspaceId: number,
    path: string,
    connId: string,
  ): Promise<{ content: string }> {
    return requestRemote<{ content: string }>(
      "server:filesRead",
      { workspaceId, path },
      connId,
    );
  }

  /** 图片上传（≤3MB base64；返回数据根相对 imagePath） */
  static async filesUploadImage(
    input: RemoteFileUploadInput,
    connId: string,
  ): Promise<{ imagePath: string }> {
    return requestRemote<{ imagePath: string }>(
      "server:filesUploadImage",
      input,
      connId,
    );
  }

  /** 重新生成（202 受理；messageId 缺省=最后一条 assistant；流式经
   * chunk 事件回传，收尾 session.updated/error 同 send） */
  static async sessionRegenerate(
    sessionId: number,
    messageId: number | undefined,
    connId: string,
  ): Promise<void> {
    await requestRemote(
      "server:sessionRegenerate",
      { sessionId, ...(messageId != null ? { messageId } : {}) },
      connId,
    );
  }

  /** 专家列表（发送选专家用；headless 空表如实返回空；icon 头像列显示） */
  static async assistantList(connId: string): Promise<
    Array<{
      id: number;
      name: string;
      description?: string | null;
      icon?: string | null;
      quickPrompts?: string[] | null;
    }>
  > {
    return requestRemote("server:assistantQuery", {}, connId);
  }

  /** 工作空间概要列表（HD-A1：单 UI 远程态侧栏分组树数据源） */
  static async workspaceList(connId: string): Promise<RemoteWorkspaceBrief[]> {
    return requestRemote<RemoteWorkspaceBrief[]>(
      "server:workspaceList",
      {},
      connId,
    );
  }

  /** 审批应答（T17，移动端 spec §4.1 同协议）：批准/拒绝挂起的 write
   * 工具调用；被控端 4040 = 该审批已被处理（双端竞速先到/超时自动拒）
   * 或被控端版本过旧不支持审批应答——调用方捕获 RemoteRequestError 按
   * code 分流 */
  static async approveSession(
    connId: string,
    sessionId: number,
    toolCallId: string,
    approved: boolean,
    remember?: { toolName: string },
  ): Promise<void> {
    // remember（审批记住批）：批准同时写工作空间级工具记忆（被控端归属
    // 校验后落 toolPermission——远程态「允许并记住」由此解锁）
    await requestRemote(
      "server:sessionApprove",
      {
        sessionId,
        toolCallId,
        approved,
        ...(remember ? { remember: true, toolName: remember.toolName } : {}),
      },
      connId,
    );
  }

  // —— ui-drive（UD-T2，spec §3.3）：被控桌面端 UI 驱动端点（ui/
  //  openSession|notify|openRoute）保留在协议面（face/无头端路由 + IPC
  //  通道注册）供外部/调试调用；HD-P2c/P3b 后控制端无 UI 消费者，
  //  ServerApi 封装方法已删（原 uiOpenSession 随 RemoteSessionPanel
  //  退役，语义被单 UI 主机切换取代）

  // —— 桥审批（TB-T2，spec §4.2）：主进程 write 门应答（本地通道） ——

  /**
   * 桥审批卡应答：命中消费返回 true；未知/已超时（迟到应答——主进程已
   * 按拒绝收敛并 respond）返回 false，调用方示 stale
   */
  static async bridgeDecision(
    requestId: string,
    approved: boolean,
  ): Promise<boolean> {
    return invoke<boolean>("server:bridgeDecision", { requestId, approved });
  }
}

/**
 * 订阅远程会话流式 chunk（server:chunk:<connId>:<sessionId>），返回卸载
 */
export function onRemoteChunk(
  connId: string,
  sessionId: number,
  listener: (chunk: ChatStreamChunk) => void,
): () => void {
  return on(`server:chunk:${connId}:${sessionId}`, (_, chunk) =>
    listener(chunk as ChatStreamChunk),
  );
}

/**
 * 订阅连接级合并事件（server:event:<connId>：server.connected /
 * session.updated / session.error，载荷 {type, payload}），返回卸载
 */
export function onRemoteEvent(
  connId: string,
  listener: (event: RemoteSessionEvent) => void,
): () => void {
  return on(`server:event:${connId}`, (_, event) =>
    listener(event as RemoteSessionEvent),
  );
}

/**
 * 桥审批请求载荷（TB-T2，spec §2.1 tool.request 同形——主进程 write 门
 * 经 server:bridgeApproval 推送渲染层）
 */
export type BridgeApprovalPayload = ToolRequestPayload;

/**
 * 订阅桥审批请求（TB-T2，spec §4.2）：主进程 bridge-executor write 门经
 * server:bridgeApproval 推送（广播通道无 connId——活动连接均可能触发），
 * 返回卸载
 */
export function onBridgeApproval(
  listener: (payload: ToolRequestPayload) => void,
): () => void {
  return on("server:bridgeApproval", (_, payload) =>
    listener(payload as ToolRequestPayload),
  );
}
