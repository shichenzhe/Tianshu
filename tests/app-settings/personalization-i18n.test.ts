/**
 * 个性化模块 locale 一致性测试：守卫 CLAUDE.md 的 zh-CN/en-US 同步规范——
 * settings.json 的 personalization 深层 key 集与 nav.profile 必须两语言
 * 完全一致（缺 key 时 t() 会渲染出裸 key）；chat.json 的 loadingPhrases
 * 两语言均须为非空数组（useLoadingPhrase 按数组消费）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type LocaleJson = Record<string, unknown>;

function loadLocale(locale: string, ns: string): LocaleJson {
  return JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        `../../src-react/i18n/locales/${locale}/${ns}.json`,
      ),
      "utf8",
    ),
  );
}

/** 递归收集叶子 key 路径（"style.options.default.label" 形式；数组视为叶子） */
function deepKeys(value: unknown, prefix: string): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as LocaleJson).flatMap(([key, child]) =>
    deepKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("settings.json 个性化文案 zh/en key 一致性", () => {
  const zh = loadLocale("zh-CN", "settings");
  const en = loadLocale("en-US", "settings");

  it("两语言均有 personalization 对象", () => {
    expect(zh.personalization).toBeTypeOf("object");
    expect(en.personalization).toBeTypeOf("object");
  });

  it("personalization 深层 key 集两语言完全一致", () => {
    const zhKeys = deepKeys(zh.personalization, "").sort();
    const enKeys = deepKeys(en.personalization, "").sort();
    expect(zhKeys).toEqual(enKeys);
    // 兜底：空集相等无意义，key 集必须非空
    expect(zhKeys.length).toBeGreaterThan(0);
  });

  it("两语言均有 nav.profile 入口文案", () => {
    const zhNav = zh.nav as LocaleJson;
    const enNav = en.nav as LocaleJson;
    expect(zhNav.profile).toBeTypeOf("string");
    expect(enNav.profile).toBeTypeOf("string");
  });
});

describe("chat.json 加载欢迎语文案池", () => {
  it("两语言 loadingPhrases 均为非空数组", () => {
    for (const locale of ["zh-CN", "en-US"]) {
      const chat = loadLocale(locale, "chat");
      expect(Array.isArray(chat.loadingPhrases)).toBe(true);
      expect((chat.loadingPhrases as unknown[]).length).toBeGreaterThan(0);
    }
  });
});
