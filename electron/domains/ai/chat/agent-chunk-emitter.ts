/**
 * streamEvents → onChunk 映射层——re-export 兼容层：实现随 @tianshu/core
 * 物理搬入（RC-T4，packages/tianshu-core/src/agent-chunk-emitter.ts，随
 * runChatStream 闭包剥出——仅依赖 @langchain/core，无 electron/chat 域
 * 耦合），此处 re-export 兼容，老 import 链与导出名不变。
 */
export { consumeAgentStream, type EmitterCallbacks } from "@tianshu/core";
