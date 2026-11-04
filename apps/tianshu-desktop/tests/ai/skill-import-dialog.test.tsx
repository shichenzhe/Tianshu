// @vitest-environment jsdom
/**
 * SkillImportDialog 组件测试：导入弹窗当场打场景标（spec Deviation 7 收口）——
 * 摘要态出现三场景复选（chat:skills.scenario.* 词条），勾选后点「安装」/
 * 「非高风险自动安装」触发安装时 importSkill 透传 scenarios（空数组=显式
 * 不打标）；dryRun 预检不带 scenarios；重选文件勾选复位。
 * i18n t mock 直返 key；Dialog/Checkbox 走真实 Radix（fireEvent.click）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import SkillImportDialog from "@/domains/ai/skills/components/SkillImportDialog";

const SUMMARY_OK = { status: "ok", name: "demo", description: "d" };
const INSTALLED = {
  status: "installed",
  record: { name: "demo" },
};

/** mock 编排：经 pickImport 返回路径触发选择（拖拽区按钮初始态 name 含
 *  importDrop；摘要态 name 为摘要文本——由调用方传按钮匹配器） */
async function pickPath(
  path: string,
  trigger: RegExp | string = /importDrop|upload/i,
): Promise<void> {
  invokeMock.mockImplementation((channel: string) => {
    if (channel === "skill:pickImport") {
      return Promise.resolve({ canceled: false, path });
    }
    if (channel === "skill:import") {
      const params = invokeMock.mock.calls
        .filter((c) => c[0] === "skill:import")
        .at(-1)![1] as { dryRun?: boolean };
      return Promise.resolve(params.dryRun ? SUMMARY_OK : INSTALLED);
    }
    return Promise.resolve(null);
  });
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("skill:import", {
      path,
      dryRun: true,
    }),
  );
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("SkillImportDialog 场景打标", () => {
  it("摘要态渲染三场景复选；勾选后安装透传 scenarios", async () => {
    render(<SkillImportDialog open onOpenChange={vi.fn()} />);
    await pickPath("/tmp/demo.zip");
    // 三场景复选出现（label = chat:skills.scenario.*）
    const daily = screen.getByLabelText("chat:skills.scenario.daily");
    expect(daily).toBeTruthy();
    expect(screen.getByLabelText("chat:skills.scenario.coding")).toBeTruthy();
    expect(screen.getByLabelText("chat:skills.scenario.design")).toBeTruthy();
    fireEvent.click(daily);
    fireEvent.click(screen.getByText("chat:skills.install"));
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(
        (c) => c[0] === "skill:import",
      );
      const installCall = calls.find(
        (c) => !(c[1] as { dryRun?: boolean }).dryRun,
      );
      expect(installCall![1]).toMatchObject({
        path: "/tmp/demo.zip",
        scenarios: ["daily"],
      });
    });
  });

  it("不勾选直接安装透传空数组（显式不打标）", async () => {
    render(<SkillImportDialog open onOpenChange={vi.fn()} />);
    await pickPath("/tmp/demo.zip");
    fireEvent.click(screen.getByText("chat:skills.install"));
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(
        (c) => c[0] === "skill:import",
      );
      const installCall = calls.find(
        (c) => !(c[1] as { dryRun?: boolean }).dryRun,
      );
      expect(installCall![1]).toMatchObject({
        path: "/tmp/demo.zip",
        scenarios: [],
      });
    });
  });

  it("重选文件后场景勾选复位（新包不继承上一包勾选）", async () => {
    render(<SkillImportDialog open onOpenChange={vi.fn()} />);
    await pickPath("/tmp/a.zip");
    fireEvent.click(screen.getByLabelText("chat:skills.scenario.coding"));
    // 摘要态拖拽区按钮 name 为摘要文本（demo/d），据此点击重选另一包
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "skill:pickImport") {
        return Promise.resolve({ canceled: false, path: "/tmp/b.zip" });
      }
      if (channel === "skill:import") {
        const params = invokeMock.mock.calls
          .filter((c) => c[0] === "skill:import")
          .at(-1)![1] as { dryRun?: boolean };
        return Promise.resolve(
          params.dryRun ? SUMMARY_OK : { ...INSTALLED, record: { name: "b" } },
        );
      }
      return Promise.resolve(null);
    });
    fireEvent.click(screen.getByText("demo").closest("button")!);
    await waitFor(() => {
      // Radix Checkbox 为 button[role=checkbox]，状态在 aria-checked 上
      const checkbox = screen.getByLabelText(
        "chat:skills.scenario.coding",
      ) as HTMLElement;
      expect(checkbox.getAttribute("aria-checked")).toBe("false");
    });
  });
});
