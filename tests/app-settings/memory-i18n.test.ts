/**
 * 记忆与进化模块 locale 一致性测试（Task 6）：settings.json 顶层 memory
 * 子树 zh/en key 集必须完全一致；关键 key 必须存在（含 Task 5 错误码
 * MEMORY_BUSY）；跨 AI 导入预置提示词 zh 含四分类标题与日期格式、en 非空。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getImportPrompt } from "../../src-react/domains/app-settings/model/import-prompt";

const zh = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../src-react/i18n/locales/zh-CN/settings.json"),
    "utf8",
  ),
);
const en = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../src-react/i18n/locales/en-US/settings.json"),
    "utf8",
  ),
);

function flatKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) {
    return [prefix];
  }
  return Object.entries(obj).flatMap(([k, v]) => flatKeys(v, `${prefix}${k}.`));
}

describe("memory i18n（zh/en key 对齐）", () => {
  it("zh memory 子树与 en memory 子树 key 完全一致", () => {
    expect(flatKeys(en.memory).sort()).toEqual(flatKeys(zh.memory).sort());
  });
  it("存在关键 key", () => {
    for (const key of [
      "title",
      "description",
      "toggle.label",
      "toggle.desc",
      "manage.title",
      "manage.subtitle",
      "sections.work",
      "sections.personal",
      "sections.current",
      "sections.recent",
      "edit.save",
      "edit.cancel",
      "resetDialog.title",
      "resetDialog.confirm",
      "importDialog.title",
      "importDialog.step1.title",
      "importDialog.step2.title",
      "empty.title",
      "empty.enable",
      "toast.reset",
      "toast.imported",
      "toast.importFallback",
      "toast.instructionFailed",
      "disabledNotice",
      "error.MEMORY_DISABLED",
      "error.MEMORY_MODEL_MISSING",
      "error.MEMORY_COMPILE_FAILED",
      "error.MEMORY_NO_MATERIAL",
      "error.MEMORY_BUSY",
    ]) {
      expect(flatKeys(zh.memory)).toContain(`${key}.`);
    }
  });
});

describe("导入提示词", () => {
  it("zh 提示词含四分类标题与日期格式", () => {
    const p = getImportPrompt("zh-CN");
    for (const t of ["工作背景", "个人背景", "当前关注", "近期动态"]) {
      expect(p).toContain(t);
    }
    expect(p).toContain("[YYYY-MM-DD]");
  });
  it("en 提示词存在且非空", () => {
    expect(getImportPrompt("en-US").length).toBeGreaterThan(50);
  });
});
