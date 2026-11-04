// @vitest-environment jsdom
/**
 * 标签式列表输入 StringListInput 的重复值语义：dbParams 与 SQL 占位符
 * 按序一一对应，两个占位符绑同值是常态，须允许重复（allowDuplicates）；
 * 变量名等默认场景保持去重。顺带守护逗号分隔批量录入与空项过滤
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { StringListInput } from "../../src-react/domains/ai/orchestration/components/GraphNodeEditor";

beforeEach(cleanup);

function commitDraft(input: HTMLInputElement, draft: string) {
  fireEvent.change(input, { target: { value: draft } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("StringListInput 重复值语义", () => {
  it("allowDuplicates：两个占位符绑同值可重复录入（逗号分隔批量提交）", () => {
    const onChange = vi.fn();
    const { getByPlaceholderText } = render(
      <StringListInput
        values={[]}
        placeholder="p"
        allowDuplicates
        onChange={onChange}
      />,
    );
    commitDraft(getByPlaceholderText("p") as HTMLInputElement, "5, 5, name");
    expect(onChange).toHaveBeenCalledWith(["5", "5", "name"]);
  });

  it("默认仍去重（变量名场景回归）", () => {
    const onChange = vi.fn();
    const { getByPlaceholderText } = render(
      <StringListInput values={["a"]} placeholder="p" onChange={onChange} />,
    );
    commitDraft(getByPlaceholderText("p") as HTMLInputElement, "a, a, b");
    expect(onChange).toHaveBeenCalledWith(["a", "b"]);
  });

  it("空项过滤：纯逗号/空白不产生空标签", () => {
    const onChange = vi.fn();
    const { getByPlaceholderText } = render(
      <StringListInput values={["x"]} placeholder="p" onChange={onChange} />,
    );
    commitDraft(getByPlaceholderText("p") as HTMLInputElement, " , , ");
    // 全部被过滤且无新增，长度不变则不回调
    expect(onChange).not.toHaveBeenCalled();
  });
});
