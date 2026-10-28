# 移动端「呈现层 + 输入层」现代化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 tianshu-mobile「体感老旧」的最大来源——呈现层缺口（Markdown 链接/表格不渲染、Alert 弹窗当详情页）与输入层缺口（无相机拍照、零触觉反馈），对标 2026 AI 原生 APP 交互基线（方案 A 生成式 UI 呈现 / 输入层语音+多模态）。

**Architecture:** 全部改动收敛在 `apps/tianshu-mobile` 单端内闭环（不动协议、不动被控端）。呈现层沿既有自研 `parseMarkdown` 纯函数 + `MarkdownLite` 原生渲染路线扩语法节点（不引第三方渲染库，延续 T14 决策）；反馈形态复刻既有 PlusSheet 底部面板视觉抽公共 `DetailSheet`；输入层相机链复用 `imageUriAsBase64` 多模态压缩链（拍照=选图的同链分流）。

**Tech Stack:** Expo 57 / RN 0.86 / expo-router / NativeWind 4 / vitest（node 环境，仅纯函数测试）/ expo-image-picker（已在依赖）/ expo-web-browser（已在依赖）/ expo-haptics（本计划新增）。

**Spec:** 本计划即 spec（源自 2026-10-24 交互对比调研结论：呈现层+输入层为优先级 1/2 差距项）。

## 假设与范围裁定（规划期自主决策，执行期不再议）

1. **markdown 内联图片语法（`![](url)`）不做**——天枢图片走 ImageBlock 块型（`MessageImage` 文件名 chip 链），assistant 文本内联图片极罕见，YAGNI。链接/表格是真实高频缺口。
2. **语音输入不在本计划**——需跨三端（`@tianshu/protocol` 新增 transcribe 方法 + 桌面/无头双被控端实现 + 移动端录音），属独立子系统，按 scope check 拆独立计划（见文末骨架）。
3. **表格渲染 MVP 不做横向滚动**——flex 均分列宽，列数 >5 挤压可接受（assistant 极少输出宽表），后续视需要加 ScrollView horizontal。
4. **删除确认保留系统 Alert**——破坏性操作的二次确认用平台原生弹窗是 iOS/Android 惯例，不替换。
5. **widget 生成式 UI 扩展不在本计划**——`show_widget` 通道基础设施已就位，属呈现层二期（块型扩展，另一批）。

## Global Constraints

- 主干直接提交，不开分支（用户自管分支纪律）。
- 所有命令在仓库根执行时必须显式 `cd apps/tianshu-mobile`（Bash cwd 漂移回仓库根）。
- i18n：新 key 必须同时写入 `src/i18n/locales/zh-CN/chat.json` 与 `en-US/chat.json`（`src/i18n/locales.test.ts` 双语 parity 校验兜底）。
- 测试环境为 vitest node（`include: ["src/**/*.test.ts"]`）：**只测纯函数**，组件无渲染测试；UI 任务的验证 = `npm run typecheck -w apps/tianshu-mobile` + 真机验收清单。
- 代码风格：双引号、分号、printWidth 80、tabWidth 2（eslint-plugin-prettier 强制）。
- 新依赖一律 `cd apps/tianshu-mobile && npx expo install <pkg>`（SDK 57 版本自动对齐）；**install 后必查 nativewind 本地树**（根 install/npm 11 拦截 postinstall 会毁掉它——检查 `apps/tianshu-mobile/node_modules/nativewind` 存在且为本地目录，被毁则跑 `restore-local-nativewind.sh`）。
- 提交信息中文 `feat(mobile): 主题——细节（批次出处）` 风格，对齐 git log 既有格式。
- 移动端组件注释风格：文件头 `/** ... */` 中文块注释说明批次与语义（照抄本计划代码块内注释）。

---

### Task 1: MarkdownLite 链接语法（解析 + 渲染 + 外链打开）

**Files:**
- Modify: `apps/tianshu-mobile/src/logic/markdown.ts:11-54`（InlineSpan 类型、INLINE_RE、parseInline）
- Modify: `apps/tianshu-mobile/src/logic/markdown.test.ts`（parseInline 组加用例）
- Modify: `apps/tianshu-mobile/src/components/MarkdownLite.tsx:22-50`（InlineText 加 link 分支）
- Modify: `apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json` + `en-US/chat.json`（各加 1 key）

**Interfaces:**
- Produces: `InlineSpan` 新变体 `{ type: "link"; text: string; href: string }`（href 限定 `http(s)://`，由正则保证）；后续任务无依赖。

