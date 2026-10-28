/**
 * 快捷指令矩阵（WorkBuddy office.prompt.* 文案对照移植，spec §6.5）：
 * 点击仅插入输入框不自动发送。label/prompt 均走 i18n。
 * 未入矩阵的类型（csv/audiovideo）无指令。
 */
import type { FileWindowContentKind } from "../store/file-window.store";

export interface QuickPrompt {
  id: string;
  labelKey: string;
  promptKey: string;
}

const WORD_LIKE = {
  summarize: {
    id: "summarize",
    labelKey: "md.summarize.label",
    promptKey: "md.summarize.text",
  },
  proofread: {
    id: "proofread",
    labelKey: "md.proofread.label",
    promptKey: "md.proofread.text",
  },
  polish: {
    id: "polish",
    labelKey: "md.polish.label",
    promptKey: "md.polish.text",
  },
  outline: {
    id: "outline",
    labelKey: "md.outline.label",
    promptKey: "md.outline.text",
  },
};

const MATRIX: Partial<Record<FileWindowContentKind, QuickPrompt[]>> = {
  md: [
    WORD_LIKE.summarize,
    WORD_LIKE.proofread,
    WORD_LIKE.polish,
    WORD_LIKE.outline,
  ],
  text: [
    {
      id: "summarize",
      labelKey: "text.summarize.label",
      promptKey: "text.summarize.text",
    },
    {
      id: "proofread",
      labelKey: "text.proofread.label",
      promptKey: "text.proofread.text",
    },
    {
      id: "extract",
      labelKey: "text.extract.label",
      promptKey: "text.extract.text",
    },
    {
      id: "translate",
      labelKey: "text.translate.label",
      promptKey: "text.translate.text",
    },
  ],
  image: [
    {
      id: "describe",
      labelKey: "image.describe.label",
      promptKey: "image.describe.text",
    },
    { id: "ocr", labelKey: "image.ocr.label", promptKey: "image.ocr.text" },
    {
      id: "analyze",
      labelKey: "image.analyze.label",
      promptKey: "image.analyze.text",
    },
    { id: "qa", labelKey: "image.qa.label", promptKey: "image.qa.text" },
  ],
  html: [
    {
      id: "summarize",
      labelKey: "html.summarize.label",
      promptKey: "html.summarize.text",
    },
    {
      id: "improve",
      labelKey: "html.improve.label",
      promptKey: "html.improve.text",
    },
  ],
  pdf: [
    {
      id: "summarize",
      labelKey: "pdf.summarize.label",
      promptKey: "pdf.summarize.text",
    },
    {
      id: "extract",
      labelKey: "pdf.extract.label",
      promptKey: "pdf.extract.text",
    },
    {
      id: "outline",
      labelKey: "pdf.outline.label",
      promptKey: "pdf.outline.text",
    },
    { id: "qa", labelKey: "pdf.qa.label", promptKey: "pdf.qa.text" },
  ],
};

export function quickPromptsOf(kind: FileWindowContentKind): QuickPrompt[] {
  return (MATRIX[kind] ?? []).map((p) => ({
    ...p,
    labelKey: `chat:fileWindow.prompt.${p.labelKey}`,
    promptKey: `chat:fileWindow.prompt.${p.promptKey}`,
  }));
}
