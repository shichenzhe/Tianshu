// @vitest-environment jsdom
/**
 * ConfirmFormCard（confirm_form 工具块渲染的工作流确认卡）冒烟：
 * running 态可编辑表单 + 确认/取消（确认以编辑后值决议 agent:confirmRespond）；
 * done 态只读展示回执（取消回执走取消文案）；error 态展示原因；
 * sessionId 缺省只读不可操作。setup 同 table-view-card.test.tsx。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN" },
    }),
  };
});

vi.mock("@/domains/ai/api/chat.api", () => ({
  default: { confirmFormRespond: vi.fn(async () => true) },
}));

import ConfirmFormCard from "../../src-react/domains/ai/chat/components/ConfirmFormCard";
import ChatApi from "@/domains/ai/api/chat.api";
import type { ConfirmFormPanelItem } from "../../src-react/domains/ai/chat/lib/group-blocks";

afterEach(cleanup);

const respondMock = ChatApi.confirmFormRespond as unknown as Mock;

const item = (
  over: Partial<ConfirmFormPanelItem> = {},
): ConfirmFormPanelItem => ({
  toolCallId: "c1",
  title: "执行确认",
  workflowId: 3,
  workflowName: "记账·记一笔",
  fields: [
    { key: "amount", label: "金额", value: "35" },
    { key: "note", label: "备注", value: "午饭", hint: "可空" },
  ],
  state: "running",
  ...over,
});

describe("ConfirmFormCard", () => {
  it("running 态渲染可编辑表单与双按钮（标题含工作流名）", () => {
    render(<ConfirmFormCard item={item()} sessionId={42} />);
    expect(screen.getByText("执行确认")).toBeTruthy();
    expect(screen.getByText("记账·记一笔")).toBeTruthy();
    expect(screen.getByLabelText(/金额/)).toBeTruthy();
    expect(screen.getByLabelText(/备注/)).toBeTruthy();
    expect(screen.getByText("chat:confirmForm.confirm")).toBeTruthy();
    expect(screen.getByText("common:cancel")).toBeTruthy();
  });

  it("编辑后确认：以编辑值决议 agent:confirmRespond", () => {
    render(<ConfirmFormCard item={item()} sessionId={42} />);
    const amount = screen.getByLabelText(/金额/) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "40" } });
    fireEvent.click(screen.getByText("chat:confirmForm.confirm"));
    expect(respondMock).toHaveBeenCalledWith(42, {
      action: "confirm",
      values: { amount: "40", note: "午饭" },
    });
  });

  it("取消：cancel 决议不携带值", () => {
    render(<ConfirmFormCard item={item()} sessionId={42} />);
    fireEvent.click(screen.getByText("common:cancel"));
    expect(respondMock).toHaveBeenCalledWith(42, { action: "cancel" });
  });

  it("typed 控件（切片 D4）：enum 出下拉项、number 数值框，确认值 typed 上送", async () => {
    const { container } = render(
      <ConfirmFormCard
        sessionId={42}
        item={item({
          fields: [
            {
              key: "category",
              label: "类别",
              value: "餐饮",
              type: "enum",
              enumValues: ["餐饮", "交通", "其他"],
            },
            { key: "amount", label: "金额", value: "35", type: "number" },
            { key: "ok", label: "标记", value: "false", type: "boolean" },
          ],
        })}
      />,
    );
    // enum 控件以触发器呈现当前值（候选项在关闭态不渲染——portal）
    // number 数值框
    const amount = screen.getByLabelText(/金额/) as HTMLInputElement;
    expect(amount.type).toBe("number");
    fireEvent.change(amount, { target: { value: "45" } });
    fireEvent.click(screen.getByText("chat:confirmForm.confirm"));
    await vi.waitFor(() =>
      expect(respondMock).toHaveBeenCalledWith(42, {
        action: "confirm",
        values: { category: "餐饮", amount: 45, ok: false },
      }),
    );
    expect(container.querySelector("select, [role=combobox]")).not.toBeNull();
  });

  it("done 态只读展示回执；取消回执走取消文案", () => {
    render(
      <ConfirmFormCard
        item={item({
          state: "done",
          output: "用户已确认，工作流已按最终参数执行。回执：已启动试运行",
        })}
        sessionId={42}
      />,
    );
    expect(screen.getByText(/已确认，工作流已按最终参数执行/)).toBeTruthy();
    expect(screen.queryByText("chat:confirmForm.confirm")).toBeNull();
    render(
      <ConfirmFormCard
        item={item({ state: "done", output: "用户已取消本次工作流执行" })}
        sessionId={42}
      />,
    );
    expect(screen.getAllByText("chat:confirmForm.cancelled").length).toBe(1);
  });

  it("error 态展示原因；sessionId 缺省只读（无按钮）", () => {
    render(
      <ConfirmFormCard
        item={item({ state: "error", output: "错误: 会话不存在" })}
      />,
    );
    expect(screen.getByText("错误: 会话不存在")).toBeTruthy();
    render(<ConfirmFormCard item={item()} />);
    expect(screen.queryByText("chat:confirmForm.confirm")).toBeNull();
    expect(screen.getByLabelText(/金额/)).toBeTruthy();
  });
});
