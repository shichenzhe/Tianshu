// 控制端 IPC 面（T16）：连接注册表 CRUD/测试 + 本地无头端启停 + session
// 遥控透传（POST session/* 六端点——含 T17 approve 审批应答，被控端
// 协议契约——业务错 200+4xxx、send 202、认证 401/4010 → 注册表连接态
// invalid-token）+ 编排区遥控
// （GA-T8：graph/* 五端点 + automation/* 四端点同款透传，九端点面——
// 启停走 automation/save 全量 enabled 字段，无 toggle 端点，Ruling 12）。
// remoteHandler 端点路径全引 ENDPOINTS 常量（2026-11-01 审查架构债收敛：
// 43 处字面量改名只能运行时 4040 发现——键漂移编译期红，server-face
// routes.ts 同款口径）。
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
import fs from "node:fs";
import path from "node:path";
import { ENDPOINTS } from "@tianshu/protocol";
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
import { isExternalReadAllowed } from "../ai/chat/external-file-gate";

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
      event.type === "automation.changed" ||
      // 编排页路由化（orchestration 批 2026-11-10）：图定义级变更刷新
      // 信号（无头端写面/对话工具建图/启停 → 编排页列表失效重拉）
      event.type === "graph.changed" ||
      // 批③（2026-11-01）：空间/项目变更列表级刷新信号——远程主机态侧栏
      // 分组树失效消费（HostSwitcher onRemoteEvent 分支）
      event.type === "workspace.changed" ||
      event.type === "project.changed"
    ) {
      broadcast(`server:event:${connId}`, event);
    }
  });
  ipcMain.handle("server:connectionList", () => registry.list());
  ipcMain.handle("server:connectionSave", (_event, raw) =>
    registry.saveConnection(raw),
  );
  // 切换即连（2026-11-10）：HostSwitcher 对 idle 连接触发建链（activate
  // 持久化 activeConnId + fire-and-forget 建链；渲染层轮询 connected 再切）
  ipcMain.handle("server:connectionActivate", (_event, id: string) =>
    registry.activate(id),
  );
  ipcMain.handle("server:connectionDelete", (_event, raw) =>
    registry.deleteConnection(String(raw ?? "")),
  );
  // TOFU 指纹用户确认（P0-1 确认仪式）：协商指纹钉扎 + confirmedAt 落档，
  // 重建 transport 转 expectedFingerprint 强制校验
  ipcMain.handle("server:connectionConfirmFingerprint", (_event, raw) =>
    registry.confirmFingerprint(String(raw ?? "")),
  );
  ipcMain.handle("server:testConnection", (_event, raw) => registry.test(raw));
  ipcMain.handle("server:localStart", (_event, raw) =>
    startLocalServer(registry, String(raw ?? "")),
  );
  ipcMain.handle("server:localStop", () => stopLocalServer(registry));
  ipcMain.handle("server:localStatus", () => localServerStatus());
  ipcMain.handle(
    "server:sessionList",
    remoteHandler(registry, ENDPOINTS.session.query),
  );
  ipcMain.handle(
    "server:sessionGet",
    remoteHandler(registry, ENDPOINTS.session.getById),
  );
  ipcMain.handle("server:sessionSend", remoteHandler(registry, ENDPOINTS.session.send));
  ipcMain.handle(
    "server:sessionAbort",
    remoteHandler(registry, ENDPOINTS.session.abort),
  );
  ipcMain.handle(
    "server:sessionCreate",
    remoteHandler(registry, ENDPOINTS.session.create),
  );
  ipcMain.handle(
    "server:sessionDelete",
    remoteHandler(registry, ENDPOINTS.session.delete),
  );
  // 审批应答（T17）：approve 透传——4040=已被处理/已失效，渲染层 Banner
  // 内联提示（与移动端同协议）
  ipcMain.handle(
    "server:sessionApprove",
    remoteHandler(registry, ENDPOINTS.session.approve),
  );
  // —— 模型面（会话指定模型配套）：provider 查/存透传——headless 有
  // save 端点（upsert 数组语义，密钥脱敏回显），desktop 被控面 provider
  // 只读（无 save 路由，调用将 404——UI 按 headless 判定隐藏编辑表单） ——
  ipcMain.handle(
    "server:providerQuery",
    remoteHandler(registry, ENDPOINTS.provider.query),
  );
  ipcMain.handle(
    "server:providerSave",
    remoteHandler(registry, ENDPOINTS.provider.save),
  );
  // —— 模型面打磨（FA 批）：删除/测试/上游拉取 + 会话重命名 + 专家列表 ——
  ipcMain.handle(
    "server:providerDelete",
    remoteHandler(registry, ENDPOINTS.provider.delete),
  );
  ipcMain.handle(
    "server:providerTest",
    remoteHandler(registry, ENDPOINTS.provider.test),
  );
  ipcMain.handle(
    "server:providerFetchModels",
    remoteHandler(registry, ENDPOINTS.provider.fetchModels),
  );
  ipcMain.handle(
    "server:sessionUpdate",
    remoteHandler(registry, ENDPOINTS.session.update),
  );
  ipcMain.handle(
    "server:sessionRegenerate",
    remoteHandler(registry, ENDPOINTS.session.regenerate),
  );
  // —— 聊天面板对齐（CU 批）：编辑重发 + 权限模式（get/set 合一） ——
  ipcMain.handle(
    "server:sessionEditResend",
    remoteHandler(registry, ENDPOINTS.session.editAndResend),
  );
  ipcMain.handle(
    "server:sessionAccessMode",
    remoteHandler(registry, ENDPOINTS.session.accessMode),
  );
  // —— P1 尾未读角标：已读推进透传（session/read，与移动端上报同语义） ——
  ipcMain.handle("server:sessionRead", remoteHandler(registry, ENDPOINTS.session.read));
  // —— 会话内工具批（A9）：压缩 202 受理 + 润色同步透传（两端被控面
  //  session/compact、session/polish 齐备——修复前缺注册致远程恒走
  //  本地通道） ——
  ipcMain.handle(
    "server:sessionCompact",
    remoteHandler(registry, ENDPOINTS.session.compact),
  );
  ipcMain.handle(
    "server:sessionPolish",
    remoteHandler(registry, ENDPOINTS.session.polish),
  );
  // —— 文件面（FA-T3，spec 2026-10-20）：files 三端点透传 ——
  ipcMain.handle("server:filesList", remoteHandler(registry, ENDPOINTS.files.list));
  ipcMain.handle("server:filesRead", remoteHandler(registry, ENDPOINTS.files.read));
  ipcMain.handle(
    "server:filesUploadImage",
    remoteHandler(registry, ENDPOINTS.files.uploadImage),
  );
  // —— 对齐批（AL）：上下文用量 + 技能面 ——
  ipcMain.handle(
    "server:sessionUsage",
    remoteHandler(registry, ENDPOINTS.session.usage),
  );
  ipcMain.handle("server:skillsQuery", remoteHandler(registry, ENDPOINTS.skills.query));
  ipcMain.handle("server:skillsRead", remoteHandler(registry, ENDPOINTS.skills.read));
  ipcMain.handle(
    "server:skillsSetEnabled",
    remoteHandler(registry, ENDPOINTS.skills.setEnabled),
  );
  ipcMain.handle(
    "server:assistantQuery",
    remoteHandler(registry, ENDPOINTS.assistant.query),
  );
  ipcMain.handle(
    "server:workspaceList",
    remoteHandler(registry, ENDPOINTS.workspace.query),
  );
  // —— 工作空间写面透传（2026-11-09 批：face A8 端点已装配，控制端补
  //    接线——远程态「新建空间」可用；bindDirectory 仍按 spec §1.4 留
  //    桌面端本地，无透传）——
  ipcMain.handle(
    "server:workspaceCreate",
    remoteHandler(registry, ENDPOINTS.workspace.create),
  );
  ipcMain.handle(
    "server:workspaceUpdate",
    remoteHandler(registry, ENDPOINTS.workspace.update),
  );
  ipcMain.handle(
    "server:workspaceDelete",
    remoteHandler(registry, ENDPOINTS.workspace.delete),
  );
  // —— 监控读面（P0-1，spec monitoring.md §6）：monitor/stats 透传——
  //  monitor.api 主机路由化（本地 monitor:stats / 远程此通道），两端
  //  被控面均含 monitor capability ——
  ipcMain.handle("server:monitorStats", remoteHandler(registry, ENDPOINTS.monitor.stats));
  // —— 编排区遥控（GA-T8）：graph 五端点 + automation 四端点（同款透传） ——
  ipcMain.handle("server:graphQuery", remoteHandler(registry, ENDPOINTS.graph.query));
  ipcMain.handle("server:graphSave", remoteHandler(registry, ENDPOINTS.graph.save));
  ipcMain.handle("server:graphDelete", remoteHandler(registry, ENDPOINTS.graph.delete));
  ipcMain.handle("server:graphRun", remoteHandler(registry, ENDPOINTS.graph.run));
  ipcMain.handle(
    "server:graphRunAbort",
    remoteHandler(registry, ENDPOINTS.graph.runAbort),
  );
  // —— 编排页路由化（orchestration 批 2026-11-10）：toggle 直达端点 +
  //   图运行历史两读面（automation/runPage graphId 过滤 + runNodes
  //   节点级行；编排页 GraphApi.runs/runNodes 的远程通道） ——
  ipcMain.handle(
    "server:graphToggle",
    remoteHandler(registry, ENDPOINTS.graph.toggle),
  );
  ipcMain.handle(
    "server:graphRuns",
    remoteHandler(registry, ENDPOINTS.automation.runPage),
  );
  ipcMain.handle(
    "server:graphRunNodes",
    remoteHandler(registry, ENDPOINTS.automation.runNodes),
  );
  ipcMain.handle(
    "server:automationQuery",
    remoteHandler(registry, ENDPOINTS.automation.query),
  );
  ipcMain.handle(
    "server:automationSave",
    remoteHandler(registry, ENDPOINTS.automation.save),
  );
  ipcMain.handle(
    "server:automationDelete",
    remoteHandler(registry, ENDPOINTS.automation.delete),
  );
  ipcMain.handle(
    "server:automationRunNow",
    remoteHandler(registry, ENDPOINTS.automation.runNow),
  );
  // —— 自动化任务页路由化（automation/library 批 2026-11-10）：运行历史
  //   任务口径（taskId+status 过滤；graphRuns 为图口径同端点） ——
  ipcMain.handle(
    "server:automationRuns",
    remoteHandler(registry, ENDPOINTS.automation.runPage),
  );
  // —— 健康度总览原始行集（automation/library 批挂账收口 2026-11-10）：
  //   时区敏感聚合在渲染层 computeStats（core 单源）完成 ——
  ipcMain.handle(
    "server:automationStats",
    remoteHandler(registry, ENDPOINTS.automation.stats),
  );
  // —— 资料库路由化（automation/library 批）：library/* 十七端点同款
  //   透传（结构 CRUD + 收藏/打点 + read/readImage 内容读 + writeContent
  //   内容写；uploadFile 未接——本地盘导入深水门控挂账） ——
  ipcMain.handle("server:libraryList", remoteHandler(registry, ENDPOINTS.library.list));
  ipcMain.handle("server:libraryTree", remoteHandler(registry, ENDPOINTS.library.tree));
  ipcMain.handle("server:librarySearch", remoteHandler(registry, ENDPOINTS.library.search));
  ipcMain.handle(
    "server:libraryListRecent",
    remoteHandler(registry, ENDPOINTS.library.listRecent),
  );
  ipcMain.handle(
    "server:libraryListFavorites",
    remoteHandler(registry, ENDPOINTS.library.listFavorites),
  );
  ipcMain.handle(
    "server:libraryCreateFolder",
    remoteHandler(registry, ENDPOINTS.library.createFolder),
  );
  ipcMain.handle(
    "server:libraryCreateFile",
    remoteHandler(registry, ENDPOINTS.library.createFile),
  );
  ipcMain.handle("server:libraryAddLink", remoteHandler(registry, ENDPOINTS.library.addLink));
  ipcMain.handle("server:libraryRename", remoteHandler(registry, ENDPOINTS.library.rename));
  ipcMain.handle("server:libraryMove", remoteHandler(registry, ENDPOINTS.library.move));
  ipcMain.handle("server:libraryDelete", remoteHandler(registry, ENDPOINTS.library.delete));
  ipcMain.handle(
    "server:librarySubtreeCount",
    remoteHandler(registry, ENDPOINTS.library.subtreeCount),
  );
  ipcMain.handle(
    "server:libraryToggleFavorite",
    remoteHandler(registry, ENDPOINTS.library.toggleFavorite),
  );
  ipcMain.handle(
    "server:libraryMarkViewed",
    remoteHandler(registry, ENDPOINTS.library.markViewed),
  );
  ipcMain.handle("server:libraryRead", remoteHandler(registry, ENDPOINTS.library.read));
  ipcMain.handle(
    "server:libraryReadImage",
    remoteHandler(registry, ENDPOINTS.library.readImage),
  );
  ipcMain.handle(
    "server:libraryWriteContent",
    remoteHandler(registry, ENDPOINTS.library.writeContent),
  );
  // —— 跨端上传组合（automation/library 批挂账收口 2026-11-10）——
  //   控制端本地文件（选择器/拖拽授权路径）读盘 base64 → 远端
  //   library/uploadFile 逐个入库；paths 过 external-file-gate 授权门
  //   （未授权路径直接拒——与 file:readExternalFile 同口径防任意读），
  //   ≤3MB 对齐 server 上限（超限入 failed 不发往返）；同层重名序号在
  //   server 侧。importFolder（目录树组合）仍门控挂账。
  ipcMain.handle(
    "server:libraryAddFiles",
    async (_event, raw: unknown, connId?: unknown) => {
      const body = (raw ?? {}) as { paths?: unknown; parentId?: unknown };
      const pathsIn = Array.isArray(body.paths) ? body.paths : [];
      const parentId =
        typeof body.parentId === "number" ? body.parentId : null;
      const targetConnId =
        typeof connId === "string" && connId ? connId : null;
      const UPLOAD_LIMIT_BYTES = 3 * 1024 * 1024;
      const added: unknown[] = [];
      const failed: Array<{ path: string; reason: string }> = [];
      for (const rawPath of pathsIn) {
        const absPath = typeof rawPath === "string" ? rawPath : "";
        if (!absPath) {
          continue;
        }
        const name = path.basename(absPath);
        try {
          if (!isExternalReadAllowed(absPath)) {
            throw new Error("未授权的文件路径");
          }
          const stat = await fs.promises.stat(absPath);
          if (!stat.isFile()) {
            throw new Error("非普通文件");
          }
          if (stat.size > UPLOAD_LIMIT_BYTES) {
            throw new Error("超过 3MB 上限");
          }
          const buf = await fs.promises.readFile(absPath);
          // registry.request 出原始信封 {status, body}——同渲染层
          // requestRemote 拆封语义（success=false 的业务错入 failed）
          const envelope = (await registry.request(
            targetConnId,
            "POST",
            ENDPOINTS.library.uploadFile,
            {
              name,
              base64: buf.toString("base64"),
              ...(parentId !== null ? { parentId } : {}),
            },
          )) as { body?: { success?: boolean; data?: unknown; message?: unknown } };
          const wire = envelope?.body;
          if (!wire || wire.success !== true) {
            throw new Error(
              typeof wire?.message === "string" ? wire.message : "上传失败",
            );
          }
          added.push(wire.data);
        } catch (e) {
          failed.push({
            path: absPath,
            reason: e instanceof Error ? e.message : "上传失败",
          });
        }
      }
      return { added, failed };
    },
  );
  // —— 跨端目录导入组合（挂账收口 2026-11-11）：本地 importFolder 同构
  //   （目录名建根 → 递归建层 + 逐文件上传；隐藏文件跳过；单条失败不
  //   阻断批次）——dirPath 来自主进程目录选择器（不经渲染层授权链，与
  //   本地 library:importFolder 同口径）；建层/入库走远端
  //   createFolder/uploadFile，信封拆封同上。
  ipcMain.handle(
    "server:libraryImportFolder",
    async (_event, raw: unknown, connId?: unknown) => {
      const body = (raw ?? {}) as { dirPath?: unknown; parentId?: unknown };
      const dirPath = typeof body.dirPath === "string" ? body.dirPath : "";
      const parentId =
        typeof body.parentId === "number" ? body.parentId : null;
      const targetConnId =
        typeof connId === "string" && connId ? connId : null;
      const UPLOAD_LIMIT_BYTES = 3 * 1024 * 1024;
      const request = async (
        endpoint: string,
        payload: object,
      ): Promise<{ id?: number }> => {
        const envelope = (await registry.request(
          targetConnId,
          "POST",
          endpoint,
          payload,
        )) as {
          body?: { success?: boolean; data?: unknown; message?: unknown };
        };
        const wire = envelope?.body;
        if (!wire || wire.success !== true) {
          throw new Error(
            typeof wire?.message === "string" ? wire.message : "请求失败",
          );
        }
        return wire.data as { id?: number };
      };
      /** 递归铺目录内容（镜像本地 importDirContents 语义） */
      const importDir = async (
        dir: string,
        folderId: number,
      ): Promise<{
        added: unknown[];
        failed: Array<{ path: string; reason: string }>;
      }> => {
        const entries = await fs.promises.readdir(dir, {
          withFileTypes: true,
        });
        const result = {
          added: [] as unknown[],
          failed: [] as Array<{ path: string; reason: string }>,
        };
        for (const entry of entries) {
          if (entry.name.startsWith(".")) {
            continue;
          }
          const absPath = path.join(dir, entry.name);
          try {
            if (entry.isDirectory()) {
              const sub = await request(ENDPOINTS.library.createFolder, {
                name: entry.name,
                parentId: folderId,
              });
              const subResult = await importDir(
                absPath,
                typeof sub.id === "number" ? sub.id : folderId,
              );
              result.added.push(...subResult.added);
              result.failed.push(...subResult.failed);
            } else if (entry.isFile()) {
              const stat = await fs.promises.stat(absPath);
              if (stat.size > UPLOAD_LIMIT_BYTES) {
                throw new Error("超过 3MB 上限");
              }
              const buf = await fs.promises.readFile(absPath);
              const row = await request(ENDPOINTS.library.uploadFile, {
                name: entry.name,
                base64: buf.toString("base64"),
                parentId: folderId,
              });
              result.added.push(row);
            }
          } catch (e) {
            result.failed.push({
              path: absPath,
              reason: e instanceof Error ? e.message : "导入失败",
            });
          }
        }
        return result;
      };
      try {
        const stat = await fs.promises.stat(dirPath);
        if (!stat.isDirectory()) {
          throw new Error("源路径不是目录");
        }
      } catch (e) {
        return {
          added: [],
          failed: [
            {
              path: dirPath,
              reason: e instanceof Error ? e.message : "源目录不存在",
            },
          ],
        };
      }
      try {
        const root = await request(ENDPOINTS.library.createFolder, {
          name: path.basename(dirPath),
          parentId,
        });
        return importDir(dirPath, typeof root.id === "number" ? root.id : 0);
      } catch (e) {
        return {
          added: [],
          failed: [
            {
              path: dirPath,
              reason: e instanceof Error ? e.message : "导入失败",
            },
          ],
        };
      }
    },
  );
  // —— webhook 配置遥控（WH 消费端批）：无头端 graph/webhook/* 三端点
  // 同款透传（enable 重开换 token；路径带 graph/ 前缀是 WH 批安全裁定
  // ——管理面不落 /webhook/ 触发面守卫豁免前缀） ——
  ipcMain.handle(
    "server:webhookEnable",
    remoteHandler(registry, ENDPOINTS.webhook.enable),
  );
  ipcMain.handle(
    "server:webhookDisable",
    remoteHandler(registry, ENDPOINTS.webhook.disable),
  );
  ipcMain.handle(
    "server:webhookStatus",
    remoteHandler(registry, ENDPOINTS.webhook.status),
  );
  // —— ui-drive（UD-T2，spec §3.3）：被控桌面端 UI 驱动三端点透传
  // （openSession 配控制端按钮；notify/openRoute 协议端点供外部/调试，
  // spec §6 假设 2 不配 UI——通道面齐备按需调用） ——
  ipcMain.handle(
    "server:uiOpenSession",
    remoteHandler(registry, ENDPOINTS.ui.openSession),
  );
  ipcMain.handle("server:uiNotify", remoteHandler(registry, ENDPOINTS.ui.notify));
  ipcMain.handle("server:uiOpenRoute", remoteHandler(registry, ENDPOINTS.ui.openRoute));
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
