/**
 * 安全门装配（2026-11-01 审查批 P0）单测：installSecurityGates 后
 * commandGate/fileGate 模块单例生效——内置敏感路径保护与自定义规则面
 * （此前全仓无装配调用方，黑名单恒 fail-open）。
 */
import { installSecurityGates } from 'src/core/chat-core.module';
import { commandGate } from 'src/core/security/command-gate';
import { fileGate } from 'src/core/security/file-gate';
import type { TianshuConfig } from 'src/commons/config/tianshu-config.entity';
import os from 'node:os';

/** ConfigService 最小替身（installSecurityGates 只消费 .get） */
const configOf = (config: Partial<TianshuConfig>): never =>
  ({ get: () => config }) as never;

describe('installSecurityGates（安全门装配，审查批 P0）', () => {
  afterAll(() => {
    // 复装默认，避免模块单例污染其他套件
    installSecurityGates(configOf({ dataRoot: '~/.tianshu-server' }));
  });

  it('装配后内置敏感路径保护生效：fileGate 对凭据路径非 default', () => {
    installSecurityGates(configOf({ dataRoot: '~/.tianshu-server' }));
    // ~/.ssh 凭据目录在 BUILTIN_FILE_BLOCKLIST_ALL（已逐字移植自 mirror）
    const sshKey = `${os.homedir()}/.ssh/id_rsa`;
    expect(fileGate(sshKey, '/tmp/ws')).not.toBe('default');
  });

  it('programBlacklist 配置生效：黑名单命令 block，普通命令 default', () => {
    installSecurityGates(
      configOf({
        dataRoot: '~/.tianshu-server',
        security: {
          sandboxEnabled: true,
          programBlacklist: ['danger-cli'],
          cmdAsk: [],
          cmdAllow: [],
          fileBlocklist: [],
          fileAllowlist: [],
        },
      }),
    );
    expect(commandGate('danger-cli --flag')).toBe('block');
    expect(commandGate('ls -la')).toBe('default');
  });

  it('fileBlocklist 自定义路径生效（相对内置清单的追加面）', () => {
    installSecurityGates(
      configOf({
        dataRoot: '~/.tianshu-server',
        security: {
          sandboxEnabled: true,
          programBlacklist: [],
          cmdAsk: [],
          cmdAllow: [],
          fileBlocklist: ['/tmp/secret-zone'],
          fileAllowlist: [],
        },
      }),
    );
    expect(fileGate('/tmp/secret-zone/key.pem', '/tmp/ws')).not.toBe('default');
  });

  it('sandboxEnabled=false 两门旁路回 default（既有审批链语义）', () => {
    installSecurityGates(
      configOf({
        dataRoot: '~/.tianshu-server',
        security: {
          sandboxEnabled: false,
          programBlacklist: ['danger-cli'],
          cmdAsk: [],
          cmdAllow: [],
          fileBlocklist: [],
          fileAllowlist: [],
        },
      }),
    );
    expect(commandGate('danger-cli')).toBe('default');
    expect(fileGate('/etc/shadow', '/tmp/ws')).toBe('default');
  });
});
