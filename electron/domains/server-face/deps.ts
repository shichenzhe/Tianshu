// 被控面依赖装配点（server-face spec §6.2）：routes.handleRoute 消费的
// service 桥。Application 构造期注入既有单例（SessionRepository /
// ChatService——send 签名零改动，被控面经 chat.send(params, userId,
// undefined) 无头调用）；测试注入内存替身。userId 取 user 表首个（被控面
// 单用户语义，webhook-server 的 workspace 取法同款先例——handleUser 的
// token 解析在无渲染层请求的 HTTP/WS 面不可用）。
import type {
  SessionCreateParams,
  SessionRecord,
  MessageRecord,
} from "../../../src-react/domains/ai/api/session.api";
import type { ServerFaceArtifactWire } from "./artifact-tap";
import type {
  ChatSendParams,
  PolishStyle,
} from "../../../src-react/domains/ai/api/chat.api";
import type {
  AssetEntryDto,
  AssetStorageDto,
  AssistantDetailResult,
  AssistantSavePayload,
  ExpertExportResult,
  ExpertImportPayload,
  ExpertImportResult,
  ExpertMarketDetail,
  ExpertMarketSummary,
  ImagePayload,
  LibraryItemDto,
  LibraryListResult,
  LibraryReadImageResult,
  LibraryReadResult,
  LibraryUploadFilePayload,
  McpDetailResult,
  McpSavePayload,
  McpStatusItemDto,
  MonitorScene,
  MonitorStats,
  PermissionFullGrantItem,
  PermissionFullGrantsResult,
  PermissionRememberedItem,
  PermissionRevokeResult,
  PlanFieldDefDto,
  PlanItemAttachmentRecordDto,
  PlanItemCreatePayload,
  PlanItemMovePayload,
  PlanItemRecordDto,
  PlanItemUpdatePayload,
  PlanViewRecordDto,
  ProjectCreatePayload,
  ProjectDetailResult,
  ProjectMemberItemDto,
  ProjectRecordDto,
  ProjectUpdatePayload,
  ProviderSavePayload,
  RemoteSkillBrief,
  RemoteWorkspaceBrief,
  SkillBriefExtension,
  SkillHubCategoryDto,
  SkillHubDetailDto,
  SkillHubListPayload,
  SkillHubPageDto,
  SkillHubSkillDto,
  SkillInstallResultDto,
  SkillScenario,
  SkillStatItem,
  SkillsInstallUploadPayload,
  WorkspaceSavePayload,
} from "@tianshu/protocol";
import type {
  AutomationRunPage,
  AutomationRunRecord,
  BackupMeta,
  GraphRecord,
  MemoryServiceResult,
  MemoryState,
  TaskRecord,
} from "@tianshu/protocol";
import type { TaskCreateParams } from "../../../src-react/domains/ai/automation/api/automation.api";
import type { McpRepository } from "../ai/mcp/mcp.repo";
import type { SessionReadResult } from "@tianshu/protocol";
import type {
  SessionQueryPage,
  SessionQueryParams,
  SessionSummaryRecord,
} from "../ai/chat/session.repo";

/** 会话仓储原始行结构子集（SessionRow 满足；send 预检/详情回读用） */
export interface SessionBriefRow {
  id: number;
  userId: number | null;
  title: string;
  archivedAt: Date | null;
  updatedAt: Date;
}

