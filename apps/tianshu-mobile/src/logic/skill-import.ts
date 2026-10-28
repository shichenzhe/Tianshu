/**
 * 技能 zip 上传链（A3 尾）：document-picker 单选 → 扩展名守卫（.zip）→
 * RN 内建 fetch(file://)→blob 原语（与文本/图片链同手法，picker uri 形态
 * 兼容，真机 2026-10-24 定案见 file-read.ts）→ base64（FileReader 剥
 * data: 前缀）→ 3MB 预检（对齐 files/uploadImage 口径；超限客户端即拒，
 * 服务端 SKILL_UPLOAD_INVALID 双保险——超 3MB/坏 zip/包结构不合法同码）。
 *
 * 结果判别联合：{name, base64} 成功 / null 取消 / "invalid" 非 zip 扩展 /
 * "tooLarge" 超 3MB；读取异常（fetch/FileReader 炸）抛给调用方 toast。
 * 不设 mime type 过滤——Android 常报 application/octet-stream，靠扩展名
 * 守卫兜底，防误选而非防漏选。
 */
import * as DocumentPicker from "expo-document-picker";

import { blobToBase64, fetchBlob } from "./file-read";

/** zip 上传上限（对齐图片链 3MB；spec A3 尾取 files 同口径） */
export const SKILL_ZIP_LIMIT_BYTES = 3 * 1024 * 1024;

export type SkillZipPickResult =
  { name: string; base64: string } | null | "invalid" | "tooLarge";

/** 选 zip 并编码 base64；取消返回 null（判别联合见文件头） */
export async function pickSkillZip(): Promise<SkillZipPickResult> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
  });
  if (result.canceled || result.assets.length === 0) {
    return null;
  }
  const asset = result.assets[0];
  const name = asset.name ?? asset.uri.split("/").pop() ?? "skill.zip";
  if (!name.toLowerCase().endsWith(".zip")) {
    return "invalid";
  }
  const blob = await fetchBlob(asset.uri);
  if (blob.size > SKILL_ZIP_LIMIT_BYTES) {
    return "tooLarge";
  }
  return { name, base64: await blobToBase64(blob) };
}
