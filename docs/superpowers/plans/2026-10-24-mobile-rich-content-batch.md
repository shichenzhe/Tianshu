# 移动端富内容渲染批（MC）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对齐桌面已有能力、补移动端呈现层最后一块富内容缺口——```mermaid 围栏图渲染 + 会话文件 .html 产物 WebView 预览（当前两者均降级为纯文本/源码）。

**Architecture:** 单端闭环 `apps/tianshu-mobile`。mermaid 渲染走 WebView（复用 WidgetCard 已验证的 srcdoc+CSP+高度桥模式），runtime 首版从 CDN 加载（mermaid 12 与桌面同版系）；HTML 产物预览直接复用 `buildWidgetSrcDoc` 沙箱。纯函数（srcdoc 构造）TDD，组件以三闸+真机验收。

**Tech Stack:** react-native-webview（已在依赖）、mermaid@12（CDN，零包体）。

**Spec:** 本计划自含（对比报告呈现层缺口 + 桌面 MermaidBlock.tsx 语义参照：失败降级源码、明暗主题、strict 安全级）。

## 假设与范围裁定

1. **mermaid runtime 走 CDN（jsdelivr mermaid@12）**：min.js 5.2MB 打包进 app（asset 化+同目录部署+baseUrl 加载链）复杂度与包体代价不成比例；网络不可达/语法错误均降级现有代码块显源码（对齐桌面失败降级语义）。内网纯离线场景无图但有源码——可接受，本地 runtime 资产化留后续优化批。
2. **HTML 产物预览允许脚本**（allow-scripts，同 widget 沙箱语义）——模型产物本来就是交互页；CSP default-src 'none' 收敛外联面。
3. **HTML 分支不受 50k 截断**——截断会破坏页面结构；WebView 无渲染树性能问题（512KB files/read 上限天然封顶）。MarkdownLite 分支截断逻辑不动。
4. 桌面 MermaidBlock 的 PNG 导出/复制图（file:saveDataUrl、剪贴板图）不在移动端首版（剪贴板写图是渲染层 W3C 域，另有价值评估），标注为后续可选。

## Global Constraints

- 主干直接提交；命令显式 cd（cwd 漂移坑）；rtk 吞输出用 node 复核。
- 零新依赖（本批不动 npm install——若意外需要 install，装后必全量 vitest，前批 R8 教训）。
- 双引号+分号+printWidth 80；提交信息 `feat(mobile): …（富内容批）`。
- WebView 组件不用 nativewind className（动效批已裁定）。

---

### Task MC-1: mermaid 围栏渲染（srcdoc 纯函数 TDD + MermaidView 组件）

**Files:**
- Create: `apps/tianshu-mobile/src/logic/mermaid-srcdoc.ts`（纯函数）
- Create: `apps/tianshu-mobile/src/logic/mermaid-srcdoc.test.ts`
- Create: `apps/tianshu-mobile/src/components/MermaidView.tsx`
- Modify: `apps/tianshu-mobile/src/components/MarkdownLite.tsx`（CodeBlock 导出 + code 分流）

**Interfaces:**
- Produces: `buildMermaidSrcDoc(code: string, dark: boolean): string`；`parseMermaidFrame(data: string): { type: "resize"; height: number } | { type: "error" } | null`；`MermaidView({ code }: { code: string })`。

- [ ] **Step 1: 失败测试**（mermaid-srcdoc.test.ts）

```ts
import { describe, expect, it } from "vitest";

import {
  buildMermaidSrcDoc,
  parseMermaidFrame,
} from "./mermaid-srcdoc";

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
    expect(
      parseMermaidFrame(JSON.stringify({ type: "other" })),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试失败** `cd apps/tianshu-mobile && npx vitest run src/logic/mermaid-srcdoc.test.ts`
- [ ] **Step 3: 实现 mermaid-srcdoc.ts**——骨架对齐 widget-srcdoc（RESIZE_BOOTSTRAP 同款复用其常量语义，frame 解析含 error 帧）；渲染脚本：`mermaid.initialize({ startOnLoad:false, securityLevel:"strict", theme })` → `mermaid.render("m", code)` 成功后 innerHTML 注入 + script 标签 onerror/`window.onerror` postMessage `{type:"mermaid:error"}`。
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: MermaidView 组件**——外层卡片（标题字面量 "mermaid" 对齐桌面）；加载态复用 WidgetCard 占位样式；`onMessage` 解析：resize→setHeight（clamp 40-800 同 widget）、error→failed 降级 `<CodeBlock code lang="mermaid" />`；dark 取 `useColorScheme()`（nativewind）。
- [ ] **Step 6: MarkdownLite 分流**——`CodeBlock` 改 `export`；`renderNode` case "code"：`node.lang === "mermaid" ? <MermaidView code={node.code}/> : <CodeBlock node={node}/>`。
- [ ] **Step 7: 三闸 + 提交** `feat(mobile): mermaid 围栏渲染——CDN WebView+失败降级源码（富内容批）`

### Task MC-2: 会话文件 HTML 产物 WebView 预览

**Files:**
- Modify: `apps/tianshu-mobile/src/components/FilePreviewModal.tsx`

- [ ] **Step 1**：`isHtml = /\.(html?)$/i.test(path)`（.htm 一并）；ok 态分支：html → `<WebView source={{ html: buildWidgetSrcDoc(content) }} javaScriptEnabled originWhitelist={["*"]} style={{ height, backgroundColor:"transparent" }} onMessage={…parseWidgetResize…}/>`（height state 40-800 clamp 同 widget；不套 ScrollView、不走 50k 截断）；其余原 MarkdownLite 路径不动。
- [ ] **Step 2**：三闸 + 提交 `feat(mobile): HTML 产物 WebView 预览——复用 widget 沙箱（富内容批）`

---

## Self-Review

- 范围：呈现层富内容两缺口；PNG 导出、本地 runtime 明确延后（裁定 1/4）。
- 类型一致：`MermaidView`/`buildMermaidSrcDoc`/`parseMermaidFrame` 定义与消费一致；CodeBlock 导出仅加 export 关键字不改签名。
- 占位符：无（组件代码在计划内以要点+复用锚描述，文件均已读过）。