**设计裁定:** 链接文本内不再二次解析 bold/italic（子集克制，与标题/列表项同口径）；仅 `http(s)://` 协议可识别为链接，`mailto:` 等按字面文本（渲染层才谈得上安全打开）。

- [ ] **Step 1: 写失败测试**

在 `markdown.test.ts` 的 `describe("parseInline")` 组内追加：

```ts
  it("链接：http 完整解析为 link span", () => {
    expect(parseInline("见 [天枢](https://tianshu.dev) 文档")).toEqual([
      { type: "text", text: "见 " },
      { type: "link", text: "天枢", href: "https://tianshu.dev" },
      { type: "text", text: " 文档" },
    ]);
  });

  it("链接：与粗体混排保序", () => {
    expect(parseInline("**重点** [链接](http://a.b/c)")).toEqual([
      { type: "bold", text: "重点" },
      { type: "text", text: " " },
      { type: "link", text: "链接", href: "http://a.b/c" },
    ]);
  });

  it("链接：非 http(s) 协议按字面文本", () => {
    expect(parseInline("[邮件](mailto:x@y.z)")).toEqual([
      { type: "text", text: "[邮件](mailto:x@y.z)" },
    ]);
  });

  it("链接：未闭合方括号按字面文本", () => {
    expect(parseInline("[裸文本 (https://a.b)")).toEqual([
      { type: "text", text: "[裸文本 (https://a.b)" },
    ]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/tianshu-mobile && npx vitest run src/logic/markdown.test.ts
```

预期：新增 4 例 FAIL（link 变体不存在，实际收到 text span）。

- [ ] **Step 3: 实现解析层**

`markdown.ts` 三处修改：

类型（第 11-15 行 InlineSpan 联合追加）：

```ts
export type InlineSpan =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };
```

正则（替换第 30 行，链接分支追加在末位——分支序即优先级，粗体/斜体/行内码先匹配；行尾注释同步更新）：

```ts
/** 行内标记：按出现顺序取最早匹配（粗体优先于斜体；链接仅认 http(s)
 *  协议——渲染层才谈得上安全打开，mailto: 等按字面），内容不含换行 */
const INLINE_RE =
  /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
```

parseInline 分支（第 41-47 行，**link 判空必须在 code 的 else 之前**——否则 link 捕获组被 else 吞成 code）：

```ts
    if (m[1] !== undefined) {
      spans.push({ type: "bold", text: m[1] });
    } else if (m[2] !== undefined) {
      spans.push({ type: "italic", text: m[2] });
    } else if (m[4] !== undefined) {
      spans.push({ type: "link", text: m[4], href: m[5] ?? "" });
    } else {
      spans.push({ type: "code", text: m[3] ?? "" });
    }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/tianshu-mobile && npx vitest run src/logic/markdown.test.ts
```

预期：全部 PASS（含既有用例——`else` 语义未变）。

- [ ] **Step 5: 渲染层**

`MarkdownLite.tsx`：文件头 import 区加 `import * as WebBrowser from "expo-web-browser";` 与 `import { toast } from "@/lib/toast-bus";`、`import { useThemeColors } from "@/store/theme";`，并加打开函数（放在 `InlineText` 定义之前）：

```ts
/** 外链打开（链接语法批）：优先内置浏览器标签（Chrome Custom Tabs /
 *  SFSafariViewController），失败降级系统浏览器，再失败 toast */
function openLink(href: string): void {
  void WebBrowser.openBrowserAsync(href).catch(() => {
    toast.error(t0("openLinkFailed"));
  });
}
```

注意 `toast` 需要 i18n 文案——组件层取 `t` 需在组件内，故改为在 `InlineText` 内闭包调用。最终形态：`InlineText` 组件体首行加 `const { t } = useTranslation("chat");` 与 `const colors = useThemeColors();`，`openLink` 改为组件内函数：

```ts
function InlineText({ spans }: { spans: InlineSpan[] }) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();

  const openLink = (href: string) => {
    void WebBrowser.openBrowserAsync(href).catch(() => {
      toast.error(t("openLinkFailed"));
    });
  };

  return (
    <>
      {spans.map((span, i) => {
        if (span.type === "code") {
          return (
            <Text
              key={i}
              style={{ fontFamily: MONO, backgroundColor: INLINE_CODE_BG }}
            >
              {span.text}
            </Text>
          );
        }
        if (span.type === "link") {
          return (
            <Text
              key={i}
              onPress={() => openLink(span.href)}
              style={{ color: colors.primary, textDecorationLine: "underline" }}
            >
              {span.text}
            </Text>
          );
        }
        return (
          <Text
            key={i}
            style={
              span.type === "bold"
                ? { fontWeight: "700" }
                : span.type === "italic"
                  ? { fontStyle: "italic" }
                  : undefined
            }
          >
            {span.text}
          </Text>
        );
      })}
    </>
  );
}
```

