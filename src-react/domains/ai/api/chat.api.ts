/**
 * Chat 调用 API：发送（invoke）+ 流式事件订阅
 */

import { invoke, on } from "@/lib/ipc";

export interface ChatModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface ChatSendParams {
  sessionId: number;
  content: string;
  modelId?: number;
  overrides?: ChatModelParams;
}

export type ChatStreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "finish" }
  | { type: "error"; errorCode: string; message: string }
  | { type: "title-updated"; title: string }
  | {
      type: "tool-update";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      state:
        "ready" | "awaiting-approval" | "running" | "done" | "denied" | "error";
      output?: string;
    }
  | {
      type: "approval-request";
      toolCallId: string;
      toolName: string;
      argSummary: string;
    };

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
   * 查询会话流状态（切回会话恢复 UI，spec §4）
   */
  static async status(sessionId: number): Promise<ChatStatusResult> {
    return invoke<ChatStatusResult>("chat:status", sessionId);
  }

  /**
   * 发送消息（结果经 chat:stream:{sessionId} 事件推送，无返回值）
   */
  static async send(params: ChatSendParams): Promise<void> {
    return invoke<void>("chat:send", params);
  }

  /**
   * 重新生成最后一条回复（删除尾部消息原位重跑）
   */
  static async regenerate(
    sessionId: number,
    messageId?: number,
  ): Promise<void> {
    return invoke<void>("chat:regenerate", sessionId, messageId);
  }

  /**
   * 编辑 user 消息并重发（更新内容、删除其后全部消息、重跑流）
   */
  static async editAndResend(
    sessionId: number,
    messageId: number,
    content: string,
  ): Promise<void> {
    return invoke<void>("chat:editAndResend", sessionId, messageId, content);
  }

  /**
   * 停止会话进行中的流
   */
  static async stop(sessionId: number): Promise<void> {
    return invoke<void>("chat:stop", sessionId);
  }

  /**
   * 审批决议（P1：渲染层 → 主进程，resolve 挂起的 write 工具）
   */
  static async approveToolCall(
    toolCallId: string,
    approved: boolean,
  ): Promise<void> {
    return invoke<void>("agent:approve", toolCallId, approved);
  }

  /** 查询会话工具权限模式（P3）：default 询问 / full 放行 */
  static async getPermission(sessionId: number): Promise<"default" | "full"> {
    return invoke<"default" | "full">("permission:get", sessionId);
  }

  /** /compact 会话压缩(v8):摘要走一次流式 send 后落 session */
  static async compact(sessionId: number): Promise<void> {
    return invoke<void>("chat:compact", sessionId);
  }

  /** 设置会话工具权限模式（P3；主进程内存态，无会话校验） */
  static async setPermission(
    sessionId: number,
    mode: "default" | "full",
  ): Promise<void> {
    return invoke<void>("permission:set", sessionId, mode);
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
}

/**
 * 订阅会话流式 chunk，返回卸载函数
 */
export function onChatStream(
  sessionId: number,
  listener: (chunk: ChatStreamChunk) => void,
): () => void {
  return on(`chat:stream:${sessionId}`, (_, chunk) =>
    listener(chunk as ChatStreamChunk),
  );
}
