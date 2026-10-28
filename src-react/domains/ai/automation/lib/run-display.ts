// src-react/domains/ai/automation/lib/run-display.ts
/** 运行记录展示工具(全局 Tab 与详情页共享) */
/** 与 schedule-text.ts 同款 t 签名(纯函数,文案走 i18n 便于测试复用) */
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

const ATTACHMENT_MISSING_PREFIX = "attachment_missing: ";

/** 运行错误本地化:attachment_missing(file/skill 变体)转可读文案,其余原样 */
export function localizeRunError(error: string | undefined, t: TFunc): string {
  if (!error) {
    return "";
  }
  if (error.startsWith(ATTACHMENT_MISSING_PREFIX)) {
    return t("chat:automation.create.attachmentMissing", {
      name: error.slice(ATTACHMENT_MISSING_PREFIX.length),
    });
  }
  return error;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) {
    return "-";
  }
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 触发方式 → i18n key(event 为 T10 事件触发枚举扩展;subflow 为子工作流
 * 节点触发的内嵌执行;六种全覆盖) */
const TRIGGER_KEYS: Record<string, string> = {
  schedule: "chat:automation.runs.triggerSchedule",
  catchUp: "chat:automation.runs.triggerCatchUp",
  retry: "chat:automation.runs.triggerRetry",
  manual: "chat:automation.runs.triggerManual",
  event: "chat:automation.runs.triggerEvent",
  subflow: "chat:automation.runs.triggerSubflow",
  webhook: "chat:automation.runs.triggerWebhook",
};

export function triggerTypeKey(triggerType: string): string {
  return TRIGGER_KEYS[triggerType] ?? TRIGGER_KEYS.schedule;
}