/** sessions 仓储结构子集（SessionRepository 满足，方法逐一对应） */
export interface ServerFaceSessions {
  getSession(id: number): Promise<SessionBriefRow | null>;
  createSession(p: SessionCreateParams, userId: number): Promise<SessionRecord>;
  listAllSessions(userId: number): Promise<SessionRecord[]>;
  /** P1 未读角标批：enriched 列表（末条摘要+未读数动态算） */
  listAllSessionsSummarized(userId: number): Promise<SessionSummaryRecord[]>;
  /** face 全表扫描优化批：session/query 数据源——条件下推 + DB 分页仅当前
   *  页 enrich（keyword 大小写敏感内存过滤契约同无头端，语义与
   *  tianshu-server session.repository.query 对齐） */
  querySessions(
    params: SessionQueryParams,
    userId: number,
  ): Promise<SessionQueryPage>;
  /** P1 未读角标批：单行 enriched 摘要（不存在/他人会话返回 null） */
  getSessionSummary(
    id: number,
    userId: number,
  ): Promise<SessionSummaryRecord | null>;
  /** P1 未读角标批：已读游标单调推进（SessionRepository.markSessionRead） */
  markSessionRead(
    sessionId: number,
    messageId: number,
    userId: number,
  ): Promise<SessionReadResult>;
  getSessionById(id: number, userId: number): Promise<SessionRecord>;
  deleteSession(id: number, userId: number): Promise<void>;
  /** 重命名（远控台 session/update 桥） */
  renameSession(id: number, title: string, userId: number): Promise<void>;
  /** 模式切换（agent|ask|plan；session/update 扩展桥——CU 批） */
  setMode(
    id: number,
    mode: "agent" | "ask" | "plan",
    userId: number,
  ): Promise<void>;
  /** 归档切换（AL 批：SessionRepository.archiveSession 桥） */
  archiveSession(id: number, archived: boolean, userId: number): Promise<void>;
  /** 置顶切换（LA 批：SessionRepository.pinSession 桥） */
  pinSession(id: number, pinned: boolean, userId: number): Promise<void>;
  /** 绑定专家（PM 批：＋菜单专家子菜单写会话；SessionRepository 同名） */
  setSessionAssistant(
    id: number,
    assistantId: number | null,
    userId: number,
  ): Promise<void>;
  /** 会话当前模型（HD 批：本地 session:setModel 持久同语义桥） */
  setSessionModel(
    id: number,
    modelId: number | null,
    userId: number,
  ): Promise<void>;
  listMessages(
    sessionId: number,
    userId: number,
    opts?: { beforeId?: number; limit?: number },
  ): Promise<{
    items: MessageRecord[];
    hasMore: boolean;
    nextBeforeId: number | null;
  }>;
}

/** chat 服务结构子集（ChatService 满足；send 第三参 sender 可选） */
export interface ServerFaceChat {
  send(
    params: ChatSendParams,
    userId: number,
    sender?: undefined,
  ): Promise<void>;
  /** 重新生成（ChatService 实现；sender 走 undefined——被控面无渲染层） */
  regenerate(
    sessionId: number,
    userId: number,
    messageId?: number,
    sender?: undefined,
  ): Promise<void>;
  /** 编辑重发（CU 批桥本地 ChatService.editAndResend） */
  editAndResend(
    sessionId: number,
    userId: number,
    messageId: number,
    content: string,
    sender?: undefined,
  ): Promise<void>;
  /** 会话压缩（A9 批：/compact 无头版——清旧压缩态 → 摘要指令走普通轮 →
   *  末条 assistant 文本回填 summary/compactedUpToId；中止不回填；异步
   *  语义由路由层 setImmediate 保证，与 send 桥同构） */
  compact(sessionId: number, userId: number, sender?: undefined): Promise<void>;
  /** 落地页润色（A9 批：一次性非流式补全，30s 超时语义在 service 内
   *  AbortSignal.timeout(30_000)；不落库不建会话） */
  polish(
    p: { workspaceId: number; text: string; style: PolishStyle },
    userId: number,
  ): Promise<{ text: string }>;
  /** 上下文用量拆解（AL 批：chat:usage 同口径五类估算） */
  getUsageBreakdown(sessionId: number, userId: number): Promise<unknown>;
  /** 会话工具权限（CU 批：归属校验同 IPC 口径） */
  getAccessMode(sessionId: number, userId: number): Promise<"default" | "full">;
  setAccessMode(
    sessionId: number,
    mode: "default" | "full",
    userId: number,
  ): Promise<void>;
  stop(sessionId: number): void;
  /** 审批应答（T2）：不匹配 pending 返 false（session/approve 转发） */
  respondApproval(toolCallId: string, approved: boolean): boolean;
  /** 审批应答（可选记住——审批记住批）：归属校验+记忆先落在本方法内
   *  收口；remembered=false = 未请求记忆 / 拒绝 / toolName 未上送 /
   *  会话无工作空间 */
  respondApprovalRemember(
    sessionId: number,
    toolCallId: string,
    approved: boolean,
    userId: number,
    remember: boolean,
    toolName: string | null,
  ): Promise<{ hit: boolean; remembered: boolean }>;
  /** A10 审批记忆面数据源（ChatService 五方法 A10 批提 public；归属过滤/
   *  单条幂等 no-op 语义内聚 service——permission-tap 只信封 DTO） */
  listRemembered(userId: number): Promise<PermissionRememberedItem[]>;
  revokeRemembered(id: number, userId: number): Promise<void>;
  /** 返回实际撤销条数（桌面 IPC 忽略返回值；被控面回 {revoked}） */
  revokeAllRemembered(userId: number): Promise<number>;
  listFullGrants(): Promise<PermissionFullGrantItem[]>;
  revokeAllFull(): number;
}

