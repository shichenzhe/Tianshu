// @vitest-environment jsdom
/**
 * FileListItem 文件行测试（mock 骨架同 tasks-pane.test.tsx：t 返回 key、
 * sonner、Radix 桩；ArtifactApi 静态桩——事件回调才调用）：
 * - "..." 菜单锚点常驻布局：opacity 显隐而非 hidden/group-hover:block
 *   （display:none 使 Radix Popper 的 getBoundingClientRect 塌缩 (0,0)，
 *   菜单打开后鼠标离行即跳应用左上角——定位回归防护）
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Radix DropdownMenu 在 jsdom 的最小桩（popper 依赖 ResizeObserver）
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("../../../src-react/domains/ai/api/artifact.api", () => ({
  default: {
    exportFile: vi.fn(),
    revealFile: vi.fn(),
    listAggregated: vi.fn(),
  },
}));

import FileListItem from "../../../src-react/domains/ai/chat/components/artifacts/FileListItem";
import type { SessionFile } from "../../../src-react/domains/ai/chat/lib/artifacts";

const FILE: SessionFile = {
  path: "report.md",
  group: "artifact",
  status: "written",
  messageId: 1,
};

describe("FileListItem", () => {
  it('"..." 触发器锚点常驻布局：opacity 显隐，不用 display:none 切换', () => {
    render(
      <ul>
        <FileListItem file={FILE} workspaceId={1} onPreview={() => {}} />
      </ul>,
    );
    const trigger = screen.getByRole("button", {
      name: "chat:artifacts.moreActions",
    });
    // display:none 会让 Radix Popper 锚点测量塌缩 (0,0)（菜单跳左上角）
    expect(trigger.className).not.toMatch(/\bhidden\b/);
    // 项目 hover 显隐惯例（MessageItem 同款）：布局常在、透明度切换
    expect(trigger.className).toContain("opacity-0");
    expect(trigger.className).toContain("group-hover:opacity-100");
  });
});
