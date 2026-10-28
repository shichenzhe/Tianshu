// 控制端 IPC 面（T16）：连接注册表 CRUD/测试 + 本地无头端启停 + session
// 遥控透传（POST session/* 六端点——含 T17 approve 审批应答，被控端
// 协议契约——业务错 200+4xxx、send 202、认证 401/4010 → 注册表连接态
// invalid-token）+ 编排区遥控
// （GA-T8：graph/* 五端点 + automation/* 四端点同款透传，九端点面——
// 启停走 automation/save 全量 enabled 字段，无 toggle 端点，Ruling 12）。
// 事件桥（Transport onEvent → 渲染层）：
// - message.chunk → `server:chunk:<connId>:<sessionId>`（chunk 载荷）
// - session.updated / session.error / server.connected / graph.run.updated /
//   automation.changed → `server:event:<connId>` 合并通道（载荷
//   {type, payload}——单一订阅口消费全部非 chunk 事件，T17/T18/T8 无需双通道；
//   graph/automation 事件仅无头端发布，GA-T6 起 ServerEvent 联合成员）
// - server.connected 同时在注册表就地消化为连接态（下发渲染层是 spec §13
//   项 2 重连全量刷新信号：订阅方 refetch 会话列表/连接态，消卡流式态）
// - tool.request（TB-T2，spec §4.3）→ bridge-executor（隐藏桥窗执行 + write
//   经 server:bridgeApproval 审批卡，应答走 server:bridgeDecision INVOKE），
//   结果 POST tool/respond 回传被控端（Event 白名单登记 server:bridgeApproval）
// session 类通道末参可选 connId：显式指定即透传该连接并切换活动连接（粘性），
// 省略走当前活动连接（activeConnId，注册表维护、option 持久化）。
import { BrowserWindow, ipcMain } from "electron";
import {
  localServerStatus,
  serverConnections,
  startLocalServer,
  stopLocalServer,
  type ConnectionRegistry,
} from "./connections";
import {
  bridgeExecutor,
  destroyBridgeWindow,
  handleBridgeToolRequest,
} from "./bridge-executor";

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

/** 远程透传通道工厂（session/graph/automation 通用）：统一
 * (body?, connId?) 签名 POST 被控端端点；connId 缺省走活动连接（注册表
 * request 内部路由——save/delete/runNow 等控制面操作同口径） */
function remoteHandler(
  registry: ConnectionRegistry,
  wirePath: string,
): (
  event: Electron.IpcMainInvokeEvent,
  body: unknown,
  connId?: unknown,
) => unknown {
  return (_event, body, connId) =>
    registry.request(
      typeof connId === "string" && connId ? connId : null,
      "POST",
      wirePath,
      body,
    );
}

/** Application 构造期装配（幂等由 ipcMain "second handler" 报错保障，
 * server-face/ipc 同款口径）；测试可注入独立注册表实例 */
