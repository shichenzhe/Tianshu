/**
 * CSV 表格编辑器（详情面板 csv 实时编辑载体）：矩形网格 + 行号/列标
 * 坐标轴（行号 hover 换 × 删行、列标 hover 换 × 删列、列标尾「+」加列、
 * 行号尾「+」加行；删空回落一格保可编辑）。单元格无边框受控 input，
 * 聚焦 primary 描边。变更经 onChange 上抛（父层防抖实时保存）。
 */
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import IconTooltip from "./icon-tooltip";

interface LibraryCsvEditorProps {
  rows: string[][];
  onChange: (rows: string[][]) => void;
}

/** 空网格回落（删空后保一格可编辑） */
const EMPTY_GRID = () => [[""]];

export default function LibraryCsvEditor({
  rows,
  onChange,
}: LibraryCsvEditorProps) {
  const { t } = useTranslation(["chat"]);

  const columnCount = Math.max(...rows.map((row) => row.length), 1);

  const updateCell = (rowIndex: number, colIndex: number, value: string) => {
    onChange(
      rows.map((row, i) =>
        i === rowIndex
          ? row.map((cell, j) => (j === colIndex ? value : cell))
          : row,
      ),
    );
  };

  const addRow = () => {
    onChange([...rows, new Array(columnCount).fill("")]);
  };

  const addColumn = () => {
    onChange(rows.map((row) => [...row, ""]));
  };

  const deleteRow = (rowIndex: number) => {
    const next = rows.filter((_, i) => i !== rowIndex);
    onChange(next.length > 0 ? next : EMPTY_GRID());
  };

  const deleteColumn = (colIndex: number) => {
    const next = rows.map((row) => row.filter((_, j) => j !== colIndex));
    onChange(next.some((row) => row.length > 0) ? next : EMPTY_GRID());
  };

  return (
    <TooltipProvider>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/50">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-primary-subtle/40">
              {/* 行号列头空占位（删行入口在行号上，见 tbody） */}
              <th className="w-9 min-w-9 border-r border-border/50" />
              {Array.from({ length: columnCount }, (_, j) => (
                <th
                  key={j}
                  className="group relative border-r border-border/50 px-1 py-1 font-normal last:border-r-0"
                >
                  <span className="block truncate text-xs font-medium text-muted-foreground">
                    {String.fromCharCode(65 + (j % 26))}
                    {j >= 26 ? Math.floor(j / 26) : ""}
                  </span>
                  <IconTooltip label={t("chat:library.deleteColumn")}>
                    <button
                      type="button"
                      aria-label={t("chat:library.deleteColumn")}
                      onClick={() => deleteColumn(j)}
                      className="absolute inset-y-0 right-0 hidden items-center rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:flex"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </IconTooltip>
                </th>
              ))}
              {/* 加列入口（列标尾「+」） */}
              <th className="w-9 min-w-9">
                <IconTooltip label={t("chat:library.addColumn")}>
                  <button
                    type="button"
                    aria-label={t("chat:library.addColumn")}
                    onClick={addColumn}
                    className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </IconTooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-border/50">
                {/* 行号：hover 换 × 删行 */}
                <td className="group/row relative w-9 min-w-9 border-r border-border/50 text-center align-middle">
                  <span className="block px-1 text-xs text-muted-foreground group-hover/row:hidden">
                    {i + 1}
                  </span>
                  <IconTooltip label={t("chat:library.deleteRow")}>
                    <button
                      type="button"
                      aria-label={t("chat:library.deleteRow")}
                      onClick={() => deleteRow(i)}
                      className="hidden items-center justify-center rounded p-0.5 text-muted-foreground hover:text-destructive group-hover/row:flex"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </IconTooltip>
                </td>
                {Array.from({ length: columnCount }, (_, j) => (
                  <td
                    key={j}
                    className="border-r border-border/50 p-0 last:border-r-0"
                  >
                    <input
                      value={row[j] ?? ""}
                      onChange={(e) => updateCell(i, j, e.target.value)}
                      aria-label={`${i + 1},${String.fromCharCode(65 + (j % 26))}`}
                      className={cn(
                        "w-full bg-transparent px-2 py-1 text-sm outline-none",
                        "focus:bg-primary-subtle/30 focus:ring-1 focus:ring-primary/40",
                      )}
                    />
                  </td>
                ))}
                {/* 行数据列数可短于 columnCount（防御渲染），空占位 */}
                {row.length < columnCount && (
                  <td colSpan={columnCount - row.length} />
                )}
              </tr>
            ))}
            {/* 加行入口（行号尾「+」） */}
            <tr>
              <td className="border-t border-border/50">
                <IconTooltip label={t("chat:library.addRow")}>
                  <button
                    type="button"
                    aria-label={t("chat:library.addRow")}
                    onClick={addRow}
                    className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </IconTooltip>
              </td>
              <td colSpan={columnCount} className="border-t border-border/50" />
            </tr>
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}
