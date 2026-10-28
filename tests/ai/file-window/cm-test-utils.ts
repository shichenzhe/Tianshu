/**
 * file-window 测试共用：CM6 视图定位与本地输入模拟。jsdom 无法经真实击键
 * 进 CM6（contenteditable 输入走 DOM 变更观察链），测试经 view.dispatch +
 * userEvent=input 注解触发组件受控桥接的本地来源路径（与真实输入同路，
 * 组件内 localOriginRef/onChange 行为一致；probe 实测 CM6 在 jsdom 可挂载）。
 */
import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";

// jsdom 缺 Range 几何 API（CM6 测量链调用）：补空列表桩——浏览器对折叠
// 选区本就可能回空列表，CM6 原生处理该分支；不桩则语言加载后测量抛
// "getClientRects is not a function"（stderr 噪声）
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function (): DOMRectList {
    return [] as unknown as DOMRectList;
  };
}

/** 作用域内首个 CM6 视图（.cm-content 元素 → EditorView.findFromDOM） */
export function cmViewOf(scope: ParentNode = document): EditorView {
  const content = scope.querySelector(".cm-content");
  if (!(content instanceof HTMLElement)) {
    throw new Error("cm-content 未挂载");
  }
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("EditorView 未找到");
  return view;
}

/** .cm-content 元素（role=textbox 查询结果）直取视图 */
export function cmViewFromContent(el: Element): EditorView {
  if (!(el instanceof HTMLElement)) throw new Error("非 .cm-content 元素");
  const view = EditorView.findFromDOM(el);
  if (!view) throw new Error("EditorView 未找到");
  return view;
}

/** 作用域内首个编辑器 doc 文本 */
export function cmDocOf(scope: ParentNode = document): string {
  return cmViewOf(scope).state.doc.toString();
}

/** 模拟本地输入（整文替换，userEvent=input 注解触发本地来源路径） */
export function cmType(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    annotations: Transaction.userEvent.of("input"),
  });
}