export function registerServerIpc(
  registry: ConnectionRegistry = serverConnections,
): void {
  registry.setEventSink((connId, event) => {
    if (event.type === "message.chunk") {
      broadcast(
        `server:chunk:${connId}:${event.payload.sessionId}`,
        event.payload.chunk,
      );
      return;
    }
    // 桥执行请求（TB-T2，spec §4.3）：过滤出 tool.request → bridge-executor
    // （隐藏桥窗执行 + write 审批卡），结果经 requestRemote POST tool/respond
    if (event.type === "tool.request") {
      handleBridgeToolRequest(registry, connId, event.payload);
      return;
    }
    if (
      event.type === "session.updated" ||
      event.type === "session.error" ||
      event.type === "server.connected" ||
      event.type === "graph.run.updated" ||
      event.type === "automation.changed"
    ) {
      broadcast(`server:event:${connId}`, event);
    }
  });
  ipcMain.handle("server:connectionList", () => registry.list());
  ipcMain.handle("server:connectionSave", (_event, raw) =>
    registry.saveConnection(raw),
  );
  ipcMain.handle("server:connectionDelete", (_event, raw) =>
    registry.deleteConnection(String(raw ?? "")),
  );
  ipcMain.handle("server:testConnection", (_event, raw) => registry.test(raw));
  ipcMain.handle("server:localStart", (_event, raw) =>
    startLocalServer(registry, String(raw ?? "")),
  );
  ipcMain.handle("server:localStop", () => stopLocalServer(registry));
  ipcMain.handle("server:localStatus", () => localServerStatus());
  ipcMain.handle(
    "server:sessionList",
    remoteHandler(registry, "session/query"),
  );
  ipcMain.handle(
    "server:sessionGet",
    remoteHandler(registry, "session/getById"),
  );
  ipcMain.handle("server:sessionSend", remoteHandler(registry, "session/send"));
  ipcMain.handle(
    "server:sessionAbort",
    remoteHandler(registry, "session/abort"),
  );
  ipcMain.handle(
    "server:sessionCreate",
    remoteHandler(registry, "session/create"),
  );
  ipcMain.handle(
    "server:sessionDelete",
    remoteHandler(registry, "session/delete"),
  );
  // 审批应答（T17）：approve 透传——4040=已被处理/已失效，渲染层 Banner
  // 内联提示（与移动端同协议）
  ipcMain.handle(
    "server:sessionApprove",
    remoteHandler(registry, "session/approve"),
  );
  // —— 模型面（会话指定模型配套）：provider 查/存透传——headless 有
  // save 端点（upsert 数组语义，密钥脱敏回显），desktop 被控面 provider
  // 只读（无 save 路由，调用将 404——UI 按 headless 判定隐藏编辑表单） ——
  ipcMain.handle(
    "server:providerQuery",
    remoteHandler(registry, "provider/query"),
  );
  ipcMain.handle(
    "server:providerSave",
    remoteHandler(registry, "provider/save"),
  );
  // —— 模型面打磨（FA 批）：删除/测试/上游拉取 + 会话重命名 + 专家列表 ——
  ipcMain.handle(
    "server:providerDelete",
    remoteHandler(registry, "provider/delete"),
  );
  ipcMain.handle(
    "server:providerTest",
    remoteHandler(registry, "provider/test"),
  );
  ipcMain.handle(
    "server:providerFetchModels",
    remoteHandler(registry, "provider/fetchModels"),
  );
  ipcMain.handle(
    "server:sessionUpdate",
    remoteHandler(registry, "session/update"),
  );
  ipcMain.handle(
    "server:sessionRegenerate",
    remoteHandler(registry, "session/regenerate"),
  );
  // —— 聊天面板对齐（CU 批）：编辑重发 + 权限模式（get/set 合一） ——
  ipcMain.handle(
    "server:sessionEditResend",
    remoteHandler(registry, "session/editAndResend"),
  );
  ipcMain.handle(
    "server:sessionAccessMode",
    remoteHandler(registry, "session/accessMode"),
  );
  // —— P1 尾未读角标：已读推进透传（session/read，与移动端上报同语义） ——
  ipcMain.handle("server:sessionRead", remoteHandler(registry, "session/read"));
  // —— 文件面（FA-T3，spec 2026-10-20）：files 三端点透传 ——
  ipcMain.handle("server:filesList", remoteHandler(registry, "files/list"));
  ipcMain.handle("server:filesRead", remoteHandler(registry, "files/read"));
  ipcMain.handle(
    "server:filesUploadImage",
    remoteHandler(registry, "files/uploadImage"),
  );
  // —— 对齐批（AL）：上下文用量 + 技能面 ——
  ipcMain.handle(
    "server:sessionUsage",
    remoteHandler(registry, "session/usage"),
  );
  ipcMain.handle("server:skillsQuery", remoteHandler(registry, "skills/query"));
  ipcMain.handle("server:skillsRead", remoteHandler(registry, "skills/read"));
  ipcMain.handle(
    "server:skillsSetEnabled",
    remoteHandler(registry, "skills/setEnabled"),
  );
  ipcMain.handle(
    "server:assistantQuery",
    remoteHandler(registry, "assistant/query"),
  );
  ipcMain.handle(
    "server:workspaceList",
    remoteHandler(registry, "workspace/query"),
  );
  // —— 编排区遥控（GA-T8）：graph 五端点 + automation 四端点（同款透传） ——
  ipcMain.handle("server:graphQuery", remoteHandler(registry, "graph/query"));
  ipcMain.handle("server:graphSave", remoteHandler(registry, "graph/save"));
  ipcMain.handle("server:graphDelete", remoteHandler(registry, "graph/delete"));
  ipcMain.handle("server:graphRun", remoteHandler(registry, "graph/run"));
  ipcMain.handle(
    "server:graphRunAbort",
    remoteHandler(registry, "graph/runAbort"),
  );
  ipcMain.handle(
    "server:automationQuery",
    remoteHandler(registry, "automation/query"),
  );
  ipcMain.handle(
    "server:automationSave",
    remoteHandler(registry, "automation/save"),
  );
  ipcMain.handle(
    "server:automationDelete",
    remoteHandler(registry, "automation/delete"),
  );
  ipcMain.handle(
    "server:automationRunNow",
    remoteHandler(registry, "automation/runNow"),
  );
  // —— webhook 配置遥控（WH 消费端批）：无头端 graph/webhook/* 三端点
  // 同款透传（enable 重开换 token；路径带 graph/ 前缀是 WH 批安全裁定
  // ——管理面不落 /webhook/ 触发面守卫豁免前缀） ——
  ipcMain.handle(
    "server:webhookEnable",
    remoteHandler(registry, "graph/webhook/enable"),
  );
  ipcMain.handle(
    "server:webhookDisable",
    remoteHandler(registry, "graph/webhook/disable"),
  );
  ipcMain.handle(
    "server:webhookStatus",
    remoteHandler(registry, "graph/webhook/status"),
  );
  // —— ui-drive（UD-T2，spec §3.3）：被控桌面端 UI 驱动三端点透传
  // （openSession 配控制端按钮；notify/openRoute 协议端点供外部/调试，
  // spec §6 假设 2 不配 UI——通道面齐备按需调用） ——
  ipcMain.handle(
    "server:uiOpenSession",
    remoteHandler(registry, "ui/openSession"),
  );
  ipcMain.handle("server:uiNotify", remoteHandler(registry, "ui/notify"));
  ipcMain.handle("server:uiOpenRoute", remoteHandler(registry, "ui/openRoute"));
  // —— 桥审批应答（TB-T2，spec §4.2）：渲染层审批卡 → 主进程收敛挂起审批
  // （命中消费返回 true；未知/已超时返回 false——渲染层示 stale） ——
  ipcMain.handle("server:bridgeDecision", (_event, raw) => {
    const body = (raw ?? {}) as { requestId?: unknown; approved?: unknown };
    return bridgeExecutor.resolveDecision(
      typeof body.requestId === "string" ? body.requestId : "",
      body.approved === true,
    );
  });
}

/** 应用退出收口：拆全部 transport（停重连计时器）+ 停本地无头端 + 销毁桥窗 */
export async function shutdownServerConsole(): Promise<void> {
  serverConnections.closeAll();
  await stopLocalServer(serverConnections);
  destroyBridgeWindow();
}
