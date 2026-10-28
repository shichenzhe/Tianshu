# 移动端消息渲染对齐（MR 批）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移动端消息流补齐五类「模型已产出、移动端看不见」的渲染（widget 沙箱/专家推荐卡/Agent 进度行/伪工具调用警示/代码块复制）+ 会话产物文件 sheet。

**Architecture:** 全部走既有消息 blocks 数据（历史 `entry.history` 已 parse、流式 `liveBlocks` 产出同构 tool_call 块），`MessageItem` 的 `BlockView` 按 toolName/text 特征块级分流；产物 sheet 纯派生自消息 + live；远控协议零改动。纯函数走 `src/logic/` + vitest 单测，视觉组件真机手测。

**Tech Stack:** Expo SDK 57（RN + expo-router + zustand + NativeWind）、react-native-webview（新增，Expo Go 内置）、@tianshu/protocol ENDPOINTS 既有端点。

**Spec:** `docs/superpowers/specs/2026-10-23-mobile-render-align-design.md`

## Global Constraints

- mobile 测试/类型（**必须显式 cd**——Bash cwd 会漂移回仓库根）：`cd apps/tianshu-mobile && npm run test`、`cd apps/tianshu-mobile && npm run typecheck`
- mobile 代码风格：**无分号**、双引号、2 空格（与 mobile 现有文件一致；root Prettier 分号规则不适用 mobile 树）
- i18n 双语同步：`apps/tianshu-mobile/src/i18n/locales/{zh-CN,en-US}/chat.json` 同时新增 key，禁止 JSX 硬编码中文
- nativewind 本地树守护：mobile 有独立 node_modules/lockfile；任何装包后在 mobile 目录内 `node -e "console.log(require.resolve('nativewind', {paths:['./']}))"` 必须指向 `apps/tianshu-mobile/node_modules`
- 分流常量 import 自既有 `@/logic/group-blocks.ts`（`WIDGET_TOOL_NAME` / `RECOMMEND_TOOL_NAME`），不得重定义
- 纯函数双份移植来源（不收编共享包——`@tianshu/core` 带 langChain peer）：桌面 `src-react/domains/ai/chat/components/WidgetRenderer.tsx`（buildWidgetSrcDoc）、`src-react/domains/ai/chat/lib/pseudo-tool-call.ts`、`src-react/domains/ai/chat/lib/artifacts.ts`（deriveSessionFiles）——移植版文件头注释标注桌面出处
- 提交粒度：每任务一提交，消息 `feat(mobile): …（MR-Tn）` 风格

---

### Task 1: react-native-webview 依赖 + widget 沙箱文档纯函数

**Files:**
- Modify: `apps/tianshu-mobile/package.json`（+react-native-webview，expo install 写入）
- Create: `apps/tianshu-mobile/src/logic/widget-srcdoc.ts`
- Test: `apps/tianshu-mobile/src/logic/widget-srcdoc.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `buildWidgetSrcDoc(code: string): string`（含 CSP + RN postMessage 桥上报脚本）
  - `parseWidgetResize(data: string): number | null`（onMessage 高度帧解析 + clamp）
  - `WIDGET_MIN_HEIGHT = 40`、`WIDGET_MAX_HEIGHT = 800`、`WIDGET_INITIAL_HEIGHT = 120`

- [ ] **Step 1: 装依赖**（mobile 独立树内，expo install 自动选 SDK 57 配套版本）：

```bash
cd /Users/hjx/workspace/mirror/apps/tianshu-mobile && npx expo install react-native-webview
```

- [ ] **Step 2: nativewind 本地树守护核验**：

```bash
cd /Users/hjx/workspace/mirror/apps/tianshu-mobile && node -e "console.log(require.resolve('nativewind', {paths:['./']}))"
```

Expected: 输出以 `apps/tianshu-mobile/node_modules/nativewind` 结尾（若指向根树——跑 `apps/tianshu-mobile/scripts/restore-local-nativewind.sh` 后复验）

- [ ] **Step 3: 写失败测试** `src/logic/widget-srcdoc.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import {
  buildWidgetSrcDoc,
  parseWidgetResize,
  WIDGET_INITIAL_HEIGHT,
  WIDGET_MAX_HEIGHT,
  WIDGET_MIN_HEIGHT,
} from "./widget-srcdoc";

describe("buildWidgetSrcDoc", () => {
  it("CSP 隔离头与代码本体注入", () => {
    const doc = buildWidgetSrcDoc("<b>hi</b>");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("<b>hi</b>");
  });

  it("高度 clamp 常量与桌面同值", () => {
    expect(WIDGET_MIN_HEIGHT).toBe(40);
    expect(WIDGET_MAX_HEIGHT).toBe(800);
    expect(WIDGET_INITIAL_HEIGHT).toBe(120);
  });

  it("RN postMessage 桥上报脚本注入", () => {
    expect(buildWidgetSrcDoc("x")).toContain("ReactNativeWebView");
  });
});

describe("parseWidgetResize", () => {
  it("合法帧解析 + clamp", () => {
    expect(
      parseWidgetResize(JSON.stringify({ type: "widget:resize", height: 10 })),
    ).toBe(WIDGET_MIN_HEIGHT);
    expect(
      parseWidgetResize(JSON.stringify({ type: "widget:resize", height: 9000 })),
    ).toBe(WIDGET_MAX_HEIGHT);
    expect(
      parseWidgetResize(JSON.stringify({ type: "widget:resize", height: 250 })),
    ).toBe(250);
  });

  it("非 resize 帧 / 坏 JSON 返回 null", () => {
    expect(parseWidgetResize("not json")).toBeNull();
    expect(parseWidgetResize(JSON.stringify({ type: "other" }))).toBeNull();
  });
});
```

- [ ] **Step 4: 跑红**：`cd apps/tianshu-mobile && npm run test` → widget-srcdoc 模块不存在 FAIL

- [ ] **Step 5: 实现 `src/logic/widget-srcdoc.ts`**（桌面 WidgetRenderer.tsx 的 buildWidgetSrcDoc 移植；差异点：上报脚本优先 `window.ReactNativeWebView.postMessage`——RN WebView 中 `window.postMessage` 不触发 onMessage，需走 RN 注入的桥对象；CSP/重置样式/root 结构照搬）：

```ts
/**
 * widget 沙箱文档构造（MR-T1）——桌面
 * src-react/domains/ai/chat/components/WidgetRenderer.tsx 的 buildWidgetSrcDoc
 * 双份移植（@tianshu/core 带 langChain peer 不宜引，同 file-refs 先例）。
 * 差异：高度上报优先 window.ReactNativeWebView.postMessage（RN WebView
 * onMessage 桥；window.postMessage 在 RN WebView 内不触发 onMessage），
 * 兜底 parent.postMessage（web 预览场景）。
 */

/** 高度 clamp（与桌面同值）：过小无意义，过大撑爆消息流 */
export const WIDGET_MIN_HEIGHT = 40;
export const WIDGET_MAX_HEIGHT = 800;
/** 加载态默认高度（上报到达前的初值） */
export const WIDGET_INITIAL_HEIGHT = 120;

