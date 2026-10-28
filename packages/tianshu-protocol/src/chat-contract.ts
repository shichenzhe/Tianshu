/**
 * chat 线上契约类型（RC-T1 自 mirror 收编，原位改 re-export）：
 * - ChatSendParams/ChatModelParams/ChatSendImage：session/send 请求体与
 *   本机 IPC chat:send 的共用形态；
 * - ChatStreamChunk：流式增量协议（SSE message.chunk / IPC
 *   chat:stream:{sessionId} / relay event 帧三承载同构，全部 chunk 类型
 *   不过滤原样透传——title-updated 等控制型 chunk 由控制端自行识别消费）；
 * - TextBlock..MessageBlock：消息 blocks 持久化协议（message.blocks 列
 *   文本的 JSON 形态，双仓零翻译复用——tianshu-server spec §3.1）。
 * 历史出处在 mirror src-react/domains/ai/api/chat.api.ts 与
 * electron/domains/ai/chat/blocks.ts（现为 re-export 兼容层，老 import
 * 链不变）。
 */

export interface ChatModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

/** 用户消息图片附件（绝对路径；主进程校验须在 attachments/library 数据子目录内） */
export interface ChatSendImage {
  absPath: string;
  /** FA-T3 远程图片链：控制端图片字节（粘贴/拖拽 blob 直接转存，不落
   *  控制端盘）；远程主机 send 时经 files/uploadImage 上传被控端，
   *  本地链忽略该字段（absPath 落盘链照常） */
  base64?: string;
}

export interface ChatSendParams {
  sessionId: number;
  content: string;
  modelId?: number;
  overrides?: ChatModelParams;
  /** 图片附件（多模态输入，视觉模型识别）；缺省纯文本 */
  images?: ChatSendImage[];
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

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface UsageBlock {
  type: "usage";
  input: number;
  output: number;
}

export interface ToolCallBlock {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  state:
    "ready" | "awaiting-approval" | "running" | "done" | "denied" | "error";
  output?: unknown;
}

/**
 * 用户消息图片块：多模态输入（视觉模型识图）。imagePath 为相对数据根
 * 路径（attachments/xxx.png、library/xxx.png——数据根迁移后仍有效），
 * base64 不落库（防 SQLite 膨胀），回喂/展示时按路径读盘。
 */
export interface ImageBlock {
  type: "image";
  imagePath: string;
  mime: string;
  /** 展示名（原文件名，降级占位提示用） */
  name?: string;
}

export type MessageBlock =
  TextBlock | ThinkingBlock | UsageBlock | ToolCallBlock | ImageBlock;

/** 审批应答（移动端 spec §4.1）：批准/拒绝挂起的 write 工具调用；
 *  remember=true 时被控端写工作空间级工具记忆（toolPermission 持久行，
 *  归属校验在被控端收口——审批记住批；approved=false 时忽略） */
export interface ApproveParams {
  sessionId: number;
  toolCallId: string;
  approved: boolean;
  /** remember=true 时被控端写工作空间级工具记忆（toolPermission 持久行，
   *  归属校验在被控端收口——审批记住批；approved=false 时忽略） */
  remember?: boolean;
  /** remember 时由控制端上送的 pending 工具名（token 全权语义下可接受；
   *  被控端仍校验会话归属，写行落会话所属工作空间） */
  toolName?: string;
}

/** 图片读取响应（移动端 spec §4.2）：base64 单一形态，direct/relay 同构 */
export interface ImagePayload {
  mime: string;
  dataBase64: string;
}

/**
 * provider/query 脱敏掩码（M5 终审安全跟踪项）：两仓查询响应将
 * apiKey/extraHeaders 有值时替换为该常量（空值保持原样——空与已配置
 * 可区分）；控制端（移动端/远控台）只读展示字段，save 回传该掩码时
 * 服务端按未传处理保持现值，勿当真实密钥回写。
 */
export const REDACTED_SECRET = "__REDACTED__";
