import {
  DEFAULT_LISTEN_HOSTNAME,
  emitListenSecurityWarnings,
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
    const warnings = collectWarnings('0.0.0.0', 'secret-token');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[安全告警]');
    expect(warnings[0]).toContain('0.0.0.0');
  });

  it('通配绑定且无 token：双告警（暴露 + 无鉴权）', () => {
    const warnings = collectWarnings('::', undefined);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('0.0.0.0/::');
    expect(warnings[1]).toContain('TIANSHU_TOKEN');
  });

  it('loopback 绑定且无 token：静默（本地开发放行语义维持）', () => {
    expect(collectWarnings('127.0.0.1', undefined)).toHaveLength(0);
    expect(collectWarnings('localhost', undefined)).toHaveLength(0);
    expect(collectWarnings('::1', undefined)).toHaveLength(0);
  });

  it('非 loopback 内网地址且无 token：仅无鉴权告警', () => {
    const warnings = collectWarnings('192.168.1.10', undefined);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('TIANSHU_TOKEN');
  });

  it('非 loopback 地址且有 token：无告警', () => {
    expect(collectWarnings('192.168.1.10', 'secret-token')).toHaveLength(0);
  });
});
