import { memo } from "react";
import { Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Sparkles } from "lucide-react-native";
import { useColorScheme } from "nativewind";

import type { MessageBlock } from "@/logic/blocks";
import { splitFileRefPrefix } from "@/logic/file-refs";
import { RECOMMEND_TOOL_NAME, WIDGET_TOOL_NAME } from "@/logic/group-blocks";
import { AppIcon } from "@/components/AppIcon";
import { MarkdownLite } from "@/components/MarkdownLite";
import { MessageFileRef } from "@/components/MessageFileRef";
import { SkillRefCard } from "@/components/SkillRefCard";
import { MessageImage } from "@/components/MessageImage";
import { PseudoToolCallNotice } from "@/components/PseudoToolCallNotice";
import { RecommendCard } from "@/components/RecommendCard";
import { ThinkingPanel } from "@/components/ThinkingPanel";
import { ToolCallCard } from "@/components/ToolCallCard";
import { WidgetCard } from "@/components/WidgetCard";
import { detectPseudoToolCallText } from "@/logic/pseudo-tool-call";
import { useThemeColors } from "@/store/theme";

/** 单块命中区间（块内偏移；active=当前导航位——实底主色，其余半透明） */
export interface BlockHitRange {
  start: number;
  length: number;
  active: boolean;
}

/** 搜索高亮：text 块在 blocks 数组中的下标 → 块内命中区间列表 */
export type SearchHighlight = Map<number, BlockHitRange[]>;

/** 逐词高亮文本（RN 合法模式：命中子串包嵌套 <Text> 主色底——桌面
 *  search-highlight <mark> 的 RN 等价；命中块在搜索态降级为纯文本渲染，
 *  markdown 语法不二次解析）。区间按 start 排序后切分，越界区间忽略 */
function HighlightedText({
  text,
  ranges,
}: {
  text: string;
  ranges: BlockHitRange[];
}) {
  const colors = useThemeColors();
  const segments: Array<{ text: string; active: boolean | null }> = [];
  let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.start < cursor || range.start > text.length) {
      continue; // 重叠/越界防御
    }
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), active: null });
    }
    segments.push({
      text: text.slice(range.start, range.start + range.length),
      active: range.active,
    });
    cursor = range.start + range.length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), active: null });
  }
  return (
    <Text className="text-[15px] leading-[22px] text-black dark:text-white">
      {segments.map((segment, index) =>
        segment.active == null ? (
          segment.text
        ) : (
          <Text
            key={index}
            style={
              segment.active
                ? { backgroundColor: colors.primary, color: "#FFFFFF" }
                : { backgroundColor: `${colors.primary}33` }
            }
          >
            {segment.text}
          </Text>
        ),
      )}
    </Text>
  );
}

/** 单块分发：text→伪工具调用检测（命中收警示折叠条）/MarkdownLite、
 * thinking→面板、tool_call→卡片、usage→小字角标、image→MessageImage
 * （base64 拉取渲染，T15）；搜索态 text 块带命中区间时改逐词高亮渲染 */
