import { describe, expect, it } from "vitest";

import {
  buildCsvTable,
  CSV_MAX_COLS,
  CSV_MAX_ROWS,
  splitCsv,
} from "./csv-table";

describe("splitCsv", () => {
  it("常规多行多列", () => {
    expect(splitCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("引号包裹的逗号按字面", () => {
    expect(splitCsv('"a,b",c')).toEqual([["a,b", "c"]]);
  });

  it("引号内换行按字面", () => {
    expect(splitCsv('"a\nb",c')).toEqual([["a\nb", "c"]]);
  });

  it('双引号转义（"" → "）', () => {
    expect(splitCsv('"he said ""hi"""')).toEqual([['he said "hi"']]);
  });

  it("引号内逗号换行转义混合", () => {
    expect(splitCsv('"x,""\ny",z')).toEqual([['x,"\ny', "z"]]);
  });

  it("空行跳过", () => {
    expect(splitCsv("a\n\nb")).toEqual([["a"], ["b"]]);
    expect(splitCsv("\n\n")).toEqual([]);
  });

  it("末尾换行不产额外空行；空文本返回空表", () => {
    expect(splitCsv("a,b\n")).toEqual([["a", "b"]]);
    expect(splitCsv("")).toEqual([]);
  });

  it("空字段与行尾空字段保留", () => {
    expect(splitCsv(",a,\n,b")).toEqual([
      ["", "a", ""],
      ["", "b"],
    ]);
  });

  it("裸 \\r 与 \\r\\n 均作行分隔", () => {
    expect(splitCsv("a\rb")).toEqual([["a"], ["b"]]);
    expect(splitCsv("a\r\nb")).toEqual([["a"], ["b"]]);
  });

  it("未闭合引号宽容吞到文件尾", () => {
    expect(splitCsv('"abc')).toEqual([["abc"]]);
  });

  it("字段中间出现的引号按字面", () => {
    expect(splitCsv('ab"cd,e')).toEqual([['ab"cd', "e"]]);
  });
});

describe("buildCsvTable 截断", () => {
  it("200 行边界：恰 200 不截，201 截断并保留 totalRows", () => {
    const exactly = Array.from({ length: CSV_MAX_ROWS }, (_, i) => `r${i}`);
    const table200 = buildCsvTable(exactly.join("\n"));
    expect(table200.rows).toHaveLength(200);
    expect(table200.truncatedRows).toBe(false);

    const over = Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `r${i}`);
    const table201 = buildCsvTable(over.join("\n"));
    expect(table201.rows).toHaveLength(200);
    expect(table201.totalRows).toBe(201);
    expect(table201.truncatedRows).toBe(true);
  });

  it("20 列边界：恰 20 不截，21 截断且 totalCols 保留原始值", () => {
    const cols20 = Array.from({ length: CSV_MAX_COLS }, (_, i) => `c${i}`);
    const table20 = buildCsvTable(cols20.join(","));
    expect(table20.rows[0]).toHaveLength(20);
    expect(table20.truncatedCols).toBe(false);

    const cols21 = Array.from({ length: CSV_MAX_COLS + 1 }, (_, i) => `c${i}`);
    const table21 = buildCsvTable(cols21.join(","));
    expect(table21.rows[0]).toHaveLength(20);
    expect(table21.totalCols).toBe(21);
    expect(table21.truncatedCols).toBe(true);
  });

  it("行截断与列截断可同时成立；totalCols 按原始最大列数", () => {
    const wide = Array.from({ length: 25 }, () => "x").join(",");
    const text = Array.from({ length: 5 }, () => wide).join("\n");
    const table = buildCsvTable(text, 3, 4);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toHaveLength(4);
    expect(table.totalRows).toBe(5);
    expect(table.totalCols).toBe(25);
    expect(table.truncatedRows).toBe(true);
    expect(table.truncatedCols).toBe(true);
  });

  it("空文本 → 空表且无截断", () => {
    const table = buildCsvTable("");
    expect(table.rows).toEqual([]);
    expect(table.totalRows).toBe(0);
    expect(table.truncatedRows).toBe(false);
    expect(table.truncatedCols).toBe(false);
  });
});
