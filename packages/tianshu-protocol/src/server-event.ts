/**
 * 服务端协议事件与常量（RC-T1 收编单份）——原三处同构双写
 * （tianshu-server src/protocol/server-event.ts / mirror
 * electron/domains/server/protocol.ts / mirror server-face/face-events.ts）。
 *
 * **wire 口径（T7/T12 契约注记）**：事件 payload 的 updatedAt 一律 ISO
 * 字符串——SSE data / relay event 帧承载日期均为字符串，勿 new Date(str)
 * 假设时区（tianshu-server 仓内存态为 Date，序列化出口与本定义对齐）。
 *
 * server.connected 为连接级合成事件不进被控端事件总线（FaceEvent 不含
 * 它）：DirectTransport 来自 SSE 首帧；RelayTransport 无 SSE，连上后自动
 * GET info 合成同构事件（见 relay-transport.ts 头注释）。控制端
 * connections.ts 就地消化为连接态后仍经 eventSink 下发渲染层（重连全量
 * 刷新信号）。
 *
 * session.error 事件 ARCHIVED_SESSION 语义：无头端 202 受理后经事件回传，
 * 与 mirror 桌面端 5000 即拒有意分歧——spec §4 裁决 4。
 *
 * GA-T6 增两名无头端编排事件（spec §4.2，编排+自动化+webhook+定时归并
 * 单一 graph 能力域）：graph.run.updated（run 级状态流，state 投影枚举
 * 以 GA-T4 executor-runtime 投影为 wire 契约——run 表单一状态源
 * success|failed，aborted 为 user_aborted 的展示精化态；queued 保留给
 * 控制层队列语义，无头端不合成——run 生命周期从 running 起）与
 * automation.changed（任务级变更刷新信号，mirror AUTOMATION_CHANGED 全
 * 窗口广播语义 + 载荷提示；消费端一律以重拉列表为准）。
 *
 * TB-T1 增 tool.request（桌面工具桥，spec §2.1）：无头端遇桥工具
 * （browser 四件）回调控制端桌面执行——广播给全部活跃控制端连接（SSE
 * data / relay event 帧，现有通道零新传输）；requestId 一次性，多控制
 * 端并发时首个 respond 生效（spec §7.1）。仅无头端发布，不进 mirror
 * 桌面端被控面事件总线（FaceEvent 不含它——与 graph.run.updated 同侧）。
 *
 * TB-T3 增 BridgeToolResult（spec §2.2）：respond 端点 result 载荷——
 * 双仓（mirror bridge-executor / server bridge-registry+tool DTO）原先
 * 本地同形定义，上提单份（ruling 4）。
 */
import type { ChatStreamChunk } from "./chat-contract";
import type { BackupProgressPayload } from "./backup-contract";

/** P1 未读角标批（spec §1.2）：末条消息摘要 wire 契约——会话列表/详情
 *  与 session.updated 事件透传，移动端角标行渲染数据源。kind 优先级
 *  text > image > tool > empty（@tianshu/core summarizeLastMessage 产出口
 *  径）；image 的 text 恒空串（「[图片]」文案由消费端本地化） */
export interface SessionLastMessage {
  id: number;
  role: string;
  /** text=摘要文本（≤80 字符截断加省略号）/ image=空串 / tool=首个
   *  tool_call 的 toolName / empty=空串（无可摘要块） */
  kind: "text" | "image" | "tool" | "empty";
  text: string;
  /** ISO 字符串（wire 口径） */
  createdAt: string;
}

/** P1 未读角标批（spec §1.2）：session/read 响应——lastReadMessageId 为
 *  单调推进后的生效游标（请求 id 小于库内游标时不回退）；unreadCount 按
 *  生效游标现算（cursor 后 assistant 消息条数，NULL 游标=全计） */
export interface SessionReadResult {
  sessionId: number;
  lastReadMessageId: number;
  unreadCount: number;
}

/** 被控端事件总线事件（server.connected 除外——其为连接级合成帧；
 * graph.run.updated/automation.changed/tool.request 仅无头端发布，不进
 * mirror 桌面端被控面事件总线） */
