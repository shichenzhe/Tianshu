// 被控面 IPC 装配（server-face spec §6.3 / T12）：Application 构造期调
// attachServerFace——① deps 注入（既有 SessionRepository/ChatService 单例，
// send 签名零改动）；② 登记 serverFace:status / serverFace:setEnabled
// （ipc-channels 白名单两通道；系统级开关无用户态语义，走裸 ipcMain.handle，
// Log/webhook 先例同款）；③ 按 option 持久化配置恢复服务面与 relay 客户端。
// setEnabled 兼收 boolean（旧形态，纯启停）与配置对象 {enabled, port?,
// host?, relayUrl?, relayToken?, regenerateToken?}（spec §13 项 1 被控面
// 设置 UI——字段合并落库后应用；启用时无 token 自动生成——spec §3.4
// 「服务面默认关闭，开启时生成」；非法载荷回落只读 status 快照）。
import { randomBytes } from "node:crypto";
import { app, ipcMain } from "electron";
import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import type { ProviderRepository } from "../ai/provider/provider.repo";
import type { ModelRepository } from "../ai/provider/model.repo";
import type { AssistantRepository } from "../ai/chat/assistant.repo";
import type { MonitorRepository } from "../ai/monitor/monitor.repo";
import type LibraryRepository from "../ai/library/library.repo";
import type ProjectRepository from "../project/project.repo";
import type PlanItemRepository from "../project/plan-item.repo";
import type PlanViewRepository from "../project/plan-view.repo";
import type AssetRepository from "../project/asset.repo";
import type { McpRepository } from "../ai/mcp/mcp.repo";
import type { SessionRepository } from "../ai/chat/session.repo";
import { SkillRepository } from "../ai/skill/skill.repo";
import { readImageWithinRoot } from "../ai/chat/workspace-files";
import {
  setServerFaceDeps,
  type ServerFaceArtifact,
  type ServerFaceChat,
  type ServerFaceSessions,
} from "./deps";
import { createExpertsFace } from "./expert-tap";
import { createFilesFace } from "./files-tap";
import { createArtifactFace } from "./artifact-tap";
import { createLibraryFace } from "./library-tap";
import { createMcpsFace } from "./mcp-tap";
import { createPermissionFace } from "./permission-tap";
import { createPlanItemFace } from "./plan-item-tap";
import { createPlanViewFace } from "./plan-view-tap";
import { createProjectAssetFace } from "./project-asset-tap";
import { createProjectFace } from "./project-tap";
import { createProvidersFace } from "./providers-tap";
import { createSkillsFace } from "./skills-tap";
import { createAutomationFace, createGraphsFace } from "./automation-tap";
import type { ServerFaceBackup, ServerFaceMemory } from "./deps";
import type AutomationRepository from "../ai/automation/automation.repo";
import type GraphRepository from "../ai/orchestration/graph.repo";
import { createSkillHubFace } from "./skillhub-tap";
import { createWorkspaceFace } from "./workspace-tap";
import {
  ensureServerFace,
  getServerFaceState,
  readServerFaceConfig,
  saveServerFaceConfig,
  stopServerFace,
  type FaceE2eMode,
  type ServerFaceConfig,
} from "./server-face";
import {
  isRelayConnected,
  isE2eActive,
  startRelayClient,
  stopRelayClient,
} from "./relay-client";
import { ensureE2eStaticPair } from "./e2e-keys";
import { FACE_CAPABILITIES, FACE_INSTANCE_ID, FACE_NAME } from "./face-info";
import { getReportedActiveUser, reportActiveUser } from "./active-user";
import { fingerprintOf, type E2EKeyPair } from "@tianshu/core";

/** setEnabled 对象载荷（spec §13 项 1 被控面设置 UI）：enabled 必填，
 * 其余字段可选合并（未提供的键保持现值）；boolean 旧形态等价 {enabled} */
interface SetFacePayload {
  enabled: boolean;
  port?: number;
  host?: string;
  relayUrl?: string;
  relayToken?: string;
  e2e?: FaceE2eMode;
  regenerateToken?: boolean;
}

/** 载荷解析：boolean 直通；对象形态校验 enabled 必填 + port 形态
 * （host/relay 字符串形态，e2e 三值枚举，真值收敛交给 parseConfigValue）；
 * 不合法 → null */
