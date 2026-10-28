/**
 * run_command 子进程 proxy env 注入单测（SP5 Task 4）：
 * 门装且代理启动时子进程 env 含 HTTPS_PROXY；门未装零注入（缺省继承）。
 * 真实子进程 node -e 回显 env（命令本身零网络行为）。
 * network-gate 传递依赖 Log（→ electron，终审 S2），经 vi.mock 替换。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));

import type { NetworkPolicyState } from "../../electron/domains/security/domain-policy";
import { makeRunCommandTool } from "../../electron/domains/ai/agent/command-tool";
import {
  installNetworkGate,
  uninstallNetworkGateForTest,
} from "../../electron/domains/security/network-gate";

/** 判定输入用全量策略（judgeDomain 直读各名单字段，部分态会抛错走 fail-open） */
const policy = (over: Partial<NetworkPolicyState>): NetworkPolicyState => ({
  exemptDomains: [],
  domainAllow: [],
  domainDeny: [],
  blockAllNetwork: false,
  maliciousDomainProtection: false,
  ...over,
});

/** 子进程回显自身的 HTTPS_PROXY（未设置时回 none） */
const echoProxyEnv =
  "node -e \"console.log(process.env.HTTPS_PROXY || 'none')\"";

describe("run_command 子进程 proxy env 注入（SP5）", () => {
  it("门装且代理启动时 env 含 HTTPS_PROXY（子进程 echo 验证）", async () => {
    const gate = installNetworkGate({
      policyProvider: () => policy({ exemptDomains: ["localhost"] }),
      audit: () => {},
    });
    gate.setProxyUrl("http://127.0.0.1:3128");
    const tool = makeRunCommandTool();
    const out = await tool.execute(
      { workspacePath: process.cwd(), sessionId: 1, onSecurityEvent: () => {} },
      { command: echoProxyEnv },
    );
    expect(out).toContain("http://127.0.0.1:3128");
    uninstallNetworkGateForTest();
  });

  it("门未装时 env 不注入（none）", async () => {
    uninstallNetworkGateForTest();
    // 宿主代理变量清场：未注入时子进程缺省继承宿主 env，须排除自带干扰
    delete process.env.HTTPS_PROXY;
    const tool = makeRunCommandTool();
    const out = await tool.execute(
      { workspacePath: process.cwd(), sessionId: 1 },
      { command: echoProxyEnv },
    );
    expect(out).toContain("none");
  });
});
