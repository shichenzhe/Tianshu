/**
 * MCP 审批横幅门控（P2 spec 决策 #1）：
 * MCP 工具的审批不吃工作空间写授权——「允许并记住」仅对文件类 write 工具显示
 */
export function canRemember(toolName: string): boolean {
  return !toolName.startsWith("mcp__");
}