export type FaceEvent =
  | {
      type: "session.updated";
      payload: {
        id: number;
        title: string | null;
        updatedAt: string;
        /** P1 未读角标批：未读数（查询期动态算，cursor 后 assistant 条数） */
        unreadCount: number;
        /** P1 未读角标批：末条消息摘要（无消息为 null） */
        lastMessage: SessionLastMessage | null;
      };
    }
  | {
      type: "message.chunk";
      payload: { sessionId: number; chunk: ChatStreamChunk };
    }
  | {
      type: "session.error";
      payload: { sessionId: number; code: string; message: string };
    }
  | {
      /** 移动端 CRUD 批（2026-10-27）：桌面被控面任务级变更信号（本地
       *  repo runNow 收口/scheduler/event-bus/face save·delete →
       *  change-bus → face 桥扇出）；与无头端 EventBus automation.changed
       *  同载荷——taskId 0 = 列表级刷新（tick 聚合多任务变更无单一 id） */
      type: "automation.changed";
      payload: AutomationChangedPayload;
    }
  | {
      /** 备份面批（2026-10-27）：桌面被控面备份进度帧——202 受理的
       *  backup/create 后台执行经此推进度；done=true 终态帧（error 携
       *  失败原因），移动端据此复位并重拉列表 */
      type: "backup.progress";
      payload: BackupProgressPayload;
    };

/** graph.run.updated 事件载荷（GA-T6；GA-T4 executor publishRunUpdated 同形） */
export interface GraphRunUpdatedPayload {
  runId: number;
  graphId: number;
  /** run 状态投影（wire 契约；aborted=failed+user_aborted 展示精化） */
  state: "queued" | "running" | "succeeded" | "failed" | "aborted";
  /** 终态 output（succeeded 时为最后成功节点完整输出） */
  output?: string;
  /** 终态错误聚合（run 表 error 同源） */
  error?: string;
  /** 节点级状态变化（run 级 state 恒 running） */
  progress?: { nodeId: string; nodeStatus: "running" | "success" | "failed" };
}

/** automation.changed 事件载荷（GA-T6）：taskId 必带；enabled/nextRunAt 仅
 * 在相应字段变化时携带（enabled 为启停端点预留——九端点面未列 toggle），
 * 缺席不表示字段未变——消费端以重拉列表为准（刷新信号语义） */
export interface AutomationChangedPayload {
  taskId: number;
  enabled?: boolean;
  /** ISO 字符串（wire 口径同头注释）；null = 不再调度（once 已跑完等） */
  nextRunAt?: string | null;
}

/** tool.request 事件载荷（TB-T1，spec §2.1）：桥工具执行请求——args 为
 * 桥工具 zod 校验后的参数原样（控制端按 tool 名分发到对应桌面工具） */
export interface ToolRequestPayload {
  /** 一次性请求 id：respond 端点匹配键（重复/未知应答 4005） */
  requestId: string;
  /** 发起桥调用的会话 id（控制端执行上下文/审计用）；图执行无会话传
   * null（2026-10-28 去会话化——桥窗与本地会话 tab 无关，null 照常执行） */
  sessionId: number | null;
  /** 桥工具名（首批 browser 四件——widget/file-window 等后续批再扩枚举） */
  tool:
    "browser_snapshot" | "browser_navigate" | "browser_click" | "browser_type";
  /** 工具参数（zod 校验后原样；快照类为空对象） */
  args: Record<string, unknown>;
}

/**
 * 桥工具执行结果（TB-T3 上提单份，spec §2.2）：控制端桌面执行完经
 * POST tool/respond 回传的 result 载荷（请求侧对应 ToolRequestPayload——
 * tool.request 事件出、tool/respond 端点入，同为桥 wire 契约）。
 * ok=true 携模型可见 output（错误文案也走 output 回喂的口径在控制端收敛）；
 * ok=false 携 error（控制端拒绝/审批超时/执行失败文案由控制端定义——
 * server 侧转「错误:」前缀回喂模型）。
 */
export type BridgeToolResult =
  { ok: true; output: string } | { ok: false; error: string };

/** 控制端事件全量（= FaceEvent ∪ 连接级合成 server.connected ∪ 无头端
 * 编排/桥事件） */
export type ServerEvent =
  | {
      type: "server.connected";
      payload: { instanceId: string; capabilities: string[] };
    }
  | FaceEvent
  | { type: "graph.run.updated"; payload: GraphRunUpdatedPayload }
  | { type: "automation.changed"; payload: AutomationChangedPayload }
  | { type: "tool.request"; payload: ToolRequestPayload };

