// @vitest-environment jsdom
/**
 * useWebviewGuard 直测（从 FileTabContent 内联守卫抽取的语义基线；T28
 * spec §16 项 6 收敛至 chat/lib 共享——FileTabContent/LibraryTabBody/
 * FilePreview/LibraryPreviewContent 四消费方）：
 * will-navigate 全拦 / did-fail-load 降级 / errorCode -3（ERR_ABORTED）
 * 不误降级 / src 变更重绑复位。集成路径由 file-tab-content.test.tsx 与
 * file-preview.test.tsx / library-preview-content.test.tsx 的 webview 用例
 * 隐式覆盖。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useWebviewGuard } from "../../../src-react/domains/ai/chat/lib/use-webview-guard";

afterEach(cleanup);

/** 探针：模拟真实用法（webview 随 src 就绪条件渲染），透出 failed 态 */
function Probe({ src }: { src: string | null }) {
  const { ref, failed } = useWebviewGuard(src);
  return (
    <div>
      {src !== null && <webview ref={ref} data-testid="node" />}
      <span data-testid="failed">{failed ? "yes" : "no"}</span>
    </div>
  );
}

/** did-fail-load 事件（可携带 Electron errorCode） */
function failEvent(errorCode?: number) {
  const ev = new Event("did-fail-load");
  if (errorCode !== undefined) {
    Object.defineProperty(ev, "errorCode", { value: errorCode });
  }
  return ev;
}

describe("useWebviewGuard", () => {
  it("will-navigate 全拦（preventDefault）+ did-fail-load → failed 置位", () => {
    render(<Probe src="file:///tmp/a.pdf" />);
    const node = screen.getByTestId("node");
    const navigate = new Event("will-navigate", { cancelable: true });
    fireEvent(node, navigate);
    expect(navigate.defaultPrevented).toBe(true);
    fireEvent(node, failEvent());
    expect(screen.getByTestId("failed").textContent).toBe("yes");
  });

  it("errorCode -3（ERR_ABORTED）不误降级", () => {
    render(<Probe src="file:///tmp/a.pdf" />);
    fireEvent(screen.getByTestId("node"), failEvent(-3));
    expect(screen.getByTestId("failed").textContent).toBe("no");
  });

  it("src 变更重绑并复位 failed", () => {
    const { rerender } = render(<Probe src="file:///tmp/a.pdf" />);
    fireEvent(screen.getByTestId("node"), failEvent());
    expect(screen.getByTestId("failed").textContent).toBe("yes");
    rerender(<Probe src="file:///tmp/b.pdf" />);
    expect(screen.getByTestId("failed").textContent).toBe("no");
  });
});
