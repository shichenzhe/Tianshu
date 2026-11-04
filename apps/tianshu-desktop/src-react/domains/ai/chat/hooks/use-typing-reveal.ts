// src-react/domains/ai/chat/hooks/use-typing-reveal.ts
/**
 * 流式吐字平滑 hook（WorkBuddy use-streaming-text-buffer 移植）：
 * rAF 按 TYPING_REVEAL_CONFIG 间隔（40ms）用 advanceReveal 平滑吐字，
 * 吐完停帧、目标增长随下次渲染重启；enabled=false（历史消息/流结束）
 * 与 prefers-reduced-motion（系统无障碍）直接返回原文零开销。
 */
import { useEffect, useRef, useState } from "react";
import {
  advanceReveal,
  TYPING_REVEAL_CONFIG,
  type TypingRevealState,
} from "../lib/typing-reveal";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useTypingReveal(targetText: string, enabled: boolean): string {
  const [displayLength, setDisplayLength] = useState(0);
  const stateRef = useRef<TypingRevealState>({ displayLength: 0, emaLag: 0 });

  useEffect(() => {
    if (!enabled || prefersReducedMotion()) {
      stateRef.current = { displayLength: targetText.length, emaLag: 0 };
      setDisplayLength(targetText.length);
      return;
    }
    let raf = 0;
    let lastAdvance = 0;
    const tick = (now: number) => {
      const next = advanceReveal(
        stateRef.current,
        targetText.length,
        targetText,
        TYPING_REVEAL_CONFIG,
      );
      // 间隔节流：未满 targetIntervalMs 只排下一帧不推进（rAF 60fps > 40ms 目标）
      if (now - lastAdvance >= TYPING_REVEAL_CONFIG.targetIntervalMs) {
        stateRef.current = next;
        setDisplayLength(next.displayLength);
        lastAdvance = now;
      }
      if (next.displayLength < targetText.length) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [targetText, enabled]);

  if (!enabled || prefersReducedMotion()) {
    return targetText;
  }
  return targetText.slice(0, Math.min(displayLength, targetText.length));
}
