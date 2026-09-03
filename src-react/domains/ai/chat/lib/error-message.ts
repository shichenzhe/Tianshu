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
  "NO_MODEL",
  "MODEL_OR_PROVIDER_MISSING",
  "NOTHING_TO_REGENERATE",
  "MODEL_MISSING",
  "PROVIDER_MISSING",
  "ASSISTANT_BUILTIN",
] as const;

export function mapIpcError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if ((ERROR_CODES as readonly string[]).includes(message)) {
    return i18n.t(`chat:errors.${message}`);
  }
  return message;
}
