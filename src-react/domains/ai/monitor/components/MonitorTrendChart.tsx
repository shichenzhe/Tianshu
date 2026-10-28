// src-react/domains/ai/monitor/components/MonitorTrendChart.tsx
/** 7 天趋势（spec §6）：每日两柱——token 总量 bg-primary / 调用次数
 *  bg-primary-active（主题变量）；两序列各自以窗口内单日最大值独立归一
 *  （token 量级远大于调用次数，共用基准会让调用柱恒 3px 不可读）；
 *  顶部图例标注两色含义 */
import { useTranslation } from "react-i18next";
import type { MonitorStats } from "../api/monitor.api";

const BAR_AREA_HEIGHT = 64;

function TrendBar({
  value,
  max,
  className,
}: {
  value: number;
  max: number;
  className: string;
}) {
  const height =
    value === 0 ? 2 : Math.max(3, Math.round((value / max) * BAR_AREA_HEIGHT));
  return (
    <div
      className={`w-2.5 rounded-sm ${className} ${value === 0 ? "opacity-30" : ""}`}
      style={{ height }}
    />
  );
}

export default function MonitorTrendChart({
  trend,
}: {
  trend: MonitorStats["trend"];
}) {
  const { t } = useTranslation(["chat"]);
  const maxTokens = Math.max(
    1,
    ...trend.map((d) => d.inputTokens + d.outputTokens),
  );
  const maxCalls = Math.max(1, ...trend.map((d) => d.llmCalls + d.toolCalls));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-primary" />
          {t("chat:monitor.trendTokens")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-primary-active" />
          {t("chat:monitor.trendCalls")}
        </span>
      </div>
      <div className="flex items-end gap-2">
        {trend.map((day) => (
          <div
            key={day.date}
            className="flex flex-1 flex-col items-center gap-1"
            title={t("chat:monitor.trendBar", {
              date: day.date,
              tokens: day.inputTokens + day.outputTokens,
              calls: day.llmCalls + day.toolCalls,
            })}
          >
            <div
              className="flex items-end justify-center gap-1"
              style={{ height: BAR_AREA_HEIGHT }}
            >
              <TrendBar
                value={day.inputTokens + day.outputTokens}
                max={maxTokens}
                className="bg-primary"
              />
              <TrendBar
                value={day.llmCalls + day.toolCalls}
                max={maxCalls}
                className="bg-primary-active"
              />
            </div>
            <span className="text-[10px] leading-none text-muted-foreground">
              {day.date.slice(5)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
