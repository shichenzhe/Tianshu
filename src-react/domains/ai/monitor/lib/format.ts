// src-react/domains/ai/monitor/lib/format.ts
/** 紧凑数字（Intl compact，zh → 1.2万/en → 12K 交由 locale） */
export function formatCount(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
}

/** 耗时：<1s 毫秒、否则秒保留 1 位；null → "-" */
export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "-";
  }
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
