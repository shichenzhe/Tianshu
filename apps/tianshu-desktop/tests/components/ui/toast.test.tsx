// @vitest-environment jsdom
/**
 * DismissableToaster 点击关闭测试（sonner 2.x 无内建点击关闭，经事件委托
 * + data-index 对位 getHistory() 实现）：
 * - 点击 toast 主体：精确关闭被点的那条（多条时其余保留）
 * - 点击按钮区域（action）：不触发点击关闭，走 sonner 原生
 * - li 文本守卫：对位错位窗口宁可不关、不错关（getToasts 保持原量）
 *
 * 断言口径用 toast.getToasts()（dismiss 即时剔除）而非 li 卸载——jsdom
 * 无 CSS transition，sonner 卸载依赖 transitionend 会挂起
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { DismissableToaster } from "@/components/ui/toast";

const renderToaster = () =>
  render(<DismissableToaster position="top-center" />);

const findToastByTitle = (title: string) =>
  Array.from(document.querySelectorAll("li[data-sonner-toast]")).find((li) =>
    li.textContent?.includes(title),
  );

// sonner ToastState 为模块级单例，用例间须清场（无参 dismiss 全关）
const clearToasts = () => {
  toast.dismiss();
};

describe("DismissableToaster 点击关闭", () => {
  beforeEach(() => {
    renderToaster();
  });

  afterEach(() => {
    clearToasts();
    cleanup();
  });

  it("点击 toast 主体关闭该条", async () => {
    toast.success("第一条消息");
    await waitFor(() => {
      expect(findToastByTitle("第一条消息")).toBeTruthy();
    });

    fireEvent.click(findToastByTitle("第一条消息")!);

    await waitFor(() => {
      expect(
        toast.getToasts().filter((t) => t.title === "第一条消息"),
      ).toHaveLength(0);
    });
  });

  it("多条时只关闭被点的那条", async () => {
    toast.success("保留消息");
    toast.success("将被点击的消息");
    await waitFor(() => {
      expect(
        toast.getToasts().filter((t) => typeof t.title === "string"),
      ).toHaveLength(2);
    });

    fireEvent.click(findToastByTitle("将被点击的消息")!);

    await waitFor(() => {
      const titles = toast
        .getToasts()
        .map((t) => t.title)
        .filter((t): t is string => typeof t === "string");
      expect(titles).toContain("保留消息");
      expect(titles).not.toContain("将被点击的消息");
    });
  });

  it("点击 action 按钮不触发点击关闭（走原生）", async () => {
    const onAction = vi.fn();
    toast("带动作消息", { action: { label: "执行", onClick: onAction } });
    await waitFor(() => {
      expect(findToastByTitle("带动作消息")).toBeTruthy();
    });

    fireEvent.click(findToastByTitle("带动作消息")!.querySelector("button")!);

    expect(onAction).toHaveBeenCalledOnce();
    // 未触发点击关闭：toast 仍在
    expect(
      toast.getToasts().filter((t) => t.title === "带动作消息"),
    ).toHaveLength(1);
  });

  it("li 文本守卫拦下错位对位（不关错条）", async () => {
    toast.success("守卫消息");
    await waitFor(() => {
      expect(findToastByTitle("守卫消息")).toBeTruthy();
    });

    // 伪造 data-index 越界：对位源取不到条目时应静默不关
    const li = findToastByTitle("守卫消息")!;
    li.setAttribute("data-index", "99");
    fireEvent.click(li);

    expect(
      toast.getToasts().filter((t) => t.title === "守卫消息"),
    ).toHaveLength(1);
  });

  it("另一条播放关闭动画期间点击仍精确关闭（占位条目不打乱对位）", async () => {
    toast.success("先点这条");
    toast.success("动画期点这条");
    await waitFor(() => {
      expect(
        toast.getToasts().filter((t) => typeof t.title === "string"),
      ).toHaveLength(2);
    });

    // jsdom 无 transitionend：dismiss 后条目常驻 getHistory/渲染数组，
    // 天然模拟「关闭动画播放中」窗口期——被点条目仍占位
    fireEvent.click(findToastByTitle("先点这条")!);
    fireEvent.click(findToastByTitle("动画期点这条")!);

    await waitFor(() => {
      expect(toast.getToasts()).toHaveLength(0);
    });
  });
});
