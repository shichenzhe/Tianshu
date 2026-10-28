/**
 * Chat 调用 API：发送（invoke）+ 流式事件订阅
 * 线上契约类型（ChatModelParams/ChatSendImage/ChatSendParams/
 * ChatStreamChunk）已收编 @tianshu/protocol（共享 core 重构 RC-T1），
 * 本文件 re-export 兼容——老 import 链不变；ChatStatusResult/PolishStyle
 * 为本机 IPC 形态非线上契约，留原地。
 * 流式五方法（send/regenerate/editAndResend/stop/usage）、onChatStream、
 * status、审批 approveToolCall 与权限 get/set 已主机路由化（HD-T3/P2a）：
 * 本地 invoke 原通道参数逐字；远程走 server:* 对应端点。其余方法
 * （polish/compact/工作空间记忆等）仍本地 IPC——polish/compact 远程
 * 不支持由 caps 门控。
 */

import { invoke } from "@/lib/ipc";
import type {
  ChatModelParams,
  ChatSendImage,
  ChatSendParams,
  ChatStreamChunk,
  SessionUsageBreakdown,
} from "@tianshu/protocol";
import { routeInvoke } from "@/domains/ai/data-source/host-route";
import { onChatStream as routeOnChatStream } from "@/domains/ai/data-source/chat-stream";
import * as remoteFiles from "@/domains/ai/data-source/remote-files";
import ServerApi from "@/domains/ai/server/api/server.api";

export type { ChatModelParams, ChatSendImage, ChatSendParams, ChatStreamChunk };

export interface ChatStatusResult {
  streaming: boolean;
  /** P3：会话工具权限模式（default 询问 / full 放行），切回会话恢复胶囊状态用 */
  accessMode: "default" | "full";
  text: string;
  thinking: string;
  /** P1：流式工具态（保序），切回会话恢复 agent 进度用 */
  tools: {
    order: string[];
    map: Record<
      string,
      {
        toolName: string;
        args?: unknown;
        state: string;
        output?: string;
        argSummary?: string;
      }
    >;
  };
}

export type PolishStyle = "professional" | "concise" | "translate-en";

export default class ChatApi {
  /**
   * 查询会话流状态（切回会话恢复 UI，spec §4）；远程主机 P1 简化（spec
   * §4 风险 3）：无同步 status 端点，恒返回非流式态——活跃流由 UI stream
   * 订阅态表达，断连残留竞态由 server.connected 重连全量刷新兜底。
   * accessMode 远程走 sessionAccessMode 查询对齐本地快照语义。
   */
  static async status(sessionId: number): Promise<ChatStatusResult> {
    return routeInvoke(
      { ch: "chat:status", args: [sessionId] },
      async (connId) => {
        const { mode } = await ServerApi.sessionAccessMode(
          sessionId,
          undefined,
          connId,
        );
        return {
          streaming: false,
          accessMode: mode,
          text: "",
          thinking: "",
          tools: { order: [], map: {} },
        };
      },
    );
  }

  /**
   * 发送消息（结果经 chat:stream:{sessionId} 事件推送，无返回值）；
   * 空 images 归一化掉（无附件时载荷与既往一致）
   */
  static async send(params: ChatSendParams): Promise<void> {
    const { images, ...rest } = params;
    // 远程链（FA-T3 图片批）：带 base64 的图逐张上传被控端 attachments/
    // （files/uploadImage），返回的数据根相对路径进 sessionSend.images
    // 落 ImageBlock——远端引擎 loadImage 回喂零适配。图片引用不正常
    // （无 base64 的本地路径图——补齐链 [粘贴 LT-T1/剪贴板兜底] 以外的
    // 场景，如资料库图片 pill；上传业务错/网络错由 ServerApi throw）一律
    // 阻断发送（裁定 2026-10-21：明确图片正常才发文本，不静默剔图发纯文）
    return routeInvoke(
      {
        ch: "chat:send",
        args: [{ ...rest, ...(images && images.length > 0 ? { images } : {}) }],
      },
      async (connId) => {
        // 先全量校验再上传（快速失败——不因序列后半的坏图浪费前半上传）
        if ((images ?? []).some((image) => !image.base64)) {
          throw new Error("REMOTE_IMAGE_UNAVAILABLE");
        }
        const remoteImages: string[] = [];
        for (const image of images ?? []) {
          const { imagePath } = await remoteFiles.uploadImage(
            {
              name: image.absPath.split("/").pop() || "image.png",
              base64: image.base64!,
            },
            connId,
          );
          remoteImages.push(imagePath);
        }
        await ServerApi.sessionSend(
          params.sessionId,
          params.content,
          connId,
          params.modelId,
          undefined,
          remoteImages.length > 0 ? remoteImages : undefined,
        );
      },
    );
  }

  /**
   * 重新生成最后一条回复（删除尾部消息原位重跑）
   */
  static async regenerate(
    sessionId: number,
    messageId?: number,
  ): Promise<void> {
    return routeInvoke(
      { ch: "chat:regenerate", args: [sessionId, messageId] },
      (connId) => ServerApi.sessionRegenerate(sessionId, messageId, connId),
    );
  }

