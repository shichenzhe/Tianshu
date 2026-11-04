/**
 * CodeMirror 6 编辑器（T24，spec §14）：文件窗 md/text/代码编辑统一载体
 * （textarea 与 LibraryMarkdownEditor 的 CM6 替换）。
 * - 受控桥接：updateListener 上抛 onChange（userEvent=input/delete/keyboard
 *   标记本地来源）；外部 value 变化（重载/冲突 reload）经 effect 比对
 *   dispatch 全量替换（光标同 offset、越界截断），替换期间 syncingRef 抑制
 *   onChange 回环（外部 reload 不得误标 dirty）；本地输入后外部 value 未
 *   跟进（父未回声）不覆写——防回环撤掉用户输入。外部替换经
 *   historyCompartment 重置 undo 链（替换不入史）：弃稿后 Mod-z 不复活
 *   旧文（T24 审查修复，T25）。
 * - 语言懒加载：language Compartment 先挂无语言视图，dynamic import 到位
 *   后 reconfigure（lib/cm-language，Vite 自动分包）。
 * - readOnly：EditorState.readOnly + EditorView.editable（contenteditable=
 *   false 禁输入）；显式 dispatch 不受限——loading 期间外部内容仍同步进
 *   视图（防半值编辑而非空窗）。
 * - 主题：EditorView.theme 透明底 + 应用 CSS 变量（gutter/边框/当前行/选
 *   区随 4 主题与暗色皮肤切换）；语法高亮一套固定柔和中性色（不随主题色
 *   相——中亮度兼顾明暗皮肤，spec §14 项 3 裁定）。
 * - Mod-s 不入 keymap：未被 CM6 处理的键冒泡 window，现有 ⌘S 保存监听照
 *   常触发（file-tab-editor/file-window-editor 测试钉住）。
 */
import { useEffect, useRef } from "react";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

import { loadCmLanguage, type CmLanguage } from "../lib/cm-language";

/** Compartment 为无状态标记，多视图实例共用安全 */
const languageCompartment = new Compartment();
const editableCompartment = new Compartment();
const historyCompartment = new Compartment();
const ariaCompartment = new Compartment();

/** .cm-content 无障碍标签扩展（空 label 不注入属性） */
const contentAttrsOf = (label?: string) =>
  EditorView.contentAttributes.of(label ? { "aria-label": label } : {});

/** 柔和中性语法配色（固定色值：中亮度兼顾明暗皮肤，不随主题色相） */
const cmSyntaxHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword], color: "#9966d6" },
  { tag: [t.string, t.special(t.string)], color: "#4c9e6b" },
  { tag: [t.number, t.bool, t.null], color: "#c07a45" },
  { tag: t.comment, color: "#8b93a5", fontStyle: "italic" },
  { tag: t.function(t.variableName), color: "#3e80c9" },
  { tag: [t.typeName, t.className], color: "#2f9189" },
  { tag: t.tagName, color: "#b1689c" },
  { tag: [t.attributeName, t.link, t.url], color: "#4a86c9" },
  { tag: t.heading, color: "#b45a3f", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.invalid, color: "#d05050" },
]);

/** 编辑器主题：透明底 + 应用 CSS 变量（Tailwind 4 @theme 变量），随主题/皮肤切换 */
const cmEditorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", fontSize: "0.875rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, monospace)",
    lineHeight: "1.625",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-background)",
    color: "var(--color-muted-foreground)",
    border: "none",
    borderRight:
      "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--color-primary) 7%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--color-primary) 7%, transparent)",
    color: "var(--color-foreground)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid var(--color-primary)",
  },
  ".cm-content": { caretColor: "var(--color-primary)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor:
      "color-mix(in srgb, var(--color-primary) 20%, transparent)",
  },
  ".cm-content ::selection": {
    backgroundColor:
      "color-mix(in srgb, var(--color-primary) 20%, transparent)",
  },
});

/** 体验面基础扩展（spec §14 项 2）：行号/折叠/撤销重做/括号匹配/当前行高亮/换行 */
const baseExtensions: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  historyCompartment.of(history()),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  EditorView.lineWrapping,
  indentOnInput(),
  bracketMatching(),
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  syntaxHighlighting(cmSyntaxHighlight),
  cmEditorTheme,
];