（`useTranslation` 原本已在该文件 import；确认 import 列表补齐 `WebBrowser`/`toast`/`useThemeColors` 三项即可。）

- [ ] **Step 6: i18n key 双语同步**

`zh-CN/chat.json` 加：`"openLinkFailed": "无法打开链接"`；`en-US/chat.json` 加：`"openLinkFailed": "Failed to open link"`（放在各自文件 `copyFailed` 之后，两份同位）。

- [ ] **Step 7: typecheck + 真机验收 + 提交**

```bash
cd apps/tianshu-mobile && npm run typecheck && npx vitest run
```

真机验收：让 assistant 输出含 `[文本](https://...)` 的回复（或任意含链接的历史消息），链接呈主题色下划线可点，点开系统内建浏览器标签，返回不丢会话。

```bash
git add apps/tianshu-mobile/src/logic/markdown.ts apps/tianshu-mobile/src/logic/markdown.test.ts apps/tianshu-mobile/src/components/MarkdownLite.tsx apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json apps/tianshu-mobile/src/i18n/locales/en-US/chat.json
git commit -m "feat(mobile): markdown 链接语法——解析 link span+主题色下划线渲染+内建浏览器打开（呈现层现代化批）"
```

---

### Task 2: MarkdownLite 表格语法（解析 + 渲染）

**Files:**
- Modify: `apps/tianshu-mobile/src/logic/markdown.ts:17-27,91-166`（MarkdownNode 类型、parseMarkdown 状态机）
- Modify: `apps/tianshu-mobile/src/logic/markdown.test.ts`（parseMarkdown 组加用例）
- Modify: `apps/tianshu-mobile/src/components/MarkdownLite.tsx:79-149`（renderNode 加 table 分支）

**Interfaces:**
- Produces: `MarkdownNode` 新变体 `{ type: "table"; headers: string[]; rows: string[][] }`——单元格存**原始字符串**（行内标记在渲染层 `parseInline` 二次解析，与 heading/list item 同口径）。

**设计裁定:** 分隔行 GFM 规范 `:?-{1,}:?`；表格行判定 = trim 后以 `|` 开头（严格，行中含 `|` 不算）；不支持 `\|` 转义与列对齐语法（`:---:` 中的冒号仅作分隔行成分，不透出）；无分隔行不识别（降级为普通段落文本，GFM 行为）。

- [ ] **Step 1: 写失败测试**

在 `markdown.test.ts` 的 `describe("parseMarkdown")` 组内追加：

```ts
  it("表格：表头+分隔行+数据行解析", () => {
    const nodes = parseMarkdown(
      "| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 香蕉 | 5 |",
    );
    expect(nodes).toEqual([
      {
        type: "table",
        headers: ["名称", "数量"],
        rows: [
          ["苹果", "3"],
          ["香蕉", "5"],
        ],
      },
    ]);
  });

  it("表格：冒号对齐语法与单元格空白容错", () => {
    const nodes = parseMarkdown(
      "|  a  | b |\n| :--- | ---: |\n| 1 | 2 |",
    );
    expect(nodes).toEqual([
      { type: "table", headers: ["a", "b"], rows: [["1", "2"]] },
    ]);
  });

  it("表格：单元格行内标记原样保留（渲染层二次解析）", () => {
    const nodes = parseMarkdown("| x |\n| --- |\n| **粗** `c` |");
    expect(nodes).toEqual([
      { type: "table", headers: ["x"], rows: [["**粗** `c`"]] },
    ]);
  });

  it("表格：无分隔行降级段落（GFM 行为）", () => {
    const nodes = parseMarkdown("| 名称 | 数量 |\n| 苹果 | 3 |");
    expect(nodes).toEqual([
      { type: "paragraph", text: "| 名称 | 数量 |\n| 苹果 | 3 |" },
    ]);
  });

  it("表格：表体遇空行或非 | 行截止，后文独立成块", () => {
    const nodes = parseMarkdown(
      "| a |\n| --- |\n| 1 |\n\n段落",
    );
    expect(nodes).toEqual([
      { type: "table", headers: ["a"], rows: [["1"]] },
      { type: "paragraph", text: "段落" },
    ]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/tianshu-mobile && npx vitest run src/logic/markdown.test.ts
```

