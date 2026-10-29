/**
 * 引用内容注入拼装（发送层共享纯函数）：逐引用前缀块 + 原输入——前缀块间
 * \n\n 分隔、前缀块整体与原文间 \n\n 分隔、无引用原样返回。此前为 ChatPane/
 * ProjectChatBar handleSend 内联逻辑（行为不变迁移），新建任务 dispatch 同口径复用
 */
import type { PendingFile } from "./pending-file";

/** 引用前缀：技能/待办专属语义（模型可分辨引用来源），文件与本地文件统一 [引用文件]；
 *  引用式（fileRef）只有路径行 + read 指示——AI 处理时自读，面板不显示文件内容 */
function referencePrefix(file: PendingFile): string {
  if (file.kind === "skill") {
    return `[引用技能 ${file.path}]`;
  }
  if (file.kind === "todo") {
    return `[引用待办 ${file.path}]`;
  }
  if (file.kind === "fileRef") {
    return `[引用文件 ${file.path}]（请用 read 工具读取该文件后处理）`;
  }
  return `[引用文件 ${file.path}]`;
}

export function buildInjectedContent(
  text: string,
  files: PendingFile[],
): string {
  // 图片附件不进文本注入（发送层分流为多模态 image part；此处过滤防漏）
  const injectable = files.filter((file) => !file.image);
  if (injectable.length === 0) {
    return text;
  }
  return `${injectable
    .map((file) =>
      // 引用式块只有前缀行（content 忽略——无尾随空行）
      file.kind === "fileRef"
        ? referencePrefix(file)
        : `${referencePrefix(file)}\n${file.content}`,
    )
    .join("\n\n")}\n\n${text}`;
}