/** 能力清单（无头端面，spec §3.1+§4.2：tianshu-server /info 与 relay
 * register 报此值；GA-T6 增 graph——编排/自动化/webhook/定时归并单一
 * 能力域，控制端据此渲染编排区；FA-T1 增 files——文件三端点
 * （list/read/uploadImage），控制端 caps.files 据此开文件面；
 * library 批增 library——资料库十七端点管理面（list/tree/search/recent/
 * favorites/新建/链接/重命名/移动/删除/收藏/读/读图/写内容），无头端
 * LibraryModule 全量实现，连接 capability 三上报点（info/event/relay）
 * 同引本常量自动携带） */
export const CAPABILITIES = [
  "chat",
  "provider",
  "graph",
  "files",
  "library",
  // MO 批（2026-10-27）：monitor/stats 只读聚合面——事件两表+三处埋点
  // （chat-runner/graph-executor/automation-runner）+端点已落；连接
  // capability 三上报点同引本常量自动携带
  "monitor",
] as const;

/** 被控桌面端能力（spec §6.1：mirror server-face 报此值——桌面端被控面
 * 无 graph/automation 端点（远程编排属无头端专属），勿与 CAPABILITIES
 * 混用；RC-T1 收编时二者同引用，GA-T6 拆分——桌面端保持 chat+provider，
 * 老断言（FACE_CAPABILITIES 与包常量同引用）改为与本常量同引用；
 * UD-T1 增 ui-drive：桌面被控端专属 UI 驱动三端点（ui/openSession|
 * notify|openRoute），无头端不报——与 graph 相反方向，协商语义双向覆盖；
 * FA-T2 增 files：文件三端点双侧同构（桌面被控面读写本机数据根）；
 * MCP 批增 mcp：连接器管理面（mcp/query|setEnabled——列表+启停，
 * 增删改引导桌面端）仅桌面被控端（mcpServer 表在此，无头端无 MCP
 * 概念不实现不报）；
 * A5 增 library：资料库读面+元数据写面（list/tree/search/recent/
 * favorites/新建/重命名/移动/删除/收藏/预览读）仅桌面被控端——无头端
 * 有表但管理写面全缺另批（同 A6 monitor 先例）；
 * A7 增 project：项目域读面+计划/资产写面（23 段）仅桌面被控端——无头端
 * 仅 Project/PlanItem 两表（AI 工具用），member/binding/view/attachment
 * 四表与模块全缺另批；
 * A2/A3/A4 增 skillhub：技能市场面走桌面被控端 SkillHubClient（宿主侧
 * 下载 zip 落盘，手机零流量）——无头端无 SkillHub 概念不报 */
export const DESKTOP_CAPABILITIES = [
  "chat",
  "provider",
  "ui-drive",
  "files",
  "mcp",
  "monitor", // A6 监控读面
  "library", // A5 资料库批
  "project", // A7 项目批
  "skillhub", // A3 技能市场批（宿主侧安装）
  // 移动端 CRUD 批（2026-10-27）：桌面 face 透出 automation 五段 +
  // graph/query 只读（选图面）——GA-T6「远程编排属无头端专属」的
  // automation 半边推翻；graph 能力仍不报（Graphs 段/图运行遥控
  // graph/run 等仍无头端专属，控制端按本能力字独立判定 automation 面）
  "automation",
  // 记忆进化批（2026-10-27）：memory 五端点（读写面+AI 操作）——桌面
  // 被控面专属（option 表存储+每晚调度在此），无头端不报
  "memory",
  // 备份面批（2026-10-27）：backup 三端点（遥控桌面备份客户端：触发/
  // 列表/删除代理）——桌面被控面专属，无头端不报（它是存储端）
  "backup",
] as const;

/** /info 端点结果形状（双侧被控端同构；username 为身份面增补——token
 * 是实例级非用户级，被控数据面实际归属的用户名单独透出：桌面 face =
 * user 表最新用户（resolveUserId 语义）、无头端 = 伴生用户 userId=1；
 * 旧被控端/伴生用户未建行时缺省或 null——控制端按未知显示） */
export interface RemoteInstanceInfo {
  name: string;
  version: string;
  instanceId: string;
  capabilities: string[];
  username?: string | null;
}

