/**
 * 资料库文件上传链（资料库上传批）：document-picker 单选（不限 mime）→
 * 扩展名守卫（拒无扩展名/明显非文件类——防误选而非防漏选，同 skill-import
 * 口径：Android 常报 application/octet-stream，mime 不可信）→
 * fetchBlob→blobToBase64（file-read 原语，picker uri 形态兼容）→ 3MB 客户端
 * 预检（对齐 skills installUpload / files uploadImage 口径，relay 单帧 4MiB
 * 余量；服务端 LIBRARY_UPLOAD_INVALID 双保险）。
 *
 * 结果判别联合：{name, base64} 成功 / null 取消 / "invalid" 扩展名守卫未过 /
 * "tooLarge" 超 3MB；读取异常（fetch/FileReader 炸）抛给调用方 toast。
 * v1 单文件（spec 1.5：多文件/文件夹上传非目标）。
 */
import * as DocumentPicker from "expo-document-picker";

import { blobToBase64, fetchBlob } from "./file-read";

/** 上传上限（对齐 skills zip 链 3MB 口径） */
export const LIBRARY_UPLOAD_LIMIT_BYTES = 3 * 1024 * 1024;

export type LibraryFilePickResult =
  { name: string; base64: string } | null | "invalid" | "tooLarge";

/** 文件名扩展名守卫：须含合法扩展名（拒无扩展名/点开头隐藏名/尾点） */
export function hasValidExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1;
}

/** 选文件并编码 base64；取消返回 null（判别联合见文件头） */
export async function pickLibraryFile(): Promise<LibraryFilePickResult> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
  });
  if (result.canceled || result.assets.length === 0) {
    return null;
  }
  const asset = result.assets[0];
  const name = asset.name ?? asset.uri.split("/").pop() ?? "";
  if (!hasValidExtension(name)) {
    return "invalid";
  }
  const blob = await fetchBlob(asset.uri);
  if (blob.size > LIBRARY_UPLOAD_LIMIT_BYTES) {
    return "tooLarge";
  }
  return { name, base64: await blobToBase64(blob) };
}
