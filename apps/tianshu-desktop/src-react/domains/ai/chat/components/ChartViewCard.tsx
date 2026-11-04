/**
 * 图表卡（show_chart 工具块渲染）：手绘简版 SVG——零新依赖（依赖互锁
 * 铁律），line 折线（趋势）/bar 柱状（量级对比）两形态。规范要点
 * （dataviz 方法约束的降采样版）：系列色按固定次序分配不循环（主题
 * 变量取色，明暗主题自适应）；2px 线宽；柱体顶端 2px 圆角 + 相邻 2px
 * 留白；网格线退后（border 色）；文字一律文字色（muted-foreground）
 * 不用系列色；≥2 系列必有图例；mark 挂原生 <title> 悬停读值；空态/
 * 单点（折线退化为独立圆点标记）处理。执行中骨架占位、失败/被拒不渲染。
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { LineChart as LineChartIcon } from "lucide-react";

import type { ChartPanelItem, ChartSeries } from "../lib/group-blocks";

/** 系列色固定次序（不循环；主题变量——图表不硬编码色） */
const SERIES_COLORS = [
  "var(--primary)",
  "var(--muted-foreground)",
  "var(--primary-active)",
];

/** 画布常量（viewBox 坐标系） */
const VB_W = 320;
const VB_H = 168;
const PAD = { top: 10, right: 10, bottom: 20, left: 10 };
const PLOT_W = VB_W - PAD.left - PAD.right;
const PLOT_H = VB_H - PAD.top - PAD.bottom;

/** 数值域：柱状从 0 起（量级锚定基线）；全等值 ±1 防除零 */
function valueDomain(series: ChartSeries[], chartType: "line" | "bar") {
  const values = series.flatMap((s) => s.values);
  let min = chartType === "bar" ? 0 : Math.min(0, ...values);
  let max = Math.max(...values, 0);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

const formatAxis = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 10000) return `${Math.round(n / 1000)}k`;
  if (abs >= 100) return String(Math.round(n));
  if (abs >= 10) return n.toFixed(0);
  return String(Number(n.toFixed(1)));
};

/** x 轴刻度最多 ~6 个（均匀抽样保末位） */
function sampledLabels(
  labels: string[],
): Array<{ index: number; text: string }> {
  if (labels.length === 0) {
    return [];
  }
  if (labels.length <= 6) {
    return labels.map((text, index) => ({ index, text }));
  }
  const step = Math.ceil(labels.length / 5);
  const out: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < labels.length; i += step) {
    out.push({ index: i, text: labels[i] });
  }
  if (out[out.length - 1].index !== labels.length - 1) {
    out.push({ index: labels.length - 1, text: labels[labels.length - 1] });
  }
  return out;
}

function ChartViewCardBody({ item }: { item: ChartPanelItem }) {
  const { t } = useTranslation(["chat"]);

  if (item.state === "running" || item.state === "awaiting-approval") {
    return (
      <div
        data-testid="chart-loading"
        className="my-2 overflow-hidden rounded-lg border border-border/50"
      >
        <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <LineChartIcon className="h-3.5 w-3.5 shrink-0 animate-pulse text-primary" />
          <span className="truncate">
            {item.title || t("chat:showChart.loading")}
          </span>
        </div>
        <div className="space-y-1.5 px-3 py-2.5">
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-16 w-full animate-pulse rounded bg-muted/60" />
        </div>
      </div>
    );
  }

  if (item.state === "denied" || item.state === "error") {
    return null;
  }

  const empty =
    item.labels.length === 0 ||
    item.series.length === 0 ||
    item.series.every((s) => s.values.length === 0);

  return (
    <div
      data-testid="chart-card"
      className="my-2 overflow-hidden rounded-lg border border-border/50"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <LineChartIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate">
            {item.title || t("chat:showChart.defaultTitle")}
          </span>
        </span>
        {/* 图例（≥2 系列必有——identity 不依赖颜色单独成立） */}
        {item.series.length >= 2 &&
          item.series.map((series, index) => (
            <span
              key={series.name}
              className="flex shrink-0 items-center gap-1"
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-sm"
                style={{
                  backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length],
                }}
              />
              <span className="truncate">{series.name}</span>
            </span>
          ))}
      </div>

      {empty ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          {t("chat:showChart.empty")}
        </p>
      ) : (
        <div className="px-2 py-2">
          <svg
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            className="w-full"
            role="img"
            aria-label={item.title || t("chat:showChart.defaultTitle")}
          >
            <ChartGeometry
              chartType={item.chartType}
              labels={item.labels}
              series={item.series}
            />
          </svg>
        </div>
      )}
    </div>
  );
}