const RESIZE_BOOTSTRAP = `<script>
(function () {
  var last = 0;
  function send() {
    var h = document.documentElement.scrollHeight || document.body.scrollHeight;
    if (h !== last) {
      last = h;
      var msg = JSON.stringify({ source: "widget", type: "widget:resize", height: h });
      if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(msg); }
      else { parent.postMessage(msg, "*"); }
    }
  }
  send();
  if (window.ResizeObserver) {
    new ResizeObserver(send).observe(document.documentElement);
  }
  if (window.MutationObserver) {
    new MutationObserver(send).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
    });
  }
  window.addEventListener("load", send);
})();
</script>`;

export function buildWidgetSrcDoc(code: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background-color: transparent; overflow: visible; }
body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
#root { width: 100%; }
</style>
</head>
<body>
<div id="root">${code}</div>
${RESIZE_BOOTSTRAP}
</body>
</html>`;
}

/** WebView onMessage 高度帧解析：合法 resize 帧 clamp 后返回高度，其余 null */
export function parseWidgetResize(data: string): number | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown; height?: unknown };
    if (parsed?.type === "widget:resize" && typeof parsed.height === "number") {
      return Math.min(
        Math.max(Math.round(parsed.height), WIDGET_MIN_HEIGHT),
        WIDGET_MAX_HEIGHT,
      );
    }
  } catch {
    // 非 JSON 上报忽略
  }
  return null;
}
```

- [ ] **Step 6: 跑绿**：`cd apps/tianshu-mobile && npm run test` → 全 PASS

- [ ] **Step 7: 提交**：

```bash
git add apps/tianshu-mobile/package.json apps/tianshu-mobile/package-lock.json apps/tianshu-mobile/src/logic/widget-srcdoc.ts apps/tianshu-mobile/src/logic/widget-srcdoc.test.ts
git commit -m "feat(mobile): widget 沙箱文档构造纯函数+webview 依赖（MR-T1）"
```

---

### Task 2: WidgetCard 组件 + MessageItem widget 分流

**Files:**
- Create: `apps/tianshu-mobile/src/components/WidgetCard.tsx`
- Modify: `apps/tianshu-mobile/src/components/MessageItem.tsx`（BlockView tool_call case 分流）
- Modify: `apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json`、`en-US/chat.json`（+widgetDefaultTitle、widgetLoading）

**Interfaces:**
- Consumes: Task 1 的 `buildWidgetSrcDoc` / `parseWidgetResize` / `WIDGET_INITIAL_HEIGHT`；既有 `@/logic/group-blocks` 的 `WIDGET_TOOL_NAME`
- Produces: `WidgetCard({ title?: string; code: string; state: string })`（组件，无导出依赖方）

- [ ] **Step 1: i18n 双语**（zh-CN / en-US chat.json 各加两 key）：

```json
"widgetDefaultTitle": "可视化组件",
"widgetLoading": "图表生成中…",
```

```json
"widgetDefaultTitle": "Widget",
"widgetLoading": "Generating chart…",
```

- [ ] **Step 2: 实现 `src/components/WidgetCard.tsx`**（视觉对齐桌面：标题栏 + 圆角边框卡；running/awaiting-approval 占位，其余终态注入沙箱——状态语义照搬桌面 WidgetRenderer）：

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Text, View } from "react-native";
import { BarChart3 } from "lucide-react-native";
import { WebView } from "react-native-webview";

import {
  buildWidgetSrcDoc,
  parseWidgetResize,
  WIDGET_INITIAL_HEIGHT,
} from "@/logic/widget-srcdoc";
import { useThemeColors } from "@/store/theme";

/**
 * show_widget 可视化卡（MR-T1，桌面 WidgetRenderer 语义移植）：
 * 沙箱 WebView 渲染模型产出的 HTML/JS——独立原生视图无同源共享，安全
 * 语义不弱于桌面 iframe sandbox=allow-scripts；文档内自带 CSP 与高度
 * 上报脚本（ReactNativeWebView 桥），onMessage 解析 clamp 40-800。
 * running/awaiting-approval 加载占位，其余终态一次性注入。
 */
