// PK 终审 F1：日志目录 env 覆盖（TIANSHU_LOG_DIR → configuration.log.dir）。
// applyLogDirEnv 纯函数直测（db-url.spec 同款 env 三态口径）+ load 工厂
// 链路（configuration-secret-chain.spec 同款 fs mock——configuration.ts
// 顶层读 <root>/config/config.yml，jest 直跑 src 下不存在，mock 探测命中
// 内存假配置带 log 段）。
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  const fakeYaml =
    'database:\n  url: "file:./test.db"\nlog:\n  level: info\n  dir: ./logs\n';
  return {
    ...actual,
    existsSync: (path: unknown): boolean =>
      typeof path === 'string' && path.endsWith('/config.yml')
        ? true
        : actual.existsSync(path as Parameters<typeof actual.existsSync>[0]),
    readFileSync: (
      path: unknown,
      ...rest: Parameters<typeof actual.readFileSync>[1][]
    ): ReturnType<typeof actual.readFileSync> =>
      typeof path === 'string' && path.endsWith('/config.yml')
        ? fakeYaml
        : actual.readFileSync(
            path as Parameters<typeof actual.readFileSync>[0],
            ...rest,
          ),
  };
});

import configuration, {
  applyLogDirEnv,
  LOG_DIR_ENV,
} from 'src/commons/config/configuration';

describe('applyLogDirEnv（纯函数：env 三态）', () => {
  it('未注入 → 零改动（yml 值保留）', () => {
    const config = { log: { dir: './logs' } };
    expect(applyLogDirEnv(config, {})).toBe(config);
    expect(config.log.dir).toBe('./logs');
  });

  it('空白值视为未注入', () => {
    const config = { log: { dir: './logs' } };
    applyLogDirEnv(config, { [LOG_DIR_ENV]: '   ' });
    expect(config.log.dir).toBe('./logs');
  });

  it('注入 → 覆盖 log.dir（缺 log 段自建）', () => {
    const noSection: { log?: { dir?: string } } = {};
    applyLogDirEnv(noSection, { [LOG_DIR_ENV]: ' /var/log/ts \n' });
    expect(noSection.log?.dir).toBe('/var/log/ts');
  });
});

describe('configuration load 工厂日志目录链路（F1）', () => {
  const original = process.env[LOG_DIR_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[LOG_DIR_ENV];
    else process.env[LOG_DIR_ENV] = original;
  });

  it('未注入（dev 态）→ log.dir 保持 yml 值（现状链路零改动）', () => {
    delete process.env[LOG_DIR_ENV];
    expect(configuration().log?.dir).toBe('./logs');
  });

  it('注入（打包态桌面端 spawn）→ 工厂求值后 log.dir 为 env 绝对路径', () => {
    process.env[LOG_DIR_ENV] = '/Users/u/.tianshu-server/logs';
    expect(configuration().log?.dir).toBe('/Users/u/.tianshu-server/logs');
    // 其余 log 字段不受覆盖影响
    expect(configuration().log?.level).toBe('info');
  });
});