预期：新增 5 例 FAIL（无 table 节点，首例实际为 paragraph）。

- [ ] **Step 3: 实现解析层**

`markdown.ts`：MarkdownNode 联合追加变体：

```ts
  | { type: "table"; headers: string[]; rows: string[][] }
```

正则区（第 61-63 行附近）加两个常量：

```ts
/** 表格分隔行：| --- | :---: | 形态（首尾竖线可省，冒号仅成分不透出） */
const TABLE_SEP_RE = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/;
/** 表格行：trim 后以 | 开头（严格——行中含 | 不算） */
function isTableLine(line: string): boolean {
  return line.trim().startsWith("|");
}

/** 表格行拆单元格：首尾空段丢弃 + 逐格 trim（不支持 \| 转义——子集） */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}
```

`parseMarkdown` 主循环（在 `HR_RE` 判定之后、`heading` 判定之前插入；主循环开头已有 `const { rest } = splitIndent(lines[i])` 可复用）：

```ts
    // 表格：| 开头行 + 下一行为分隔行（GFM：无分隔行不识别降级段落）；
    // 表体连续消费 | 开头行，遇空行/非 | 行截止
    if (isTableLine(lines[i]) && i + 1 < lines.length) {
      const sepMatch = TABLE_SEP_RE.test(lines[i + 1].trim());
      if (sepMatch) {
        const headers = splitTableRow(lines[i]);
        const rows: string[][] = [];
        i += 2; // 越过表头与分隔行
        while (i < lines.length && isTableLine(lines[i]) && lines[i].trim() !== "") {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        nodes.push({ type: "table", headers, rows });
        continue;
      }
    }
```

同时给 `isPlainLine`（第 80-89 行）补表格行排除——否则表格前的段落会吞掉 `|` 开头行：

