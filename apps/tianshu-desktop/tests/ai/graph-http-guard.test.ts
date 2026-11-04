import { describe, expect, it } from "vitest";
import {
  graphHttpUrlError,
  graphHttpUrlErrorDns,
} from "../../../../packages/tianshu-core/src/graph-http-guard";

/**
 * 图 HTTP 节点 URL 守卫（安全批 S5）：协议白名单 + 字面 IP 分类。
 * 域名形态放行（含解析到内网的域名——DNS 解析级分类属后续深度）。
 */
describe("graphHttpUrlError", () => {
  it("放行：公网域名/合法 IP/端口与路径不影响判定", () => {
    expect(graphHttpUrlError("https://api.example.com/v1")).toBeNull();
    expect(graphHttpUrlError("http://8.8.8.8/dns")).toBeNull();
    expect(graphHttpUrlError("https://example.com:8443/x?a=b")).toBeNull();
  });

describe('graphHttpUrlErrorDns（安全批 F1：DNS 解析级分类）', () => {
  it('解析到私网 IP 的域名拒（localtest.me → 127.0.0.1 标准解析）', async () => {
    const r = await graphHttpUrlErrorDns('http://localtest.me/x');
    expect(r).toContain('禁止');
  }, 10_000);
  it('公网域名放行；字面 IP 直达字面层；NXDOMAIN 放行', async () => {
    expect(await graphHttpUrlErrorDns('https://api.example.com/v1')).toBeNull();
    expect(await graphHttpUrlErrorDns('http://127.0.0.1:3000/')).toContain('禁止');
    expect(await graphHttpUrlErrorDns('http://nonexistent-xyz-a1b2.invalid/')).toBeNull();
  }, 15_000);
});

  it("协议白名单：非 http(s) 拒（file/ftp/无协议裸串）", () => {
    expect(graphHttpUrlError("file:///etc/passwd")).toContain("http(s)");
    expect(graphHttpUrlError("ftp://x/")).toContain("http(s)");
    expect(graphHttpUrlError("not a url")).toContain("非法");
  });

  it("metadata 端点拒（三元组，与 ssrf-hosts 清单同步）", () => {
    expect(graphHttpUrlError("http://169.254.169.254/latest")).toContain(
      "metadata",
    );
    expect(graphHttpUrlError("http://metadata.google.internal/")).toContain(
      "metadata",
    );
    expect(graphHttpUrlError("http://metadata.azure.com/")).toContain(
      "metadata",
    );
  });

  it("环回/私网/链路本地/CGNAT 字面 IPv4 拒", () => {
    expect(graphHttpUrlError("http://127.0.0.1:3000/")).toContain("禁止");
    expect(graphHttpUrlError("http://127.8.9.9/")).toContain("禁止");
    expect(graphHttpUrlError("http://10.1.2.3/")).toContain("禁止");
    expect(graphHttpUrlError("http://192.168.1.10/")).toContain("禁止");
    expect(graphHttpUrlError("http://172.16.0.5/")).toContain("禁止");
    expect(graphHttpUrlError("http://172.31.255.1/")).toContain("禁止");
    expect(graphHttpUrlError("http://169.254.170.2/")).toContain("禁止");
    expect(graphHttpUrlError("http://100.64.0.1/")).toContain("禁止");
    expect(graphHttpUrlError("http://localhost:18411/")).toContain("禁止");
  });

  it("IPv6 环回/唯一本地/链路本地/映射拒", () => {
    expect(graphHttpUrlError("http://[::1]/x")).toContain("禁止");
    expect(graphHttpUrlError("http://[::]/x")).toContain("禁止");
    expect(graphHttpUrlError("http://[fd00::1]/x")).toContain("禁止");
    expect(graphHttpUrlError("http://[fe80::1]/x")).toContain("禁止");
    expect(graphHttpUrlError("http://[::ffff:127.0.0.1]/x")).toContain(
      "禁止",
    );
  });

  it("数字编码 IP 形态拒（十进制/十六进制——http://2130706433 = 127.0.0.1）", () => {
    expect(graphHttpUrlError("http://2130706433/")).toContain("禁止");
    expect(graphHttpUrlError("http://0x7f000001/")).toContain("禁止");
    // 公网段的数字编码放行（8.8.8.8 = 134744072）
    expect(graphHttpUrlError("http://134744072/")).toBeNull();
  });
});