export function WidgetCard({
  title,
  code,
  state,
}: {
  title?: string;
  code: string;
  /** 工具执行态（与 ChatStreamChunk tool-update.state 同词表） */
  state: string;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [height, setHeight] = useState(WIDGET_INITIAL_HEIGHT);
  const ready = state !== "running" && state !== "awaiting-approval";

  return (
    <View className="my-2 overflow-hidden rounded-lg border border-black/10 dark:border-white/15">
      <View className="flex-row items-center gap-1.5 border-b border-black/10 bg-black/5 px-3 py-1.5 dark:border-white/15 dark:bg-white/10">
        <BarChart3 size={13} color={colors.primary} />
        <Text
          numberOfLines={1}
          className="flex-1 text-xs text-black/50 dark:text-white/50"
        >
          {title ?? t("widgetDefaultTitle")}
        </Text>
      </View>
      {ready ? (
        <WebView
          source={{ html: buildWidgetSrcDoc(code) }}
          javaScriptEnabled
          originWhitelist={["*"]}
          style={{ height, backgroundColor: "transparent" }}
          onMessage={(e) => {
            const next = parseWidgetResize(e.nativeEvent.data);
            if (next != null) setHeight(next);
          }}
        />
      ) : (
        <View
          className="flex-row items-center justify-center gap-2 px-3 py-6"
          style={{ height: WIDGET_INITIAL_HEIGHT }}
        >
          <ActivityIndicator size="small" color="#9ca3af" />
          <Text className="text-xs text-black/50 dark:text-white/50">
            {t("widgetLoading")}
          </Text>
        </View>
      )}
    </View>
  );
}
```

- [ ] **Step 3: MessageItem BlockView 分流**——`src/components/MessageItem.tsx` 的 `BlockView` tool_call case 改为（其余不动；args 形态与桌面 group-blocks 注释一致：`{ title?, widget_code }`）：

```tsx
case "tool_call": {
  if (block.toolName === WIDGET_TOOL_NAME) {
    const args = block.args as { widget_code?: unknown; title?: unknown };
    const code = typeof args.widget_code === "string" ? args.widget_code : "";
    if (code === "") return null; // args 畸形不渲染（历史容错）
    return (
      <WidgetCard
        title={typeof args.title === "string" ? args.title : undefined}
        code={code}
        state={block.state}
      />
    );
  }
  return (
    <ToolCallCard
      toolName={block.toolName}
      args={block.args}
      state={block.state}
      output={block.output}
    />
  );
}
```

（`WIDGET_TOOL_NAME` 自 `@/logic/group-blocks` import；Task 3 会在同一 case 追加 recommend 分流。）

- [ ] **Step 4: typecheck + 全量测试**：

```bash
cd apps/tianshu-mobile && npm run typecheck && npm run test
```

Expected: 0 error、全 PASS（组件无单测框架，行为靠真机手测——Task 10 清单）

- [ ] **Step 5: 提交**：

```bash
git add apps/tianshu-mobile/src/components/WidgetCard.tsx apps/tianshu-mobile/src/components/MessageItem.tsx apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json apps/tianshu-mobile/src/i18n/locales/en-US/chat.json
git commit -m "feat(mobile): show_widget 可视化卡 WebView 沙箱渲染+消息流分流（MR-T1）"
```

---

### Task 3: RecommendCard 只读推荐卡 + 分流

**Files:**
- Create: `apps/tianshu-mobile/src/components/RecommendCard.tsx`
- Modify: `apps/tianshu-mobile/src/components/MessageItem.tsx`（tool_call case 追加 recommend 分流）
- Modify: i18n `chat.json` 双语（+recommendTitle、recommendAddOnDesktop）

**Interfaces:**
- Consumes: 既有 `@/logic/group-blocks` 的 `RECOMMEND_TOOL_NAME`；args 形态 `{ candidates: string[], reason: string }`
- Produces: `RecommendCard({ reason: string; slugs: string[] })`

- [ ] **Step 1: i18n 双语**：

```json
"recommendTitle": "专家推荐",
"recommendAddOnDesktop": "在桌面端添加启用",
```

```json
"recommendTitle": "Recommended experts",
"recommendAddOnDesktop": "Add on desktop",
```

- [ ] **Step 2: 实现 `src/components/RecommendCard.tsx`**（只读——添加动作需 assistant/save 端点+marketplace，远控协议无，spec §4 裁剪；视觉对齐 MessageFileRef 卡片形态）：

```tsx
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { Sparkles } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";

/**
 * 专家推荐卡（MR-T2，桌面 ExpertRecommendCard 只读版）：reason + slug
 * 胶囊行；「添加并启用」裁剪（需 assistant/save+marketplace，远控协议
 * 无此端点——spec §4 留档另行立批），脚注引导桌面端操作。
 */
export function RecommendCard({
  reason,
  slugs,
}: {
  reason: string;
  slugs: string[];
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();

  return (
    <View className="my-2 rounded-lg border border-black/10 bg-white px-3 py-2.5 dark:border-white/15 dark:bg-neutral-800">
      <View className="mb-1 flex-row items-center gap-1.5">
        <Sparkles size={13} color={colors.primary} />
        <Text className="text-xs font-medium text-black/60 dark:text-white/60">
          {t("recommendTitle")}
        </Text>
      </View>
      {reason !== "" && (
        <Text className="mb-2 text-sm leading-5 text-black dark:text-white">
          {reason}
        </Text>
      )}
      {slugs.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingBottom: 4 }}
        >
          {slugs.map((slug) => (
            <View
              key={slug}
              className="rounded-full border px-3 py-1"
              style={{
                borderColor: `${colors.primary}40`,
                backgroundColor: colors.subtle,
              }}
            >
              <Text
                className="text-xs"
                style={{ color: colors.primary }}
                numberOfLines={1}
              >
                {slug}
              </Text>
            </View>
          ))}
        </ScrollView>
      )}
      <Text className="mt-1 text-[10px] text-black/35 dark:text-white/35">
        {t("recommendAddOnDesktop")}
      </Text>
    </View>
  );
}
```

- [ ] **Step 3: MessageItem tool_call case 追加分流**（在 Task 2 的 `WIDGET_TOOL_NAME` 分支后、ToolCallCard 之前插入；命中块不再渲染通用 ToolCallCard）：

```tsx
if (block.toolName === RECOMMEND_TOOL_NAME) {
  const args = block.args as { candidates?: unknown; reason?: unknown };
  const slugs = Array.isArray(args.candidates)
    ? args.candidates.filter((s): s is string => typeof s === "string")
    : [];
  return (
    <RecommendCard
      reason={typeof args.reason === "string" ? args.reason : ""}
      slugs={slugs}
    />
  );
}
```

- [ ] **Step 4: typecheck + 测试 + 提交**：

```bash
cd apps/tianshu-mobile && npm run typecheck && npm run test
git add apps/tianshu-mobile/src/components/RecommendCard.tsx apps/tianshu-mobile/src/components/MessageItem.tsx apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json apps/tianshu-mobile/src/i18n/locales/en-US/chat.json
git commit -m "feat(mobile): recommend_experts 只读推荐卡+消息流分流（MR-T2）"
```

---

### Task 4: 伪工具调用警示（检测移植 + 折叠条 + text 分流）

**Files:**
- Create: `apps/tianshu-mobile/src/logic/pseudo-tool-call.ts` + `pseudo-tool-call.test.ts`
- Create: `apps/tianshu-mobile/src/components/PseudoToolCallNotice.tsx`
- Modify: `apps/tianshu-mobile/src/components/MessageItem.tsx`（BlockView text case 先检测）
- Modify: i18n `chat.json` 双语（+pseudoToolCallNotice）

**Interfaces:**
- Consumes: 无
- Produces: `detectPseudoToolCallText(text: string): boolean`（与桌面 `src-react/domains/ai/chat/lib/pseudo-tool-call.ts` 同规则）

- [ ] **Step 1: 写失败测试** `src/logic/pseudo-tool-call.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { detectPseudoToolCallText } from "./pseudo-tool-call";