function parseSetPayload(raw: unknown): SetFacePayload | null {
  if (typeof raw === "boolean") return { enabled: raw };
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<SetFacePayload>;
  if (typeof candidate.enabled !== "boolean") return null;
  if (
    candidate.port !== undefined &&
    !(
      Number.isInteger(candidate.port) &&
      candidate.port >= 0 &&
      candidate.port < 65_536
    )
  ) {
    return null;
  }
  const pickString = (key: "host" | "relayUrl" | "relayToken") =>
    typeof candidate[key] === "string"
      ? { [key]: candidate[key] as string }
      : {};
  return {
    enabled: candidate.enabled,
    ...(candidate.port !== undefined ? { port: candidate.port } : {}),
    ...pickString("host"),
    ...pickString("relayUrl"),
    ...pickString("relayToken"),
    ...(candidate.e2e !== undefined &&
    ["auto", "required", "off"].includes(candidate.e2e)
      ? { e2e: candidate.e2e }
      : {}),
    ...(candidate.regenerateToken === true ? { regenerateToken: true } : {}),
  };
}

/** 应用配置并启停：启用→按配置起服务面（端口/host 变更热重载——
 * ensureServerFace 对不一致先停后起）+（relay url+token 成对时）relay
 * 客户端（startRelayClient 幂等换目标）；停用/relay 不成对→双停。
 * 返回 status 快照（渲染层立即回显状态点） */
async function setEnabled(payload: SetFacePayload): Promise<unknown> {
  const config = await readServerFaceConfig();
  const next: ServerFaceConfig = {
    ...config,
    enabled: payload.enabled,
    ...(payload.port !== undefined ? { port: payload.port } : {}),
    ...(payload.host !== undefined ? { host: payload.host } : {}),
    ...(payload.relayUrl !== undefined ? { relayUrl: payload.relayUrl } : {}),
    ...(payload.relayToken !== undefined
      ? { relayToken: payload.relayToken }
      : {}),
    ...(payload.e2e !== undefined ? { e2e: payload.e2e } : {}),
    // 主动重生成，或无 token 开启：自动生成（spec §3.4；ensureServerFace
    // 对空 token 拒启兜底，双保险）
    ...(payload.regenerateToken || (payload.enabled && !config.token)
      ? { token: randomBytes(24).toString("hex") }
      : {}),
  };
  await saveServerFaceConfig(next);
  if (next.enabled) {
    const port = await ensureServerFace();
    if (next.relayUrl && next.relayToken) {
      await startRelayClient(next.relayUrl, next.relayToken).catch((e) =>
        Log.error("relay 客户端启动失败（HTTP 面不受影响）", e),
      );
    } else {
      stopRelayClient();
    }
    Log.info("serverFace 已启用，端口", port);
  } else {
    await stopServerFace();
    stopRelayClient();
  }
  return faceStatus();
}

/** E2E 状态面（spec §13 被控端设置卡「端到端加密」区数据源）：status 查询
 * 即确保静态对存在（惰性生成持久化——指纹带外传递需在首连前可见）；
 * 生成失败（DB 异常等）降级空值，status 本身不崩 */
async function e2eStatus(mode: FaceE2eMode): Promise<{
  e2eMode: FaceE2eMode;
  e2ePublicKey: string;
  e2eFingerprint: string;
  e2eActive: boolean;
}> {
  let pair: E2EKeyPair | null = null;
  try {
    pair = await ensureE2eStaticPair();
  } catch (e) {
    Log.error("serverFace e2e 静态密钥装载失败（status 降级空值）", e);
  }
  return {
    e2eMode: mode,
    e2ePublicKey: pair ? pair.publicKey.toString("base64") : "",
    e2eFingerprint: pair ? fingerprintOf(pair.publicKey) : "",
    e2eActive: isE2eActive(),
  };
}

async function faceStatus(): Promise<unknown> {
  const [config, state] = await Promise.all([
    readServerFaceConfig(),
    Promise.resolve(getServerFaceState()),
  ]);
  return {
    enabled: config.enabled,
    running: state.running,
    port: state.running ? state.port : config.port,
    host: config.host,
    token: config.token,
    relayUrl: config.relayUrl ?? "",
    // relayToken 随 status 回传（设置 UI 回显编辑；本机配置项，与 face
    // token 同敏感级，渲染层可见口径一致）
    relayToken: config.relayToken ?? "",
    relayConnected: isRelayConnected(),
    instanceId: FACE_INSTANCE_ID,
    ...(await e2eStatus(config.e2e ?? "auto")),
  };
}

