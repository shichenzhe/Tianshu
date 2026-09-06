/**
 * 待注入引用(发送时随消息带出,ChatView 渲染层拼前缀块):
 * 工作空间文件或已安装技能(内联 token 解析产物)
 */
export interface PendingFile {
  /** 文件相对路径;kind="skill" 时为技能名 */
  path: string;
  content: string;
  /** 引用来源:工作空间文件(默认)或已安装技能 */
  kind?: "file" | "skill";
}
