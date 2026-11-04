import { describe, expect, it } from "vitest";
import {
  graphHttpUrlError,
  graphHttpUrlErrorDns,
  type GraphHttpUrlPolicy,
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

/**
 * policy 逃生口（2026-11-04 裁定）：桌面端 allowPrivateNetwork 放行内网；
 * server 端 allowlist 显式登记。硬边界不随 policy 变化——协议白名单、
 * metadata 三元组、链路本地段（IPv4 169.254/16 与 IPv6 fe8-eb）恒拦。
 */
describe("graphHttpUrlErrorDns policy 逃生口", () => {
  const OPEN: GraphHttpUrlPolicy = { allowPrivateNetwork: true };

  it("allowPrivateNetwork：环回/localhost/私网/CGNAT/编码/IPv6 ULA 全放行", async () => {
    expect(await graphHttpUrlErrorDns("http://127.0.0.1:3000/", OPEN)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://localhost:18411/", OPEN)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://10.1.2.3/", OPEN)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://192.168.1.10/", OPEN)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://172.16.0.5/", OPEN)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://100.64.0.1/", OPEN)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://[::1]/x", OPEN)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://[fd00::1]/x", OPEN)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://[::ffff:127.0.0.1]/x", OPEN)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://2130706433/", OPEN)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://0x7f000001/", OPEN)).toBeNull();
  });

  it("allowPrivateNetwork 硬边界：协议/metadata/链路本地段仍拦", async () => {
    expect(await graphHttpUrlErrorDns("file:///etc/passwd", OPEN)).toContain(
      "http(s)",
    );
    expect(await graphHttpUrlErrorDns("ftp://x/", OPEN)).toContain("http(s)");
    expect(
      await graphHttpUrlErrorDns("http://169.254.169.254/latest", OPEN),
    ).toContain("metadata");
    expect(
      await graphHttpUrlErrorDns("http://metadata.google.internal/", OPEN),
    ).toContain("metadata");
    // 链路本地段保留（metadata 所在段，IPv6 fe80 对称保留）
    expect(await graphHttpUrlErrorDns("http://169.254.170.2/", OPEN)).toContain(
      "禁止",
    );
    expect(await graphHttpUrlErrorDns("http://[fe80::1]/x", OPEN)).toContain(
      "禁止",
    );
  });

  it("allowPrivateNetwork DNS 级跟随：解析到内网的域名放行（localtest.me → 127.0.0.1）", async () => {
    expect(
      await graphHttpUrlErrorDns("http://localtest.me/x", OPEN),
    ).toBeNull();
  }, 10_000);

  it("allowlist：精确 IP/域名条目命中放行，段外与未登记仍拦", async () => {
    const p: GraphHttpUrlPolicy = {
      allowlist: ["127.0.0.1", "localtest.me"],
    };
    expect(await graphHttpUrlErrorDns("http://127.0.0.1:3000/", p)).toBeNull();
    // 域名条目跳过 DNS 级判定（解析到内网也放行）
    expect(await graphHttpUrlErrorDns("http://localtest.me/x", p)).toBeNull();
    // 对照：同 URL 无 policy 仍拒
    expect(await graphHttpUrlErrorDns("http://localtest.me/x")).toContain(
      "禁止",
    );
    // 未登记的私网 IP 仍拦
    expect(await graphHttpUrlErrorDns("http://10.0.0.1/", p)).toContain(
      "禁止",
    );
  }, 15_000);

  it("allowlist CIDR：段内字面 IP 与解析落段域名放行，段外仍拦", async () => {
    const p: GraphHttpUrlPolicy = { allowlist: ["192.168.1.0/24"] };
    expect(await graphHttpUrlErrorDns("http://192.168.1.55/api", p)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://192.168.1.255/api", p)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://192.168.2.55/api", p)).toContain(
      "禁止",
    );
    expect(await graphHttpUrlErrorDns("http://192.168.1.1/", {})).toContain(
      "禁止",
    );
  });

  it("allowlist 不能豁免硬边界（metadata/链路本地登记也不放行）", async () => {
    const p: GraphHttpUrlPolicy = {
      allowlist: ["169.254.169.254", "169.254.170.2", "metadata.google.internal"],
    };
    expect(await graphHttpUrlErrorDns("http://169.254.169.254/x", p)).toContain(
      "metadata",
    );
    expect(await graphHttpUrlErrorDns("http://169.254.170.2/x", p)).toContain(
      "禁止",
    );
    expect(
      await graphHttpUrlErrorDns("http://metadata.google.internal/", p),
    ).toContain("metadata");
  });

  it("叠加语义：allowPrivateNetwork 与 allowlist 任一通道放行即放行", async () => {
    const p: GraphHttpUrlPolicy = {
      allowPrivateNetwork: true,
      allowlist: ["10.9.9.9"],
    };
    expect(await graphHttpUrlErrorDns("http://172.19.0.3/", p)).toBeNull();
    expect(await graphHttpUrlErrorDns("http://10.9.9.9/", p)).toBeNull();
  });

  it("缺省 policy（空对象/缺省参数）与既有严拦行为逐字一致", async () => {
    expect(await graphHttpUrlErrorDns("http://127.0.0.1/", {})).toContain(
      "禁止",
    );
    expect(await graphHttpUrlErrorDns("http://127.0.0.1/")).toContain("禁止");
  });
});