/**
 * 逻辑端点路径表（spec §3.1；值为无前导斜杠形态——与被控面 handleRoute
 * 的归一口径一致：HTTP "/session/query" 与 relay 帧 "session/query" 等
 * 价，直连 HTTP 实际请求由 transport 拼接 "/" 前缀与 base）。
 * 双端面合并表：provider/graph/automation/webhook 由 tianshu-server 提供
 * （mirror 被控面暂未实现该组端点）；ui/* 三段为桌面被控端专属（UD-T1，
 * 无头端不实现——capability 不报即控制端不可达，直连调用返回 404）；
 * webhook 两段带路径参数占位（POST 触发 / GET 任务状态，外部系统语义，
 * bearer 非业务 token）。graph 五段 + automation 四段为 GA-T6/T8 落地
 * 端点的补录（终审 Minor 5 清账）。tool 一段（TB）为无头端工具桥应答
 * 回传入口（POST tool/respond，与 ui/* 相反方向的无头端专属面——TB 终审
 * Minor 补录；值以 server tool.controller 实际路由为准）。
 */
export const ENDPOINTS = {
  info: "info",
  session: {
    create: "session/create",
    query: "session/query",
    getById: "session/getById",
    delete: "session/delete",
    update: "session/update",
    send: "session/send",
    regenerate: "session/regenerate",
    editAndResend: "session/editAndResend",
    abort: "session/abort",
    accessMode: "session/accessMode",
    usage: "session/usage",
    approve: "session/approve",
    // P1 未读角标批：已读游标单调推进（响应 SessionReadResult）
    read: "session/read",
    // A9 会话内工具批：compact 异步语义（202 受理后台执行，完成后
    // session.updated 事件刷新）；polish 同步 30s 超时（桌面 chat:polish
    // 同款 AbortSignal.timeout(30_000)）
    compact: "session/compact",
    polish: "session/polish",
  },
  provider: {
    query: "provider/query",
    save: "provider/save",
    delete: "provider/delete",
    test: "provider/test",
    fetchModels: "provider/fetchModels",
  },
  // A2 专家批（5 段新增，桌面被控面专属）：detail 归属校验全量透出；
  // save 单条 upsert 三态；marketList 概要无 systemPrompt，marketDetail
  // 按 slug 取单条全文（数据收编 @tianshu/core expert-market）
  assistant: {
    query: "assistant/query",
    detail: "assistant/detail",
    save: "assistant/save",
    delete: "assistant/delete",
    marketList: "assistant/marketList",
    marketDetail: "assistant/marketDetail",
    // A2 尾导入导出批：export 归属校验产 JSON 文本（builtin 同样可导——
    // 内容是用户可见的）；import 解析校验新建（重名 dedupeName 后缀）
    export: "assistant/export",
    import: "assistant/import",
  },
  // A8 工作空间管理批：create/update/delete 写面双端同批（无 bindDirectory
  // ——绑定目录留桌面端，spec §1.4）
  workspace: {
    query: "workspace/query",
    create: "workspace/create",
    update: "workspace/update",
    delete: "workspace/delete",
  },
  files: {
    list: "files/list",
    read: "files/read",
    uploadImage: "files/uploadImage",
  },
  // A3 技能批：setScenarios 场景打标 / uninstall 卸载（builtin 拒）；
  // skillhub 四段为市场面（宿主侧 SkillHubClient 转发，zip 不过手机）；
  // A3 尾：installUpload base64 zip 直装（≤3MB）/ stats 事件表聚合统计
  skills: {
    query: "skills/query",
    read: "skills/read",
    setEnabled: "skills/setEnabled",
    setScenarios: "skills/setScenarios",
    uninstall: "skills/uninstall",
    installUpload: "skills/installUpload",
    stats: "skills/stats",
  },
  // detail 批（2026-10-27）：hub /api/v1/skills/{slug} 详情透传——正文/
  //  统计/作者/安全归一，移动端详情页增广区消费
  skillhub: {
    list: "skillhub/list",
    top: "skillhub/top",
    categories: "skillhub/categories",
    install: "skillhub/install",
    detail: "skillhub/detail",
  },
  // A4 MCP 批：statuses 运行态透出 / save HTTP-only upsert（headers 掩码
  // 三态）/ delete / reconnect；detail 读面供编辑表单取数（stdio 仅摘要）
  mcp: {
    query: "mcp/query",
    setEnabled: "mcp/setEnabled",
    statuses: "mcp/statuses",
    save: "mcp/save",
    delete: "mcp/delete",
    reconnect: "mcp/reconnect",
    detail: "mcp/detail",
  },
  // A6：只读聚合面
  monitor: {
    stats: "monitor/stats",
  },
  // A5 资料库批：读面 + 元数据写面（桌面被控面专属）；read/readImage
  // 按 id 取内容——服务端校验归属后解析磁盘路径，DTO 不携带本机路径；
  // writeContent 为资料库编辑批新增内容写面（全量覆写，最后写赢）
  library: {
    list: "library/list",
    tree: "library/tree",
    search: "library/search",
    listRecent: "library/listRecent",
    listFavorites: "library/listFavorites",
    createFolder: "library/createFolder",
    createFile: "library/createFile",
    addLink: "library/addLink",
    rename: "library/rename",
    move: "library/move",
    delete: "library/delete",
    subtreeCount: "library/subtreeCount",
    toggleFavorite: "library/toggleFavorite",
    markViewed: "library/markViewed",
    read: "library/read",
    readImage: "library/readImage",
    // 资料库编辑批（spec 2026-10-26）：文本内容覆写——全量覆盖写，
    // ≤512KiB 对齐 read 口径；回传刷新 DTO（size/updatedAt）
    writeContent: "library/writeContent",
    // 资料库上传批（spec 2026-10-26）：移动端二进制入库——base64 原始
    // ≤3MB（skills installUpload 口径，relay 单帧 4MiB 余量）；落盘
    // {libraryDir}/{id}/{name}，fileType/mime 经扩展名分类表推断
    uploadFile: "library/uploadFile",
  },
  image: "image",
  // A10 审批记忆批：记忆管理五段双端同批（remembered=toolPermission 表
  // 读删；full=会话级运行态列表/清空）——permission 不在 sdk-contract
  // 自动覆盖组，无头端侧显式入册
  permission: {
    listRemembered: "permission/listRemembered",
    revokeRemembered: "permission/revokeRemembered",
    revokeAllRemembered: "permission/revokeAllRemembered",
    listFullGrants: "permission/listFullGrants",
    revokeAllFull: "permission/revokeAllFull",
  },
  // A7 项目批（23 段，桌面被控面专属）：project 六段 / planItem 十段 /
  // planView 只读一段（含懒播种语义）/ projectAsset 六段（readImage 服务端
  // 解析资产根，不泄物理布局）；文本预览复用 files/list|read
  project: {
    query: "project/query",
    getDetail: "project/getDetail",
    create: "project/create",
    update: "project/update",
    delete: "project/delete",
    listMembers: "project/listMembers",
  },
  planItem: {
    list: "planItem/list",
    listMine: "planItem/listMine",
    create: "planItem/create",
    update: "planItem/update",
    delete: "planItem/delete",
    move: "planItem/move",
    fieldsList: "planItem/fieldsList",
    attachmentList: "planItem/attachmentList",
    attachmentCreate: "planItem/attachmentCreate",
    attachmentDelete: "planItem/attachmentDelete",
  },
  planView: {
    list: "planView/list",
  },
  projectAsset: {
    list: "projectAsset/list",
    createFolder: "projectAsset/createFolder",
    rename: "projectAsset/rename",
    delete: "projectAsset/delete",
    storage: "projectAsset/storage",
    readImage: "projectAsset/readImage",
  },
  ui: {
    openSession: "ui/openSession",
    notify: "ui/notify",
    openRoute: "ui/openRoute",
  },
  graph: {
    query: "graph/query",
    save: "graph/save",
    delete: "graph/delete",
    run: "graph/run",
    runAbort: "graph/runAbort",
  },
  automation: {
    query: "automation/query",
    save: "automation/save",
    delete: "automation/delete",
    runNow: "automation/runNow",
    // 移动端 CRUD+运行历史批：分页运行历史（page/taskId?/status? 下推
    // 筛选；载荷 AutomationRunRecord 剔 graphTrace 精简面）
    runPage: "automation/runPage",
    // 移动端执行详情批：runId 查节点级执行详情（载荷
    // AutomationRunNodeRecord[]，graphRunNode 表透传；图 run 专有，
    // prompt run 恒空数组）
    runNodes: "automation/runNodes",
  },
  tool: {
    respond: "tool/respond",
  },
  // webhook 触发两段（外部系统语义，token 路径参数占位）：POST 触发 +
  // GET 任务状态查询（tianshu-server webhook.controller / mirror
  // webhook-server.ts 双端同构路由）；管理三段（WH 批 2026-10-27）：
  // 开启（重开换 token）/ 关闭 / 查询回显——业务语义受 TIANSHU_TOKEN
  // 守卫，逻辑路径带 graph/webhook/ 前缀避开 `/webhook/` 触发面守卫
  // 豁免前缀（token.guard 终审 F1）：管理面含 fullAccess 全权开关，
  // 落豁免前缀即匿名可达，安全裁定不可
  webhook: {
    trigger: "webhook/:token",
    jobStatus: "webhook/:token/jobs/:id",
    enable: "graph/webhook/enable",
    disable: "graph/webhook/disable",
    status: "graph/webhook/status",
  },
  // 备份面批（2026-10-27）：桌面被控面专属三端点——遥控桌面备份客户端
  // （打包上传它所配 direct 连接的无头端）；恢复不做；无头端自身的
  // /backup/* 六端点是存储服务面（BACKUP_TOKEN 守卫），不进本表
  backup: {
    list: "backup/list",
    create: "backup/create",
    delete: "backup/delete",
  },
  // 记忆进化批（2026-10-27）：桌面被控面专属五端点——记忆数据（option
  // 表）与每晚整理调度在桌面端，无头端不实现不报
  memory: {
    get: "memory/get",
    saveConfig: "memory/saveConfig",
    saveProfile: "memory/saveProfile",
    applyInstruction: "memory/applyInstruction",
    compile: "memory/compile",
  },
  // AR 批（2026-10-27）：本地产物三端点——桌面被控面专属（artifact 表
  // 只在桌面端；无头端不实现不报，移动端首 404 隐藏视图）
  artifact: {
    list: "artifact/list",
    toggleFavorite: "artifact/toggleFavorite",
    read: "artifact/read",
  },
} as const;

