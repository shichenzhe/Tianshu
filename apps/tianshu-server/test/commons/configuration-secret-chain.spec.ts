// JWT 密钥链路级用例（T21 审查 F5 修复回归）：configuration 的 load 工厂
// 在「.env 装入 process.env 之后」求值时必须取到 env 密钥——密钥应用点
// 在工厂内而非模块顶层（顶层执行早于 @nestjs/config 的 loadEnvFile，
// .env 的 JWT_SECRET 永不胜出、随机兜底冒名顶替）。
//
// 导入真实 configuration.ts 需绕开 jest 路径坑：其顶层按 __dirname 解析
// <root>/config/config.yml（运行态为 dist/config/config.yml，jest 直跑
// src 下不存在）——mock fs 让两个 config.yml 探测命中内存假配置。
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  const fakeYaml =
    'database:\n  url: "file:./test.db"\nauth:\n  jwt:\n    expiresIn: 30m\n';
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

import configuration from 'src/commons/config/configuration';
import { jwtSecretSource } from 'src/commons/config/env-secret';

describe('configuration load 工厂密钥链路（F5）', () => {
  const original = process.env.JWT_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original;
  });

  it('模块导入期（.env 未装入）：fallback 垫底不抛错；工厂求值期 env 出现 → 覆盖为 env 值', () => {
    // 导入已发生（顶层读假 config.yml、无 env）——不崩、且不可能是 env 值
    const importTime = configuration();
    expect(importTime.auth?.jwt?.secret).toBeTruthy();
    expect(importTime.auth?.jwt?.secret).not.toBe('chain-env-secret');

    // 模拟 @nestjs/config 装好 .env 后求值 load 工厂：env 必须胜出
    process.env.JWT_SECRET = 'chain-env-secret';
    const factoryTime = configuration();
    expect(factoryTime.auth?.jwt?.secret).toBe('chain-env-secret');
    expect(factoryTime).toBe(importTime); // 同一配置对象就地覆写（ConfigService 缓存口径）
    expect(jwtSecretSource.current).toBe('env');
  });

  it('env 恒定场景工厂重复求值幂等：值与来源稳定（ConfigService 可能多次取配置）', () => {
    process.env.JWT_SECRET = 'chain-env-secret';
    const first = configuration();
    const second = configuration();
    expect(first.auth?.jwt?.secret).toBe('chain-env-secret');
    expect(second.auth?.jwt?.secret).toBe('chain-env-secret');
    expect(jwtSecretSource.current).toBe('env');
    // 注：真实进程 env 在 dotenv 装载后恒定——「求值中途删 env」非真实场景，
    // 配置对象对既有 secret 就地保留（env>yml 遗留>兜底的 yml 分支语义）
  });
});
