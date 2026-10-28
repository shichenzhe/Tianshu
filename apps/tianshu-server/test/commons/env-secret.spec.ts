// JWT 密钥 env 外移（spec §13 项 6）：applyJwtSecretEnv 纯函数——
// 优先级 env > yml 遗留值 > 随机兜底；来源标记供 main.ts 告警口径。
import {
  applyJwtSecretEnv,
  jwtSecretSource,
} from 'src/commons/config/env-secret';

describe('applyJwtSecretEnv（密钥外移 .env）', () => {
  it('env 提供（含两端空白收敛）：覆盖 yml 遗留值，source=env', () => {
    const config = applyJwtSecretEnv(
      { auth: { jwt: { secret: 'yml-legacy' } } },
      { JWT_SECRET: '  env-secret  ' },
    );
    expect(config.auth?.jwt?.secret).toBe('env-secret');
    expect(jwtSecretSource.current).toBe('env');
  });

  it('env 缺席 + yml 有遗留值：保持不动，source=yml（兼容历史部署）', () => {
    const config = applyJwtSecretEnv(
      { auth: { jwt: { secret: 'yml-legacy' } } },
      {},
    );
    expect(config.auth?.jwt?.secret).toBe('yml-legacy');
    expect(jwtSecretSource.current).toBe('yml');
  });

  it('两者皆无：随机兜底垫 secret（防 passport-jwt 构造抛错），source=fallback', () => {
    let fallbackUsed = false;
    const config = applyJwtSecretEnv({}, {}, () => {
      fallbackUsed = true;
      return 'random-boot-secret';
    });
    expect(fallbackUsed).toBe(true);
    expect(config.auth?.jwt?.secret).toBe('random-boot-secret');
    expect(jwtSecretSource.current).toBe('fallback');
  });

  it('env 空白串视同缺席（不覆盖 yml、走兜底）', () => {
    const withYml = applyJwtSecretEnv(
      { auth: { jwt: { secret: 'yml-legacy' } } },
      { JWT_SECRET: '   ' },
    );
    expect(withYml.auth?.jwt?.secret).toBe('yml-legacy');

    const bare = applyJwtSecretEnv({ auth: {} }, { JWT_SECRET: '' }, () => 'f');
    expect(bare.auth?.jwt?.secret).toBe('f');
    expect(jwtSecretSource.current).toBe('fallback');
  });
});
