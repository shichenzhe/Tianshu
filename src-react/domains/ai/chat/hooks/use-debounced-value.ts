/**
 * 时间防抖值：@ 联想搜索等「每击键一发 IPC」场景，延迟窗口内只在停顿后
 * 取最新值（useDeferredValue 是渲染优先级调度，不替代时间防抖）
 */
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
