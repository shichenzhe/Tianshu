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
  /** 技能引用（skill_ref 批）：引用 ⚡技能 名单——落 SkillRefBlock 前置
   *  于 text 块（消息库不存全文，组装侧 loadSkill 展开注入）；
   *  缺省走旧 text 前缀注入形态（历史兼容） */
  skillRefs?: string[];
  /** 内容注入式文件引用（file_ref 批）：path+内容随块落库（组装侧直取
   *  展开，渲染零泄漏）；缺省走旧 text 前缀注入形态（历史兼容） */
  contentRefs?: Array<{ path: string; content: string }>;
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

/**
 * 技能引用块（user 消息）：引用 ⚡技能 落块的形态——只存技能名，全文由
 * 组装侧 loadSkill 展开注入（对齐 WorkBuddy resource_link 语义：消息库
 * 不膨胀、技能改版后重发取新版全文；引用块前置于 text，与旧注入前缀
 * 同序）。渲染侧独立技能卡片（点击按名预览全文）。
 */
export interface SkillRefBlock {
  type: "skill_ref";
  /** 技能名（readSkill 键） */
  name: string;
}

/**
 * 文件内容引用块（user 消息，file_ref 批）：内容注入式文件引用的落块
 * 形态——**内容随块落库**（发送侧已按授权门读到的文本原样入块，组装侧
 * 直接展开 `[引用文件 path]\n<内容>`，零重读零 TOCTOU——消息库体积与
 * 旧 text 前缀注入形态持平）。根治渲染层从扁平 text 逆推的空行切段泄漏
 * （与 skill_ref 同构范式：块化即渲染无歧义）；引用式（路径行 + AI 自读
 * 指示，无空行问题）维持 text 前缀形态不动。
 */
export interface FileRefBlock {
  type: "file_ref";
  /** 文件路径（展示与注入前缀标识；卡片预览走既有文件通道） */
  path: string;
  /** 文件文本内容（发送侧授权读取的结果；空文件为空串） */
  content: string;
}

/**
 * 专家团成员产出块（assistant 消息，专家团可观测性批 2026-11-05）：
 * dispatch 成员补全的结构化留痕——落库落卡可审计，但**不回喂模型**
 * （dispatch tool_call 块的 output 已携带同文作为 tool-result 回喂，
 * 此处再进正文会双份）。增量可选块型：老端遇未知块型经 isValidBlock
 * 丢弃不炸。
 */
export interface MemberReportBlock {
  type: "memberReport";
  /** 成员名（展示用；args.member id 经成员清单解析，缺席回退 id 原文） */
  memberName: string;
  /** 本轮交给成员的任务描述（dispatch args.task） */
  task: string;
  /** 成员产出原文 */
  content: string;
  /** 当次请求内第几次成员调度（1 起） */
  round: number;
}

export type MessageBlock =
  | TextBlock
  | ThinkingBlock
  | UsageBlock
  | ToolCallBlock
  | ImageBlock
  | SkillRefBlock
  | FileRefBlock
  | MemberReportBlock;

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
