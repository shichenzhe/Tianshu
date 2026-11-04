// TB-T2 控制端桥执行面（spec §4）：无头端 tool.request 事件 → 本机隐藏
// BrowserWindow 单例（GuestControl：executeJavaScript/loadURL——BrowserWindow
// 天然实现该接口）上复用 mirror browser 四工具执行。
// 接线方式裁定：agent/browser-tools.ts 的工具函数与定义一体（makeBrowserTools
// 工厂闭包，不可独立调用），照 mirror chat 装配先例（tool-registry 经
// guestControlResolver 注入）——本侧 resolver 恒返回桥窗（桥窗与本地会话
// tab 无关，跨桥调用共享状态，spec §7 假设 2）。
// 审批分级（spec §4.2）：read（snapshot）+ navigate（工具内 SSRF 已守）
// 直接执行；write（click/type）推 server:bridgeApproval 审批卡等渲染层
// server:bridgeDecision 应答（拒绝为默认安全态；本地 30s 上限防悬空，
// 与 server 桥超时同款——审批等待计入超时）。
// 结果经 registry.request POST tool/respond 回传（transport 无关，spec §4.3）。
import { BrowserWindow, type WebContents } from "electron";
import Log from "../../commons/Log";
import type { BridgeToolResult, ToolRequestPayload } from "@tianshu/protocol";
import { isSsrfHost } from "../security/ssrf-hosts";
import { makeBrowserTools, type GuestControl } from "../ai/agent/browser-tools";
import type { ToolDefinition } from "../ai/agent/file-tools";

/** 审批等待本地上限（毫秒）：与 server config tianshu.bridge.timeoutMs 缺省
 *  同款 30s——超出按拒绝收敛，防渲染层无应答时 promise 悬空 */
export const BRIDGE_APPROVAL_TIMEOUT_MS = 30_000;

/** 用户拒绝的回传错误（spec §4.2 逐字；server 侧转「错误:」前缀回喂模型） */
export const BRIDGE_DENIED_ERROR = "denied by user";

/** 审批超时回传错误（区别于显式拒绝：无人应答） */
export const BRIDGE_APPROVAL_TIMEOUT_ERROR = "控制端审批超时（无人应答）";

// respond 端点载荷（spec §2.2）：requestId 一次性 + 判别结果——
// BridgeToolResult 定义在 @tianshu/protocol 单份（TB-T3 上提 ruling 4，
// server bridge-registry/tool DTO 同引）

/** 隐藏桥窗（模块级单例懒建；销毁后下次使用重建） */
let bridgeWindow: BrowserWindow | null = null;

/** 桥窗最近一次被安全门阻断的导航原因（loadURL 包装层把裸 ERR_ABORTED
 *  拒绝转成带原因可读错误的依据；每次 loadURL 前清零——共享单窗多请求
 *  并发时为近似归因，安全门结论优先于原始拒绝文案） */
let blockedNavReason: string | null = null;

/** 桥窗导航门复查（终审 F1）：仅 http/https 且非 SSRF 封锁主机放行（与
 *  browser-tools assertUrl 同口径；返回 null=放行，否则为阻断原因，
 *  fail-closed——非法 URL 亦阻断） */
function navBlockReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "无效 URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "仅支持 http/https";
  }
  if (isSsrfHost(parsed.hostname)) {
    return "禁止访问云 metadata 内网地址";
  }
  return null;
}

/** 桥窗加固（终审 F1，browser-session.ts 先例同款）：弹窗一律 deny
 *  （window.open/target=_blank 无 handler 会真开子窗——钓鱼/刷窗向量）+
 *  导航/重定向复查（页面自导航或 302 落封锁地址时 preventDefault 阻断
 *  ——防重定向绕初始 assertUrl；在途 loadURL 的 Promise 随之拒绝，经
 *  bridgeLoadURL 转可读错误传到工具层成为错误结果）。建窗时装配一次。 */
function hardenBridgeContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // event 按最小结构面收窄（Electron Event<T> 恒含 preventDefault）——
  // will-navigate/will-redirect 两 overloads 共用同一门
  const gate = (event: { preventDefault: () => void }, url: string): void => {
    const bad = navBlockReason(url);
    if (!bad) return;
    blockedNavReason = `${bad}: ${url}`;
    Log.warn("桥窗导航被安全门阻断", { url, reason: bad });
    event.preventDefault();
  };
  contents.on("will-navigate", gate);
  contents.on("will-redirect", gate);
}

/** loadURL 包装：安全门阻断（preventDefault → Chromium abort）时把裸
 *  ERR_ABORTED 拒绝转成带原因的可读错误——navigate 工具层 catch 后以
 *  「导航失败: …」文案回传（模块头注释的工具输出语义），对模型/用户
 *  可读；非安全门拒绝原样上抛 */
async function bridgeLoadURL(
  contents: WebContents,
  url: string,
): Promise<void> {
  blockedNavReason = null;
  try {
    return await contents.loadURL(url);
  } catch (e) {
    if (blockedNavReason) {
      throw new Error(`导航被桥窗安全门阻断（${blockedNavReason}）`, {
        cause: e,
      });
    }
    throw e;
  }
}

/** 桥窗访问口：BrowserWindow 单例实现 GuestControl（show:false 隐藏，
 *  无 node 集成/无 preload 暴露——spec §6；仅工具函数内固定脚本可达） */