/** provider/delete 载荷（批量删除，与 save upsert 数组语义对称）：
 * providerIds 删除级联清其 models；modelIds 单删模型行 */
export interface ProviderDeleteParams {
  providerIds?: number[];
  modelIds?: number[];
}

/** provider/test 结果（两端实现口径：headless 轻探 /models 连通+鉴权，
 * desktop 被面桥本地模型对话测试——形状统一 ok/message，细节差异由
 * message 承载） */
export interface ProviderTestResult {
  ok: boolean;
  message: string;
}

/** provider/fetchModels 上游拉取项（OpenAI 兼容 /models 的 id 与可选
 * 展示名；导入时勾选转 provider/save 新建模型行） */
export interface RemoteUpstreamModel {
  modelId: string;
  name?: string;
}

/** provider/fetchModels 结果（连通失败是预期结果而非异常——结构化
 * success/errorCode 语义对齐 mirror 本地 listRemote） */
export interface ProviderFetchModelsResult {
  success: boolean;
  errorCode?: string;
  message: string;
  models: RemoteUpstreamModel[];
}

/** session/regenerate 载荷（messageId 缺省=最后一条 assistant 消息；
 * 删除该消息及之后全部，原位重跑其前最近一轮 user 输入——不新增 user 行） */
export interface SessionRegenerateParams {
  sessionId: number;
  messageId?: number;
}