describe("detectPseudoToolCallText", () => {
  it("空串不命中", () => {
    expect(detectPseudoToolCallText("")).toBe(false);
  });

  it("单个 <tool_call> 可能是讨论语法，不命中", () => {
    expect(detectPseudoToolCallText("工具语法是 <tool_call> 标签")).toBe(false);
  });

  it("两个及以上 <tool_call> 命中", () => {
    expect(
      detectPseudoToolCallText("<tool_call>a</tool_call>\n<tool_call>b"),
    ).toBe(true);
  });

  it("分词器特殊 token <| 命中", () => {
    expect(detectPseudoToolCallText("<|im_start|>")).toBe(true);
  });

  it("正常文本不命中", () => {
    expect(detectPseudoToolCallText("普通回答，1 < 2 且 3 > 2")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑红** → `cd apps/tianshu-mobile && npm run test` FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/logic/pseudo-tool-call.ts`**（桌面 lib/pseudo-tool-call.ts 逐行移植）：

```ts
/**
 * 伪工具调用碎片检测（MR-T4）——桌面
 * src-react/domains/ai/chat/lib/pseudo-tool-call.ts 双份移植：
 * 本地推理服务未实现结构化 tool_calls 时，模型把 Qwen 工具语法
 * （<tool_call> 字面量 / <| 特殊 token）直接写进正文；命中的 text 块
 * 不按正文渲染，收进警示折叠区保真可见。
 */

/** 命中阈值：<tool_call> 字面量至少出现次数（1 次可能是讨论语法的正常输出） */
const TOOL_CALL_TAG_MIN = 2;
const TOOL_CALL_TAG = "<tool_call>";
/** 分词器特殊 token 前缀，正常文本不应出现 */
const SPECIAL_TOKEN = "<|";

export function detectPseudoToolCallText(text: string): boolean {
  if (!text) {
    return false;
  }
  let count = 0;
  let index = text.indexOf(TOOL_CALL_TAG);
  while (index !== -1) {
    count += 1;
    if (count >= TOOL_CALL_TAG_MIN) {
      return true;
    }
    index = text.indexOf(TOOL_CALL_TAG, index + TOOL_CALL_TAG.length);
  }
  return text.includes(SPECIAL_TOKEN);
}
```

- [ ] **Step 4: 跑绿** → 全 PASS

- [ ] **Step 5: i18n**：

```json
"pseudoToolCallNotice": "模型输出了仿冒工具调用的文本，未实际执行",
```

```json
"pseudoToolCallNotice": "Pseudo tool-call text detected; not executed",
```

- [ ] **Step 6: 实现 `src/components/PseudoToolCallNotice.tsx`**（桌面 PseudoToolCallNotice 折叠条形态移植；注意 RN 动画值未用——纯 state 切换无坑）：

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";

const MAX_COLLAPSED_LINES = 200;

/** 伪工具调用警示折叠条（MR-T4）：警示头 + 原文保真（不进 Markdown） */
export function PseudoToolCallNotice({ rawText }: { rawText: string }) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [open, setOpen] = useState(false);

  return (
    <View className="my-1 rounded-md border border-amber-500/40 bg-amber-500/10">
      <Pressable
        onPress={() => setOpen((prev) => !prev)}
        accessibilityLabel={t("pseudoToolCallNotice")}
        className="flex-row items-center gap-2 px-3 py-1.5"
      >
        <AlertTriangle size={13} color="#f59e0b" />
        <Text
          numberOfLines={1}
          className="flex-1 text-xs text-amber-700 dark:text-amber-400"
        >
          {t("pseudoToolCallNotice")}
        </Text>
        {open ? (
          <ChevronUp size={13} color={colors.primary} />
        ) : (
          <ChevronDown size={13} color={colors.primary} />
        )}
      </Pressable>
      {open && (
        <ScrollView
          style={{ maxHeight: 300 }}
          nestedScrollEnabled
          className="px-3 pb-2"
        >
          <Text className="text-[11px] leading-4 text-black/60 dark:text-white/60">
            {rawText.slice(0, MAX_COLLAPSED_LINES * 80)}
            {rawText.length > MAX_COLLAPSED_LINES * 80 ? "…" : ""}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}
```

- [ ] **Step 7: MessageItem text case 分流**（BlockView 内，assistant 正文检测——user 分支不动）：

```tsx
case "text":
  return detectPseudoToolCallText(block.text) ? (
    <PseudoToolCallNotice rawText={block.text} />
  ) : (
    <MarkdownLite text={block.text} />
  );
```

- [ ] **Step 8: typecheck + 测试 + 提交**：

```bash
cd apps/tianshu-mobile && npm run typecheck && npm run test
git add apps/tianshu-mobile/src/logic/pseudo-tool-call.ts apps/tianshu-mobile/src/logic/pseudo-tool-call.test.ts apps/tianshu-mobile/src/components/PseudoToolCallNotice.tsx apps/tianshu-mobile/src/components/MessageItem.tsx apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json apps/tianshu-mobile/src/i18n/locales/en-US/chat.json
git commit -m "feat(mobile): 伪工具调用警示折叠条——检测移植+text 块分流（MR-T4）"
```

---

### Task 5: Agent 进度行（派生 + 替换占位行）

**Files:**
- Create: `apps/tianshu-mobile/src/logic/agent-progress.ts` + `agent-progress.test.ts`
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx`（替换 438-445 占位行；删 streamStarted 定义）
- Modify: i18n `chat.json` 双语（+agentPreparing、agentResponding、agentStep）

**Interfaces:**
- Consumes: 既有 `@/logic/remote-stream` 的 `RemoteStreamState`（字段 text/thinking/toolOrder/tools）
- Produces: `deriveAgentProgress(live: RemoteStreamState | null): { preparing: boolean; stepCount: number; activeTool?: string }`

- [ ] **Step 1: 写失败测试** `src/logic/agent-progress.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { deriveAgentProgress } from "./agent-progress";
import type { RemoteStreamState } from "./remote-stream";

function makeLive(overrides: Partial<RemoteStreamState>): RemoteStreamState {
  return {
    active: true,
    status: "streaming",
    text: "",
    thinking: "",
    toolOrder: [],
    tools: {},
    approvals: [],
    ...overrides,
  } as RemoteStreamState;
}

describe("deriveAgentProgress", () => {
  it("null live → 准备中 stepCount 1", () => {
    expect(deriveAgentProgress(null)).toEqual({
      preparing: true,
      stepCount: 1,
    });
  });

  it("空产出 live → 准备中", () => {
    expect(deriveAgentProgress(makeLive({}))).toEqual({
      preparing: true,
      stepCount: 1,
    });
  });

  it("仅有文本 → 回复中 stepCount 1", () => {
    expect(deriveAgentProgress(makeLive({ text: "hi" }))).toEqual({
      preparing: false,
      stepCount: 1,
    });
  });

  it("running 工具 → 步数+工具名（最新 running 优先）", () => {
    const live = makeLive({
      toolOrder: ["t1", "t2"],
      tools: {
        t1: { toolCallId: "t1", toolName: "read_file", state: "done" },
        t2: { toolCallId: "t2", toolName: "write_file", state: "running" },
      },
    });
    expect(deriveAgentProgress(live)).toEqual({
      preparing: false,
      stepCount: 3,
      activeTool: "write_file",
    });
  });

  it("工具全终态 → 回复中（无 activeTool）", () => {
    const live = makeLive({
      thinking: "…",
      toolOrder: ["t1"],
      tools: { t1: { toolCallId: "t1", toolName: "read_file", state: "done" } },
    });
    expect(deriveAgentProgress(live)).toEqual({
      preparing: false,
      stepCount: 2,
    });
  });
});
```

- [ ] **Step 2: 跑红** → FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/logic/agent-progress.ts`**（桌面 AgentProgress 的 store 派生逻辑移动端版——数据源换 RemoteStreamState）：

```ts
import type { RemoteStreamState } from "./remote-stream";

export interface AgentProgressInfo {
  /** 准备中（发出后尚无任何流式产出） */
  preparing: boolean;
  /** 当前生成轮次 = 流式 tools 条数 + 1（桌面 AgentProgress 同口径） */
  stepCount: number;
  /** 最新 running/awaiting-approval 工具名；无则回复中 */
  activeTool?: string;
}

/** Agent 流式进度派生（MR-T3，桌面 AgentProgress props 派生同构） */
export function deriveAgentProgress(
  live: RemoteStreamState | null,
): AgentProgressInfo {
  if (live == null) {
    return { preparing: true, stepCount: 1 };
  }
  const hasOutput =
    live.text !== "" || live.thinking !== "" || live.toolOrder.length > 0;
  if (!hasOutput) {
    return { preparing: true, stepCount: 1 };
  }
  const stepCount = live.toolOrder.length + 1;
  for (let i = live.toolOrder.length - 1; i >= 0; i--) {
    const tool = live.tools[live.toolOrder[i]];
    if (
      tool &&
      (tool.state === "running" || tool.state === "awaiting-approval")
    ) {
      return { preparing: false, stepCount, activeTool: tool.toolName };
    }
  }
  return { preparing: false, stepCount };
}
```

- [ ] **Step 4: 跑绿** → 全 PASS

- [ ] **Step 5: i18n**：

```json
"agentPreparing": "准备中",
"agentResponding": "回复中",
"agentStep": "第 {{step}} 步 · {{tool}}",
```

```json
"agentPreparing": "Preparing",
"agentResponding": "Responding",
"agentStep": "Step {{step}} · {{tool}}",
```

- [ ] **Step 6: [id].tsx 接线**——三处改动：

（a）import 区加：`import { deriveAgentProgress } from "@/logic/agent-progress";`

（b）删除 `streamStarted` 定义（327-328 行，仅占位行使用），在原位换派生：

```tsx
// Agent 进度行派生（MR-T3，桌面 AgentProgress 同口径）
const progress = useMemo(
  () => deriveAgentProgress(sending ? (entry?.live ?? null) : null),
  [sending, entry?.live],
);
```

（c）替换 438-445 占位块为（sending 态全程显示，preparing 吸收原 !streamStarted 条件）：

```tsx
{sending && (
  <View className="flex-row items-center gap-2 px-4 pb-1">
    <ActivityIndicator size="small" color={colors.primary} />
    <Text
      numberOfLines={1}
      className="text-xs text-black/50 dark:text-white/50"
    >
      {progress.preparing
        ? t("agentPreparing")
        : progress.activeTool != null
          ? t("agentStep", {
              step: progress.stepCount,
              tool: progress.activeTool,
            })
          : t("agentResponding")}
    </Text>
  </View>
)}
```

- [ ] **Step 7: typecheck + 测试 + 提交**：

```bash
cd apps/tianshu-mobile && npm run typecheck && npm run test
git add apps/tianshu-mobile/src/logic/agent-progress.ts apps/tianshu-mobile/src/logic/agent-progress.test.ts apps/tianshu-mobile/src/app/session/[id].tsx apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json apps/tianshu-mobile/src/i18n/locales/en-US/chat.json
git commit -m "feat(mobile): Agent 流式进度行——三态派生替换 preparing 占位（MR-T3）"
```

---

### Task 6: MarkdownLite 代码块长按复制

**Files:**
- Modify: `apps/tianshu-mobile/src/components/MarkdownLite.tsx`（code 节点包 Pressable）

**Interfaces:**
- Consumes: 既有 `expo-clipboard`、`@/lib/toast-bus`、i18n 既有 key（copied/copyFailed）——零新增 key

- [ ] **Step 1: 改造 code case**——MarkdownLite.tsx 顶部加 import：

```tsx
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { Pressable } from "react-native";

import { toast } from "@/lib/toast-bus";
```

（Pressable 并入既有 react-native import 行；`renderNode` 提为组件外纯函数的现状不变，code 分支改为渲染内部组件）：

```tsx
function CodeBlock({ node }: { node: Extract<MarkdownNode, { type: "code" }> }) {
  const { t } = useTranslation("chat");
  const handleCopy = () => {
    void Clipboard.setStringAsync(node.code)
      .then(() => toast.info(t("copied")))
      .catch(() => toast.error(t("copyFailed")));
  };
  return (
    <Pressable
      onLongPress={handleCopy}
      accessibilityLabel={t("copy")}
      className="my-1 rounded-lg px-3 py-2"
      style={{ backgroundColor: CODE_BG }}
    >
      {node.lang !== "" && (
        <Text className="mb-1 text-[10px]" style={{ color: "#94a3b8" }}>
          {node.lang}
        </Text>
      )}
      <Text style={{ fontFamily: MONO, fontSize: 12, color: CODE_FG, lineHeight: 17 }}>
        {node.code}
      </Text>
    </Pressable>
  );
}
```

`renderNode` 的 `case "code"` 改为 `return <CodeBlock key={i} node={node} />`。

- [ ] **Step 2: typecheck + 测试（markdown.test 既有用例不回归）+ 提交**：

```bash
cd apps/tianshu-mobile && npm run typecheck && npm run test
git add apps/tianshu-mobile/src/components/MarkdownLite.tsx
git commit -m "feat(mobile): MarkdownLite 代码块长按复制（MR-T5）"
```

---

### Task 7: 会话产物文件派生（纯函数移植）

**Files:**
- Create: `apps/tianshu-mobile/src/logic/session-files.ts` + `session-files.test.ts`

**Interfaces:**
- Consumes: 既有 `@/logic/blocks` 的 `MessageBlock`；既有 `@/logic/remote-stream` 的 `RemoteStreamState`
- Produces:
  - `SessionFile = { path: string; group: "artifact" | "workspace"; status: "written" | "writing"; messageId: number }`
  - `HistoryMessage = { id: number; role: string; blocks: MessageBlock[] }`（[id].tsx 的 entry.history 行子集）
  - `deriveSessionFiles(history: HistoryMessage[], live?: RemoteStreamState | null): SessionFile[]`

- [ ] **Step 1: 写失败测试** `src/logic/session-files.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { deriveSessionFiles, type HistoryMessage } from "./session-files";
import type { RemoteStreamState } from "./remote-stream";

function msg(
  id: number,
  role: string,
  blocks: Array<Record<string, unknown>>,
): HistoryMessage {
  return { id, role, blocks: blocks as HistoryMessage["blocks"] };
}

function makeLive(tools: Record<string, unknown>, order: string[]) {
  return {
    active: true,
    status: "streaming",
    text: "",
    thinking: "",
    toolOrder: order,
    tools,
    approvals: [],
  } as unknown as RemoteStreamState;
}

describe("deriveSessionFiles", () => {
  it("write_file done → 产物文件 written", () => {
    const history = [
      msg(1, "assistant", [
        {
          type: "tool_call",
          toolCallId: "t1",
          toolName: "write_file",
          args: { path: "/w/out/a.md" },
          state: "done",
        },
      ]),
    ];
    expect(deriveSessionFiles(history)).toEqual([
      {
        path: "/w/out/a.md",
        group: "artifact",
        status: "written",
        messageId: 1,
      },
    ]);
  });

  it("write_file denied/error 与 args 缺失不收录", () => {
    const history = [
      msg(1, "assistant", [
        {
          type: "tool_call",
          toolCallId: "t1",
          toolName: "write_file",
          args: { path: "/w/a.md" },
          state: "denied",
        },
        {
          type: "tool_call",
          toolCallId: "t2",
          toolName: "write_file",
          args: {},
          state: "done",
        },
      ]),
    ];
    expect(deriveSessionFiles(history)).toEqual([]);
  });

  it("user [引用文件 x] 行 → 工作空间文件", () => {
    const history = [
      msg(2, "user", [{ type: "text", text: "[引用文件 /w/b.md]\n问题如下" }]),
    ];
    expect(deriveSessionFiles(history)).toEqual([
      {
        path: "/w/b.md",
        group: "workspace",
        status: "written",
        messageId: 2,
      },
    ]);
  });

  it("live running → writing 置顶；done → written 覆盖同 path 历史", () => {
    const history = [
      msg(1, "assistant", [
        {
          type: "tool_call",
          toolCallId: "t1",
          toolName: "write_file",
          args: { path: "/w/a.md" },
          state: "done",
        },
      ]),
    ];
    const live = makeLive(
      {
        t2: { toolCallId: "t2", toolName: "write_file", args: { path: "/w/c.md" }, state: "running" },
      },
      ["t2"],
    );
    const files = deriveSessionFiles(history, live);
    expect(files[0]).toEqual({
      path: "/w/c.md",
      group: "artifact",
      status: "writing",
      messageId: -1,
    });
    expect(files).toHaveLength(2);
  });

  it("同 path 历史去重取源消息 id 较大者，按 id 降序输出", () => {
    const history = [
      msg(1, "assistant", [
        {
          type: "tool_call",
          toolCallId: "t1",
          toolName: "write_file",
          args: { path: "/w/a.md" },
          state: "done",
        },
      ]),
      msg(5, "assistant", [
        {
          type: "tool_call",
          toolCallId: "t2",
          toolName: "write_file",
          args: { path: "/w/a.md" },
          state: "done",
        },
      ]),
    ];
    expect(deriveSessionFiles(history)).toEqual([
      {
        path: "/w/a.md",
        group: "artifact",
        status: "written",
        messageId: 5,
      },
    ]);
  });

  it("空历史返回空数组", () => {
    expect(deriveSessionFiles([])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑红** → FAIL

- [ ] **Step 3: 实现 `src/logic/session-files.ts`**（桌面 chat/lib/artifacts.ts 移植；两处适配：入参 history blocks 已 parse（免 parseBlocks）；流式合并的 ToolStreamMap{order,map} 换 RemoteStreamState{toolOrder,tools}）：

```ts
/**
 * 会话产物文件派生（MR-T6）——桌面
 * src-react/domains/ai/chat/lib/artifacts.ts 移植（spec §3.6）：
 * - 产物文件 = write_file tool_call(state=done) 的 args.path
 * - 工作空间文件 = user 消息 text 块的 [引用文件 x] 行首前缀
 * - 流式合并 live.tools（running→writing / done→written，messageId=-1 置顶）
 * - 同 path 跨组去重（取源消息最新者），按 messageId 降序
 * 适配差异：入参 blocks 已 parse（mobile history 即 parse 产物）；流式
 * 面字段名 toolOrder/tools（RemoteStreamState）。
 */
import type { MessageBlock } from "./blocks";
import type { RemoteStreamState } from "./remote-stream";

export interface SessionFile {
  path: string;
  group: "artifact" | "workspace";
  status: "written" | "writing";
  messageId: number;
}

export interface HistoryMessage {
  id: number;
  role: string;
  blocks: MessageBlock[];
}

/** 行首行尾锚定（消息为多文件前缀逐段拼接，各占一行） */
const REFERENCE_LINE = /^\[引用文件 (.+?)\]$/gm;

/** 同 path 去重收录：流式条目(-1)覆盖历史；历史之间取源消息 id 较大者 */
function addFile(byPath: Map<string, SessionFile>, file: SessionFile): void {
  const existing = byPath.get(file.path);
  if (
    !existing ||
    file.messageId === -1 ||
    (existing.messageId !== -1 && file.messageId >= existing.messageId)
  ) {
    byPath.set(file.path, file);
  }
}

/** 工具态 → 收录结果；denied/error/args 缺失返回 null */
function entryToFiles(entry: {
  toolName: string;
  args?: unknown;
  state: string;
}): { path: string; status: "written" | "writing" } | null {
  if (entry.toolName !== "write_file") return null;
  const path = (entry.args as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || !path.trim()) return null;
  if (entry.state === "done") return { path, status: "written" };
  if (entry.state === "denied" || entry.state === "error") return null;
  return { path, status: "writing" };
}

/** 单条消息：write_file(done) 产物 + user [引用文件] 行 */
function scanMessage(
  message: HistoryMessage,
  byPath: Map<string, SessionFile>,
): void {
  for (const block of message.blocks) {
    if (block.type !== "tool_call") {
      if (block.type === "text" && message.role === "user") {
        for (const match of block.text.matchAll(REFERENCE_LINE)) {
          addFile(byPath, {
            path: match[1],
            group: "workspace",
            status: "written",
            messageId: message.id,
          });
        }
      }
      continue;
    }
    if (block.state !== "done") continue;
    const parsed = entryToFiles(block);
    if (!parsed) continue;
    addFile(byPath, {
      path: parsed.path,
      group: "artifact",
      status: "written",
      messageId: message.id,
    });
  }
}

/** 流式工具合并：write_file running/done → 置顶条目（messageId=-1） */
function mergeLiveTools(
  live: RemoteStreamState,
  byPath: Map<string, SessionFile>,
): void {
  for (const id of live.toolOrder) {
    const entry = live.tools[id];
    if (!entry) continue;
    const parsed = entryToFiles(entry);
    if (!parsed) continue;
    addFile(byPath, {
      path: parsed.path,
      group: "artifact",
      status: parsed.status,
      messageId: -1,
    });
  }
}

/** 排序：流式(-1)置顶；其余源消息新→旧；同 id 路径字典序稳定 */
function sortByPinned(files: SessionFile[]): SessionFile[] {
  const sortKey = (m: number) => (m === -1 ? Number.MAX_SAFE_INTEGER : m);
  return [...files].sort(
    (a, b) =>
      sortKey(b.messageId) - sortKey(a.messageId) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

export function deriveSessionFiles(
  history: HistoryMessage[],
  live?: RemoteStreamState | null,
): SessionFile[] {
  const byPath = new Map<string, SessionFile>();
  for (const message of history) {
    scanMessage(message, byPath);
  }
  if (live) {
    mergeLiveTools(live, byPath);
  }
  return sortByPinned([...byPath.values()]);
}
```

- [ ] **Step 4: 跑绿** → 全 PASS

- [ ] **Step 5: 提交**：

```bash
git add apps/tianshu-mobile/src/logic/session-files.ts apps/tianshu-mobile/src/logic/session-files.test.ts
git commit -m "feat(mobile): 会话产物文件派生纯函数移植（MR-T6 前置）"
```

---

### Task 8: FilePreviewModal 抽取（MessageFileRef 行为不变改造）

**Files:**
- Create: `apps/tianshu-mobile/src/components/FilePreviewModal.tsx`
- Modify: `apps/tianshu-mobile/src/components/MessageFileRef.tsx`（预览弹层段改用新组件）

**Interfaces:**
- Consumes: 既有 `wireRequest` + `ENDPOINTS.files.read`（载荷 `{ workspaceId, path }`，响应 `{ content: string }`）；i18n 既有 keys（fileRefPreviewTitle/fileRefTruncated/fileRefStats/fileRefLoadFailed/copy/copied/copyFailed/close）
- Produces: `FilePreviewModal({ path: string; workspaceId: number | null; visible: boolean; onClose: () => void })`——Task 9 产物 sheet 复用

- [ ] **Step 1: 实现 `src/components/FilePreviewModal.tsx`**（逻辑原样搬自 MessageFileRef 的 preview state 机 + Modal 段；差异：visible 外控、打开时 fetch）：

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ENDPOINTS } from "@tianshu/protocol";
import * as Clipboard from "expo-clipboard";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Copy, X } from "lucide-react-native";

import { toast } from "@/lib/toast-bus";
import { fileRefBasename } from "@/logic/file-refs";
import { MarkdownLite } from "@/components/MarkdownLite";
import { useThemeColors } from "@/store/theme";
import { wireRequest } from "@/transport/wire";

/** 预览渲染上限（字符）：files/read 上限 512KB，全量塞渲染树会卡 */
const PREVIEW_MAX_CHARS = 50000;

type PreviewState =
  | { status: "loading" }
  | { status: "ok"; content: string };

/**
 * 文件全文预览弹层（MR-T6，自 MessageFileRef 抽取复用）：files/read 拉
 * 全文 → MarkdownLite 渲染 + 超长截断（按行边界取整）+ 复制全文；读取
 * 失败 toast 并关闭。visible 置 true 时发起拉取。
 */
export function FilePreviewModal({
  path,
  workspaceId,
  visible,
  onClose,
}: {
  path: string;
  workspaceId: number | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    if (!visible) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview({ status: "loading" });
    void wireRequest("POST", ENDPOINTS.files.read, { workspaceId, path }).then(
      (r) => {
        if (cancelled) return;
        const content = (r.data as { content?: unknown } | null)?.content;
        if (r.ok && typeof content === "string") {
          setPreview({ status: "ok", content });
        } else {
          toast.error(t("fileRefLoadFailed"));
          onClose();
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // 拉取按 visible/path 单次触发；t/onClose 为稳定引用或随语言/宿主更新重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, path, workspaceId]);

  const handleCopy = async (content: string) => {
    try {
      await Clipboard.setStringAsync(content);
      toast.info(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const fullContent = preview?.status === "ok" ? preview.content : null;
  const truncated =
    fullContent != null && fullContent.length > PREVIEW_MAX_CHARS;
  const shownContent = truncated
    ? fullContent.slice(0, PREVIEW_MAX_CHARS).replace(/\n[^\n]*$/, "")
    : fullContent;
  const lineCount = fullContent != null ? fullContent.split("\n").length : 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-center bg-black/50 px-4" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="max-h-[85%] rounded-2xl bg-white p-4 dark:bg-neutral-900"
        >
          <View className="mb-1 flex-row items-center gap-2">
            <Text
              numberOfLines={1}
              className="flex-1 text-sm font-medium text-black dark:text-white"
            >
              {t("fileRefPreviewTitle", { name: fileRefBasename(path) })}
            </Text>
            {preview?.status === "ok" && (
              <Pressable
                onPress={() => void handleCopy(preview.content)}
                accessibilityLabel={t("copy")}
                hitSlop={8}
                className="mr-1"
              >
                <Copy size={16} color={colors.primary} />
              </Pressable>
            )}
            <Pressable onPress={onClose} accessibilityLabel={t("close")} hitSlop={8}>
              <X size={18} color={colors.primary} />
            </Pressable>
          </View>
          <Text
            numberOfLines={1}
            className="mb-2 text-xs text-black/40 dark:text-white/40"
          >
            {path}
          </Text>
          {preview?.status !== "ok" ? (
            <View className="h-40 items-center justify-center">
              <ActivityIndicator size="small" color="#9ca3af" />
            </View>
          ) : (
            <>
              {truncated && (
                <Text className="mb-1 text-xs text-amber-600 dark:text-amber-400">
                  {t("fileRefTruncated", {
                    shown: shownContent?.length ?? 0,
                    total: fullContent?.length ?? 0,
                  })}
                </Text>
              )}
              <ScrollView>
                <MarkdownLite text={shownContent ?? ""} />
                <Text className="mt-3 mb-1 text-[10px] text-black/30 dark:text-white/30">
                  {t("fileRefStats", {
                    lines: lineCount,
                    chars: fullContent?.length ?? 0,
                  })}
                </Text>
              </ScrollView>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

- [ ] **Step 2: MessageFileRef 改造**——删除 preview state 机/Modal/截断/复制段（原 21-87 行逻辑与 121-194 行 JSX），卡片 onPress 改 `setPreviewOpen(true)`，尾部渲染：

```tsx
<FilePreviewModal
  path={path}
  workspaceId={workspaceId ?? null}
  visible={previewOpen}
  onClose={() => setPreviewOpen(false)}
/>
```

（state 换 `const [previewOpen, setPreviewOpen] = useState(false)`；`clickable` 门禁保留——不可点仍不开预览；其余 import 清理。）

- [ ] **Step 3: typecheck + 测试 + 提交**（行为不变重构——file-refs 既有单测全绿即回归面）：

```bash
cd apps/tianshu-mobile && npm run typecheck && npm run test
git add apps/tianshu-mobile/src/components/FilePreviewModal.tsx apps/tianshu-mobile/src/components/MessageFileRef.tsx
git commit -m "refactor(mobile): 文件预览弹层抽取 FilePreviewModal——引用卡与产物 sheet 共用（MR-T6）"
```

---

### Task 9: SessionFilesSheet 产物 sheet + 会话页入口

**Files:**
- Create: `apps/tianshu-mobile/src/components/SessionFilesSheet.tsx`
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx`（headerRight 入口 + sheet + 预览接线）
- Modify: i18n `chat.json` 双语（+filesSheetTitle、filesGroupArtifact、filesGroupWorkspace、filesWriting、filesEmpty）

**Interfaces:**
- Consumes: Task 7 `deriveSessionFiles`/`SessionFile`；Task 8 `FilePreviewModal`；既有 `fileRefBasename`
- Produces: `SessionFilesSheet({ files: SessionFile[]; visible: boolean; onClose: () => void; onOpenFile: (file: SessionFile) => void })`

- [ ] **Step 1: i18n 双语**：

```json
"filesSheetTitle": "会话文件",
"filesGroupArtifact": "产物文件",
"filesGroupWorkspace": "工作空间文件",
"filesWriting": "写入中",
"filesEmpty": "暂无文件",
```

```json
"filesSheetTitle": "Session files",
"filesGroupArtifact": "Artifacts",
"filesGroupWorkspace": "Workspace files",
"filesWriting": "Writing",
"filesEmpty": "No files yet",
```

- [ ] **Step 2: 实现 `src/components/SessionFilesSheet.tsx`**（视觉对齐 MessageActionsSheet 底部 sheet 形态；两组分区，writing 态琥珀标注）：

```tsx
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { FileText, FolderOutput } from "lucide-react-native";

import type { SessionFile } from "@/logic/session-files";
import { fileRefBasename } from "@/logic/file-refs";
import { useThemeColors } from "@/store/theme";

function FileRow({
  file,
  onPress,
}: {
  file: SessionFile;
  onPress: () => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-lg px-2 py-2.5"
      style={({ pressed }) => ({
        backgroundColor: pressed ? colors.subtle : "transparent",
      })}
    >
      <View
        className="h-8 w-8 items-center justify-center rounded-lg"
        style={{ backgroundColor: colors.subtle }}
      >
        <FileText size={15} color={colors.primary} />
      </View>
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className="text-sm text-black dark:text-white"
        >
          {fileRefBasename(file.path)}
        </Text>
        <Text
          numberOfLines={1}
          className="text-xs text-black/40 dark:text-white/40"
        >
          {file.path}
        </Text>
      </View>
      {file.status === "writing" && (
        <Text className="text-[10px] text-amber-600 dark:text-amber-400">
          {t("filesWriting")}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * 会话文件 sheet（MR-T6，桌面 DetailPanel 产物 tab 的移动端形态）：
 * 产物文件（write_file done/writing）+ 工作空间文件（引用）两组列表；
 * 点行上抛 onOpenFile 由宿主页开 FilePreviewModal。
 */
export function SessionFilesSheet({
  files,
  visible,
  onClose,
  onOpenFile,
}: {
  files: SessionFile[];
  visible: boolean;
  onClose: () => void;
  onOpenFile: (file: SessionFile) => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const artifacts = files.filter((f) => f.group === "artifact");
  const workspace = files.filter((f) => f.group === "workspace");

  const section = (title: string, list: SessionFile[]) => (
    <View className="mb-3">
      <Text className="mb-1 px-2 text-xs font-medium text-black/40 dark:text-white/40">
        {title}
      </Text>
      {list.map((file) => (
        <FileRow
          key={`${file.group}-${file.path}`}
          file={file}
          onPress={() => onOpenFile(file)}
        />
      ))}
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-end bg-black/50" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="max-h-[70%] rounded-t-2xl bg-white px-4 pb-8 pt-3 dark:bg-neutral-900"
        >
          <View className="mb-2 self-center h-1 w-10 rounded-full bg-black/15 dark:bg-white/20" />
          <View className="mb-2 flex-row items-center gap-2 px-1">
            <FolderOutput size={15} color={colors.primary} />
            <Text className="text-sm font-medium text-black dark:text-white">
              {t("filesSheetTitle")}
            </Text>
          </View>
          {files.length === 0 ? (
            <Text className="px-2 py-6 text-center text-sm text-black/40 dark:text-white/40">
              {t("filesEmpty")}
            </Text>
          ) : (
            <ScrollView nestedScrollEnabled>
              {artifacts.length > 0 && section(t("filesGroupArtifact"), artifacts)}
              {workspace.length > 0 && section(t("filesGroupWorkspace"), workspace)}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

- [ ] **Step 3: [id].tsx 接线**——四处改动：

（a）import 区：`import { deriveSessionFiles, type SessionFile } from "@/logic/session-files";`、`import { SessionFilesSheet } from "@/components/SessionFilesSheet";`、`import { FilePreviewModal } from "@/components/FilePreviewModal";`、`import { FolderOutput } from "lucide-react-native";`

（b）派生 + 开关 state（rows useMemo 之后）：

```tsx
// 会话文件派生（MR-T6）：write_file 产物 + 引用文件；live 合并 writing 态
const sessionFiles = useMemo(
  () => deriveSessionFiles(entry?.history ?? [], entry?.live ?? null),
  [entry?.history, entry?.live],
);
const [filesSheetOpen, setFilesSheetOpen] = useState(false);
const [previewFile, setPreviewFile] = useState<SessionFile | null>(null);
```

（c）`Stack.Screen` options 加 headerRight（有文件才渲染入口）：

```tsx
options={{
  title: entry?.sessionTitle ?? t("untitled"),
  headerRight: () =>
    sessionFiles.length > 0 ? (
      <Pressable
        onPress={() => setFilesSheetOpen(true)}
        accessibilityLabel={t("filesSheetTitle")}
        hitSlop={8}
        className="mr-1"
      >
        <FolderOutput size={18} color={colors.primary} />
      </Pressable>
    ) : null,
}}
```

（d）MessageActionsSheet 之后追加两组件：

```tsx
<SessionFilesSheet
  files={sessionFiles}
  visible={filesSheetOpen}
  onClose={() => setFilesSheetOpen(false)}
  onOpenFile={(file) => {
    setFilesSheetOpen(false);
    setPreviewFile(file);
  }}
/>
<FilePreviewModal
  path={previewFile?.path ?? ""}
  workspaceId={entry?.sessionWorkspaceId ?? null}
  visible={previewFile != null}
  onClose={() => setPreviewFile(null)}
/>
```

- [ ] **Step 4: typecheck + 测试 + 提交**：

```bash
cd apps/tianshu-mobile && npm run typecheck && npm run test
git add apps/tianshu-mobile/src/components/SessionFilesSheet.tsx apps/tianshu-mobile/src/app/session/[id].tsx apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json apps/tianshu-mobile/src/i18n/locales/en-US/chat.json
git commit -m "feat(mobile): 会话产物文件 sheet——头部入口+分组列表+点开预览（MR-T6）"
```

---

### Task 10: 回归收尾 + 真机手测清单

- [ ] **Step 1: mobile 全量绿**：

```bash
cd apps/tianshu-mobile && npm run test && npm run typecheck
```

- [ ] **Step 2: mirror 全量零新增失败**（mobile 树外不受影响，守基线）：

```bash
cd /Users/hjx/workspace/mirror && npm run test
```

- [ ] **Step 3: 真机手测清单**（Expo Go 连桌面端 face，spec §5 口径——组件层无 UI 测试框架）：

  1. **widget**：会话让模型「用 show_widget 画一个柱状图」→ 移动端消息流出现卡片：标题栏 + 高度自适应图表；流式 running 期显示「图表生成中…」占位
  2. **推荐卡**：触发 recommend_experts 的会话 → 推荐卡只读展示（reason + slug 胶囊 + 桌面端脚注），无通用工具卡
  3. **进度行**：发送消息 →「准备中」→ 有工具时「第 N 步 · 工具名」→ 纯文本「回复中」；桌面端同会话对照口径
  4. **伪调用警示**（可选，需本地小模型服务复现）：<tool_call> 碎片正文 → 琥珀警示折叠条，展开原文
  5. **代码块复制**：任意含代码块回答 → 长按代码块 toast「已复制」，剪贴板内容一致
  6. **产物 sheet**：write_file 会话 → 头部出现文件夹图标 → sheet 两组列表 → 点行全文预览；引用文件卡片（MessageFileRef 改造后）预览行为不变
  7. **倒置列表回归**：长列表会话滚动/发送/编辑重发/重生成均正常（[id].tsx 改动面回归）

- [ ] **Step 4: 文档收尾**：若手测出问题逐项修复提交；全绿后本计划勾完，无零散遗留改动（`git status` 干净）