/** 审批应答桥（ChatService.respondApprovalRemember 满足——审批记住批：
 *  remember 时归属校验+记忆先落在 ChatService 内收口；remembered=false =
 *  未请求记忆 / 拒绝 / toolName 未上送 / 会话无工作空间） */
export interface ServerFaceApprovals {
  respondRemember(
    sessionId: number,
    toolCallId: string,
    approved: boolean,
    userId: number,
    remember: boolean,
    toolName: string | null,
  ): Promise<{ hit: boolean; remembered: boolean }>;
}

/** A10 审批记忆面桥（permission 五段数据源——spec 2026-10-26 §1.2）：
 *  remembered 面归属过滤/单条幂等 no-op 内聚 ChatService；full 面为全局
 *  运行态（与 IPC 全局通道同口径，收回属收紧无泄露面）；revokeAll 两
 *  返回实际撤销条数（桌面 IPC 返 void，被控面增强 spec §1.1） */
export interface ServerFacePermissions {
  listRemembered(userId: number): Promise<PermissionRememberedItem[]>;
  /** 单条撤销：不存在/非本人幂等成功返 null（桌面既定语义，无 NOT_FOUND） */
  revokeRemembered(userId: number, id: number): Promise<null>;
  revokeAllRemembered(userId: number): Promise<PermissionRevokeResult>;
  listFullGrants(userId: number): Promise<PermissionFullGrantsResult>;
  revokeAllFull(userId: number): Promise<PermissionRevokeResult>;
}

/** 模型配置桥（provider/query|delete|test|fetchModels 数据源） */
export interface ServerFaceProviders {
  listBundle(userId: number): Promise<{
    providers: unknown[];
    models: unknown[];
  }>;
  /** 批量删除：providerIds 级联清 models；modelIds 单删（归属内判定） */
  deleteProviders(ids: number[], userId: number): Promise<void>;
  deleteModels(ids: number[], userId: number): Promise<void>;
  /** 上游模型清单拉取（结构化结果——连通失败为预期结果非异常） */
  listRemote(
    providerId: number,
    userId: number,
  ): Promise<{
    success: boolean;
    errorCode?: string;
    message: string;
    models: Array<{ modelId: string; name?: string }>;
  }>;
  /** A1 批写面：批量 upsert（掩码防回写语义在 ipc.ts 桥实现；顺序应用无
      事务——spec §1.2 差异声明；成功返回脱敏 bundle） */
  save(
    payload: ProviderSavePayload,
    userId: number,
  ): Promise<{ providers: unknown[]; models: unknown[] }>;
}

/** 专家面桥（assistant/query 数据源——远控台会话选专家；A2 批扩 detail/
 *  save/delete 写面与 marketList/marketDetail 市场静态数据——tap 在
 *  expert-tap.ts，归属校验/内置守卫/三态语义内聚） */
export interface ServerFaceAssistants {
  list(
    userId: number,
  ): Promise<Array<{ id: number; name: string; description?: string }>>;
  /** A2：归属校验详情（systemPrompt/专家团全量透出——用户私有内容无掩码；
   *  不存在/越权 ASSISTANT_NOT_FOUND） */
  detail(userId: number, id: number): Promise<AssistantDetailResult>;
  /** A2：单条 upsert（字段三态 undefined 保留/null 清空；不传 members/
   *  expertType 保留原值；内置拒改名 ASSISTANT_BUILTIN） */
  save(
    userId: number,
    payload: AssistantSavePayload,
  ): Promise<AssistantDetailResult>;
  /** A2：删除（内置拒删 ASSISTANT_BUILTIN） */
  remove(userId: number, id: number): Promise<void>;
  /** A2：市场概要清单（无 systemPrompt——不全量下发长 prompt） */
  marketList(): Promise<ExpertMarketSummary[]>;
  /** A2：市场单条全文（slug 定位；不存在 EXPERT_MARKET_NOT_FOUND） */
  marketDetail(slug: string): Promise<ExpertMarketDetail>;
  /** A2 尾：导出 JSON 文本（归属校验；builtin 同样可导——纯内容面零路径） */
  export(userId: number, id: number): Promise<ExpertExportResult>;
  /** A2 尾：导入 JSON 文本（parse 失败/缺 name/kind 不符 ASSISTANT_INVALID；
   *  重名 dedupeName 后缀；members 随团 JSON 透传） */
  import(
    userId: number,
    payload: ExpertImportPayload,
  ): Promise<ExpertImportResult>;
}

