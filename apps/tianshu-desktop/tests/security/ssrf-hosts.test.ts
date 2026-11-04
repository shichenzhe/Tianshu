import { describe, expect, it } from "vitest";
import {
  SSRF_HOSTS,
  isSsrfHost,
} from "../../electron/domains/security/ssrf-hosts";

describe("ssrf-hosts（云 metadata 封锁清单）", () => {
  it("覆盖三大云 metadata 端点", () => {
    expect(isSsrfHost("169.254.169.254")).toBe(true);
    expect(isSsrfHost("metadata.google.internal")).toBe(true);
    expect(isSsrfHost("metadata.azure.com")).toBe(true);
  });
  it("大小写不敏感；普通域名放行", () => {
    expect(isSsrfHost("Metadata.Google.Internal")).toBe(true);
    expect(isSsrfHost("example.com")).toBe(false);
    expect(isSsrfHost("")).toBe(false);
  });
  it("SSRF_HOSTS 只读快照含三端点", () => {
    expect(SSRF_HOSTS.size).toBeGreaterThanOrEqual(3);
  });
});