```ts
function isPlainLine(line: string): boolean {
  const { rest } = splitIndent(line);
  return (
    line.trim() !== "" &&
    !rest.startsWith("```") &&
    !HEADING_RE.test(rest) &&
    !HR_RE.test(line.trim()) &&
    !isTableLine(line) &&
    lineKind(rest) === "plain"
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/tianshu-mobile && npx vitest run src/logic/markdown.test.ts
```

预期：全部 PASS（既有段落用例不受 `!isTableLine` 影响——原文不含 `|`）。

- [ ] **Step 5: 渲染层**

`MarkdownLite.tsx` 的 `renderNode` switch（`case "code"` 之后加）：

```tsx
    case "table": {
      // 表格 MVP（呈现层现代化批）：flex 均分列宽不横滚（列 >5 挤压
      // 可接受——assistant 极少输出宽表，后续视需要加横向滚动）
      const cell = (text: string, header: boolean) => (
        <Text
          className={`flex-1 text-sm leading-5 ${
            header
              ? "font-semibold text-black dark:text-white"
              : "text-black/85 dark:text-white/85"
          }`}
        >
          <InlineText spans={parseInline(text)} />
        </Text>
      );
      return (
        <View
          key={i}
          className="my-1 rounded-lg border border-black/10 px-2 py-1.5 dark:border-white/15"
        >
          <View className="flex-row gap-2 border-b border-black/15 pb-1.5 dark:border-white/20">
            {node.headers.map((h, k) => (
              <View key={k} className="flex-1">
                {cell(h, true)}
              </View>
            ))}
          </View>
          {node.rows.map((row, r) => (
            <View
              key={r}
              className="flex-row gap-2 border-b border-black/5 py-1.5 last:border-b-0 dark:border-white/10"
            >
              {row.map((c, k) => (
                <View key={k} className="flex-1">
                  {cell(c, false)}
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    }
```

- [ ] **Step 6: typecheck + 真机验收 + 提交**

```bash
cd apps/tianshu-mobile && npm run typecheck && npx vitest run
```

真机验收：会话内让模型「用表格对比 A 和 B」，表格呈卡片式边框网格、表头加粗、深浅色皆可读；无分隔行的残缺输入不炸（降级文本）。

```bash
git add apps/tianshu-mobile/src/logic/markdown.ts apps/tianshu-mobile/src/logic/markdown.test.ts apps/tianshu-mobile/src/components/MarkdownLite.tsx
git commit -m "feat(mobile): markdown 表格语法——GFM 解析+卡片式网格渲染（呈现层现代化批）"
```

---

### Task 3: DetailSheet 共享组件 + UsageChip 用量拆解 Alert 替换

**Files:**
- Create: `apps/tianshu-mobile/src/components/DetailSheet.tsx`
- Modify: `apps/tianshu-mobile/src/components/UsageChip.tsx:43-60`（showDetail 去 Alert）

**Interfaces:**
- Produces: `DetailSheet` 组件，签名 `{ visible: boolean; title: string; onClose: () => void; children: ReactNode }`——Task 4 复用。

**设计裁定:** 视觉复刻 PlusSheet 骨架（rounded-t-2xl、把手、`bg-black/50` 遮罩、fade 动画）保持全 App 底部面板一致性；不做共享 Sheet 基类大重构（既有各 sheet 不回迁——避免大爆炸，后续新面板统一走 DetailSheet）。

- [ ] **Step 1: 实现 DetailSheet（组件无渲染测试，本任务以 typecheck 为闸）**

```tsx
import type { ReactNode } from "react";
import { Modal, Pressable, Text, View } from "react-native";

/**
 * 底部详情面板（Alert 替换批）：系统 Alert 弹纯文本当详情页是「老旧感」
 * 来源之一——替换为与 PlusSheet 同视觉骨架的底部面板（把手/圆角/半透明
 * 遮罩），标题 + children 自由内容。既有各专用 sheet 不回迁，新详情面板
 * 统一走此组件。
 */
export function DetailSheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        className="flex-1 justify-end bg-black/50"
        onPress={onClose}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="rounded-t-2xl bg-white px-4 pb-8 pt-3 dark:bg-neutral-900"
        >
          <View className="mb-2 self-center h-1 w-10 rounded-full bg-black/15 dark:bg-white/20" />
          <Text className="mb-2 px-1 text-sm font-medium text-black dark:text-white">
            {title}
          </Text>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

- [ ] **Step 2: UsageChip 替换**

`UsageChip.tsx`：import 区加 `import { View } from "react-native";`（Alert 从 import 中移除）、`import { DetailSheet } from "@/components/DetailSheet";`；组件内加状态 `const [open, setOpen] = useState(false);`；`showDetail` 回调整体替换为：

```tsx
  const rows: Array<[string, number]> = [
    [t("usageSystem"), usage.system],
    [t("usageTools"), usage.tools],
    [t("usageMessages"), usage.messages],
    [t("usageMcp"), usage.mcp],
    [t("usageSkills"), usage.skills],
  ];
```

（`rows` 从原 showDetail 内提升到组件体——usage 非空才渲染组件，无需判空）；Pressable 的 `onPress` 改 `() => setOpen(true)`；组件 return 之后追加面板：

```tsx
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={6}
        className="flex-row items-center gap-1 rounded-md px-1.5 py-1"
        accessibilityLabel={t("usageTitle")}
      >
        {/* ……原胶囊内容不变（Gauge + 文本）…… */}
      </Pressable>
      <DetailSheet
        visible={open}
        title={t("usageTitle")}
        onClose={() => setOpen(false)}
      >
        {rows.map(([label, value]) => (
          <View
            key={label}
            className="flex-row items-center justify-between px-1 py-1.5"
          >
            <Text className="text-sm text-black/70 dark:text-white/70">
              {label}
            </Text>
            <Text className="text-sm text-black dark:text-white">
              {usageShort(value)}
            </Text>
          </View>
        ))}
        <View className="mt-1 border-t border-black/10 px-1 pt-2 dark:border-white/15">
          <Text className="text-xs text-black/50 dark:text-white/50">
            {usage.contextWindow != null
              ? t("usageWindow", {
                  total: usageShort(usage.total),
                  window: usageShort(usage.contextWindow),
                })
              : t("usageTotal", { total: usageShort(usage.total) })}
          </Text>
        </View>
      </DetailSheet>
    </>
  );
```

（Text 组件补进 react-native import；原 `showDetail` useCallback 与 `Alert` import 删除。）

- [ ] **Step 3: typecheck + 真机验收 + 提交**

```bash
cd apps/tianshu-mobile && npm run typecheck && npx vitest run
```

真机验收：点击用量胶囊弹底部面板（非居中 Alert），五类行左右对齐、底部窗口占比行、点遮罩/把手区关闭。

```bash
git add apps/tianshu-mobile/src/components/DetailSheet.tsx apps/tianshu-mobile/src/components/UsageChip.tsx
git commit -m "feat(mobile): DetailSheet 底部详情面板+用量拆解 Alert 替换（呈现层现代化批）"
```

---

### Task 4: GraphCard 终态详情 Alert 替换（复用 DetailSheet）

**Files:**
- Modify: `apps/tianshu-mobile/src/components/GraphCard.tsx:47-56`（showDetail 去 Alert）

**Interfaces:**
- Consumes: Task 3 的 `DetailSheet`（同签名）。

- [ ] **Step 1: GraphCard 改造**

`GraphCard.tsx`：import 区 `Alert` 保留（`confirmDelete` 仍用，本任务只换终态详情）、加 `ScrollView` 与 `DetailSheet` import；组件内加状态 `const [detail, setDetail] = useState<GraphRunEntry | null>(null);`；`showDetail` 整体替换为：

```tsx
  /** 终态详情长度上限（面板可读性——与原 Alert 截断同值） */
  function openDetail(entry: GraphRunEntry) {
    const body = entry.error ?? entry.output;
    if (!body) return;
    setDetail(entry);
  }
```

（即原 showDetail 改名 openDetail 并只置状态；截断移入渲染。）组件 return 的最外层换成 Fragment 包裹（`<>`），在 `</Pressable>` 之后追加：

```tsx
      <DetailSheet
        visible={detail != null}
        title={
          detail != null
            ? `${t(`orchestration:runState.${detail.state}`)} #${detail.runId}`
            : ""
        }
        onClose={() => setDetail(null)}
      >
        <ScrollView style={{ maxHeight: 360 }}>
          <Text
            className="rounded-lg px-3 py-2 text-xs leading-4"
            style={{
              fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
              backgroundColor: "#1e293b",
              color: detail?.error != null ? "#fca5a5" : "#e2e8f0",
            }}
          >
            {(() => {
              const body = detail?.error ?? detail?.output ?? "";
              return body.length > DETAIL_MAX
                ? `${body.slice(0, DETAIL_MAX)}…`
                : body;
            })()}
          </Text>
        </ScrollView>
      </DetailSheet>
```

（`Platform` 补进 react-native import；错误文本用浅红 `#fca5a5` 区分 output，与流错误红同语义色系。）状态徽章 `onPress={() => showDetail(run)}` 改为 `onPress={() => openDetail(run)}`。

- [ ] **Step 2: typecheck + 真机验收 + 提交**

```bash
cd apps/tianshu-mobile && npm run typecheck && npx vitest run
```

真机验收：编排区跑一个 graph 至终态，点状态徽章弹底部面板：mono 深底展示 output/error、超长截断 800、长内容可滚动；长按删除确认仍为系统 Alert（保留裁定）。

```bash
git add apps/tianshu-mobile/src/components/GraphCard.tsx
git commit -m "feat(mobile): Graph 运行终态详情 Alert→DetailSheet 底部面板（呈现层现代化批）"
```

---

### Task 5: 相机拍照输入（多模态链）

**Files:**
- Create: `apps/tianshu-mobile/src/logic/camera-pick.ts`
- Modify: `apps/tianshu-mobile/src/components/PlusSheet.tsx:35-58`（items 加拍照项）
- Modify: `apps/tianshu-mobile/src/components/Composer.tsx:286-294`（PlusSheet 透传）
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx`（handleTakePhoto 挂接，`handlePickLocalFile` 同位）
- Modify: i18n `zh-CN/chat.json` + `en-US/chat.json`（各加 2 key）

**Interfaces:**
- Consumes: `imageUriAsBase64(uri, fallbackName)`（image-pick.ts 既有，返回 `{ name; base64 }`，内建压缩 + 3MB 预检抛 `ImageTooLargeError`）。
- Produces: `takePhoto(): Promise<{ name: string; base64: string } | null | "denied">`（null=用户取消，"denied"=权限未授予）。

**设计裁定:** 拍照 = file-pick 图片分流的同链入口（不挂 files 能力门禁——拍摄本地零远端依赖，与「上传文件」同口径）；权限先查后请（`getCameraPermissionsAsync` → 未授予再 `requestCameraPermissionsAsync`），拒绝后返回 "denied" 由 UI 层 toast 引导，不静默。

- [ ] **Step 1: 实现 camera-pick**

```ts
/**
 * 拍照输入链（输入层现代化批）：系统相机拍照 → 多模态压缩链（压缩 +
 * 3MB 预检内建于 imageUriAsBase64，与 file-pick 图片分流同链同语义）→
 * base64 暂存（pendingImages，发送时 uploadImage）。权限先查后请，
 * 拒绝返回 "denied" 由调用方 toast 引导设置；取消返回 null。
 */
import * as ImagePicker from "expo-image-picker";

import { imageUriAsBase64 } from "./image-pick";

export async function takePhoto(): Promise<
  { name: string; base64: string } | null | "denied"
> {
  const perm = await ImagePicker.getCameraPermissionsAsync();
  if (!perm.granted) {
    const req = await ImagePicker.requestCameraPermissionsAsync();
    if (!req.granted) {
      return "denied";
    }
  }
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    quality: 1, // 压缩/3MB 预检在 imageUriAsBase64 内（对齐相册链）
  });
  if (result.canceled || result.assets.length === 0) {
    return null;
  }
  const asset = result.assets[0];
  return imageUriAsBase64(asset.uri, asset.fileName ?? "camera.jpg");
}
```

- [ ] **Step 2: PlusSheet 加项 + Composer 透传**

`PlusSheet.tsx`：props 加 `onTakePhoto: () => void;`；lucide import 加 `Camera`；`items` 数组「localFile」项之前插入：

```ts
    {
      key: "takePhoto",
      label: t("takePhoto"),
      Icon: Camera,
      onPress: onTakePhoto,
    },
```

（不挂 filesCap 门禁——拍摄零远端依赖；PlusSheet 既有 350ms setTimeout 回调机制对系统相机同样规避 iOS present 冲突，自动生效。）

`Composer.tsx`：Props 加 `onTakePhoto?: () => void;`，解构默认 `onTakePhoto`，`<PlusSheet ...>` 加 `onTakePhoto={() => onTakePhoto?.()}`。

- [ ] **Step 3: 会话页挂接**

`session/[id].tsx`：import 加 `import { takePhoto } from "@/logic/camera-pick";`；在 `handlePickLocalFile` 同位加（对齐其图片分支的 pendingImages 暂存与错误 toast 口径——`setPendingImages`/`addPendingImage` 以现场 `handlePickLocalFile` 图片分流所用 store/局部 setter 实名为准）：

```tsx
  // 拍照输入（输入层现代化批）：相机 → 多模态压缩链 → pendingImages
  // 暂存（与上传文件图片分流同链同口径）
  const handleTakePhoto = useCallback(async () => {
    const shot = await takePhoto();
    if (shot === null) return; // 用户取消
    if (shot === "denied") {
      toast.info(t("cameraPermissionDenied"));
      return;
    }
    setPendingImages((prev) => [...prev, shot]);
  }, [t]);
```

`<Composer ...>` 加 `onTakePhoto={() => void handleTakePhoto()}`。

- [ ] **Step 4: i18n key 双语同步**

`zh-CN/chat.json`：`"takePhoto": "拍照"`、`"cameraPermissionDenied": "相机权限未授予，请在系统设置中开启"`（放 `uploadFile` 附近）；`en-US/chat.json`：`"takePhoto": "Take photo"`、`"cameraPermissionDenied": "Camera permission denied. Enable it in system settings."`（同位）。

- [ ] **Step 5: typecheck + 真机验收 + 提交**

```bash
cd apps/tianshu-mobile && npm run typecheck && npx vitest run
```

真机验收：＋菜单出现「拍照」→ 唤起系统相机 → 拍摄返回后输入区上方出现图片 chip（camera.jpg）→ 发送成功且 assistant 可读图；首次拒绝权限后重试有 toast 引导；取消拍摄无副作用。

```bash
git add apps/tianshu-mobile/src/logic/camera-pick.ts apps/tianshu-mobile/src/components/PlusSheet.tsx apps/tianshu-mobile/src/components/Composer.tsx apps/tianshu-mobile/src/app/session/[id].tsx apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json apps/tianshu-mobile/src/i18n/locales/en-US/chat.json
git commit -m "feat(mobile): 相机拍照输入——多模态压缩链复用+权限引导（输入层现代化批）"
```

---

### Task 6: 触觉反馈（haptics）

**Files:**
- Create: `apps/tianshu-mobile/src/lib/haptics.ts`
- Modify: `apps/tianshu-mobile/package.json`（新依赖 expo-haptics）
- Modify: `apps/tianshu-mobile/src/components/Composer.tsx`（发送受理）
- Modify: `apps/tianshu-mobile/src/components/ApprovalBanner.tsx`（批准/拒绝决议）
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx` 与 `apps/tianshu-mobile/src/app/index.tsx`（长按菜单触发）

**Interfaces:**
- Produces: `tapLight(): void`（轻触）、`tapSuccess(): void`（成功通知）——全 App 触觉统一口，后续触点只调这两个函数。

- [ ] **Step 1: 安装依赖（含 nativewind 本地树自检）**

```bash
cd apps/tianshu-mobile && npx expo install expo-haptics
```

装完必查（npm 11 拦截 postinstall / 根操作毁 nativewind 本地树的历史事故）：

```bash
ls -la apps/tianshu-mobile/node_modules/nativewind
```

预期存在且为本地目录（非 symlink 指向根）；异常则跑恢复脚本 `restore-local-nativewind.sh`（仓库根）后再继续。

- [ ] **Step 2: 实现 haptics 统一口**

```ts
/**
 * 触觉反馈统一口（输入层现代化批）：AI 原生 APP 基线体验——发送受理
 * /审批决议等关键节点触觉确认。web 平台无触觉静默；fire-and-forget
 * 不 await 不阻塞交互。
 */
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/** 轻触：长按菜单唤起、次要按钮 */
export function tapLight(): void {
  if (Platform.OS === "web") return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/** 成功：发送受理、审批通过 */
export function tapSuccess(): void {
  if (Platform.OS === "web") return;
  void Haptics.notificationAsync(
    Haptics.NotificationFeedbackType.Success,
  ).catch(() => {});
}
```

- [ ] **Step 3: 四个触点挂接**

1. `Composer.tsx` `handleSend` 内 `if (accepted) setText("");` 处加 `if (accepted) { tapSuccess(); setText(""); }`；
2. `ApprovalBanner.tsx` 批准按钮 onPress 回调内加 `tapSuccess()`、拒绝按钮 onPress 内加 `tapLight()`（在发起 wireRequest 决议前调用）；
3. `session/[id].tsx` 消息长按打开 `MessageActionsSheet` 的回调内加 `tapLight()`；
4. `index.tsx` 会话行长按打开 `SessionActionsSheet` 的回调内加 `tapLight()`。

（各文件 import `import { tapLight, tapSuccess } from "@/lib/haptics";`，按各自实际用到者取用。）

- [ ] **Step 4: typecheck + 真机验收 + 提交**

```bash
cd apps/tianshu-mobile && npm run typecheck && npx vitest run
```

真机验收：真机震动可感——发送消息一下、审批批准一下、长按消息/会话轻一下；Expo web 打开无报错（静默路径）。

```bash
git add apps/tianshu-mobile/package.json apps/tianshu-mobile/package-lock.json apps/tianshu-mobile/src/lib/haptics.ts apps/tianshu-mobile/src/components/Composer.tsx apps/tianshu-mobile/src/components/ApprovalBanner.tsx apps/tianshu-mobile/src/app/session/[id].tsx apps/tianshu-mobile/src/app/index.tsx
git commit -m "feat(mobile): 触觉反馈——发送/审批/长按四触点统一口（输入层现代化批）"
```

（package-lock 如在 mobile 目录无独立锁文件，以 `git status` 实际产物为准增删 add 列表。）

---

## 后续计划：语音输入（独立计划，跨三端）

按 scope check 拆出（涉及 `@tianshu/protocol` + 桌面 mirror + 无头 server + 移动端四端面，本计划不动协议）。方案骨架：

1. 协议：`packages/tianshu-protocol` 新增 `server:transcribe` 方法（入参 `{ audioBase64: string; mimeType: string }`，出参 `{ text: string }`）；
2. 被控端双实现（桌面 `electron/domains/server-face` + 无头 `apps/tianshu-server`）：经 provider 表中 OpenAI 兼容厂商调 `/audio/transcriptions`；厂商不支持时返回具名错误码；
3. 移动端：`expo-av` 录音（m4a）→ base64 → `server:transcribe` → 文本回填 Composer；Composer 加麦克风键（长按说话/点击录音两形态待定）。

风险预告：provider 表无 audio 模型字段，需补模型选择策略（固定 whisper 档 vs 用户配置），是该计划的首要设计决策。

## Self-Review 记录

- 范围覆盖：调研对比结论中优先级 1（MarkdownLite 缺口→Task 1/2）+ 优先级 2 前半（相机→Task 5）、优先级 4（Alert→sheet→Task 3/4）、优先级 3 局部（触觉→Task 6）；语音（优先级 2 后半）按假设 2 拆出——已注明。
- 占位符扫描：Task 5 Step 3 的 `setPendingImages` 以现场实名为准（session/[id].tsx 未全读，图片分流 setter 命名以 `handlePickLocalFile` 现场代码为准）——已明确标注查证方式，非 TBD；其余步骤均含完整代码。
- 类型一致性：`InlineSpan.link`（Task 1 定义/消费同文件）；`DetailSheet` 签名 Task 3 定义与 Task 4 消费一致；`takePhoto` 返回联合类型 Task 5 定义与挂接消费一致。
