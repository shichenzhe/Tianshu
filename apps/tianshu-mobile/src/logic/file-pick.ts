/**
 * 本地文件选择链（添加文件对齐批，对齐桌面 PlusMenu「添加文件」/
 * file:pickAndRead 语义；融合批 2026-10-22 单入口分流）：系统选择器
 * 多选 → 文本读取（UTF-8）→ 512KB 预检 + 二进制（NUL）拒绝 → 内容暂存
 * （发送时以 [引用文件] 前缀并入消息文本——不落库不落盘，与桌面同
 * 口径）；图片文件（mime image/* 或图片扩展名）分流走多模态链
 * （image-pick 压缩 + 3MB 预检 → 发送时 uploadImage，对齐桌面「附加
 * 图片」语义）——替代原独立选图入口。桌面另有资料库引用（远程主机
 * 面），移动端暂不透出（无对应端点）。
 */
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";

import { blobToText, fetchBlob } from "./file-read";
import { ImageTooLargeError, imageUriAsBase64 } from "./image-pick";

/** 文本注入上限（对齐桌面 READ_LIMIT = 512KB，workspace-files.ts） */
export const FILE_LIMIT_BYTES = 512 * 1024;

export type PickedFile = { name: string; content: string };

/** 单文件拒绝原因（调用方 toast 具名提示）；imageTooLarge 为图片链
 *  压缩尽力后仍超 3MB（与文本 512KB 上限不同值不同文案） */
export type FileRejectReason = "tooLarge" | "imageTooLarge" | "binary" | "read";

/** 选择结果（picked 文本 + images 图片 base64 + rejected 拒绝明细） */
export type PickResult = {
  picked: PickedFile[];
  /** 图片文件分流产物（多模态链暂存，发送时 uploadImage） */
  images: Array<{ name: string; base64: string }>;
  rejected: Array<{ name: string; reason: FileRejectReason }>;
};

/** 图片扩展名集（mime 缺失时回落判定） */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "heic",
  "bmp",
]);

/** 图片文件判定（mime 优先，缺省回落扩展名） */
export function isImageFile(name: string, mimeType?: string | null): boolean {
  if (mimeType != null && mimeType !== "") {
    return mimeType.startsWith("image/");
  }
  const ext = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/** 文本判定（对齐桌面 readTextFileGuarded NUL 守卫——UTF-8 解出 NUL
 *  视为二进制，不做扩展名猜测） */
export function isTextLike(content: string): boolean {
  return !content.includes("\u0000");
}

/** 系统文件选择（多选）→ 文本内容 + 图片 base64；取消返回 null；失败
 *  文件逐个降级（rejected 透传原因——部分成功不阻断整体）；选择器整体
 *  reject 时回退相册单选（见 pickImageFromLibrary） */
export async function pickLocalFiles(): Promise<PickResult | null> {
  let result: PickResult | null;
  try {
    result = await pickDocuments();
  } catch {
    // iOS document-picker 选图返回时可能 reject（iCloud 拷贝失败/相册
    // 位置权限等）——回退相册选择器（expo-image-picker 真机久经验证
    // 链）；用户在回退选择器取消则视为整体取消静默返回
    const fallback = await pickImageFromLibrary();
    if (fallback != null) {
      return { picked: [], images: [fallback], rejected: [] };
    }
    return null;
  }
  return result;
}

/** document-picker 主体（多选分流，原 pickLocalFiles 逻辑本体） */
async function pickDocuments(): Promise<PickResult | null> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled || result.assets.length === 0) {
    return null;
  }
  const picked: PickedFile[] = [];
  const images: Array<{ name: string; base64: string }> = [];
  const rejected: Array<{ name: string; reason: FileRejectReason }> = [];
  for (const asset of result.assets) {
    const name = asset.name ?? asset.uri.split("/").pop() ?? "file";
    try {
      if (isImageFile(name, asset.mimeType)) {
        // 图片分流：多模态链（压缩 + 3MB 预检在 image-pick）
        images.push(await imageUriAsBase64(asset.uri, name));
        continue;
      }
      // 读取原语为 RN 内建 fetch+blob（真机修复 2026-10-24，见 file-read.ts）
      const size = (await fetchBlob(asset.uri)).size;
      if (size > FILE_LIMIT_BYTES) {
        rejected.push({ name, reason: "tooLarge" });
        continue;
      }
      const content = await blobToText(await fetchBlob(asset.uri));
      if (!isTextLike(content)) {
        rejected.push({ name, reason: "binary" });
        continue;
      }
      picked.push({ name, content });
    } catch (e) {
      rejected.push({
        name,
        reason: e instanceof ImageTooLargeError ? "imageTooLarge" : "read",
      });
    }
  }
  return { picked, images, rejected };
}

/** 相册选择回退（真机反馈 2026-10-23）：document-picker 整体 reject 的
 *  出路——expo-image-picker 单选（该相册链真机久经验证）；quality 1
 *  不压缩（压缩/3MB 预检在 imageUriAsBase64 内）；取消/空 assets 视
 *  为整体取消返回 null */
async function pickImageFromLibrary(): Promise<{
  name: string;
  base64: string;
} | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 1,
    allowsMultipleSelection: false,
  });
  if (result.canceled || result.assets.length === 0) {
    return null;
  }
  const asset = result.assets[0];
  return imageUriAsBase64(asset.uri, asset.fileName ?? "image.jpg");
}
