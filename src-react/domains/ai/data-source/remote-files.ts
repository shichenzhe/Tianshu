/**
 * 文件面远程适配器（HD-FA，spec 2026-10-20 §4）：远程 files 三端点 →
 * 本地文件通道形状转换。UI 消费零变化。
 * read 的错误码映射：FILES_PATH_ESCAPE → PATH_OUTSIDE_WORKSPACE 稳定码
 * （本地 readWorkspaceFile 同码——ChatPane 注入链回退 readExternalFile
 * 授权门读取的既有判据）；其余 FILES_* → 本地同款文案。
 */
import ServerApi from "../server/api/server.api";
import type { RemoteFileUploadInput } from "@tianshu/protocol";

/** read 错误码 → 本地文案/稳定码（ChatPane/ChatInput 判据不变） */
const READ_ERROR_TEXT_OF: Record<string, string> = {
  FILES_NO_WORKSPACE: "未绑定工作空间目录",
  FILES_TOO_LARGE: "超过 512KB 上限",
  FILES_BINARY: "二进制文件不支持",
  FILES_READ_FAILED: "读取失败",
  FILES_PATH_ESCAPE: "PATH_OUTSIDE_WORKSPACE",
};

/** 清单（file:listWorkspaceFiles 同形状：相对路径数组） */
export async function list(
  workspaceId: number,
  connId: string,
): Promise<string[]> {
  return ServerApi.filesList(workspaceId, connId);
}

/** 守卫读取（file:readExternalFile 同形状：{filePath, content} | {filePath, error}） */
export async function read(
  relPath: string,
  workspaceId: number,
  connId: string,
): Promise<{ filePath: string; content?: string; error?: string }> {
  try {
    const { content } = await ServerApi.filesRead(workspaceId, relPath, connId);
    return { filePath: relPath, content };
  } catch (e) {
    const code =
      typeof (e as { code?: unknown }).code === "string"
        ? ((e as { code: string }).code satisfies string)
        : "";
    const text = READ_ERROR_TEXT_OF[code];
    if (text) {
      return { filePath: relPath, error: text };
    }
    return { filePath: relPath, error: "读取失败" };
  }
}

/** 图片上传（base64 → 被控端 attachments；imagePath 相对被控端数据根） */
export async function uploadImage(
  input: RemoteFileUploadInput,
  connId: string,
): Promise<{ imagePath: string }> {
  return ServerApi.filesUploadImage(input, connId);
}
