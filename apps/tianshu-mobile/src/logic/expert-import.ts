/**
 * 专家导入链（A2 尾）：expo-document-picker 单选 .json → 本地 URI 读文本
 * （fetch+blob 原语，对齐 file-read 真机链）→ 客户端预检解析（kind/name
 * 校验，服务端 parseExpertJson 为权威——预检只为预览对话框与有用报错）
 * → 预览确认后原样透传 assistant/import（成员团 members 随 JSON 透传）。
 * 纯内容面：DTO 不含本机路径，仅文件名用于提示。
 */
import * as DocumentPicker from "expo-document-picker";

import { blobToText, fetchBlob } from "./file-read";
import { isTextLike } from "./file-pick";

/** 导出 JSON 的 kind 标记（镜像桌面 serializeExpert 契约） */
export const EXPERT_EXPORT_KIND = "tianshu-expert";

/** 导入文件上限（对齐文本链 512KB——专家 JSON 远小于此，防御性预检） */
export const EXPERT_JSON_LIMIT_BYTES = 512 * 1024;

/** 文件级拒绝原因（toast 具名提示；预检解析失败走 parse 的 reasonKey） */
export type ExpertFileRejectReason = "tooLarge" | "binary" | "read";

/** 预检解析失败原因（i18n 键——服务端 ASSISTANT_INVALID 前的客户端闸） */
export type ExpertImportParseReject = "badJson" | "badKind" | "missingName";

export type ExpertImportParseResult =
  | { ok: true; name: string; description: string | null }
  | { ok: false; reason: ExpertImportParseReject };

/** 导入预览（确认对话框数据面） */
export interface ExpertImportPreview {
  name: string;
  description: string | null;
}

/** 解析导入 JSON 预检：坏 JSON / kind 不符 / 缺 name 拒绝（服务端
 *  parseExpertJson 全量 schema 校验为权威，此处只取预览所需字段） */
export function parseExpertImportPreview(raw: string): ExpertImportParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "badJson" };
  }
  if (
    typeof json !== "object" ||
    json === null ||
    (json as Record<string, unknown>).kind !== EXPERT_EXPORT_KIND
  ) {
    return { ok: false, reason: "badKind" };
  }
  const name = (json as Record<string, unknown>).name;
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, reason: "missingName" };
  }
  const description = (json as Record<string, unknown>).description;
  return {
    ok: true,
    name,
    description: typeof description === "string" ? description : null,
  };
}

/** 选择并读取单个专家 JSON 文件；取消返回 null，读取/预检失败抛
 *  ExpertImportFileError（原因具名，调用方 toast） */
export async function pickExpertJsonFile(): Promise<{
  fileName: string;
  content: string;
} | null> {
  let result;
  try {
    result = await DocumentPicker.getDocumentAsync({
      // mime 过滤为主；部分系统对 .json 标注不一，选择后再按扩展名/
      // 内容预检兜底（解析闸在 parseExpertImportPreview）
      type: ["application/json", "text/plain", "public.json"],
      multiple: false,
      copyToCacheDirectory: true,
    });
  } catch (error) {
    throw new ExpertImportFileError(
      "read",
      error instanceof Error ? error.message : "",
    );
  }
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0];
  const fileName = asset.name ?? asset.uri.split("/").pop() ?? "expert.json";
  try {
    const blob = await fetchBlob(asset.uri);
    if (blob.size > EXPERT_JSON_LIMIT_BYTES) {
      throw new ExpertImportFileError("tooLarge", String(blob.size));
    }
    const content = await blobToText(blob);
    if (!isTextLike(content)) {
      throw new ExpertImportFileError("binary", fileName);
    }
    return { fileName, content };
  } catch (error) {
    if (error instanceof ExpertImportFileError) throw error;
    throw new ExpertImportFileError(
      "read",
      error instanceof Error ? error.message : "",
    );
  }
}

/** 文件级拒绝异常（具名原因上抛，UI 层映射 i18n toast） */
export class ExpertImportFileError extends Error {
  constructor(
    public readonly reason: ExpertFileRejectReason,
    detail: string,
  ) {
    super(detail);
    this.name = "ExpertImportFileError";
  }
}
