/**
 * JWT 密钥 env 外移（spec §13 项 6）：config.yml 不再承载 auth.jwt.secret，
 * 改读 .env 的 JWT_SECRET。独立成文件而非内联 configuration.ts 是为可单测
 * ——configuration.ts 顶层读真实 config.yml，jest 直跑下该路径不存在会抛错。
 *
 * 时序依据（@nestjs/config config.module.js）：forRoot 先 loadEnvFile 把
 * .env 装入 process.env（assignVariablesToProcess），后才求值 load 工厂
 * ——故 configuration() 执行时 process.env.JWT_SECRET 已就位。
 */
import { randomBytes } from 'node:crypto';

/** 密钥挂载点形状（configuration 的 auth 段子集，结构兼容直传） */
export interface JwtSecretConfigShape {
  auth?: { jwt?: { secret?: string } };
}

/** 密钥解析来源（main.ts 启动告警口径；applyJwtSecretEnv 每次调用覆写） */
export type JwtSecretSource = 'env' | 'yml' | 'fallback';

export const jwtSecretSource: { current: JwtSecretSource | null } = {
  current: null,
};

/**
 * 密钥优先级：.env 的 JWT_SECRET（非空白）> 既有 yml 值（历史/环境覆盖
 * 文件 config.<NODE_ENV>.yml 兼容保留）> 随机进程级兜底。
 *
 * 兜底语义（防启动崩溃，非共享默认密钥）：passport-jwt 对空 secretOrKey
 * 构造即抛 TypeError——未配置时以每次启动随机的秘密垫底，JWT 登录跨重启
 * 不可用（不可伪造、不可跨部署复用，仅比直接崩好）；main.ts 按 source
 * 非 env 打安全告警。天枢远控面走 TIANSHU_TOKEN，不受影响。
 */
export function applyJwtSecretEnv(
  config: JwtSecretConfigShape,
  env: Partial<Pick<NodeJS.ProcessEnv, 'JWT_SECRET'>>,
  fallbackSecret: () => string = () => randomBytes(32).toString('hex'),
): JwtSecretConfigShape {
  const fromEnv = env.JWT_SECRET?.trim();
  const hasYml = !!config.auth?.jwt?.secret;
  if (fromEnv) {
    config.auth ??= {};
    config.auth.jwt ??= {};
    config.auth.jwt.secret = fromEnv;
    jwtSecretSource.current = 'env';
  } else if (hasYml) {
    jwtSecretSource.current = 'yml';
  } else {
    config.auth ??= {};
    config.auth.jwt ??= {};
    config.auth.jwt.secret = fallbackSecret();
    jwtSecretSource.current = 'fallback';
  }
  return config;
}
