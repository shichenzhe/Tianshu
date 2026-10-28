/**
 * 消息 blocks（对齐 UIMessage 形态）——re-export 兼容层：
 * 块类型自 @tianshu/protocol（RC-T1 收编），实现自 @tianshu/core
 * （RC-T3 物理搬入 packages/tianshu-core/src/blocks.ts），老 import 链
 * 与导出名不变；tool_call 块由 P1 agent loop 写入；状态词表与
 * ChatStreamChunk 的 tool-update.state 一致（六值），落库块恒为终态
 * （done / denied / error）。
 */
export type {
  ImageBlock,
  MessageBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  UsageBlock,
} from "@tianshu/protocol";
export {
  blocksToModelMessages,
  parseBlocks,
  serializeBlocks,
  type ImageDataUrlLoader,
} from "@tianshu/core";