/** 技能面桥（AL 批：skills/query|read 数据源——联想候选+读全文；A3 批
 *  list 契约扩展 scenarios/source/builtin 可选段——协议 SkillBriefExtension
 *  与 RemoteSkillBrief 交集消费，既有三字段消费方不受影响） */
export interface ServerFaceSkills {
  list(userId: number): Promise<Array<RemoteSkillBrief & SkillBriefExtension>>;
  read(userId: number, name: string): Promise<{ content: string }>;
  /** 启停切换（PM 批：SkillRepository.setEnabled 桥） */
  setEnabled(userId: number, name: string, enabled: boolean): Promise<unknown>;
  /** A3：场景三值打标（SKILL_SCENARIOS 白名单过滤；不存在 SKILL_NOT_FOUND） */
  setScenarios(
    userId: number,
    name: string,
    scenarios: SkillScenario[],
  ): Promise<unknown>;
  /** A3：卸载（builtin 拒 SKILL_BUILTIN；skillsDir 边界守卫 repo 自带） */
  uninstall(userId: number, name: string): Promise<unknown>;
  /** A3 尾：base64 zip 直装（≤3MB 服务端校验；冲突/覆盖口径同本地 zip
   *  导入；包不合法 SKILL_UPLOAD_INVALID） */
  installUpload(
    userId: number,
    payload: SkillsInstallUploadPayload,
  ): Promise<SkillInstallResultDto>;
  /** A3 尾：skillStat 事件表聚合统计（usedCount 全事件合计；无事件
   *  lastUsedAt null） */
  stats(userId: number): Promise<SkillStatItem[]>;
}

/** A3 批 skillhub 技能市场面（可选——宿主侧下载 zip 落盘安装，手机零流量；
 *  远端不可用/安装失败 SKILLHUB_UNAVAILABLE；能力位 DESKTOP_CAPABILITIES
 *  「skillhub」广告，无头端不报、移动端市场区降级隐藏） */
export interface ServerFaceSkillHub {
  list(params: SkillHubListPayload): Promise<SkillHubPageDto>;
  top(): Promise<SkillHubSkillDto[]>;
  categories(): Promise<SkillHubCategoryDto[]>;
  install(slug: string, overwrite: boolean): Promise<SkillInstallResultDto>;
  detail(slug: string): Promise<SkillHubDetailDto>;
}

/** 图片读取桥（image 端点数据源；不可读返回 null） */
export interface ServerFaceImages {
  readImage(imagePath: string): Promise<ImagePayload | null>;
}

export interface ServerFaceInfo {
  name: string;
  version: string;
  instanceId: string;
  capabilities: string[];
  /** 身份面：被控数据归属用户名（token 实例级非用户级——单独透出；
   *  库空/查询失败 null，控制端按未知显示） */
  username: string | null;
}

/** 工作空间面桥（workspace/query 数据源，HD-A1：单 UI 远程态侧栏分组树） */
export interface ServerFaceWorkspaces {
  /** 用户空间概要列表（id/name/directoryPath/defaultModelId） */
  list(userId: number): Promise<
    Array<{
      id: number;
      name: string;
      directoryPath: string | null;
      defaultModelId: number | null;
    }>
  >;
  /** A8 写面（可选——deps.workspaceRepo 在则装配，缺省报未装配）：
   *  新建（name 必填；概要四字段回传，不带 directoryPath 写面） */
  create?(
    userId: number,
    payload: WorkspaceSavePayload,
  ): Promise<RemoteWorkspaceBrief>;
  /** 更新（id 必填归属校验；name/icon/defaultModelId 全量字段传） */
  update?(
    userId: number,
    payload: WorkspaceSavePayload & { id: number },
  ): Promise<RemoteWorkspaceBrief>;
  /** 删除（硬级联：消息→会话→工作空间行，不删磁盘；返回 null） */
  remove?(userId: number, id: number): Promise<void>;
}

