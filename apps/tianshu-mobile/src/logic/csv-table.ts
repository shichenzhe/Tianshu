// CSV 只读表格解析（A5 尾富媒体批）：手写 RFC 4180 风格 splitter——引号
// 包裹的逗号/换行按字面、"" 转义为 "，不引第三方库。渲染上限 200 行 × 20 列
// 由 buildCsvTable 截断，total*/truncated* 旗标供表尾提示行插值。

export const CSV_MAX_ROWS = 200;
export const CSV_MAX_COLS = 20;

export interface CsvTable {
  /** 截断后用于渲染的行（每行已按列上限截断） */
  rows: string[][];
  /** 原始行数（截断提示插值用） */
  totalRows: number;
  /** 原始最大列数（截断提示插值用） */
  totalCols: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
}

/**
 * 手写 CSV splitter：逐字符状态机——引号内字符全字面（含换行），"" 为
 * 转义引号；裸 \r / \r\n 均作行分隔；完全空行跳过；文件末尾无换行时补
 * 最后一行；引号未闭合按字面吞到文件尾（宽容，不抛错）。
 */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let lineHasChars = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    lineHasChars = false;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      lineHasChars = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      lineHasChars = true;
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // 完全空行（无字符无字段）跳过；\r\n 合并为一次行分隔
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      if (lineHasChars || row.length > 0 || field !== "") {
        pushRow();
      }
      i += 1;
      continue;
    }
    field += ch;
    lineHasChars = true;
    i += 1;
  }
  // 收尾：末尾非空（有残留字段或已累积列）时补最后一行
  if (field !== "" || row.length > 0) {
    pushRow();
  }
  return rows;
}

/** 解析 + 渲染上限截断（默认 200 行 × 20 列） */
export function buildCsvTable(
  text: string,
  maxRows: number = CSV_MAX_ROWS,
  maxCols: number = CSV_MAX_COLS,
): CsvTable {
  const all = splitCsv(text);
  const totalRows = all.length;
  const totalCols = all.reduce((max, row) => Math.max(max, row.length), 0);
  const truncatedRows = totalRows > maxRows;
  const truncatedCols = totalCols > maxCols;
  const rows = all.slice(0, maxRows).map((row) => row.slice(0, maxCols));
  return { rows, totalRows, totalCols, truncatedRows, truncatedCols };
}
