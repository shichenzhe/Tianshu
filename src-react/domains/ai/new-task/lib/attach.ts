/** 新建任务落地页附件：本地文件按需读取（路径引用，不拷贝） */
import { invoke } from "@/lib/ipc";

export interface ExternalFileContent {
  kind: "text" | "image";
  content?: string;
  dataUrl?: string;
  size: number;
}

export function readExternalFile(
  absPath: string,
): Promise<ExternalFileContent> {
  return invoke<ExternalFileContent>("file:readExternalFile", absPath);
}

/** 跨平台路径尾段（pill 展示名）：win32 反斜杠与 posix 斜杠均切分 */
export function pathTail(absPath: string): string {
  return (
    absPath
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? absPath
  );
}

/** readExternalFile 失败分类：后端超限 reject 文案固定含 "512KB"（区分无权限/不存在等读取失败） */
export function isOversizeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("512KB");
}
