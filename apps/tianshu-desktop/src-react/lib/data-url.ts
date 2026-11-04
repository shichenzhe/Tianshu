/**
 * dataUrl 图片工具（剪贴板共享件）：dataUrlToBlob 从 BrowserToolbar 内联
 * 版收编（browser/chat 两域共用）。Electron 44 主进程 clipboard 无
 * writeImage，图片剪贴板写入统一走渲染层 W3C ClipboardItem（file:// 与
 * localhost 均算 secure context）。
 */

/** dataURL → Blob；mime 从 data: 头提取，缺省 image/png */
export function dataUrlToBlob(dataUrl: string): Blob {
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || "image/png";
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 图片 dataUrl 写入剪贴板（W3C 异步通道，失败向上抛由调用方 toast） */
export async function copyImageToClipboard(dataUrl: string): Promise<void> {
  const blob = dataUrlToBlob(dataUrl);
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}
