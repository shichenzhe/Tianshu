import { describe, expect, it } from "vitest";

import { buildMermaidSrcDoc, parseMermaidFrame } from "./mermaid-srcdoc";

describe("buildMermaidSrcDoc", () => {
  it("CSP 放行 jsdelivr 脚本源，收敛其余外联", () => {
    const doc = buildMermaidSrcDoc("graph TD; A-->B", false);
    expect(doc).toContain(
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
    );
    expect(doc).toContain("default-src 'none'");
  });

  it("图源码经 JSON 转义注入，主题随明暗", () => {
    expect(buildMermaidSrcDoc('a "q" \\ b', true)).toContain(
      JSON.stringify('a "q" \\ b'),
    );
    expect(buildMermaidSrcDoc("x", true)).toContain('"dark"');
    expect(buildMermaidSrcDoc("x", false)).toContain('"default"');
  });
});

describe("parseMermaidFrame", () => {
  it("resize 帧 clamp 返回高度；error 帧返回 error；其余 null", () => {
    expect(
      parseMermaidFrame(JSON.stringify({ type: "widget:resize", height: 300 })),
    ).toEqual({ type: "resize", height: 300 });
    expect(
      parseMermaidFrame(JSON.stringify({ type: "mermaid:error" })),
    ).toEqual({ type: "error" });
    expect(parseMermaidFrame("not-json")).toBeNull();
    expect(parseMermaidFrame(JSON.stringify({ type: "other" }))).toBeNull();
  });
});
