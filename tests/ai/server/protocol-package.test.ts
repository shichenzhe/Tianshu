// RC-T1 @tianshu/protocol 协议包接入测试：三处同构双写的协议定义收编为
// 单份权威源（ServerEvent 三写 / relay 帧双写 / blocks+chunk 双写）。
// 钉住三件事：
// 1. alias 解析——vitest resolve.alias 未登记时首行 import 即失败；
// 2. 常量值 = spec §3.1（CAPABILITIES/ENDPOINTS），且老常量位（face-info
//    的 FACE_CAPABILITIES）与包常量为同一引用（收编非复制）；
// 3. 老路径 re-export 兼容层等价——类型同一性抽查（双向可赋值 witness，
//    编译期经根 typecheck 的 import 图兜底）+ 实现留原地的老模块运行时
//    完好（isReqFrame/parseBlocks 抽查，证明类型搬走未伤实现）。
// GA-T1 增补：graph 契约 GraphIssue 收编（纯类型进包；zod schema 运行时
// 与 z.infer 推断类型留 mirror graph.schema 原位——协议包零运行时依赖，
// 边界详见任务报告）。
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  DESKTOP_CAPABILITIES,
  ENDPOINTS,
  type BridgeToolResult,
  type ChatSendParams,
  type ChatStreamChunk,
  type FaceEvent,
  type GraphIssue,
  type MessageBlock,
  type RelayFrame,
  type ServerEvent,
  type ToolCallBlock,
  type ToolRequestPayload,
} from "@tianshu/protocol";
import { FACE_CAPABILITIES } from "../../../electron/domains/server-face/face-info";
import { isReqFrame } from "../../../electron/domains/server-face/relay-protocol";
import { parseBlocks } from "../../../electron/domains/ai/chat/blocks";
import type { ServerEvent as ServerEventOld } from "../../../electron/domains/server/protocol";
import type { FaceEvent as FaceEventOld } from "../../../electron/domains/server-face/face-events";
import type { RelayFrame as RelayFrameOld } from "../../../electron/domains/server-face/relay-protocol";
import type {
  ChatSendParams as ChatSendParamsOld,
  ChatStreamChunk as ChatStreamChunkOld,
} from "../../../src-react/domains/ai/api/chat.api";
import type {
  MessageBlock as MessageBlockMainOld,
  ToolCallBlock as ToolCallBlockMainOld,
} from "../../../electron/domains/ai/chat/blocks";
import type { MessageBlock as MessageBlockRendererOld } from "../../../src-react/domains/ai/chat/model/blocks";
import {
  validateGraph,
  type GraphIssue as GraphIssueOld,
} from "../../../src-react/domains/ai/orchestration/api/graph.schema";

