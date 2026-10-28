// @vitest-environment jsdom
/**
 * AgentProgress 三态：准备中/回复中（同为渐变扫光文字，仅文案随
 * preparing 切换）→ 工具轮（第 N 步 · 工具名，无扫光）；扫光 span
 * 恒挂 agent-shimmer-text class（动效实现见 globals.css）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

import AgentProgress from "../../src-react/domains/ai/chat/components/AgentProgress";

afterEach(cleanup);

describe("AgentProgress 状态三态", () => {
  it("准备中：渐变扫光 + preparing 文案", () => {
    render(<AgentProgress stepCount={1} preparing />);
    const el = screen.getByTestId("agent-shimmer");
    expect(el.className).toContain("agent-shimmer-text");
    expect(el.textContent).toBe("chat:agent.preparing");
  });

  it("回复中（有产出无工具）：同款扫光 + replying 文案", () => {
    render(<AgentProgress stepCount={1} />);
    const el = screen.getByTestId("agent-shimmer");
    expect(el.className).toContain("agent-shimmer-text");
    expect(el.textContent).toBe("chat:agent.replying");
  });

  it("工具轮：第 N 步 · 工具名（无扫光元素）", () => {
    render(<AgentProgress stepCount={2} activeTool="read_file" />);
    expect(screen.queryByTestId("agent-shimmer")).toBeNull();
  });

  it("头像列：专家 icon（emoji）透传展示，与消息头像同源", () => {
    render(<AgentProgress stepCount={1} assistantIcon="🧭" preparing />);
    expect(screen.getByTestId("agent-shimmer").textContent).toBe(
      "chat:agent.preparing",
    );
    expect(document.querySelector("[aria-hidden]")?.textContent).toContain(
      "🧭",
    );
  });
});