/** readOnly 扩展集：禁用户输入（editable=false 摘掉 contenteditable；readOnly 供命令/输入检查） */
const readOnlyExtOf = (readOnly: boolean): Extension[] =>
  readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];

/**
 * 外部值全量替换（光标同 offset、越界截断）。替换点重置 undo 链：先摘
 * history 扩展（StateField 随扩展移除丢弃，undo/redo 清空——外部替换后
 * Mod-z 不复活弃稿），替换事务本身 addToHistory=false，随后回挂全新
 * history（替换后的本地编辑照常可撤销）。
 */
function applyExternalDoc(view: EditorView, next: string): void {
  const clamp = (pos: number) => Math.min(pos, next.length);
  const selection = view.state.selection.main;
  view.dispatch({ effects: historyCompartment.reconfigure([]) });
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    selection: { anchor: clamp(selection.anchor), head: clamp(selection.head) },
    annotations: Transaction.addToHistory.of(false),
    effects: historyCompartment.reconfigure(history()),
  });
}

interface FileWindowEditorProps {
  /** 受控值：draft ?? 磁盘内容（上层计算） */
  value: string;
  onChange: (next: string) => void;
  language: CmLanguage;
  /** 禁输入（loading 防半值编辑；外部 value 同步不受限） */
  readOnly?: boolean;
  /** 无障碍标签（.cm-content role=textbox） */
  ariaLabel?: string;
  className?: string;
}

export default function FileWindowEditor({
  value,
  onChange,
  language,
  readOnly = false,
  ariaLabel,
  className = "h-full",
}: FileWindowEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 挂载初值快照（视图只建一次，后续变化走下列 effects）
  const initialRef = useRef({ value, readOnly, ariaLabel });
  const lastValueRef = useRef(value);
  // 本地输入导致 doc 领先外部 value（父未回声期间不覆写，防回环撤输入）
  const localOriginRef = useRef(false);
  // 外部值替换 dispatch 进行中：updateListener 不上抛（reload 不得误标 dirty）
  const syncingRef = useRef(false);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // 挂载一次（初值经 initialRef，无响应式依赖）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialRef.current.value,
        extensions: [
          ...baseExtensions,
          languageCompartment.of([]),
          editableCompartment.of(readOnlyExtOf(initialRef.current.readOnly)),
          ariaCompartment.of(contentAttrsOf(initialRef.current.ariaLabel)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || syncingRef.current) return;
            const isLocal = update.transactions.some(
              (tr) =>
                tr.isUserEvent("input") ||
                tr.isUserEvent("delete") ||
                tr.isUserEvent("keyboard"),
            );
            if (isLocal) localOriginRef.current = true;
            onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // 外部 value 同步：doc 与外部值不一致且非「本地输入未回声」时全量替换
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      const localAhead =
        localOriginRef.current && value === lastValueRef.current;
      if (!localAhead) {
        syncingRef.current = true;
        try {
          applyExternalDoc(view, value);
        } finally {
          syncingRef.current = false;
        }
      }
      lastValueRef.current = value;
      return;
    }
    // 对齐（父已回声本地输入）：解除本地领先标记
    localOriginRef.current = false;
    lastValueRef.current = value;
  }, [value]);

  // readOnly 切换（loading ↔ 就绪）
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableCompartment.reconfigure(readOnlyExtOf(readOnly)),
    });
  }, [readOnly]);

  // ariaLabel 响应式更新（locale 切换不滞留旧语言标签；facet 经 Compartment 热切）
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: ariaCompartment.reconfigure(contentAttrsOf(ariaLabel)),
    });
  }, [ariaLabel]);

  // 语言懒加载：到位后 Compartment reconfigure（切换/卸载竞态经 cancelled 守卫）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    void loadCmLanguage(language).then((ext) => {
      if (cancelled) return;
      view.dispatch({ effects: languageCompartment.reconfigure(ext ?? []) });
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  return <div ref={hostRef} className={className} />;
}