function BlockView({
  block,
  highlight,
}: {
  block: MessageBlock;
  highlight?: BlockHitRange[];
}) {
  switch (block.type) {
    case "text":
      if (highlight != null && highlight.length > 0) {
        return <HighlightedText text={block.text} ranges={highlight} />;
      }
      return detectPseudoToolCallText(block.text) ? (
        <PseudoToolCallNotice rawText={block.text} />
      ) : (
        <MarkdownLite text={block.text} />
      );
    case "thinking":
      return <ThinkingPanel text={block.text} />;
    case "tool_call": {
      if (block.toolName === WIDGET_TOOL_NAME) {
        const args = (block.args ?? {}) as {
          widget_code?: unknown;
          title?: unknown;
        };
        const code =
          typeof args.widget_code === "string" ? args.widget_code : "";
        if (code === "") return null; // args 畸形不渲染（历史容错）
        return (
          <WidgetCard
            title={typeof args.title === "string" ? args.title : undefined}
            code={code}
            state={block.state}
          />
        );
      }
      if (block.toolName === RECOMMEND_TOOL_NAME) {
        const args = (block.args ?? {}) as {
          candidates?: unknown;
          reason?: unknown;
        };
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
      return (
        <ToolCallCard
          toolName={block.toolName}
          args={block.args}
          state={block.state}
          output={block.output}
        />
      );
    }
    case "usage":
      return (
        <Text className="mt-1 self-end text-[10px] text-label3 dark:text-[#EBEBF54D]">
          {`↑${block.input} ↓${block.output}`}
        </Text>
      );
    case "image":
      return <MessageImage block={block} />;
  }
}

/** 耗时格式化（durationMs 批）：≤10s 保留 1 位小数（"0.8s"）；否则整秒
 * （"12s"/"1m23s"，与桌面 ThinkingPanel 同语义）；缺省/负值不展示 */
function formatDuration(ms?: number): string | null {
  if (ms == null || ms < 0) return null;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** 消息条目（T14，T15 复用）：user 右气泡 / 助手头像+白底气泡，blocks 逐块分发；
 * memo 收敛渲染——流式 chunk 只重渲染 live 行（定稿 history 行引用稳定） */
export const MessageItem = memo(function MessageItem({
  role,
  blocks,
  workspaceId,
  modelName,
  durationMs,
  animateEnter = false,
  searchHighlight,
}: {
  role: string;
  blocks: MessageBlock[];
  /** 会话所属工作空间 id：user 消息引用文件卡片点击拉全文用；
   * null（未绑定/旧消息）纯展示不可点 */
  workspaceId?: number | null;
  /** B5 消息元信息：当条 assistant 输出模型展示名（providers bundle 反查；
   *  user/live 行不传） */
  modelName?: string | null;
  /** durationMs 批消息元信息：当条 assistant 输出耗时毫秒（wire 直透；
   *  user/live 行不传，≤10s 显 "0.8s"、否则 "1m23s"） */
  durationMs?: number;
  /** 进入动效（动效批）：live 流式新行淡入——定稿 history 行不播
   * （样式用显式 style 规避 nativewind 对 reanimated 的 className 兼容） */
  animateEnter?: boolean;
  /** 搜索逐词高亮（位置级批）：text 块下标（blocks 数组）→ 块内命中
   *  区间；缺省正常渲染。user 气泡渲染的是引用前缀剔除后的 rest 串——
   *  下方按拼接串把块内偏移换算为 rest 相对偏移 */
  searchHighlight?: SearchHighlight;
}) {
  const colors = useThemeColors();
  const { colorScheme } = useColorScheme();
  if (blocks.length === 0) return null;
  const entering = animateEnter ? FadeIn.duration(180) : undefined;

  if (role === "user") {
    // 引用前缀段（文件引用式 + 文件内容注入式 + 技能）拆出渲染卡片，按
    // kind 分发——文件走 MessageFileRef（files/read 预览）、技能走
    // SkillRefCard（skills/read 预览），对齐桌面口径；rest 回填首个 text
    // 块位置，其余 text 块跳过（保持与图片等块的相对序）
    const rawText = blocks
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    const { refs, rest } = splitFileRefPrefix(rawText);
    // 搜索高亮（位置级批）：命中区间为块内偏移，气泡渲染 rest 串——按
    // text 块拼接串把块内偏移换算为 rest 相对偏移（前缀已剔除的命中不
    // 可能存在：搜索只在 rest 内匹配）。全部区间挂到渲染 rest 的首个
    // text 块位置（气泡单文本渲染口径）
    const restRanges: BlockHitRange[] = [];
    if (searchHighlight != null && searchHighlight.size > 0) {
      const prefixLength = rawText.length - rest.length;
      let joinedStart = 0;
      for (const [block, i] of blocks.map((b, idx) => [b, idx] as const)) {
        if (block.type !== "text") continue;
        const ranges = searchHighlight.get(i);
        if (ranges != null) {
          for (const range of ranges) {
            restRanges.push({
              start: joinedStart + range.start - prefixLength,
              length: range.length,
              active: range.active,
            });
          }
        }
        joinedStart += block.text.length + 1; // + 块间 "\n"
      }
    }
    let restConsumed = false;
    // 纯引用消息（无余文且无非 text 块——图片等）不渲染空气泡
    const hasOthers = blocks.some((block) => block.type !== "text");
    return (
      <Animated.View
        entering={entering}
        style={{ marginBottom: 12, alignItems: "flex-end" }}
      >
        {refs.map((ref, index) =>
          ref.kind === "skill" ? (
            <SkillRefCard key={`${index}-${ref.path}`} name={ref.path} />
          ) : (
            <MessageFileRef
              key={`${index}-${ref.path}`}
              path={ref.path}
              workspaceId={workspaceId}
            />
          ),
        )}
        {(rest.trim() !== "" || hasOthers) && (
          <View
            className="max-w-[85%] rounded-[18px] px-3.5 py-2"
            style={{ backgroundColor: colors.subtle }}
          >
            {blocks.map((block, i) => {
              if (block.type !== "text") {
                return <BlockView key={i} block={block} />;
              }
              if (restConsumed) return null;
              restConsumed = true;
              return rest.trim() !== "" ? (
                restRanges.length > 0 ? (
                  <HighlightedText key={i} text={rest} ranges={restRanges} />
                ) : (
                  <MarkdownLite key={i} text={rest} />
                )
              ) : null;
            })}
          </View>
        )}
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={entering} style={{ marginBottom: 12 }}>
      <View className="flex-row items-start gap-2.5">
        <View
          className="mt-0.5 h-8 w-8 items-center justify-center rounded-full"
          style={{ backgroundColor: colors.primary }}
        >
          <AppIcon name="sparkles" fallback={Sparkles} size={15} color="#fff" />
        </View>
        <View
          className="flex-1 rounded-[18px] px-3.5 py-2"
          style={{
            backgroundColor: colorScheme === "dark" ? "#1C1C1E" : "#FFFFFF",
          }}
        >
          {blocks.map((block, i) => (
            <BlockView
              key={i}
              block={block}
              highlight={searchHighlight?.get(i)}
            />
          ))}
        </View>
      </View>
      {/* 消息元信息（B5 模型名 + durationMs 批耗时）：小字气泡下右侧；
        模型名与耗时以「 · 」拼接，任一项缺省只展示另一项，皆缺省不渲染 */}
      {(() => {
        const durationLabel = formatDuration(durationMs);
        const meta =
          modelName != null && modelName !== ""
            ? durationLabel != null
              ? `${modelName} · ${durationLabel}`
              : modelName
            : durationLabel;
        return meta != null ? (
          <Text className="mt-1 pl-[42px] text-[10px] text-label3 dark:text-[#EBEBF54D]">
            {meta}
          </Text>
        ) : null;
      })()}
    </Animated.View>
  );
});
