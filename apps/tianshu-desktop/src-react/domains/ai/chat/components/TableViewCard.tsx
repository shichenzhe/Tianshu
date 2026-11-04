/**
 * 数据表格卡（show_table 工具块渲染）：工作流查询结果在消息流的原生
 * 表格呈现（demo 切片 2026-10-28）。args 由模型传入、渲染层消费——执行
 * 中渲染骨架占位，失败/被拒不渲染（args 不完整无卡可示，宁退不崩）。
 * 单元格值仅标量（display-tools schema 收口），null/undefined 占位 —。
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Table2 } from "lucide-react";

import type { TablePanelItem } from "../lib/group-blocks";

/** 单元格文本：null/undefined 占位 —；布尔出符号（locale 中立）；其余 String */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "✓" : "✗";
  return String(value);
}

function TableViewCardBody({ item }: { item: TablePanelItem }) {
  const { t } = useTranslation(["chat"]);

  // 执行中（args 渐进）：骨架占位，不闪现空表
  if (item.state === "running" || item.state === "awaiting-approval") {
    return (
      <div
        data-testid="table-loading"
        className="my-2 overflow-hidden rounded-lg border border-border/50"
      >
        <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <Table2 className="h-3.5 w-3.5 shrink-0 animate-pulse text-primary" />
          <span className="truncate">
            {item.title || t("chat:showTable.loading")}
          </span>
        </div>
        <div className="space-y-1.5 px-3 py-2.5">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  // 失败/被拒：动作未发生、args 不完整，无卡可渲染
  if (item.state === "denied" || item.state === "error") {
    return null;
  }

  const empty = item.rows.length === 0;

  return (
    <div
      data-testid="table-card"
      className="my-2 overflow-hidden rounded-lg border border-border/50"
    >
      {/* 标题栏：表格图标 + 标题（视觉同 ExpertRecommendCard 标题栏） */}
      <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <Table2 className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="truncate">
          {item.title || t("chat:showTable.defaultTitle")}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/50 text-left text-muted-foreground">
              {item.columns.map((column) => (
                <th
                  key={column.key}
                  className="whitespace-nowrap px-3 py-1.5 font-medium"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {empty ? (
              <tr>
                <td
                  colSpan={Math.max(item.columns.length, 1)}
                  className="px-3 py-3 text-center text-muted-foreground"
                >
                  {t("chat:showTable.empty")}
                </td>
              </tr>
            ) : (
              item.rows.map((row, index) => (
                <tr key={index} className="text-foreground/90">
                  {item.columns.map((column) => {
                    const value = row[column.key];
                    return (
                      <td
                        key={column.key}
                        className={`whitespace-nowrap px-3 py-1.5 ${
                          typeof value === "number"
                            ? "text-right tabular-nums"
                            : ""
                        }`}
                      >
                        {formatCell(value)}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TableViewCard = memo(TableViewCardBody);
export default TableViewCard;
