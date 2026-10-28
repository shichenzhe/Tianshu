/**
 * IPC 业务错误码 → i18n 文案
 * 主进程约定：业务错误 throw new Error(CODE)（Electron invoke 拒绝时仅保留 message），
 * 渲染端统一经此映射；不在码表内的消息原样透传（如上游/系统错误）
 */
import i18n from "@/i18n";

/** 与 chat:errors.* 一一对应的业务错误码（主进程 throw 的白名单） */
const ERROR_CODES = [
  "CONCURRENT_REQUEST",
  "SESSION_NOT_FOUND",
  "MESSAGE_NOT_FOUND",
  "NO_MODEL",
  "MODEL_OR_PROVIDER_MISSING",
  "NOTHING_TO_REGENERATE",
  "MODEL_MISSING",
  "PROVIDER_MISSING",
  "ASSISTANT_BUILTIN",
  "GRAPH_NOT_RUNNING",
  "ARCHIVED_SESSION",
  // workspace:listDir 沙箱越界（外指 symlink 展开出界等），DetailPanel 文件树
  "PATH_OUTSIDE_WORKSPACE",
  // workspace:writeFile 新建语义撞名（+ 菜单换名重试后仍冲突）
  "FILE_EXISTS",
  // 远程链图片无法随行上传（无 base64 读取通道，如资料库图片 pill）——
  // 阻断发送而非静默剔图（裁定 2026-10-21）
  "REMOTE_IMAGE_UNAVAILABLE",
  // 聊天输出导出批：dataUrl 图片另存（media-export）与 widget 截图
  "IMAGE_DATAURL_INVALID",
  "WIDGET_CAPTURE_RECT_INVALID",
  // mermaid SVG → PNG 导出（mermaid-export，渲染层同码直 throw）
  "MERMAID_PNG_RENDER_FAILED",
  "MERMAID_PNG_CANVAS_UNAVAILABLE",
] as const;

/** 带尾参的错误码（消息形如 CODE: detail，exact 匹配不到——前缀命中即映射，
 *  细节对用户无意义：mime 名 / 字节数） */
const PREFIXED_ERROR_CODES = [
  "IMAGE_DATAURL_MIME_REJECTED",
  "IMAGE_DATAURL_TOO_LARGE",
] as const;

export function mapIpcError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if ((ERROR_CODES as readonly string[]).includes(message)) {
    return i18n.t(`chat:errors.${message}`);
  }
  const prefixed = (PREFIXED_ERROR_CODES as readonly string[]).find((code) =>
    message.startsWith(`${code}: `),
  );
  if (prefixed) {
    return i18n.t(`chat:errors.${prefixed}`);
  }
  return message;
}