/** 连接器面桥（MCP 批——移动端连接器管理面：mcpServer 表列表+启停，
 *  增删改不在被控面（引导桌面端）；敏感字段（env/headers）不透出） */
export interface ServerFaceMcps {
  list(userId: number): Promise<
    Array<{
      id: number;
      name: string;
      transport: string;
      command: string | null;
      url: string | null;
      enabled: boolean;
    }>
  >;
  setEnabled(id: number, enabled: boolean, userId: number): Promise<void>;
  /** A4：运行态（McpManager 状态聚合——state/toolCount/error） */
  statuses(userId: number): Promise<McpStatusItemDto[]>;
  /** A4：HTTP-only 单条 upsert（url 必须 http(s) MCP_INVALID；stdio 类型
   *  一律拒 MCP_STDIO_FORBIDDEN；headers 掩码三态 fail-closed） */
  save(payload: McpSavePayload, userId: number): Promise<McpDetailResult>;
  /** A4：删除（不存在/越权 MCP_NOT_FOUND） */
  remove(id: number, userId: number): Promise<void>;
  /** A4：重连（不存在/越权 MCP_NOT_FOUND） */
  reconnect(id: number, userId: number): Promise<void>;
  /** A4：详情（stdio 仅摘要不回 args/env；HTTP args 透传，env/headers 恒掩码） */
  detail(id: number, userId: number): Promise<McpDetailResult>;
}

/** files 面结构子集（FA-T2 文件三端点桥——files-tap createFilesFace 注入） */
export interface ServerFaceFiles {
  /** workspace 相对路径清单（@ 联想；归属校验内部完成） */
  list(userId: number, workspaceId: number): Promise<string[]>;
  /** 守卫读取（512KB/NUL；越界/守卫拒绝抛 FaceFilesError 稳定码） */
  read(
    userId: number,
    workspaceId: number,
    relPath: string,
  ): Promise<{ content: string }>;
  /** 图片上传（≤3MB；落数据根 attachments/ 返回 appDataHome 相对路径） */
  uploadImage(input: {
    name: string;
    base64: string;
  }): Promise<{ imagePath: string }>;
}

/** AR 批本地产物面数据源（SessionRepository 结构子集——face 经
 * artifact-tap 包装为 wire 面：list 剔 path / read 转协议联合） */
export interface ServerFaceArtifact {
  listArtifacts(userId: number): Promise<
    Array<{
      path: string;
      relPath: string;
      name: string;
      fileType: string;
      workspaceId: number;
      workspaceName: string;
      sessionId: number;
      sessionTitle: string;
      writtenAt: string;
      size: number;
      favorite: boolean;
    }>
  >;
  toggleArtifactFavorite(
    userId: number,
    workspaceId: number,
    relPath: string,
  ): Promise<boolean>;
  readWorkspaceFileById(
    workspaceId: number,
    relPath: string,
    userId: number,
  ): Promise<unknown>;
}

/** A5 资料库面桥（library 十八端点数据源；read/readImage 服务端解析磁盘
 *  路径——DTO 不携带本机路径，注入 LibraryRepository 单实例） */
