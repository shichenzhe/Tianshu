/**
 * 全局快捷键分发 hook（AiLayout 挂载）：
 * window keydown（非 capture，组件 stopPropagation 可拦截）→ 每次按键
 * 即时合成生效绑定（localStorage 覆盖变更立即生效）→ 匹配命中且登记了
 * 处理器时 preventDefault 执行；消费者优先：已被组件 preventDefault 的
 * 事件（联想面板/编辑态的 Esc、Radix 弹层）不参与分发
 */
import { useEffect, useMemo, useRef } from "react";

import { detectPlatform } from "@/lib/keybindings";
import {
  currentBindings,
  matchKeybindingCommand,
  type DispatchMatchInput,
} from "@/lib/keybindings/dispatcher";

/** 命令 id → 动作；未登记处理器的命令命中后被忽略（发送/换行在输入框内部处理） */
export type KeybindingHandlers = Partial<Record<string, () => void>>;

export function useKeybindingDispatcher(handlers: KeybindingHandlers): void {
  const platform = useMemo(detectPlatform, []);
  // 处理器经 ref 透传：闭包依赖（navigate/searchParams 等）更新无需重挂监听
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const commandId = matchKeybindingCommand(
        currentBindings(),
        toMatchInput(event, platform),
      );
      const handler = commandId ? handlersRef.current[commandId] : undefined;
      if (commandId && handler) {
        event.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [platform]);
}

/** 原生事件 → 匹配输入（聚焦/消费/重复旗标在此采集） */
function toMatchInput(
  event: KeyboardEvent,
  platform: ReturnType<typeof detectPlatform>,
): DispatchMatchInput {
  return {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    platform,
    inputFocused: isTextEntryFocused(),
    defaultPrevented: event.defaultPrevented,
    repeat: event.repeat,
  };
}

/** 焦点是否位于文本输入类元素（input/textarea/select/contenteditable） */
function isTextEntryFocused(): boolean {
  const element = document.activeElement;
  if (!element) {
    return false;
  }
  const tag = element.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (element as HTMLElement).isContentEditable
  );
}
