/**
 * 被控端 agent 执行器契约（AR-T1，换基座预留插槽）：会话编排层
 * （mirror chat.service / server chat-runner.service 的持久化与上下文
 * 装配）与执行引擎之间的接缝抽象。
 *
 * 现状唯一实现是 LangChain 工具循环（@tianshu/core runChatStream——
 * 回调风格，宿主桥接适配本契约）；未来接入第二引擎（如 DeepSeek agent
 * harness）时实现本接口即可整链替换：chunk 协议/审批流/UI/远控链路
 * 零改动（chunk 契约保持「引擎能力最小公分母超集」——HD spec 协议纪律）。
 *
 * 类型零运行时依赖（包纪律）；blocks 泛型由宿主收窄（mirror 为
 * MessageBlock[]，core 包 blocks 序列化产物）。
 */
import type { ChatStreamChunk } from "./chat-contract";

/** 单轮执行终态（流耗尽后有效；errorCode 存在 = 错误收敛终态） */
export interface AgentRunResult<TBlocks = unknown> {
  blocks: TBlocks[];
  errorCode?: string;
  errorMessage?: string;
}

/** run() 返回句柄：chunk 流与终值并行暴露——消费者可边流式边持终值 */
export interface AgentRunHandle<TBlocks = unknown> {
  /** 协议 chunk 流（text-delta/tool-update/approval-request/finish/...；
   *  引擎实现保证流必然终结——正常 finish 或 error chunk 后关闭） */
  chunks: AsyncIterable<ChatStreamChunk>;
  /** 终态消息块；流耗尽后 resolve（错误终态同样 resolve，查 errorCode） */
  result: Promise<AgentRunResult<TBlocks>>;
}

/**
 * agent 执行器（引擎接缝）。options 泛型由实现收窄——LangChain 实现是
 * core 包 ChatStreamOptions 宿主收窄版（模型/历史/工具定义/采样参数/
 * abortSignal 等）；DeepSeek harness 实现届时按其 daemon/CLI 调用面
 * 定义（会话装配输入 → 同一 options 形状由编排层适配）。
 */
export interface AgentRunner<TOptions = unknown, TBlocks = unknown> {
  run(options: TOptions): AgentRunHandle<TBlocks>;
  /**
   * 审批决议（approval-request 挂起的 write 工具）：批准/拒绝由引擎
   * 落到对应挂起调用；迟到应答（流已收敛）实现自判 stale 静默或抛错，
   * 契约不规定——消费端已有超时自动拒兜底
   */
  approve(toolCallId: string, approved: boolean): Promise<void>;
}