/** Application 构造期装配（幂等：重复调用只重注册 IPC，Electron 会以
 * "second handler" 报错防重复装配，属接线错误应尽早暴露） */
export function attachServerFace(deps: {
  // Omit<setMode>：仓储实现为 setSessionMode（private 亦可经此处函数引用
  // 传入），接口名适配在装配内收口
  sessions: Omit<ServerFaceSessions, "setMode">;
  chatService: ServerFaceChat;
  providerRepo: ProviderRepository;
  modelRepo: ModelRepository;
  assistantRepo: AssistantRepository;
  /** A6 监控读面：MonitorRepository.getStats 桥（必选——与 /info 能力位
      广告一致，缺装配属接线错误） */
  monitorRepo: Pick<MonitorRepository, "getStats">;
  /** A5 资料库面：LibraryRepository 单实例桥（list~writeContent 十七端点 +
      上传批 uploadFileBuffer 十八写面，含资料库编辑批 writeContent 写面；
      严禁 face 侧二次构造——构造函数注册全部 IPC handler；缺省不装配，
      library 端点报未装配） */
  libraryRepo?: Pick<
    LibraryRepository,
    | "get"
    | "list"
    | "tree"
    | "search"
    | "listRecent"
    | "listFavorites"
    | "createFolder"
    | "createFile"
    | "addLink"
    | "rename"
    | "move"
    | "delete"
    | "subtreeCount"
    | "toggleFavorite"
    | "markViewed"
    | "writeFileContent"
    | "uploadFileBuffer"
  >;
  /** AR 批本地产物面：SessionRepository 单实例桥（listArtifacts/
   *  toggleArtifactFavorite/readWorkspaceFileById 三方法既有实现；
   *  缺省不装配，artifact 端点报未装配） */
  artifactRepo?: ServerFaceArtifact;
  /** A7 项目面：ProjectRepository 单实例桥（project 六端点；归属校验 repo
   *  自带；assertProjectVisible 兼供 planView/asset 面守卫——缺省不装配，
   *  project 六端点报未装配） */
  projectRepo?: Pick<
    ProjectRepository,
    | "list"
    | "getDetail"
    | "create"
    | "update"
    | "remove"
    | "listMembers"
    | "assertProjectVisible"
  >;
  /** A7 计划事项面：PlanItemRepository 单实例桥（十端点；userId 校验
   *  repo 自带；缺省不装配） */
  planItemRepo?: Pick<
    PlanItemRepository,
    | "list"
    | "listMine"
    | "create"
    | "update"
    | "remove"
    | "move"
    | "listFields"
    | "listAttachments"
    | "createAttachment"
    | "removeAttachment"
  >;
  /** A7 计划视图面：PlanViewRepository 只读桥（list；历史裸暴露，可见性
   *  守卫复用 projectRepo.assertProjectVisible——缺 projectRepo 不装配） */
  planViewRepo?: Pick<PlanViewRepository, "list">;
  /** A7 项目资产面：AssetRepository 单实例桥（六端点；守卫同 planView；
   *  readImage 服务端解析资产根在 project-asset-tap） */
  projectAssetRepo?: Pick<
    AssetRepository,
    | "list"
    | "createFolder"
    | "rename"
    | "delete"
    | "storage"
    | "resolveAssetRoot"
  >;
  /** 技能面（AL/PM 批 + A3 扩 + A3 尾）：SkillRepository 桥——
   *  list/readSkill/setEnabled/setScenarios/uninstall + stats 事件表聚合 /
   *  installFromUpload zip 直装 + 四个 hub 市场端点（SkillHubClient/
   *  SkillInstaller 由本实例持有，严禁 face 侧二次构造） */
  skillRepo: Pick<
    SkillRepository,
    | "list"
    | "readSkill"
    | "setEnabled"
    | "setScenarios"
    | "uninstall"
    | "stats"
    | "installFromUpload"
    | "listHubSkills"
    | "listHubTop"
    | "listHubCategories"
    | "installFromHub"
    | "getHubSkillDetail"
  >;
  /** A4 批：McpRepository 实例（Application 装配——启停联动 McpManager
   *  进程生命周期；未注入时 mcps 整面不报=端点 5000 未装配） */
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
  /** 移动端 CRUD 批：AutomationRepository 单实例桥（automation 五端点
   *  ——save upsert/runPage 剔 graphTrace/变更事件经 change-bus；构造注册
   *  IPC 严禁 face 侧二次构造，未注入时五端点报未装配） */
  automationRepo?: Pick<
    AutomationRepository,
    | "listTasks"
    | "createTask"
    | "updateTask"
    | "deleteTasks"
    | "toggleTask"
    | "runNow"
    | "listRuns"
  >;
  /** CRUD 批 graph 只读面：listGraphs 全量 → 分页壳（选图）；图编辑遥控
   *  仍无头端专属不透出 */
  graphRepo?: Pick<GraphRepository, "listGraphs">;
  /** 记忆进化批 memory 面（可选——未装配时 memory 五端点报未装配）：
   *  option 读写与 MemoryService AI 操作（memory-tap 成品面直传） */
  memory?: ServerFaceMemory;
  /** 备份面批 backup 面（可选——未装配时 backup 三端点报未装配）：
   *  backup-tap 成品面直传 */
  backup?: ServerFaceBackup;
  /** A8 工作空间写面：SessionRepository 单实例桥（create/update/delete
   *  三端点——delete 硬级联语义 repo 内聚；未注入时写面不装配=端点 5000
   *  未装配，list 直查不受影响） */
  workspaceRepo?: Pick<
    SessionRepository,
    "createWorkspace" | "updateWorkspace" | "deleteWorkspace"
  >;
  /** 模式切换（CU 批）：SessionRepository.setSessionMode——deps 接口名
   *  setMode 的名字适配在此收口（Application 不感知） */
  setSessionMode: (
    id: number,
    mode: "agent" | "ask" | "plan",
    userId: number,
  ) => Promise<void>;
  /** 归档切换（AL 批）：SessionRepository.archiveSession */
  archiveSession: (
    id: number,
    archived: boolean,
    userId: number,
  ) => Promise<void>;
  /** 置顶切换（LA 批）：SessionRepository.pinSession */
  pinSession: (id: number, pinned: boolean, userId: number) => Promise<void>;
  /** 绑定专家（PM 批）：SessionRepository.setSessionAssistant */
  setSessionAssistant: (
    id: number,
    assistantId: number | null,
    userId: number,
  ) => Promise<void>;
  /** 会话当前模型（HD 批）：SessionRepository.setSessionModel */
  setSessionModel: (
    id: number,
    modelId: number | null,
    userId: number,
  ) => Promise<void>;
}): void {
  setServerFaceDeps({
    // 直传实例——spread 类实例会丢原型方法（createSession 等在 prototype，
    // 移动端连 face 新建会话因此 5000 "not a function"，真机直连实测暴露）；
    // 接口名适配（setMode←setSessionMode 等）经同名显式包装收口
    sessions: {
      ...deps.sessions,
      createSession: (p, userId) => deps.sessions.createSession(p, userId),
      getSession: (id) => deps.sessions.getSession(id),
      listAllSessions: (userId) => deps.sessions.listAllSessions(userId),
      // 原型方法必须逐个点名包装（spread 类实例丢原型——querySessions
      // face 批增、listAllSessionsSummarized/getSessionSummary/markSessionRead
      // P1 批增曾漏接，移动端 session/query 5000 "not a function" 真机暴露）
      querySessions: (params, userId) =>
        deps.sessions.querySessions(params, userId),
      listAllSessionsSummarized: (userId) =>
        deps.sessions.listAllSessionsSummarized(userId),
      getSessionSummary: (id, userId) =>
        deps.sessions.getSessionSummary(id, userId),
      markSessionRead: (sessionId, maxMessageId, userId) =>
        deps.sessions.markSessionRead(sessionId, maxMessageId, userId),
      getSessionById: (id, userId) => deps.sessions.getSessionById(id, userId),
      deleteSession: (id, userId) => deps.sessions.deleteSession(id, userId),
      renameSession: (id, title, userId) =>
        deps.sessions.renameSession(id, title, userId),
      listMessages: (sessionId, userId, opts) =>
        deps.sessions.listMessages(sessionId, userId, opts),
      setMode: deps.setSessionMode,
      archiveSession: deps.archiveSession,
      pinSession: deps.pinSession,
      setSessionAssistant: deps.setSessionAssistant,
      setSessionModel: deps.setSessionModel,
    },
    chat: deps.chatService,
    approvals: {
      respondRemember: (
        sessionId,
        toolCallId,
        approved,
        userId,
        remember,
        toolName,
      ) =>
        deps.chatService.respondApprovalRemember(
          sessionId,
          toolCallId,
          approved,
          userId,
          remember,
          toolName,
        ),
    },
    providers: createProvidersFace({
      providerRepo: deps.providerRepo,
      modelRepo: deps.modelRepo,
    }),
    // A3 技能面桥（skills-tap）：list 契约扩 scenarios/source/builtin 可选段
    // + setScenarios/uninstall——A3 批语义内聚 tap，装配一行直传实例
    skills: createSkillsFace(deps.skillRepo),
    // 移动端 CRUD 批（2026-10-27）：automation 五端点 + graph/query 只读
    // 选图面（automation-tap 桥桌面本地 repo；变更事件 automation.changed
    // 经 automation-change-bus → face-events 桥扇出）
    ...(deps.automationRepo
      ? {
          automation: createAutomationFace({
            automationRepo: deps.automationRepo,
          }),
        }
      : {}),
    ...(deps.graphRepo
      ? { graphsReadonly: createGraphsFace({ graphRepo: deps.graphRepo }) }
      : {}),
    ...(deps.memory ? { memory: deps.memory } : {}),
    ...(deps.backup ? { backup: deps.backup } : {}),
    // A3 skillhub 市场面桥（skillhub-tap）：四端点走 SkillRepository 持有的
    // SkillHubClient/SkillInstaller（宿主侧下载 zip 落盘，手机零流量）
    skillhub: createSkillHubFace(deps.skillRepo),
    // A2 专家面桥（expert-tap）：assistant/query 列表 + detail/save/delete
    // 写面 + marketList/marketDetail 市场静态数据——归属校验/内置守卫/三态
    // 语义内聚 tap（MARKET_EXPERTS 经 @tianshu/core 收编单源）
    assistants: createExpertsFace(deps.assistantRepo),
    images: {
      readImage: (imagePath) => readImageWithinRoot(imagePath),
    },
    // workspace/query 桥（HD-A1 单 UI 远程态侧栏分组树）：概要四字段
    // 直查（resolveDefaultWorkspaceId 同款 prisma 先例，审计面不外露）；
    // A8 写面三段（workspace-tap）：deps.workspaceRepo 在则装配
    // create/update/delete——delete 沿用 repo 硬级联语义
    workspaces: {
      list: async (userId) =>
        await prisma.workspace.findMany({
          where: { userId },
          select: {
            id: true,
            name: true,
            directoryPath: true,
            defaultModelId: true,
          },
          orderBy: { id: "asc" },
        }),
      ...(deps.workspaceRepo ? createWorkspaceFace(deps.workspaceRepo) : {}),
    },
    // files 三端点桥（FA-T2）：桌面被控面文件真身（数据根/归属校验内聚）
    files: createFilesFace(),
    // A5 资料库十六端点桥：复用 IPC 同款单实例（DTO 路径剔除 + 读取守卫
    // 在 library-tap）；缺 libraryRepo 不装配——路由层报未装配
    library: deps.libraryRepo ? createLibraryFace(deps.libraryRepo) : undefined,
    // AR 批本地产物三端点桥（artifact-tap：list 剔 path / read 转协议联合）
    artifact: deps.artifactRepo
      ? createArtifactFace(deps.artifactRepo)
      : undefined,
    // A7 项目域四面桥（project/planItem/planView/projectAsset 23 端点——
    // 复用 IPC 同款单实例；planView/asset 可见性守卫复用 projectRepo
    // assertProjectVisible；缺对应 repo 不装配——路由层报未装配）
    project: deps.projectRepo ? createProjectFace(deps.projectRepo) : undefined,
    planItem: deps.planItemRepo
      ? createPlanItemFace(deps.planItemRepo)
      : undefined,
    planView:
      deps.projectRepo && deps.planViewRepo
        ? createPlanViewFace(deps.projectRepo, deps.planViewRepo)
        : undefined,
    projectAsset:
      deps.projectRepo && deps.projectAssetRepo
        ? createProjectAssetFace(deps.projectRepo, deps.projectAssetRepo)
        : undefined,
    // A10 审批记忆五端点桥（permission-tap）：remembered 面归属过滤/幂等
    // no-op 语义内聚 ChatService（五方法 A10 批已提 public），tap 只信封
    // DTO——revokeAll 两返回 {revoked}（IPC 面忽略返回值，被控面增强）
    permissions: createPermissionFace(deps.chatService),
    // A6 监控读面：复用既有 MonitorRepository 聚合查询（必选装配——与
    // /info 能力位广告一致，缺装配属接线错误而非降级路径）
    monitor: {
      stats: (userId, scene) => deps.monitorRepo.getStats(userId, scene),
    },
    // 连接器面桥（MCP 批）：A4 装配修正后改走注入的 McpRepository 单实例
    // ——启停联动 McpManager 进程/工具注册生命周期，不存在/越权经
    // assertOwned 抛错（不再静默成功）；env/headers 敏感字段不透出——
    // 裁剪在此收口。未注入 mcpRepo（测试替身）时整面不报=端点 5000 未装配
    mcpRepo: deps.mcpRepo,
    // A4 连接器面桥（mcp-tap）：阶段 0 query/setEnabled 语义原样保留（list
    // 裁剪不透 env/headers；启停走 repo 联动 manager），新增 statuses/save/
    // delete/reconnect/detail 五端点——写面 v1 仅 HTTP transport
    mcps: deps.mcpRepo ? createMcpsFace(deps.mcpRepo) : undefined,
    // 被控面单用户（方案 A 裁定 2026-10-22）：渲染层上报的登录用户优先
    // ——否则此前只能猜「user 表最新一行」，切回更早注册的账号登录即
    // 错位（移动端看到的是另一个人的数据）；未上报（主进程刚起/渲染层
    // 未登录/登出清空）回落最新用户（「首个」语义在多用户 dev 库下同样
    // 错位，真机实测后修正）
    resolveUserId: async () =>
      getReportedActiveUser() ??
      (await prisma.user.findFirst({ orderBy: { id: "desc" } }))?.id ??
      null,
    resolveDefaultWorkspaceId: async (userId) =>
      (
        await prisma.workspace.findFirst({
          where: { userId },
          orderBy: { id: "desc" },
        })
      )?.id ?? null,
    info: async () => {
      // 身份面（token 实例级非用户级——被控数据实际归属的用户名单独
      // 透出供控制端显示；跟随 resolveUserId 同款语义：渲染层上报的
      // 登录用户优先、回落最新；mirror user 表无 name 列——显示名
      // nickname，缺省回落 username；库空/失败 null）
      const reportedId = getReportedActiveUser();
      const identityUser = await prisma.user
        .findFirst({
          ...(reportedId != null ? { where: { id: reportedId } } : {}),
          ...(reportedId == null ? { orderBy: { id: "desc" as const } } : {}),
          select: { username: true, nickname: true },
        })
        .catch(() => null);
      return {
        name: FACE_NAME,
        version: app.getVersion(),
        instanceId: FACE_INSTANCE_ID,
        capabilities: [...FACE_CAPABILITIES],
        username: identityUser?.nickname ?? identityUser?.username ?? null,
      };
    },
  });
  ipcMain.handle("serverFace:status", () => faceStatus());
  ipcMain.handle("serverFace:setEnabled", (_event, payload: unknown) => {
    const parsed = parseSetPayload(payload);
    // 非法载荷回落只读快照（与旧非 boolean 行为同口径，不抛崩渲染层）
    return parsed ? setEnabled(parsed) : faceStatus();
  });
  // 登录用户上报（方案 A）：number=登录/切换的用户 id，null/非法=登出
  // 清空（resolveUserId/info 跟随；本地渲染层自有信道，免鉴权）
  ipcMain.handle("serverFace:reportActiveUser", (_event, userId: unknown) => {
    reportActiveUser(typeof userId === "number" ? userId : null);
  });
  // 启动恢复：option 开着（且 token 已配）即拉起服务面与 relay 客户端；
  // 失败仅日志（端口占用等下次 setEnabled/重启重试），不阻断应用启动
  void readServerFaceConfig()
    .then(async (config) => {
      if (!config.enabled) return;
      await ensureServerFace();
      if (config.relayUrl && config.relayToken) {
        await startRelayClient(config.relayUrl, config.relayToken);
      }
    })
    .catch((e) => Log.error("serverFace 启动恢复失败", e));
}

/** 应用退出收口（app quit 事件调）：双停服务面与 relay 客户端 */
export async function shutdownServerFace(): Promise<void> {
  await stopServerFace();
  stopRelayClient();
}
