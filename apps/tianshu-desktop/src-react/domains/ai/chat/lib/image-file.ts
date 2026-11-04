/**
 * 图片路径识别（发送层口径）：按扩展名判断，与主进程
 * workspace-files IMAGE_MIME 键集同构——渲染进程不 import 主进程代码，
 * 两处扩展名变更须同步
 */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** 纯图片附件：跳过 readExternalFile 预检/读取（512KB 上限只针对文本
 * 注入），发送时走多模态 image part（主进程侧 10MB 校验兜底） */
export function isImagePath(p: string): boolean {
  return IMAGE_EXT_RE.test(p);
}
