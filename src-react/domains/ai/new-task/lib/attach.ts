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
