/**
 * 成员报告卡（memberReport 块，专家团可观测性批 2026-11-05）：专家团成员
 * 补全产出的正文位折叠卡——头部为成员名 + 轮次 + 任务摘要，展开区显成员
 * 产出全文。视觉沿用 ToolCallCard 折叠容器语言（border-border/50 +
 * bg-muted/30 + details/summary），事后审计成员观点来源
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";

import type { MemberReportPanelItem } from "../lib/group-blocks";

interface MemberReportCardProps {
  item: MemberReportPanelItem;
}

function MemberReportCardImpl({ item }: MemberReportCardProps) {
  const { t } = useTranslation(["chat"]);

  return (
    <details className="my-1 rounded-md border border-border/50 bg-muted/30">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-muted-foreground">
        <span className="inline-flex max-w-full items-center gap-1.5">
          <span className="shrink-0">
            👥{" "}
            {t("chat:memberReport.title", {
              member: item.memberName,
              round: item.round,
            })}
          </span>
          {item.task && <span className="truncate">→ {item.task}</span>}
        </span>
      </summary>
      <div className="px-3 pb-2">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed">
          {item.content}
        </pre>
      </div>
    </details>
  );
}

export default memo(MemberReportCardImpl);