describe("@tianshu/protocol 协议包", () => {
  it("CAPABILITIES 值 = spec §3.1+§4.2（GA-T6 增 graph；FA-T1 增 files），DESKTOP_CAPABILITIES = spec 2026-10-17 §2.2（UD-T1 增 ui-drive、FA-T2 增 files、MCP 批增 mcp）+ A6 增 monitor 与被控端老常量位同一引用 + CRUD 批增 automation（graph 仍不报）+ 记忆批增 memory + 备份批增 backup", () => {
    expect([...CAPABILITIES]).toEqual([
      "chat",
      "provider",
      "graph",
      "files",
      "library",
      "monitor",
    ]);
    expect([...DESKTOP_CAPABILITIES]).toEqual([
      "chat",
      "provider",
      "ui-drive",
      "files",
      "mcp",
      "monitor",
      "library",
      "project",
      "skillhub",
      "automation",
      "memory",
      "backup",
    ]);
    expect(FACE_CAPABILITIES).toBe(DESKTOP_CAPABILITIES);
  });

  it("ENDPOINTS 路径表 = spec §3.1 + UD-T1 补全（ui 三段 + GA 遗漏 graph/automation 十段 + webhook 五段 + TB tool 一段；无前导斜杠，handleRoute 归一口径）", () => {
    expect(ENDPOINTS).toEqual({
      info: "info",
      session: {
        create: "session/create",
        query: "session/query",
        getById: "session/getById",
        delete: "session/delete",
        editAndResend: "session/editAndResend",
        update: "session/update",
        regenerate: "session/regenerate",
        send: "session/send",
        abort: "session/abort",
        accessMode: "session/accessMode",
        usage: "session/usage",
        approve: "session/approve",
        // P1 未读角标批：已读游标单调推进（响应 SessionReadResult）
        read: "session/read",
        // A9 会话内工具批：compact 异步（202+session.updated）；polish
        // 同步 30s 超时
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
      assistant: {
        query: "assistant/query",
        detail: "assistant/detail",
        save: "assistant/save",
        delete: "assistant/delete",
        marketList: "assistant/marketList",
        marketDetail: "assistant/marketDetail",
        // A2 尾导入导出批：export/import（JSON 内容面，零本机路径）
        export: "assistant/export",
        import: "assistant/import",
      },
      // A8 工作空间管理批：写面三段双端同批（无 bindDirectory——绑定目录
      // 留桌面端，spec §1.4）
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
      skills: {
        query: "skills/query",
        read: "skills/read",
        setEnabled: "skills/setEnabled",
        setScenarios: "skills/setScenarios",
        uninstall: "skills/uninstall",
        // A3 尾：base64 zip 直装（≤3MB）/ 事件表聚合统计
        installUpload: "skills/installUpload",
        stats: "skills/stats",
      },
      // A3 技能市场四段 + detail 批第五段：桌面被控面专属（skillhub 能力字）
      skillhub: {
        list: "skillhub/list",
        top: "skillhub/top",
        categories: "skillhub/categories",
        install: "skillhub/install",
        detail: "skillhub/detail",
      },
      // A4 MCP 批：运行态/HTTP 写面/重连/详情——stdio 配置只读摘要
      mcp: {
        query: "mcp/query",
        setEnabled: "mcp/setEnabled",
        statuses: "mcp/statuses",
        save: "mcp/save",
        delete: "mcp/delete",
        reconnect: "mcp/reconnect",
        detail: "mcp/detail",
      },
      // A6 监控读面：仅桌面被控面实现，无头端不报即不可达
      monitor: {
        stats: "monitor/stats",
      },
      // A5 资料库批（17 段）+ 编辑批 writeContent + 上传批 uploadFile：
      // 读面+元数据写面；read/readImage 按 id 取内容，DTO 不携带本机路径；
      // writeContent 全量覆写回传刷新 DTO；uploadFile 移动端二进制入库
      // （base64 原始 ≤3MB，relay 单帧 4MiB 余量）
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
        writeContent: "library/writeContent",
        uploadFile: "library/uploadFile",
      },
      image: "image",
      // A7 项目批（23 段）：桌面被控面专属；planView 只读消费，
      // projectAsset/readImage 服务端解析资产根
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
      // ui-drive 三段（UD-T1）：仅桌面被控面实现，无头端不报即不可达
      ui: {
        openSession: "ui/openSession",
        notify: "ui/notify",
        openRoute: "ui/openRoute",
      },
      // graph 五段 + automation 四段（GA-T6/T8 落地，终审 Minor 5 补录入表；
      // 值以 tianshu-server graph/automation controller 实际路由为准）
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
        // 移动端 CRUD+运行历史批：分页运行历史（载荷剔 graphTrace）
        runPage: "automation/runPage",
      },
      // tool 一段（TB，终审补录）：无头端工具桥应答回传入口——server
      // tool.controller @Controller('tool') + @Post('respond') 实际路由
      tool: {
        respond: "tool/respond",
      },
      // A10 审批记忆批（五段双端同批）：remembered=toolPermission 表读删；
      // full=会话级运行态列表/清空（shape {sessionId,title} 读代码裁定）
      permission: {
        listRemembered: "permission/listRemembered",
        revokeRemembered: "permission/revokeRemembered",
        revokeAllRemembered: "permission/revokeAllRemembered",
        listFullGrants: "permission/listFullGrants",
        revokeAllFull: "permission/revokeAllFull",
      },
      // webhook 触发两段（外部系统语义，token 路径参数占位）：POST 触发 +
      // GET 任务状态查询（tianshu-server webhook.controller / mirror
      // webhook-server.ts 双端同构路由）；管理三段（WH 批）：开启/关闭/
      // 查询——路径带 graph/webhook/ 前缀避开 `/webhook/` 触发面守卫
      // 豁免前缀（管理面 fullAccess 全权开关不可匿名可达）
      webhook: {
        trigger: "webhook/:token",
        jobStatus: "webhook/:token/jobs/:id",
        enable: "graph/webhook/enable",
        disable: "graph/webhook/disable",
        status: "graph/webhook/status",
      },
      // 备份面批（2026-10-27）：桌面被控面专属三端点——遥控桌面备份
      // 客户端（打包上传它所配 direct 连接的无头端）；恢复不做
      backup: {
        list: "backup/list",
        create: "backup/create",
        delete: "backup/delete",
      },
      // 记忆进化批（2026-10-27）：桌面被控面专属五端点（option 表存储+
      // 每晚调度在桌面端，无头端不报）
      memory: {
        get: "memory/get",
        saveConfig: "memory/saveConfig",
        saveProfile: "memory/saveProfile",
        applyInstruction: "memory/applyInstruction",
        compile: "memory/compile",
      },
      // AR 批（本地产物）：桌面被控面专属三段
      artifact: {
        list: "artifact/list",
        toggleFavorite: "artifact/toggleFavorite",
        read: "artifact/read",
      },
    });
  });

  it("老路径 re-export 与包类型同一（双向可赋值 witness 抽查）", () => {
    const serverToOld: ServerEventOld = null as unknown as ServerEvent;
    const serverFromOld: ServerEvent = null as unknown as ServerEventOld;
    const faceToOld: FaceEventOld = null as unknown as FaceEvent;
    const faceFromOld: FaceEvent = null as unknown as FaceEventOld;
    const relayToOld: RelayFrameOld = null as unknown as RelayFrame;
    const relayFromOld: RelayFrame = null as unknown as RelayFrameOld;
    const chunkFromOld: ChatStreamChunk = null as unknown as ChatStreamChunkOld;
    const chunkToOld: ChatStreamChunkOld = null as unknown as ChatStreamChunk;
    const sendFromOld: ChatSendParams = null as unknown as ChatSendParamsOld;
    const sendToOld: ChatSendParamsOld = null as unknown as ChatSendParams;
    const blockMainFromOld: MessageBlock =
      null as unknown as MessageBlockMainOld;
    const blockMainToOld: MessageBlockMainOld = null as unknown as MessageBlock;
    const blockRendererFromOld: MessageBlock =
      null as unknown as MessageBlockRendererOld;
    const blockRendererToOld: MessageBlockRendererOld =
      null as unknown as MessageBlock;
    const toolCallFromOld: ToolCallBlock =
      null as unknown as ToolCallBlockMainOld;
    const toolCallToOld: ToolCallBlockMainOld =
      null as unknown as ToolCallBlock;
    expect([
      serverToOld,
      serverFromOld,
      faceToOld,
      faceFromOld,
      relayToOld,
      relayFromOld,
      chunkFromOld,
      chunkToOld,
      sendFromOld,
      sendToOld,
      blockMainFromOld,
      blockMainToOld,
      blockRendererFromOld,
      blockRendererToOld,
      toolCallFromOld,
      toolCallToOld,
    ]).toHaveLength(16);
  });

  it("实现留原地的老模块运行时完好（类型搬包未伤实现）", () => {
    expect(
      isReqFrame({ kind: "req", id: 1, method: "GET", path: "info" }),
    ).toBe(true);
    expect(isReqFrame({ kind: "res", id: 1, status: 200, body: null })).toBe(
      false,
    );
    expect(parseBlocks('[{"type":"text","text":"hi"}]')).toEqual([
      { type: "text", text: "hi" },
    ]);
  });

  it("graph 契约：老路径 re-export 与包类型同一（GraphIssue 双向可赋值 witness）", () => {
    const issueFromOld: GraphIssue = null as unknown as GraphIssueOld;
    const issueToOld: GraphIssueOld = null as unknown as GraphIssue;
    expect([issueFromOld, issueToOld]).toHaveLength(2);
  });

  it("graph 契约：运行时留原地的老模块完好（validateGraph 产出 GraphIssue 形态）", () => {
    const ok = validateGraph({
      version: 1,
      inputSchema: {},
      nodes: [{ id: "n-1", name: "N", kind: "llm", modelId: 1, prompt: "p" }],
      edges: [],
    });
    expect(ok.ok).toBe(true);
    const bad = validateGraph({
      version: 1,
      inputSchema: {},
      nodes: [],
      edges: [],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues[0].code).toBe("schema");
      expect(typeof bad.issues[0].params?.message).toBe("string");
    }
  });

  // TB-T1：tool.request 事件（spec §2.1）——无头端遇桥工具回调控制端桌面
  // 执行的广播帧。断言面为纯类型（payload 无运行时常量），红/绿牙在
  // typecheck:witness（vitest/oxc 剥类型不查）——与既有 witness 同款约定
  it("tool.request 事件：payload witness——requestId/sessionId/tool 四值枚举/args（TB-T1）", () => {
    const event: ServerEvent = {
      type: "tool.request",
      payload: {
        requestId: "req-1",
        sessionId: 42,
        tool: "browser_snapshot",
        args: { url: "https://example.com" },
      },
    };
    // 判别联合成员存在 + 收窄后字段可读
    if (event.type === "tool.request") {
      expect(event.payload.requestId).toBe("req-1");
      expect(event.payload.sessionId).toBe(42);
      expect(event.payload.tool).toBe("browser_snapshot");
      expect(event.payload.args).toEqual({ url: "https://example.com" });
    }
    // 独立载荷类型与事件成员同构（双向可赋值 witness）
    const payload: ToolRequestPayload =
      event.type === "tool.request"
        ? event.payload
        : (null as unknown as ToolRequestPayload);
    expect(payload.tool).toBe("browser_snapshot");
    // tool 枚举四值全量（wire 契约：browser 桥首批，后续批扩组再增）
    const tools: ToolRequestPayload["tool"][] = [
      "browser_snapshot",
      "browser_navigate",
      "browser_click",
      "browser_type",
    ];
    expect(tools).toHaveLength(4);
    // @ts-expect-error 枚举外值编译期拒绝（防手滑扩值破坏 wire 契约）
    const badTool: ToolRequestPayload["tool"] = "browser_screenshot";
    expect(badTool).toBe("browser_screenshot");
  });

  // TB-T3：BridgeToolResult 上提单份（ruling 4）——mirror bridge-executor
  // 与 server bridge-registry/tool DTO 均改引本包定义（双仓本地副本删除）
  it("桥工具结果：判别联合两成员 witness——ok:true 携 output / ok:false 携 error（TB-T3）", () => {
    const okResult: BridgeToolResult = { ok: true, output: "标题: 示例页" };
    const errResult: BridgeToolResult = { ok: false, error: "denied by user" };
    // 判别收窄后字段可读（跨字段互斥）
    if (okResult.ok) expect(okResult.output).toContain("示例页");
    if (!errResult.ok) expect(errResult.error).toBe("denied by user");
    // @ts-expect-error ok:true 分支读 error 编译期拒绝（判别联合防手滑）
    const badRead = okResult.error;
    expect(badRead).toBeUndefined();
    expect([okResult, errResult]).toHaveLength(2);
  });
});
