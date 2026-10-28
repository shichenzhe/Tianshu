import { describe, expect, it } from "vitest";
import zh from "@/i18n/locales/zh-CN/newTask.json";
import en from "@/i18n/locales/en-US/newTask.json";

/** 深拍平取全部叶子 key 路径 */
function flatKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object"
      ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

describe("newTask i18n 双语对齐", () => {
  it("zh 与 en 叶子 key 集合一致", () => {
    expect(new Set(flatKeys(en))).toEqual(new Set(flatKeys(zh)));
  });
});