export interface ServerFaceLibrary {
  /** 单层列表 + 祖先链面包屑（parentId=null 根层） */
  list(userId: number, parentId: number | null): Promise<LibraryListResult>;
  tree(userId: number): Promise<LibraryItemDto[]>;
  search(userId: number, keyword: string): Promise<LibraryItemDto[]>;
  listRecent(userId: number): Promise<LibraryItemDto[]>;
  listFavorites(userId: number): Promise<LibraryItemDto[]>;
  createFolder(
    userId: number,
    name: string,
    parentId: number | null,
  ): Promise<LibraryItemDto>;
  createFile(
    userId: number,
    name: string,
    parentId: number | null,
  ): Promise<LibraryItemDto>;
  addLink(
    userId: number,
    url: string,
    title: string | null,
    parentId: number | null,
  ): Promise<LibraryItemDto>;
  rename(userId: number, id: number, name: string): Promise<LibraryItemDto>;
  /** targetParentId=null 移到根（自身/后代目标 repo 循环防护拒绝） */
  move(
    userId: number,
    ids: number[],
    targetParentId: number | null,
  ): Promise<null>;
  delete(userId: number, ids: number[]): Promise<null>;
  /** 子树内容数（删除确认提示用） */
  subtreeCount(userId: number, id: number): Promise<number>;
  toggleFavorite(userId: number, id: number): Promise<LibraryItemDto>;
  markViewed(userId: number, id: number): Promise<LibraryItemDto>;
  /** 文本只读预览（512KB/NUL 守卫在 tap——LIBRARY_* 稳定码透传） */
  read(userId: number, id: number): Promise<LibraryReadResult>;
  /** 图片预览（mime 白名单 + 10MB 守卫在 tap） */
  readImage(userId: number, id: number): Promise<LibraryReadImageResult>;
  /** 文本内容全量覆写（资料库编辑批：≤512KiB 守卫 + 写盘失败
   *  LIBRARY_WRITE_FAILED 在 tap；回传刷新 DTO size/updatedAt） */
  writeContent(
    userId: number,
    id: number,
    content: string,
  ): Promise<LibraryItemDto>;
  /** 二进制上传入库（资料库上传批：≤3MB/坏 base64/非法文件名守卫在 tap——
   *  LIBRARY_UPLOAD_INVALID；parentId 缺省根层；源记 "upload"，分类推断在
   *  repo；归属拒沿用 LIBRARY_NOT_FOUND） */
  uploadFile(
    userId: number,
    payload: LibraryUploadFilePayload,
  ): Promise<LibraryItemDto>;
}

/** A7 项目面桥（project 六端点数据源——hub 列表/详情/新建/编辑/删除/成员；
 *  Repository 级聚合不拆（资产空间/会话/成员生命周期）；list 仅 owner 项目、
 *  getDetail/listMembers owner 或成员可见，校验在 repo 自带） */
export interface ServerFaceProject {
  query(userId: number): Promise<ProjectRecordDto[]>;
  /** 详情只带 sessionId（不泄完整 SessionRecord——聊天形状不耦合） */
  getDetail(userId: number, id: number): Promise<ProjectDetailResult>;
  /** 载荷无 ownerId（身份唯一来源 withUserId；repo 以 token 用户为准） */
  create(
    userId: number,
    payload: ProjectCreatePayload,
  ): Promise<ProjectRecordDto>;
  update(userId: number, payload: ProjectUpdatePayload): Promise<void>;
  remove(userId: number, id: number): Promise<void>;
  listMembers(
    userId: number,
    projectId: number,
  ): Promise<ProjectMemberItemDto[]>;
}

/** A7 计划事项面桥（planItem 十端点数据源——计划/任务双视图 + 字段定义
 *  只读 + 附件关联三端点；userId 校验与枚举/成员资格校验在 repo 自带） */
export interface ServerFacePlanItem {
  list(userId: number, projectId: number): Promise<PlanItemRecordDto[]>;
  listMine(userId: number): Promise<PlanItemRecordDto[]>;
  /** 载荷无 createdById（身份唯一来源 withUserId） */
  create(
    userId: number,
    payload: PlanItemCreatePayload,
  ): Promise<PlanItemRecordDto>;
  update(userId: number, payload: PlanItemUpdatePayload): Promise<void>;
  remove(userId: number, id: number): Promise<void>;
  move(userId: number, payload: PlanItemMovePayload): Promise<void>;
  listFields(userId: number, projectId: number): Promise<PlanFieldDefDto[]>;
  listAttachments(
    userId: number,
    planItemId: number,
  ): Promise<PlanItemAttachmentRecordDto[]>;
  createAttachment(
    userId: number,
    planItemId: number,
    input: { fileName: string; assetPath: string },
  ): Promise<PlanItemAttachmentRecordDto>;
  removeAttachment(userId: number, id: number): Promise<void>;
}

/** A7 计划视图面桥（planView 只读 list——含懒播种语义；Repository 历史
 *  裸暴露无 userId，可见性守卫在 tap 层经 projectRepo.assertProjectVisible
 *  补齐——漏一面即越权，spec §4 风险面） */
export interface ServerFacePlanView {
  list(userId: number, projectId: number): Promise<PlanViewRecordDto[]>;
}

