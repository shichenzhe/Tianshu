// @vitest-environment jsdom
/**
 * ExpertPromptChips（绑定专家的会话推荐提示词胶囊）：visible=false 不渲染、
 * true 渲染专家 quickPrompts 胶囊并点击回吐文案；无专家/无 quickPrompts
 * 渲染空。 assistants 数据经 ["assistants"] 缓存（ipc invoke mock）。
 * setup 同 tests/ai/expert-recommend-card.test.tsx（手动 cleanup —— vitest
 * 未开 globals，RTL 自动 cleanup 不生效；i18n 无实例时 react-i18next 降级
 * 返回 key，无 Provider 亦可渲染）。
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExpertPromptChips from "../../src-react/domains/ai/chat/components/ExpertPromptChips";

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn().mockResolvedValue([
    {
      id: 7,
      name: "翻译助手",
      // 末位重复：渲染前需去重（key={prompt} 撞 key 防护，终审顺手修）
      quickPrompts: [
        "把这段翻译成英文：",
        "润色这段英文：",
        "把这段翻译成英文：",
      ],
    },
  ]),
}));

afterEach(cleanup);

describe("ExpertPromptChips", () => {
  it("visible=false 不渲染；true 渲染专家 quickPrompts 胶囊", async () => {
    const { rerender } = render(
      <ExpertPromptChips assistantId={7} visible={false} onPick={() => {}} />,
    );
    expect(screen.queryByText("把这段翻译成英文：")).toBeNull();
    rerender(<ExpertPromptChips assistantId={7} visible onPick={() => {}} />);
    expect(await screen.findByText("把这段翻译成英文：")).toBeTruthy();
    expect(screen.getByText("润色这段英文：")).toBeTruthy();
    // 重复 prompt 去重后只渲染一枚（撞 key 防护）
    expect(screen.getAllByText("把这段翻译成英文：")).toHaveLength(1);
  });

  it("点击触发 onPick(文案)；无专家/无 quickPrompts 不渲染", async () => {
    const onPick = vi.fn();
    render(<ExpertPromptChips assistantId={7} visible onPick={onPick} />);
    fireEvent.click(await screen.findByText("把这段翻译成英文："));
    expect(onPick).toHaveBeenCalledWith("把这段翻译成英文：");
    const { container } = render(
      <ExpertPromptChips assistantId={999} visible onPick={onPick} />,
    );
    expect(container.textContent).toBe("");
  });

  it("胶囊 aria-label 为「动作：文案」复合命名（可见文本进可访问名，WCAG 2.5.3）", async () => {
    render(<ExpertPromptChips assistantId={7} visible onPick={() => {}} />);
    // 本测试 i18n 无实例 → t 降级返回 key；断言锁定复合格式与 prompt 全文
    const chip = (await screen.findByText("把这段翻译成英文：")).closest(
      "button",
    );
    expect(chip?.getAttribute("aria-label")).toBe(
      "chat:experts.chips.fill：把这段翻译成英文：",
    );
  });
});
