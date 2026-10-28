/**
 * 拍照输入链（输入层现代化批）：系统相机拍照 → ImageManipulator 归一
 * JPEG（HEIC 真机反馈 2026-10-25）→ expo-file-system 新 API（File 类）
 * 直接 base64 读盘 → 3MB 预检（超限二轮压缩）→ pendingImages 暂存。
 * 权限先查后请，拒绝返回 "denied" 由调用方 toast 引导；取消返回 null。
 *
 * 读取不走共享 fetchBlob（RN fetch(file://) 对相机/归一输出 uri 真机
 * FETCH_404——相册链 picker uri 形态兼容不受影响；相机链独享 File 直读，
 * 2026-10-25 真机反馈定案）。
 *
 * 秒回重试防御（真机排障 2026-10-24 实证）：＋菜单关闭动画期间
 * legacy 相机 picker present 到 transition VC 会被立即 dismiss →
 * canceled:true 假阳性秒回；真用户取消至少秒级停留——<1.5s 的 canceled
 * 视为未调起，静默重试一次。
 */
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";

import { IMAGE_LIMIT_BYTES, ImageTooLargeError } from "./image-pick";

/** present 失败秒回的判定阈值（ms）：真用户取消至少停留秒级 */
const CAMERA_RETRY_MS = 1_500;

async function launchCameraOnce(): Promise<ImagePicker.ImagePickerResult> {
  return ImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    quality: 1,
  });
}

/** 归一 + 直读：JPEG 两轮压缩（首轮 0.85；超限 1600px 再压），仍超限抛 */
async function toJpegBase64(
  uri: string,
  fallbackName: string,
): Promise<{ name: string; base64: string }> {
  const first = await ImageManipulator.manipulateAsync(uri, [], {
    compress: 0.85,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  let file = new File(first.uri);
  if (file.size > IMAGE_LIMIT_BYTES) {
    const second = await ImageManipulator.manipulateAsync(
      first.uri,
      [{ resize: { width: 1600 } }],
      { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG },
    );
    file = new File(second.uri);
  }
  if (file.size > IMAGE_LIMIT_BYTES) {
    throw new ImageTooLargeError();
  }
  const name = fallbackName.replace(/\.[^.]+$/, "") + ".jpg";
  return { name, base64: await file.base64() };
}

export async function takePhoto(): Promise<
  { name: string; base64: string } | null | "denied"
> {
  const perm = await ImagePicker.getCameraPermissionsAsync();
  if (!perm.granted) {
    const req = await ImagePicker.requestCameraPermissionsAsync();
    if (!req.granted) {
      return "denied";
    }
  }
  const startedAt = Date.now();
  let result = await launchCameraOnce();
  if (result.canceled && Date.now() - startedAt < CAMERA_RETRY_MS) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await launchCameraOnce();
  }
  if (result.canceled || result.assets.length === 0) {
    return null;
  }
  const asset = result.assets[0];
  return toJpegBase64(asset.uri, asset.fileName ?? "camera.jpg");
}