/** A7 项目资产面桥（projectAsset 六端点数据源——目录浏览/建夹/重命名/
 *  删除/用量/图片预览；Repository 历史裸暴露无 userId，可见性守卫同
 *  planView 在 tap 层补齐；路径越界 safeJoin 终防在 repo） */
export interface ServerFaceProjectAsset {
  /** path 缺省/空串 = 资产根层 */
  list(
    userId: number,
    projectId: number,
    path?: string,
  ): Promise<AssetEntryDto[]>;
  /** 返回服务端去重后的最终目录名 */
  createFolder(
    userId: number,
    projectId: number,
    parentPath: string,
    name: string,
  ): Promise<string>;
  /** 返回服务端去重后的最终名 */
  rename(
    userId: number,
    projectId: number,
    path: string,
    newName: string,
  ): Promise<string>;
  remove(userId: number, projectId: number, path: string): Promise<void>;
  storage(userId: number, projectId: number): Promise<AssetStorageDto>;
  /** 图片预览：服务端解析资产根 + mime 白名单 + 10MB（不泄物理布局） */
  readImage(
    userId: number,
    projectId: number,
    path: string,
  ): Promise<LibraryReadImageResult>;
}

/** 分页列表壳（无头端 starter QueryResult 同形——records 命名以移动端
 *  消费为准，face 侧桥桌面全量列表时切片包装） */
export interface ServerFacePage<T> {
  page: number;
  pageSize: number;
  records: T[];
  total: number;
}

/** 移动端 CRUD 批 automation 面（automation-tap 注入；与无头端
 *  AutomationController 五端点同构——query/save/delete/runNow/runPage） */
export interface ServerFaceAutomation {
  /** 分页 + keyword 名称内存过滤（无头端 service.query 同语义） */
  query(
    page: number,
    pageSize: number,
    keyword: string | undefined,
    userId: number,
  ): Promise<ServerFacePage<TaskRecord>>;
  /** 全量 upsert：id 携带即更新；enabled 显式携带且与现值不同才写
   *  （无头端 Ruling 12/14 同语义——控制端启停走 save 全量） */
  save(
    payload: {
      id?: number;
      enabled?: boolean;
    } & TaskCreateParams,
    userId: number,
  ): Promise<TaskRecord>;
  /** 批量删除（run 级联）；逐实删 id 发 automation.changed */
  delete(ids: number[], userId: number): Promise<void>;
  /** 202 受理：触发即返回；收尾经 automation.changed（repo runNow
   *  finally → change-bus → face 事件桥） */
  runNow(id: number, userId: number): Promise<void>;
  /** 运行历史分页（wire AutomationRunRecord 剔 graphTrace） */
  runPage(
    page: number,
    taskId: number | undefined,
    status: AutomationRunRecord["status"] | undefined,
    userId: number,
  ): Promise<AutomationRunPage>;
}

/** graph 只读面（automation 创建/编辑选图用；QueryResult 同形壳） */
export interface ServerFaceGraphsReadonly {
  query(
    page: number,
    pageSize: number,
    keyword: string | undefined,
    userId: number,
  ): Promise<ServerFacePage<GraphRecord>>;
}

/** 备份面批 backup 面（backup-tap 注入；桌面被控面专属三端点——遥控
 *  桌面备份客户端；create 202 受理，进度/终态经 backup.progress 事件） */
export interface ServerFaceBackup {
  list(): Promise<BackupMeta[]>;
  /** 202 受理：后台打包+上传（进度经事件流；终态 done 帧收敛） */
  create(note: string | undefined): Promise<{ accepted: true }>;
  delete(backupId: string): Promise<void>;
}

/** 记忆进化批 memory 面（memory-tap 注入；桌面被控面专属五端点——
 *  option 表 app 级配置无 userId 语义；AI 操作转 MemoryService 公开方法） */
export interface ServerFaceMemory {
  get(): Promise<MemoryState>;
  saveConfig(payload: {
    enabled?: boolean;
    modelId?: number | null;
  }): Promise<MemoryState>;
  /** 全量覆写（空串=重置）；超长 8000 保底截断 */
  saveProfile(profile: string): Promise<MemoryState>;
  applyInstruction(instruction: string): Promise<MemoryServiceResult>;
  compile(): Promise<MemoryServiceResult>;
}

