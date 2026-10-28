import * as WebBrowser from "expo-web-browser";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import { CodeBlock, MONO } from "@/components/CodeBlock";
import { MermaidView } from "@/components/MermaidView";
import { toast } from "@/lib/toast-bus";
import { useThemeColors } from "@/store/theme";

import {
  parseInline,
  parseMarkdown,
  type InlineSpan,
  type MarkdownNode,
} from "@/logic/markdown";

/** 行内代码底色（半透明中性，浅深色模式皆可读） */
const INLINE_CODE_BG = "rgba(128,128,128,0.18)";

/** 行内 span → 嵌套 Text（未设色项继承外层文字色）；链接呈主题色下划线
 *  可点（链接语法批），经内建浏览器标签打开，失败 toast */
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

/** 代码块（长按复制——expo-clipboard + toast 总线，i18n 复用 chat 既有 key）；
 * mermaid 围栏分流 WebView 渲染（富内容批），失败降级由 MermaidView 自管 */

function renderNode(node: MarkdownNode, i: number) {
  switch (node.type) {
    case "heading": {
      const size = node.level === 1 ? 20 : node.level === 2 ? 17 : 15;
      return (
        <Text
          key={i}
          className="mt-2 mb-1 text-black dark:text-white"
          style={{ fontSize: size, fontWeight: "600", lineHeight: size * 1.4 }}
        >
          <InlineText spans={parseInline(node.text)} />
        </Text>
      );
    }
    case "code":
      return node.lang === "mermaid" ? (
        <MermaidView key={i} code={node.code} />
      ) : (
        <CodeBlock key={i} node={node} />
      );
    case "table": {
      // 表格 MVP（呈现层现代化批）：flex 均分列宽不横滚（列 >5 挤压
      // 可接受——assistant 极少输出宽表，后续视需要加横向滚动）
      const cell = (text: string, header: boolean) => (
        <Text
          className={`flex-1 text-[15px] leading-[22px] ${
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
          className="my-1 rounded-lg border border-sep px-2 py-1.5 dark:border-[#545458A6]"
        >
          <View className="flex-row gap-2 border-b border-black/15 pb-1.5 dark:border-[#545458A6]">
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
    case "list": {
      // 有序编号按同 indent 层各自递增（嵌套缩进行各成序列），无序统一圆点
      const counters = new Map<number, number>();
      const markers = node.items.map((item) => {
        const seq = (counters.get(item.indent) ?? 0) + 1;
        counters.set(item.indent, seq);
        return node.ordered ? `${seq}.` : "•";
      });
      return (
        <View key={i} className="my-1 gap-0.5">
          {node.items.map((item, k) => (
            <View
              key={k}
              className="flex-row gap-2"
              style={{ paddingLeft: item.indent * 12 }}
            >
              <Text className="text-[15px] leading-[22px] text-black/70 dark:text-white/70">
                {markers[k]}
              </Text>
              <Text className="flex-1 text-[15px] leading-[22px] text-black dark:text-white">
                <InlineText spans={parseInline(item.text)} />
              </Text>
            </View>
          ))}
        </View>
      );
    }
    case "hr":
      return (
        <View
          key={i}
          className="my-2"
          style={{ height: 1, backgroundColor: "rgba(128,128,128,0.3)" }}
        />
      );
    case "quote":
      return (
        <View
          key={i}
          className="my-1 pl-2"
          style={{
            borderLeftWidth: 3,
            borderLeftColor: "rgba(128,128,128,0.4)",
          }}
        >
          <Text className="text-[15px] italic leading-[22px] text-label2 dark:text-[#EBEBF599]">
            <InlineText spans={parseInline(node.text)} />
          </Text>
        </View>
      );
    case "paragraph":
      return (
        <Text
          key={i}
          className="my-1 text-[15px] leading-[22px] text-black dark:text-white"
        >
          <InlineText spans={parseInline(node.text)} />
        </Text>
      );
  }
}

/** markdown 子集渲染器（T14）：parseMarkdown 节点 → 原生视图，不高亮 */
export function MarkdownLite({ text }: { text: string }) {
  const nodes = parseMarkdown(text);
  if (nodes.length === 0) return null;
  return <View>{nodes.map(renderNode)}</View>;
}
