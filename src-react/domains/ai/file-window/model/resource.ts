/**
 * 文件窗口资源（tab 打开来源联合类型；主进程 type-only 反向 import 先例
 * 同 chat.api ChatSendParams）。sessionId 由渲染层在「移到新窗口」时携带。
 * 网址 tab 已废止（spec §13 项 2）：文件窗仅面向文件。
 */
export type FileWindowResource =
  | {
      kind: "workspace";
      workspaceId: number;
      /** 工作空间内相对路径 */
      path: string;
      sessionId?: number;
    }
  | { kind: "library"; itemId: number; sessionId?: number };
