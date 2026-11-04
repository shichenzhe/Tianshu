/**
 * mermaid-export 纯函数单测：svgIntrinsicSize（viewBox 提取/回退）、
 * fitExportScale（2x 采样与 canvas 上限下调）
 */
import { describe, expect, it } from "vitest";

import {
  fitExportScale,
  PNG_EXPORT_SCALE,
  svgIntrinsicSize,
} from "../../../src-react/domains/ai/chat/lib/mermaid-export";

describe("svgIntrinsicSize", () => {
  it("从 viewBox 提取宽高（含小数）", () => {
    const svg = '<svg viewBox="0 0 640.5 480.25" width="100%">';
    expect(svgIntrinsicSize(svg)).toEqual({ width: 640.5, height: 480.25 });
  });

  it("无 viewBox / 非法数值回退 800×600", () => {
    expect(svgIntrinsicSize('<svg width="100%">')).toEqual({
      width: 800,
      height: 600,
    });
    expect(svgIntrinsicSize('<svg viewBox="0 0 -10 0">')).toEqual({
      width: 800,
      height: 600,
    });
  });
});

describe("fitExportScale", () => {
  it("常规尺寸保持 2x", () => {
    expect(fitExportScale(640, 480)).toBe(PNG_EXPORT_SCALE);
  });

  it("任一边超 canvas 上限按比例下调", () => {
    const scale = fitExportScale(5000, 400);
    expect(5000 * scale).toBeLessThanOrEqual(8192);
    expect(400 * scale).toBeLessThanOrEqual(8192);
    expect(scale).toBeLessThan(PNG_EXPORT_SCALE);
  });
});
