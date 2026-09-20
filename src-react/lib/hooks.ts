/**
 * 通用 React Hooks
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "react-router-dom";

/**
 * 防抖 Hook
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

/**
 * 壁纸清晰模式路由判断（新建任务详情页 /module/ai/new）
 * MainLayout 据此在 html 打 data-clear-wallpaper（skins.css 切换极淡纱）；
 * 顶栏右侧按钮（外观/语言/用户）据此切实底样式——清晰壁纸上需与主题色
 * 区分，其余路由保持原透明 hover 底
 */
export function useClearWallpaper(): boolean {
  return useLocation().pathname.startsWith("/module/ai/new");
}

/**
 * 防抖回调 Hook
 */
export function useDebouncedCallback<T extends (...args: never[]) => unknown>(
  callback: T,
  delay: number,
): T {
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const debouncedCallback = useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        callback(...args);
      }, delay);
    },
    [callback, delay],
  ) as T;

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return debouncedCallback;
}

/**
 * 节流回调 Hook
 */
export function useThrottledCallback<T extends (...args: never[]) => unknown>(
  callback: T,
  delay: number,
): T {
  const lastRunRef = useRef<number>(0);

  const throttledCallback = useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now();
      if (now - lastRunRef.current >= delay) {
        callback(...args);
        lastRunRef.current = now;
      }
    },
    [callback, delay],
  ) as T;

  return throttledCallback;
}

/**
 * 间隔 Hook
 */
export function useInterval(
  callback: () => void,
  delay: number | null,
  deps: unknown[] = [],
) {
  useEffect(() => {
    if (delay === null) return;

    const interval = setInterval(callback, delay);

    return () => {
      clearInterval(interval);
    };
  }, [delay, ...deps]);
}

/**
 * 上一次值的 Hook
 */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>(undefined);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref.current;
}

/**
 * 挂载状态 Hook
 */
export function useMounted(): boolean {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    return () => setIsMounted(false);
  }, []);

  return isMounted;
}

/**
 * 键盘快捷键 Hook
 */
export function useKeyboardShortcut(
  keys: string[],
  callback: (event: KeyboardEvent) => void,
  options: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 检查修饰键
      if (
        (options.ctrl && !event.ctrlKey) ||
        (options.alt && !event.altKey) ||
        (options.shift && !event.shiftKey)
      ) {
        return;
      }

      if (keys.includes(event.key)) {
        event.preventDefault();
        callback(event);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [keys, callback, options]);
}

/**
 * 窗口大小 Hook
 */
export function useWindowSize(): { width: number; height: number } {
  const [windowSize, setWindowSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return windowSize;
}

/**
 * IPC 事件监听 Hook
 */
export function useIpcListener(
  channel: string,
  listener: (...args: unknown[]) => void,
) {
  useEffect(() => {
    if (!window.ipcRenderer) return;

    const handler = (_event: unknown, ...args: unknown[]) => {
      listener(...args);
    };

    window.ipcRenderer.on(channel, handler);

    return () => {
      window.ipcRenderer.removeAllListeners(channel);
    };
  }, [channel, listener]);
}

/**
 * IPC 一次性事件监听 Hook
 */
export function useIpcOnceListener(
  channel: string,
  listener: (...args: unknown[]) => void,
) {
  useEffect(() => {
    if (!window.ipcRenderer) return;

    const handler = (_event: unknown, ...args: unknown[]) => {
      listener(...args);
    };

    window.ipcRenderer.once(channel, handler);

    return () => {
      window.ipcRenderer.removeAllListeners(channel);
    };
  }, [channel, listener]);
}