/** session/update 载荷（重命名+模式切换——title/mode 至少一项；title
 * trim 非空、mode ∈ agent|ask|plan） */
export interface SessionUpdateParams {
  sessionId: number;
  title?: string;
  mode?: "agent" | "ask" | "plan";
  /** 归档切换（AL 批）：true=归档（只读），false=取消归档 */
  archived?: boolean;
  /** 置顶切换（LA 批）：true=置顶（列表前置），false=取消 */
  pinned?: boolean;
  /** 绑定专家切换（PM 批：＋菜单专家子菜单写会话；null=不使用助手） */
  assistantId?: number | null;
  /** 会话当前模型切换（HD 批：本地 session:setModel 持久同语义；写前
   *  校验存在性，null=清除回退链） */
  currentModelId?: number | null;
}

/** session/editAndResend 载荷：改写该 user 消息文本并删除其后全部，
 * 原位重跑（mirror ChatService.editAndResend 同语义） */
export interface SessionEditResendParams {
  sessionId: number;
  messageId: number;
  content: string;
}

/** session/compact 载荷（A9 会话内工具批）：异步语义对齐 send 先例——
 * POST 202 受理后台执行，完成后被控端 publish session.updated（enriched
 * 口径），控制端订阅后重拉 getById 刷新压缩态；执行语义桌面 golden：
 * 清旧压缩态 → 压缩指令走普通轮 → 末条 assistant 文本回填
 * summary/compactedUpToId；中止不回填 */
