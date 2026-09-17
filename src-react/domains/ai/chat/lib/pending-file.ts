/**
 * 待注入引用(发送时随消息带出,ChatView 渲染层拼前缀块):
 * 工作空间文件、已安装技能或项目待办(内联 token 解析产物)
 */
export interface PendingFile {
  /** 文件相对路径;kind="localFile" 时为本地文件绝对路径;kind="skill" 时为技能名;kind="todo" 时为 待办#<id> */
  path: string;
  content: string;
  /** 引用来源:工作空间文件(默认)、本地文件、已安装技能或项目待办 */
  kind?: "file" | "localFile" | "skill" | "todo";
}
