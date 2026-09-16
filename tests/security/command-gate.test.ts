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
  it("默认规则：curl 询问 / git push 放行 / rm 拦截 / echo 默认", () => {
    const decide = makeCommandDecider(() => config({}));
    expect(decide("curl https://x.io")).toBe("ask");
    expect(decide("git push origin main")).toBe("allow");
    expect(decide("rm -rf x")).toBe("block");
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