export interface ServerFaceDeps {
  sessions: ServerFaceSessions;
  chat: ServerFaceChat;
  approvals: ServerFaceApprovals;
  providers: ServerFaceProviders;
  assistants: ServerFaceAssistants;
  skills: ServerFaceSkills;
  /** A3 批 skillhub 市场面（可选——未装配时 skillhub 四端点报未装配） */
  skillhub?: ServerFaceSkillHub;
  images: ServerFaceImages;
  workspaces: ServerFaceWorkspaces;
  /** MCP 批连接器面（可选——未装配时 mcp 两端点报未装配） */
  mcps?: ServerFaceMcps;
  /** A4 批：McpRepository 实例（Application 注入——联动 McpManager 进程
   *  生命周期；被控面严禁 new，构造函数已注册全部 IPC handler） */
  mcpRepo?: Pick<
    McpRepository,
    | "list"
    | "setEnabled"
    | "statuses"
    | "create"
    | "update"
    | "delete"
    | "reconnect"
  >;
  /** FA-T2 文件面（可选——未装配时 files 三端点报未装配） */
  files?: ServerFaceFiles;
  /** A5 资料库面（可选——未装配时 library 十六端点报未装配） */
  library?: ServerFaceLibrary;
  /** AR 批本地产物面 wire（可选——未装配时 artifact 三端点报未装配；
   * ipc 组装由 artifactRepo 经 artifact-tap 包装注入） */
  artifact?: ServerFaceArtifactWire;
  /** AR 批本地产物面数据源（SessionRepository 满足 ServerFaceArtifact
   * 结构子集——Application 注入本实例） */
  artifactRepo?: ServerFaceArtifact;
  /** A7 项目面（可选——未装配时 project 六端点报未装配） */
  project?: ServerFaceProject;
  /** A7 计划事项面（可选——未装配时 planItem 十端点报未装配） */
  planItem?: ServerFacePlanItem;
  /** A7 计划视图面（可选——未装配时 planView list 报未装配） */
  planView?: ServerFacePlanView;
  /** A7 项目资产面（可选——未装配时 projectAsset 六端点报未装配） */
  projectAsset?: ServerFaceProjectAsset;
  /** A10 审批记忆面（可选——未装配时 permission 五端点报未装配） */
  permissions?: ServerFacePermissions;
  /** 移动端 CRUD 批 automation 面（可选——未装配时 automation 五端点报
   *  未装配；Application 恒装配——automation-tap 桥桌面本地 repo，
   *  载荷/返回与无头端 AutomationController 五端点同构） */
  automation?: ServerFaceAutomation;
  /** graph 只读面（可选——CRUD 批随 automation 装配；仅 graph/query 列
   *  表选图用，save/delete/run/runAbort 编辑遥控仍无头端专属不透出） */
  graphsReadonly?: ServerFaceGraphsReadonly;
  /** 记忆进化批 memory 面（可选——未装配时 memory 五端点报未装配；
   *  Application 恒装配——memory-tap 桥 option 读写与 MemoryService） */
  memory?: ServerFaceMemory;
  /** 备份面批 backup 面（可选——未装配时 backup 三端点报未装配） */
  backup?: ServerFaceBackup;
  /** A6 监控读面（必选——/info 静态广告 monitor 能力位，装配缺位会能力
      撒谎；Application 恒传 MonitorRepository） */
  monitor: {
    stats(userId: number, scene?: MonitorScene): Promise<MonitorStats>;
  };
  /** 被控面单用户：user 表首个；无用户返回 null */
  resolveUserId(): Promise<number | null>;
  /** create 未传 workspaceId 时的默认空间（用户最新一个，webhook 先例） */
  resolveDefaultWorkspaceId(userId: number): Promise<number | null>;
  info(): Promise<ServerFaceInfo>;
}

let deps: ServerFaceDeps | null = null;

export function setServerFaceDeps(next: ServerFaceDeps): void {
  deps = next;
}

/** 未装配即调用属接线遗漏（Application.attachServerFace），直接抛错暴露 */
export function faceDeps(): ServerFaceDeps {
  if (!deps) {
    throw new Error("server-face 未装配依赖（Application.attachServerFace）");
  }
  return deps;
}

/** 测试复位（生产不调） */
export function resetServerFaceDepsForTest(): void {
  deps = null;
}
