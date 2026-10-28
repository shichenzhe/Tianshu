/**
 * 待注入引用(发送时随消息带出,ChatView 渲染层拼前缀块):
 * 工作空间文件、已安装技能或项目待办(内联 token 解析产物)
 */
export interface PendingFile {
  /** 文件相对路径;kind="localFile" 时为本地文件绝对路径;kind="skill" 时为技能名;kind="todo" 时为 待办#<id> */
  path: string;
  content: string;
  /** 引用来源:工作空间文件(默认)、本地文件、已安装技能或项目待办;
   *  fileRef = 工作空间引用式(仅路径 + read_file 指示,不读全文——
   *  content 忽略,agent/plan 会话 AI 自读,ask 无工具集不走此 kind) */
  kind?: "file" | "localFile" | "skill" | "todo" | "fileRef";
  /** 图片附件标记:path 即图片绝对路径,content 为空——发送层分流为
   *  ChatSendImage 走多模态 image part,不经 readExternalFile 读取注入 */
  image?: true;
  /** FA-T3 远程图片链:控制端图片字节(粘贴/拖拽 blob 转存,远程主机不落
   *  控制端盘);本地链缺省走 path 落盘链 */
  base64?: string;
}

/** 从 PendingFile[] 分流图片附件（发送层共享口径） */
export function splitImageFiles(files: PendingFile[]): {
  textFiles: PendingFile[];
  images: Array<{ absPath: string; base64?: string }>;
} {
  const textFiles: PendingFile[] = [];
  const images: Array<{ absPath: string; base64?: string }> = [];
  for (const file of files) {
    if (file.image) {
      // base64 透传（FA-T3 远程上传链消费；本地链忽略）
      images.push({
        absPath: file.path,
        ...(file.base64 ? { base64: file.base64 } : {}),
      });
    } else {
      textFiles.push(file);
    }
  }
  return { textFiles, images };
}
