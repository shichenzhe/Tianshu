/**
 * AI 对话面板宽度（WorkBuddy office chat pane 对齐）：默认 400，夹取
 * [320, 窗宽 50%]，localStorage 持久化（WorkBuddy storage.device 同语义），
 * 窗口 resize 时再夹取（存量宽可能超新窗 50%）。拖动期 isResizing=true，
 * 消费方罩全屏遮罩（col-resize 光标 + 盖住 webview 防吞 pointer 事件）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const KEY = "tianshu-file-window-chat-width";
const MIN = 320;
const DEFAULT = 400;

/** max 下限抬到 MIN：窗宽 < 640 时面板仍可用（不塌成 0 宽） */
const clampWidth = (width: number, innerWidth: number) =>
  Math.min(Math.max(width, MIN), Math.max(MIN, Math.floor(innerWidth / 2)));

function readSavedWidth() {
  const saved = Number(localStorage.getItem(KEY));
  return Number.isFinite(saved) && saved >= MIN ? saved : DEFAULT;
}

export function usePanelWidth() {
  const [width, setWidth] = useState(readSavedWidth);
  const [isResizing, setResizing] = useState(false);
  // 最新宽镜像：pointerup 落盘直读 ref，不经 setState updater 副作用
  // （updater 须纯，React 并发下可丢弃/重放）
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const clamp = () => setWidth((w) => clampWidth(w, window.innerWidth));
    window.addEventListener("resize", clamp);
    clamp();
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const startResize = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    let latest = widthRef.current;
    const onMove = (ev: PointerEvent) => {
      latest = clampWidth(window.innerWidth - ev.clientX, window.innerWidth);
      setWidth(latest);
    };
    // 统一收尾：pointerup 正常结束 / pointercancel（触控被系统接管）/ blur
    // （拖动中切窗）同样复位 isResizing 并落盘，监听全数清理
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      setResizing(false);
      localStorage.setItem(KEY, String(latest));
    };
    setResizing(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  }, []);

  return { width, isResizing, startResize };
}