  /**
   * 编辑 user 消息并重发（更新内容、删除其后全部消息、重跑流）
   */
  static async editAndResend(
    sessionId: number,
    messageId: number,
    content: string,
  ): Promise<void> {
    return routeInvoke(
      { ch: "chat:editAndResend", args: [sessionId, messageId, content] },
      (connId) =>
        ServerApi.sessionEditResend(sessionId, messageId, content, connId),
    );
  }

  /**
   * 停止会话进行中的流
   */
  static async stop(sessionId: number): Promise<void> {
    return routeInvoke({ ch: "chat:stop", args: [sessionId] }, (connId) =>
      ServerApi.sessionAbort(sessionId, connId),
    );
  }

  /** 上下文用量五类拆解（本地 ContextUsageBreakdown 与远程
   * SessionUsageBreakdown 同构；未配模型 null——UI 灰态） */
  static async usage(sessionId: number): Promise<SessionUsageBreakdown | null> {
    return routeInvoke({ ch: "chat:usage", args: [sessionId] }, (connId) =>
      ServerApi.sessionUsage(sessionId, connId),
    );
  }

  /**
   * 审批决议（P1：渲染层 → 主进程，resolve 挂起的 write 工具）；
   * HD-P2a 主机路由：本地 agent:approve 只收 toolCallId（sessionId
   * 不上行——参数逐字）；远程 approveSession 需 sessionId 定位会话；
   * rememberToolName（审批记住批）仅远程分支消费——远程态「允许并
   *  记住」单次上送（本地走 rememberTool IPC 两步，原语义不变）
   */
  static async approveToolCall(
    sessionId: number,
    toolCallId: string,
    approved: boolean,
    rememberToolName?: string,
  ): Promise<void> {
    return routeInvoke(
      { ch: "agent:approve", args: [toolCallId, approved] },
      (connId) =>
        // 无 remember 保持原四参形状（既有路由测试断言零扰动）
        rememberToolName != null
          ? ServerApi.approveSession(connId, sessionId, toolCallId, approved, {
              toolName: rememberToolName,
            })
          : ServerApi.approveSession(connId, sessionId, toolCallId, approved),
    );
  }

  /** 查询会话工具权限模式（P3）：default 询问 / full 放行；
   *  远程 sessionAccessMode get 合一端点（mode 缺省查询） */
  static async getPermission(sessionId: number): Promise<"default" | "full"> {
    return routeInvoke(
      { ch: "permission:get", args: [sessionId] },
      async (connId) =>
        (await ServerApi.sessionAccessMode(sessionId, undefined, connId)).mode,
    );
  }

  /** /compact 会话压缩(v8):摘要走一次流式 send 后落 session */
  static async compact(sessionId: number): Promise<void> {
    return invoke<void>("chat:compact", sessionId);
  }

  /** 设置会话工具权限模式（P3；主进程内存态，无会话校验）；
   *  远程 sessionAccessMode set 语义（被控端内存态） */
  static async setPermission(
    sessionId: number,
    mode: "default" | "full",
  ): Promise<void> {
    return routeInvoke(
      { ch: "permission:set", args: [sessionId, mode] },
      async (connId) => {
        await ServerApi.sessionAccessMode(sessionId, mode, connId);
      },
    );
  }

  /** 工作空间级工具记忆（P4，参照 Claude Code allowed-tools）：记住后免审 */
  static async rememberTool(
    workspaceId: number,
    toolName: string,
  ): Promise<void> {
    return invoke<void>("permission:rememberTool", workspaceId, toolName);
  }

  /** 已记忆工具清单（工作空间级） */
  static async listAllowedTools(workspaceId: number): Promise<string[]> {
    return invoke<string[]>("permission:listAllowedTools", workspaceId);
  }

  /** 撤销某工具的工作空间记忆 */
  static async forgetTool(
    workspaceId: number,
    toolName: string,
  ): Promise<void> {
    return invoke<void>("permission:forgetTool", workspaceId, toolName);
  }

  /** 新建任务落地页润色（一次性补全，不落库不建 session） */
  static async polish(params: {
    workspaceId: number;
    text: string;
    style: PolishStyle;
  }): Promise<{ text: string }> {
    return invoke<{ text: string }>("chat:polish", params);
  }

  /** 会话转办交接摘要（批 12）：五段式 markdown，一次性补全不落库 */
  static async handoverSummary(sessionId: number): Promise<string> {
    return invoke<string>("chat:handoverSummary", sessionId);
  }

  /** dataUrl 图片另存为（聊天输出导出批）：主进程弹保存对话框（校验与
   *  默认名清洗见 media-export），用户取消返回 null。本地专属（无远程端点，
   *  截图/导出均针对本机窗口与文件） */
  static async saveImageFile(
    dataUrl: string,
    defaultName: string,
  ): Promise<string | null> {
    return invoke<string | null>("file:saveDataUrl", dataUrl, defaultName);
  }

  /** widget 图表区域截图（iframe getBoundingClientRect，DIP）→ PNG dataUrl */
  static async captureWidget(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<string> {
    return invoke<string>("widget:capture", rect);
  }
}

/**
 * 订阅会话流式 chunk，返回卸载函数（HD-T3 主机路由：本地
 * chat:stream:<sessionId> / 远程 server:chunk:<connId>:<sessionId>，
 * 载荷同为 ChatStreamChunk 原样透传）
 */
export function onChatStream(
  sessionId: number,
  listener: (chunk: ChatStreamChunk) => void,
): () => void {
  return routeOnChatStream(sessionId, listener);
}
