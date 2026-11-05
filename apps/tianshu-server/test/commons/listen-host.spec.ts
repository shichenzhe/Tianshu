import {
  DEFAULT_LISTEN_HOSTNAME,
  emitListenSecurityWarnings,
  emitNonLoopbackTlsWarning,
  isLoopbackAddress,
  isWildcardAddress,
  resolveListenHostname,
} from 'src/commons/web/listen-host';

/**
 * 监听地址安全告警（终审必修 3）：通配绑定（0.0.0.0/::）公网暴露提示 +
 * TIANSHU_TOKEN 缺省且非 loopback 的无鉴权暴露提示；本地 loopback 无 token
 * 静默放行语义维持（token-guard 的 dev 放行先例）。
 */

function collectWarnings(hostname: string, token: string | undefined): string[] {
  const warnings: string[] = [];
  emitListenSecurityWarnings(hostname, token, (message) =>
    warnings.push(message),
  );
  return warnings;
}

describe('resolveListenHostname', () => {
  it('config app.hostname 未设置/空白 → 缺省 0.0.0.0（历史行为不变）', () => {
    expect(resolveListenHostname(undefined)).toBe(DEFAULT_LISTEN_HOSTNAME);
    expect(resolveListenHostname('')).toBe('0.0.0.0');
    expect(resolveListenHostname('   ')).toBe('0.0.0.0');
  });

  it('config app.hostname 指定值生效（trim）', () => {
    expect(resolveListenHostname('127.0.0.1')).toBe('127.0.0.1');
    expect(resolveListenHostname(' 192.168.1.10 ')).toBe('192.168.1.10');
  });
});

describe('地址分类', () => {
  it('通配地址：0.0.0.0 / ::', () => {
    expect(isWildcardAddress('0.0.0.0')).toBe(true);
    expect(isWildcardAddress('::')).toBe(true);
    expect(isWildcardAddress('127.0.0.1')).toBe(false);
    expect(isWildcardAddress('192.168.1.10')).toBe(false);
  });

  it('loopback 地址：localhost / ::1 / 127.x', () => {
    expect(isLoopbackAddress('localhost')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
  });
});

describe('emitListenSecurityWarnings', () => {
  it('通配绑定 0.0.0.0：公网暴露告警（有 token 也提示绑定面）', () => {
    const warnings = collectWarnings('0.0.0.0', 'a'.repeat(32));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[安全告警]');
    expect(warnings[0]).toContain('0.0.0.0');
  });

  it('安全批 S3：通配绑定且无 token → 先暴露告警再拒绝启动（fail-closed）', () => {
    const warnings: string[] = [];
    // jest 无 expect.unreachable：正常返回即让断言失败
    let threw: Error | null = null;
    try {
      emitListenSecurityWarnings('::', undefined, (m) => warnings.push(m));
    } catch (e) {
      threw = e as Error;
    }
    expect(threw?.message).toContain('安全拒绝启动');
    // 通配暴露告警先行（warn 回调已收集），throw 在其后
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('0.0.0.0/::');
  });

  it('loopback 绑定且无 token：静默（本地开发放行语义维持）', () => {
    expect(collectWarnings('127.0.0.1', undefined)).toHaveLength(0);
    expect(collectWarnings('localhost', undefined)).toHaveLength(0);
    expect(collectWarnings('::1', undefined)).toHaveLength(0);
  });

  it('安全批 S3：非 loopback 且无 token → 拒绝启动（原仅告警，无 token 放行面+对外绑定=全接口无鉴权）', () => {
    expect(() => collectWarnings('192.168.1.10', undefined)).toThrow(
      /安全拒绝启动/,
    );
    expect(() => collectWarnings('0.0.0.0', undefined)).toThrow(
      /安全拒绝启动/,
    );
  });

  it('非 loopback 地址且有 token：无告警', () => {
    expect(collectWarnings('192.168.1.10', 'a'.repeat(32))).toHaveLength(0);
  });
});

describe('emitNonLoopbackTlsWarning（P2-1 部署面 TLS 告警）', () => {
  function collectTls(
    hostname: string,
    opts?: { relayUrl?: string; behindTlsProxy?: boolean },
  ): string[] {
    const warnings: string[] = [];
    emitNonLoopbackTlsWarning({ hostname, ...opts }, (m) =>
      warnings.push(m),
    );
    return warnings;
  }

  it('非 loopback 且无 TLS 信号：告警明文暴露（只告警不拒绝）', () => {
    const warnings = collectTls('192.168.1.10');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[安全告警]');
    expect(warnings[0]).toContain('TLS');
    // 告警形态对齐 TIANSHU_TOKEN 先例：指引可操作配置
    expect(warnings[0]).toContain('tlsBehindProxy');
  });

  it('通配绑定 0.0.0.0 同样告警（非 loopback 子集）', () => {
    expect(collectTls('0.0.0.0')).toHaveLength(1);
  });

  it('loopback 绑定：静默（本地开发语义，与 token 告警同豁免）', () => {
    expect(collectTls('127.0.0.1')).toHaveLength(0);
    expect(collectTls('localhost')).toHaveLength(0);
    expect(collectTls('::1')).toHaveLength(0);
  });

  it('relay wss://（server↔relay 跳 TLS）：不告警', () => {
    expect(
      collectTls('192.168.1.10', { relayUrl: 'wss://relay.example.com/ws' }),
    ).toHaveLength(0);
  });

  it('relay ws://（明文中继跳）：仍告警', () => {
    expect(
      collectTls('192.168.1.10', { relayUrl: 'ws://relay.example.com/ws' }),
    ).toHaveLength(1);
  });

  it('反代终止 TLS 声明（behindTlsProxy）：不告警', () => {
    expect(
      collectTls('192.168.1.10', { behindTlsProxy: true }),
    ).toHaveLength(0);
  });

  it('relay 未启动（undefined）：非 loopback 即告警', () => {
    expect(collectTls('10.0.0.5', {})).toHaveLength(1);
  });
});