/** 纯几何层（便于直测坐标推导）：网格 + 系列 marks + 轴刻度 */
function ChartGeometry({
  chartType,
  labels,
  series,
}: {
  chartType: "line" | "bar";
  labels: string[];
  series: ChartSeries[];
}) {
  const { min, max } = valueDomain(series, chartType);
  const xAt = (i: number) =>
    PAD.left +
    (labels.length === 1 ? PLOT_W / 2 : (i / (labels.length - 1)) * PLOT_W);
  const yAt = (v: number) =>
    PAD.top + PLOT_H - ((v - min) / (max - min)) * PLOT_H;
  const ticks = sampledLabels(labels);

  return (
    <g>
      {/* 退后网格：上/中/下三条横线（border 色） */}
      {[max, (max + min) / 2, min].map((v) => (
        <line
          key={v}
          x1={PAD.left}
          x2={VB_W - PAD.right}
          y1={yAt(v)}
          y2={yAt(v)}
          stroke="var(--border)"
          strokeWidth={1}
        />
      ))}
      {/* y 轴域标注（文字色小字） */}
      <text
        x={VB_W - PAD.right}
        y={yAt(max) - 2}
        textAnchor="end"
        fontSize={8}
        fill="var(--muted-foreground)"
      >
        {formatAxis(max)}
      </text>
      <text
        x={VB_W - PAD.right}
        y={yAt(min) - 2}
        textAnchor="end"
        fontSize={8}
        fill="var(--muted-foreground)"
      >
        {formatAxis(min)}
      </text>
      {/* x 轴刻度（文字色） */}
      {ticks.map(({ index, text }) => (
        <text
          key={index}
          x={xAt(index)}
          y={VB_H - 6}
          textAnchor="middle"
          fontSize={8}
          fill="var(--muted-foreground)"
        >
          {text}
        </text>
      ))}
      {chartType === "line"
        ? series.map((s, si) => {
            const color = SERIES_COLORS[si % SERIES_COLORS.length];
            // 单点退化：独立圆点标记（无连线可画）
            const single = s.values.length === 1;
            const points = s.values
              .map((v, i) => `${xAt(i)},${yAt(v)}`)
              .join(" ");
            return (
              <g key={s.name}>
                {!single && (
                  <polyline
                    points={points}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                {s.values.map((v, i) => (
                  <circle
                    key={i}
                    cx={xAt(i)}
                    cy={yAt(v)}
                    r={single ? 4 : 3}
                    fill={color}
                  >
                    <title>{`${s.name} · ${labels[i]}: ${v}`}</title>
                  </circle>
                ))}
              </g>
            );
          })
        : series.map((s, si) => {
            const color = SERIES_COLORS[si % SERIES_COLORS.length];
            const groupW = PLOT_W / labels.length;
            // 组内均分留 2px 相邻间隔与 2px 顶端圆角（量级锚定 0 基线）
            const barW = Math.max(2, (groupW - 4) / series.length - 2);
            return (
              <g key={s.name}>
                {s.values.map((v, i) => {
                  const groupX = PAD.left + i * groupW;
                  const x =
                    groupX +
                    2 +
                    si * (barW + 2) +
                    (groupW - 4 - series.length * (barW + 2)) / 2;
                  const y = yAt(v);
                  const h = PAD.top + PLOT_H - y;
                  return (
                    <rect
                      key={i}
                      x={x}
                      y={y}
                      width={barW}
                      height={Math.max(h, 1)}
                      rx={2}
                      fill={color}
                    >
                      <title>{`${s.name} · ${labels[i]}: ${v}`}</title>
                    </rect>
                  );
                })}
              </g>
            );
          })}
    </g>
  );
}

const ChartViewCard = memo(ChartViewCardBody);
export default ChartViewCard;
