// @vitest-environment jsdom
/**
 * ToolCallCard defaultOpen 单测：挂载初始展开态由 prop 控制
 * （details.open 为初始 attribute，用户手动切换不受 React 干预）
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import ToolCallCard from "../../src-react/domains/ai/chat/components/ToolCallCard";

function renderCard(defaultOpen?: boolean) {
  const { container } = render(
    <ToolCallCard
      toolName="write_file"
      args={{ path: "src/a.ts" }}
      state="running"
      defaultOpen={defaultOpen}
    />,
  );
  return container.querySelector("details") as HTMLDetailsElement;
}

describe("ToolCallCard defaultOpen", () => {
  it("缺省 → 折叠", () => {
    expect(renderCard().open).toBe(false);
  });

  it("defaultOpen=true → 初始展开（args/output 可见）", () => {
    const details = renderCard(true);
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("src/a.ts");
  });
});
