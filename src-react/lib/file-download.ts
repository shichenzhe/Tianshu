/**
 * Blob 文件下载（纯渲染层，不经主进程）：代码块 / 文件引用导出 / 文本
 * 预览下载共用——URL.createObjectURL + 隐形 <a download> 点击即存，用后
 * 即 revoke（防泄漏）。jsdom 无 createObjectURL，组件测试对本模块 mock。
 */

/** 触发浏览器下载：blob 内容以 filename 落下载目录 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