export interface SessionCompactParams {
  sessionId: number;
}

/** session/polish 润色风格（桌面 PolishStyle 同三值——wire 契约单份，
 * 渲染层 PolishStyle 与之为双向可赋值 witness） */
export type SessionPolishStyle = "professional" | "concise" | "translate-en";

/** session/polish 载荷（A9 会话内工具批）：一次性非流式补全，不落库不建
 * 会话；workspaceId 缺省时按被控端默认空间解析（桌面被控端 = 用户默认
 * 工作空间，无头端 = 伴生用户最近空间）；同步 30s 超时对齐桌面
 * AbortSignal.timeout(30_000)，超时走 5000 业务错 */
export interface SessionPolishParams {
  workspaceId?: number;
  text: string;
  style: SessionPolishStyle;
}

/** session/polish 结果：改写后文本 */
export interface SessionPolishResult {
  text: string;
}

/** 会话权限模式（session/accessMode；server PermissionStore / 本地
 * ChatService 同枚举） */
export type SessionAccessMode = "default" | "full";

/** session/usage 结果（上下文用量五类拆解——本地 ContextUsageBreakdown
 * 同构；未配模型/会话缺失为 null 前端灰态） */
export interface SessionUsageBreakdown {
  system: number;
  tools: number;
  messages: number;
  mcp: number;
  skills: number;
  total: number;
  contextWindow: number | null;
}

/** skills/query 列表项（联想候选＋启停管理子菜单；enabled=全局启停） */
export interface RemoteSkillBrief {
  name: string;
  description?: string | null;
  enabled?: boolean;
}

/** mcp/query 列表项（MCP 批——移动端连接器管理面：列表+启停，增删改
 * 引导桌面端；transport=stdio|http 形态标识，command/url 摘要展示用，
 * 敏感字段（env/headers）不外露） */
export interface RemoteMcpBrief {
  id: number;
  name: string;
  transport: string;
  command?: string | null;
  url?: string | null;
  enabled: boolean;
}

/** mcp/setEnabled 载荷（MCP 批） */
export interface McpSetEnabledParams {
  id: number;
  enabled: boolean;
}

/** workspace/query 列表项（被控端工作空间概要——单 UI 远程态侧栏分组树；
 * icon/审计字段/writeApprovedAt/projectId 不外露） */
export interface RemoteWorkspaceBrief {
  id: number;
  name: string;
  /** 绑定目录（桌面被控端显式绑定；无头端沙箱目录） */
  directoryPath?: string | null;
  /** 空间默认模型（库内行 id——模型回退链/hasModel 判定用） */
  defaultModelId?: number | null;
}

/** skills/setEnabled 载荷（＋菜单技能子菜单多选切换——server
 * skillRecord.enabled 过滤口径，禁用对模型=不存在） */
export interface SkillSetEnabledParams {
  name: string;
  enabled: boolean;
}

/** skills/read 结果（技能全文——发送前并入消息文本，本地 token 机制同构） */
export interface RemoteSkillContent {
  content: string;
}

/** assistant/query 列表项（被控端专家概要——发送时 assistantId 选用） */
export interface AssistantBrief {
  id: number;
  name: string;
  description?: string | null;
  /** 专家 icon（emoji；消息流头像列显示） */
  icon?: string | null;
  /** 提示词胶囊（≤3 条；空会话输入区上方展示，点击填草稿） */
  quickPrompts?: string[] | null;
}

/** files/read 结果（守卫读取文本——512KB 上限/NUL 二进制判定在被控端，
 *  mirror file:readWorkspaceFile 同口径） */
export interface RemoteFileContent {
  content: string;
}

/** files/uploadImage 入参（控制端 base64 上行——≤3MB 解码前，relay 单帧
 *  4MiB 余量；落被控端数据根 attachments/） */
export interface RemoteFileUploadInput {
  workspaceId?: number;
  name: string;
  base64: string;
}

/** files/uploadImage 结果（被控端数据根相对路径——sessionSend images
 *  与 ImageBlock.imagePath 消费同值，远端引擎 loadImage 回喂零适配） */
export interface RemoteFileUploadResult {
  imagePath: string;
}
