/**
 * 本地 URI 读取原语（真机修复 2026-10-24）：RN 内建 fetch(file://)→
 * blob→FileReader，替代 expo-file-system/legacy 的
 * readAsStringAsync/getInfoAsync（legacy 入口真机运行时不可靠——逐文件
 * 读取抛致「文件读取失败」）。fetch 本地 URI 为 RN 原生实现（iOS/
 * Android 均支持），blob.size/类型读取不经 JS 桥外模块。
 */

/** URI → blob（fetch 本地文件；失败抛带信息 Error） */
export async function fetchBlob(uri: string): Promise<Blob> {
  const resp = await fetch(uri);
  if (!resp.ok) {
    throw new Error(`FETCH_${resp.status}`);
  }
  return resp.blob();
}

/** blob → base64（FileReader.readAsDataURL 剥 data: 前缀） */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(new Error("FILEREADER_FAILED"));
    reader.readAsDataURL(blob);
  });
}

/** blob → UTF-8 文本 */
export function blobToText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("FILEREADER_FAILED"));
    reader.readAsText(blob);
  });
}
