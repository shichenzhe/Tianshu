/**
 * 会话推荐提示词胶囊（WorkBuddy quickPrompts 语义）：绑定专家的空会话
 * 输入区上方展示，点击填入输入框（模板填入，用户可编辑后发送）。
 * 展示条件由父级控制（专家存在 && 有 quickPrompts && 会话尚无 user 消息）。
 */
import { memo, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  QueryClient,
  QueryClientContext,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";

import AssistantApi from "../../api/assistant.api";

const ASSISTANTS_KEY = ["assistants"] as const;

/**
 * 无 QueryClientProvider 场景（组件单测/独立预览）的兜底 client：经公开
 * QueryClientContext 探测宿主缓存，缺失时自挂隔离 client——quickPrompts
 * 读取可用，组件不因缺 Provider 而崩（ExpertRecommendCard 同款原则）
 */
let fallbackQueryClient: QueryClient | undefined;
function getFallbackQueryClient(): QueryClient {
  if (!fallbackQueryClient) {
    fallbackQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  }
  return fallbackQueryClient;
}

interface ExpertPromptChipsProps {
  /** 绑定专家 id；缺省/查无（未绑定专家）不渲染 */
  assistantId?: number;
  /** 展示门控（空会话判定）由父级计算传入；false 不渲染任何内容 */
  visible: boolean;
  /** 胶囊点击：模板文案填入输入框（由 ChatInput 接内部草稿 state） */
  onPick: (text: string) => void;
}

function ExpertPromptChipsBody({
  assistantId,
  visible,
  onPick,
}: ExpertPromptChipsProps) {
  const { t } = useTranslation(["chat"]);

  // 绑定专家的 quickPrompts（与专家徽章/推荐卡共享 ["assistants"] 缓存）
  const assistantsQuery = useQuery({
    queryKey: ASSISTANTS_KEY,
    queryFn: async () => (await AssistantApi.list()) ?? [],
    staleTime: 60_000,
  });
  // 渲染前去重：key={prompt} 需要名字唯一（导入/手输的 quickPrompts 可能
  // 重复，撞 key 会致 React 状态错位——终审顺手修）
  const quickPrompts = useMemo(
    () => [
      ...new Set(
        (assistantsQuery.data ?? []).find((a) => a.id === assistantId)
          ?.quickPrompts ?? [],
      ),
    ],
    [assistantsQuery.data, assistantId],
  );

  if (!visible || quickPrompts.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="expert-prompt-chips"
      className="flex flex-wrap gap-1.5 px-1 pb-2"
    >
      {quickPrompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          // 复合可访问名：动作 + 可见文本（WCAG 2.5.3 Label in Name）；
          // T27 窄容器：用户自拟文案可能超面板行宽——chip 自身截断（max-w-full
          // + truncate），完整文案经 title/aria-label 可达
          aria-label={`${t("chat:experts.chips.fill")}：${prompt}`}
          title={prompt}
          onClick={() => onPick(prompt)}
          className="max-w-full truncate rounded-full border border-border/50 bg-primary-subtle/50 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-primary-subtle hover:text-primary"
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}

function ExpertPromptChipsImpl(props: ExpertPromptChipsProps) {
  // 宿主无 Provider（测试等）→ 兜底隔离 client，组件可独立渲染
  const hostClient = useContext(QueryClientContext);
  if (!hostClient) {
    return (
      <QueryClientProvider client={getFallbackQueryClient()}>
        <ExpertPromptChipsBody {...props} />
      </QueryClientProvider>
    );
  }
  return <ExpertPromptChipsBody {...props} />;
}

export default memo(ExpertPromptChipsImpl);
