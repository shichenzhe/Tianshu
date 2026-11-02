import { verifyAccessJwt, type AccessQuota } from './jwt-eddsa';

/**
 * relay 鉴权策略可插拔（多租户批 Task 3）——首帧 auth 的凭证裁决从
 * relay-main 内联 static 比对抽为策略对象：static（共享 token，现状
 * 平移）与 jwt（EdDSA 验签，多租户凭证面）。relay-main 只消费裁决落
 * close/handleConnection，不感知凭证形态；裁决携带的 tenantId/quota/ak
 * 供后续租户三校验（Task 4 配额/顶号、Task 5 kick/stats）消费。
 */

/** 鉴权裁决：放行携带准入角色与租户维度（static 模式无租户维度，
 *  Task 4 据此旁路租户校验）；拒绝携带 ws close code 与 reason */
export type AuthDecision =
  | {
      ok: true;
      role: 'server' | 'client';
      tenantId?: string;
      quota?: AccessQuota;
      ak?: string;
    }
  | { ok: false; closeCode: number; reason: string };

/** 鉴权器：admit 纯同步裁决，不持有连接状态（close 由 relay-main 落） */
export interface Authenticator {
  admit(p: { token: string; role: unknown; connectionId: string }): AuthDecision;
}

/** static 鉴权器：共享 token 比对 + 角色白名单——原 admitConnection 内联
 *  校验的现状平移，token 先于 role（校验次序即行为，不得对调） */
export function createStaticAuthenticator(token: string): Authenticator {
  return {
    admit({ token: presented, role }) {
      if (presented !== token)
        return { ok: false, closeCode: 4001, reason: 'invalid-token' };
      if (role !== 'server' && role !== 'client')
        return { ok: false, closeCode: 4000, reason: 'invalid-role' };
      return { ok: true, role };
    },
  };
}

/** jwt 鉴权器：EdDSA 验签 + 吊销回调 + 角色白名单。角色取（已签名的）
 *  claims 而非首帧自报——帧 role 是未签名输入，token 才是凭证本体；
 *  白名单为签发面失守的运行时兜底（verify 的类型还原不作 wire 保证）。
 *  吊销命中与验签失败同归 invalid-token（不区分原因，报文细节不外泄
 *  给探测方——与 verifyAccessJwt 的归一语义一致） */
export function createJwtAuthenticator(
  publicKeyPem: string,
  isRevoked: (t: { tid?: string; ak?: string }) => boolean,
): Authenticator {
  return {
    admit({ token }) {
      const claims = verifyAccessJwt(token, publicKeyPem);
      if (!claims)
        return { ok: false, closeCode: 4001, reason: 'invalid-token' };
      if (isRevoked({ tid: claims.tid, ak: claims.ak }))
        return { ok: false, closeCode: 4001, reason: 'invalid-token' };
      if (claims.role !== 'server' && claims.role !== 'client')
        return { ok: false, closeCode: 4000, reason: 'invalid-role' };
      return {
        ok: true,
        role: claims.role,
        tenantId: claims.tid,
        quota: claims.quota,
        ak: claims.ak,
      };
    },
  };
}
