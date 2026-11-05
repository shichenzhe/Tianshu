// 连接安全判定（批3B，design §5 项7/9）纯函数：
// - isPlainHttpRemote：http:// 承载且主机不在局域网白名单（回环/私网/
//   链路本地）→ 明文直连警示徽标数据
// - isProtocolOutdated：被控端协议版本低于控制端基线 PROTOCOL_VERSION
//   → 「建议升级」数据；缺省=老被控端未上报，不告警（增量兼容）
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@tianshu/protocol";
import {
  isPlainHttpRemote,
  isProtocolOutdated,
} from "../../../src-react/domains/ai/server/lib/connection-safety";

describe("isProtocolOutdated", () => {
  it("低于基线才告警：undefined（老被控端）与等于/高于均不告警", () => {
    expect(isProtocolOutdated(undefined)).toBe(false);
    expect(isProtocolOutdated(null)).toBe(false);
    expect(isProtocolOutdated(PROTOCOL_VERSION)).toBe(false);
    expect(isProtocolOutdated(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isProtocolOutdated(PROTOCOL_VERSION - 1)).toBe(true);
    expect(isProtocolOutdated(0)).toBe(true);
  });
});

describe("isPlainHttpRemote（http 非局域网判定）", () => {
  it("回环/私网/链路本地的 http 直连不警示（局域网内明文风险可控）", () => {
    const lanUrls = [
      "http://127.0.0.1:3000",
      "http://127.8.8.8:3000",
      "http://localhost:3000",
      "http://192.168.1.5:8410",
      "http://10.0.0.2:3000",
      "http://172.16.3.4:3000",
      "http://172.31.255.255:3000",
      "http://169.254.10.5:3000",
      "http://0.0.0.0:3000",
      "http://[::1]:3000",
      "http://[fe80::1]:3000",
      "http://[fc00::1]:3000",
    ];
    for (const url of lanUrls) {
      expect(isPlainHttpRemote(url), url).toBe(false);
    }
  });

  it("公网 IP/域名的 http 直连警示（token 与业务面全程明文）", () => {
    const publicUrls = [
      "http://8.8.8.8:3000",
      "http://example.com:3000",
      // 172.32 超出 172.16/12、192.169 非 192.168——保守白名单外的
      // 相邻段一律按公网警示
      "http://172.32.0.1:3000",
      "http://192.169.1.1:3000",
      "http://11.0.0.1:3000",
    ];
    for (const url of publicUrls) {
      expect(isPlainHttpRemote(url), url).toBe(true);
    }
  });

  it("https/wss 恒安全态；非法/缺省输入不警示（表单校验另行拦截）", () => {
    expect(isPlainHttpRemote("https://example.com:3000")).toBe(false);
    expect(isPlainHttpRemote("ws://127.0.0.1:3000")).toBe(false);
    expect(isPlainHttpRemote("notaurl")).toBe(false);
    expect(isPlainHttpRemote("")).toBe(false);
    expect(isPlainHttpRemote(undefined)).toBe(false);
    expect(isPlainHttpRemote(null)).toBe(false);
  });
});