export function bridgeGuestControl(): GuestControl | null {
  if (!bridgeWindow || bridgeWindow.isDestroyed()) {
    bridgeWindow = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    hardenBridgeContents(bridgeWindow.webContents);
  }
  const contents = bridgeWindow.webContents;
  return {
    executeJavaScript: (code: string) => contents.executeJavaScript(code),
    loadURL: (url: string) => bridgeLoadURL(contents, url),
  };
}

/** 应用退出收口：销毁隐藏桥窗（shutdownServerConsole 调用） */
export function destroyBridgeWindow(): void {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) {
    bridgeWindow.destroy();
  }
  bridgeWindow = null;
}

/** 审批卡广播（ipc.ts broadcast 同款：全部窗口；文件窗不订阅该通道） */
function broadcastBridgeApproval(payload: ToolRequestPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("server:bridgeApproval", payload);
  }
}

/** 审批应答三态 */
type ApprovalVerdict = "approved" | "denied" | "timeout";

interface PendingApproval {
  settle: (verdict: ApprovalVerdict) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 可注入依赖（测试替身面；缺省走隐藏桥窗/全窗广播/30s） */
export interface BridgeExecutorOptions {
  guestControl?: () => GuestControl | null;
  pushApproval?: (payload: ToolRequestPayload) => void;
  timeoutMs?: number;
}

export class BridgeExecutor {
  private readonly guestControl: () => GuestControl | null;
  private readonly pushApproval: (payload: ToolRequestPayload) => void;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly tools: ToolDefinition[];

  constructor(options: BridgeExecutorOptions = {}) {
    this.guestControl = options.guestControl ?? bridgeGuestControl;
    this.pushApproval = options.pushApproval ?? broadcastBridgeApproval;
    this.timeoutMs = options.timeoutMs ?? BRIDGE_APPROVAL_TIMEOUT_MS;
    this.tools = makeBrowserTools(() => this.guestControl());
  }

  /**
   * 执行一次桥工具调用：read/navigate 直执，write 经审批门（拒绝/超时回
   * ok:false）。工具输出为字符串（错误也以「错误:」文案返回，回喂模型
   * 语义在 server 侧收敛——ok:true 携原文不影响模型可见性）。
   */
  async execute(payload: ToolRequestPayload): Promise<BridgeToolResult> {
    const def = this.tools.find((tool) => tool.name === payload.tool);
    if (!def) {
      return { ok: false, error: `未知桥工具: ${String(payload.tool)}` };
    }
    if (def.kind === "write") {
      const verdict = await this.awaitApproval(payload);
      if (verdict !== "approved") {
        return {
          ok: false,
          error:
            verdict === "denied"
              ? BRIDGE_DENIED_ERROR
              : BRIDGE_APPROVAL_TIMEOUT_ERROR,
        };
      }
    }
    try {
      const output = await def.execute(
        { workspacePath: "", sessionId: payload.sessionId },
        payload.args,
      );
      return { ok: true, output };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * 渲染层应答入口（server:bridgeDecision INVOKE）：命中即消费返回 true；
   * 未知/已超时收敛返回 false（渲染层据此示 stale）。
   * 参数为原始 IPC 载荷形状校验后的收窄值。
   */
  resolveDecision(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.settle(approved ? "approved" : "denied");
    return true;
  }

  /** write 审批门：推送审批卡 → 等应答/超时两路收敛（推送失败按拒绝） */
  private awaitApproval(payload: ToolRequestPayload): Promise<ApprovalVerdict> {
    return new Promise<ApprovalVerdict>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(payload.requestId);
        resolve("timeout");
      }, this.timeoutMs);
      this.pending.set(payload.requestId, { settle: resolve, timer });
      try {
        this.pushApproval(payload);
      } catch (e) {
        Log.warn("桥审批卡推送失败（按拒绝收敛）", e);
        this.pending.delete(payload.requestId);
        clearTimeout(timer);
        resolve("denied");
      }
    });
  }
}

/** 全局单例（ipc.ts 事件路由与 decision handler 共用） */
export const bridgeExecutor = new BridgeExecutor();

/** respond 回传目标（ConnectionRegistry.request 结构面——结构类型免耦合） */
export interface BridgeRespondTarget {
  request(
    connId: string,
    method: "GET" | "POST",
    wirePath: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

/** 入口 in-flight 去重（终审 Minor）：tool.request 广播可达多连接（直连+
 *  relay 双活），同 requestId 重复进入会本地双执行（重复注入脚本/二次
 *  审批卡）——命中即跳过，完成/失败后清理 */
const inFlightRequestIds = new Set<string>();

/**
 * tool.request 事件入口（ipc.ts eventSink 过滤后调用）：执行（含 write
 * 审批门）→ POST tool/respond 回传。fire-and-forget（事件流无背压面）；
 * 回传失败仅记日志——server 侧超时自收敛，控制端不重试（requestId 一次性）。
 */
export function handleBridgeToolRequest(
  registry: BridgeRespondTarget,
  connId: string,
  payload: ToolRequestPayload,
): void {
  if (inFlightRequestIds.has(payload.requestId)) {
    Log.warn("重复桥请求（本地执行中，跳过重复进入）", payload.requestId);
    return;
  }
  inFlightRequestIds.add(payload.requestId);
  void bridgeExecutor
    .execute(payload)
    .then((result) =>
      registry.request(connId, "POST", "tool/respond", {
        requestId: payload.requestId,
        result,
      }),
    )
    .catch((e) => {
      Log.warn("桥应答回传失败（server 侧超时自收敛）", e);
    })
    .finally(() => {
      inFlightRequestIds.delete(payload.requestId);
    });
}
