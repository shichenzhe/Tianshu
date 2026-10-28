import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileGate,
  installFileGate,
  makeFileDecider,
} from "../../electron/domains/security/file-gate";
import { SECURITY_DEFAULTS } from "../../electron/domains/security/defaults";
import type { SecurityConfig } from "../../src-react/domains/security/model/types";

const HOME = os.homedir();
const config = (over: Partial<SecurityConfig>): SecurityConfig => ({
  ...SECURITY_DEFAULTS,
  ...over,
});

describe("makeFileDecider", () => {
  it("内置 ~/.ssh 命中 → block；extraBuiltin（userData）注入生效", () => {
    const decide = makeFileDecider(() => config({}), ["/Users/x/Library/App"]);
    expect(decide(path.join(HOME, ".ssh", "config"), "/tmp/ws")).toBe("block");
    expect(decide("/Users/x/Library/App/db/x.db", "/tmp/ws")).toBe("block");
    expect(decide("/tmp/ws/a.ts", "/tmp/ws")).toBe("default");
  });
  it("用户名单生效：白名单放行、黑名单拦截", () => {
    const decide = makeFileDecider(
      () =>
        config({
          fileAllowlist: ["/tmp/ws/build"],
          fileBlocklist: ["/secret"],
        }),
      [],
    );
    expect(decide("/tmp/ws/build/out.js", "/tmp/ws")).toBe("allow");
    expect(decide("/secret/k", "/tmp/ws")).toBe("block");
  });
  it("sandboxEnabled=false 旁路；getConfigValue 抛错 fail-open", () => {
    const off = makeFileDecider(() => config({ sandboxEnabled: false }), []);
    expect(off(path.join(HOME, ".ssh", "x"), "/tmp/ws")).toBe("default");
    const boom = makeFileDecider(() => {
      throw new Error("boom");
    }, []);
    expect(boom("/secret/k", "/tmp/ws")).toBe("default");
  });
});

describe("fileGate 单例", () => {
  it("未安装 default；安装生效；可替换；gate 抛错 fail-open", () => {
    expect(fileGate("/secret/k", "/tmp/ws")).toBe("default");
    installFileGate(() => "block");
    expect(fileGate("/secret/k", "/tmp/ws")).toBe("block");
    installFileGate(() => {
      throw new Error("boom");
    });
    expect(fileGate("/x", "/tmp/ws")).toBe("default");
    installFileGate(() => "default");
  });
});
