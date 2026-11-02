import { ConfigService } from '@nestjs/config';

/**
 * relay-admin 段配置解析（Task 12，spec §6/§9）：config.yml `relayAdmin` 段
 * + env 覆盖（RA_INTERNAL_SECRET / RA_RELAY_BASE_URL），优先级与 JWT_SECRET
 * 同款纪律（env > yml；密钥类不入 config.yml——yml 段只留占位注释）。
 * Task 13（kick/stats 联动）消费 relayBaseUrl；本任务消费 internalSecret
 * （revocations 端点鉴权）。
 */

/** internal secret env 名（与 relay 本体 --internal-secret 是同一秘密的两半：
 *  运营方双机各持，控制信道专用，与 Ed25519 密钥分域——spec §10） */
export const RA_INTERNAL_SECRET_ENV = 'RA_INTERNAL_SECRET';

/** relay 本体地址 env 名（Task 13 kick/stats 消费） */
export const RA_RELAY_BASE_URL_ENV = 'RA_RELAY_BASE_URL';

/**
 * 解析 internal secret：env RA_INTERNAL_SECRET（非空白）> yml
 * relayAdmin.internalSecret；均缺 → undefined（调用方 fail-closed：缺失时
 * revocations 端点 503 拒绝服务，不给名单）。
 *
 * env 逐请求读（非构造期快照）——运维改 env 后无需重启即生效，也让
 * 「未配置→503」可被在线验证。
 */
export function resolveInternalSecret(
  configService: ConfigService,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env[RA_INTERNAL_SECRET_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const fromYml = configService
    .get<string>('relayAdmin.internalSecret')
    ?.trim();
  return fromYml || undefined;
}

/**
 * 解析 relay 本体基地址（Task 13 消费，本任务仅登记单源）：env
 * RA_RELAY_BASE_URL > yml relayAdmin.relayBaseUrl；均缺 → undefined。
 */
export function resolveRelayBaseUrl(
  configService: ConfigService,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env[RA_RELAY_BASE_URL_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const fromYml = configService
    .get<string>('relayAdmin.relayBaseUrl')
    ?.trim();
  return fromYml || undefined;
}
