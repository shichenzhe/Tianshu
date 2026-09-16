// @vitest-environment jsdom
/**
 * 安全中心二级页共享构件测试（终审 S3）：
 * - validateNonEmpty 抽取共享后行为不变（trim 归一 / 空输入 null）
 * - SandboxCard 删除 comingSoon 死分支后：三个二级入口均可点且分派到
 *   对应回调，无 aria-disabled 禁用占位、无 comingSoon 词条渲染
 * （t 返回 key 的 react-i18next mock 骨架照 plan-item-dialog.test.tsx 先例）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import SandboxCard from "../../src-react/domains/security/components/SandboxCard";
import { validateNonEmpty } from "../../src-react/domains/security/components/validators";
import type { SecurityConfig } from "../../src-react/domains/security/model/types";

const config: SecurityConfig = {
  sandboxEnabled: true,
  fileAllowlist: [],
  fileBlocklist: [],
  cmdAllow: [],
  cmdAsk: [],
  programBlacklist: [],
  domainAllow: [],
  domainDeny: [],
  blockAllNetwork: false,
  maliciousDomainProtection: false,
  fileBackupEnabled: true,
  fileBackupMaxSizeMB: 500,
  deleteProtection: true,
  bulkDeleteThreshold: 10,
};

afterEach(cleanup);

describe("validateNonEmpty（共享抽取）", () => {
  it("trim 后非空返回归一值", () => {
    expect(validateNonEmpty("  a.com  ")).toBe("a.com");
    expect(validateNonEmpty("a.com")).toBe("a.com");
  });

  it("空/纯空白输入返回 null", () => {
    expect(validateNonEmpty("")).toBeNull();
    expect(validateNonEmpty("   ")).toBeNull();
  });
});

describe("SandboxCard（死分支删除）", () => {
  it("三个二级入口均可点且分派到对应回调；无禁用占位/comingSoon 残留", () => {
    const onOpenCommand = vi.fn();
    const onOpenFile = vi.fn();
    const onOpenNetwork = vi.fn();
    render(
      <SandboxCard
        config={config}
        onToggle={vi.fn()}
        onOpenCommand={onOpenCommand}
        onOpenFile={onOpenFile}
        onOpenNetwork={onOpenNetwork}
      />,
    );
    fireEvent.click(screen.getByText("security:sandbox.command"));
    fireEvent.click(screen.getByText("security:sandbox.file"));
    fireEvent.click(screen.getByText("security:sandbox.network"));
    expect(onOpenCommand).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenNetwork).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[aria-disabled]")).toBeNull();
    expect(screen.queryByText("security:sandbox.comingSoon")).toBeNull();
  });
});
