/**
 * option 表凭证字段密封（安全审查 2026-11-02 批三·B D1）：
 * 连接 token 家族的字段级密封——load 时透明解封（旧明文兼容）、save
 * 时加密。信封复用 @tianshu/core crypto-envelope（C1）+ 桌面主密钥。
 *
 * 覆盖：connections 行（token/backupToken/relayToken）、serverFace 行
 * （token/relayToken）、serverFace.e2eKey 行（静态私钥）、
 * webhook:<graphId> 行（每图 token）。
 */
import { openSecret, sealSecret } from "./secret-field";

/** 连接行的敏感字段名（密封 AAD 用 namespace.field 命名空间隔离） */
const CONNECTION_SECRET_FIELDS = [
  "token",
  "backupToken",
  "relayToken",
] as const;

/** 任意 JSON 对象的敏感字段密封（深度 1——这些行均为扁平结构）；泛型
 *  保持调用方形状（ConnectionConfig 等） */
export async function sealSecretFields<T extends object>(
  namespace: string,
  record: T,
): Promise<T> {
  const out = { ...record } as Record<string, unknown>;
  for (const field of CONNECTION_SECRET_FIELDS) {
    const value = out[field];
    if (typeof value === "string" && value !== "") {
      out[field] = await sealSecret(`${namespace}.${field}`, value);
    }
  }
  return out as T;
}

/** 密封的逆操作（解封失败字段置 undefined——呈现为缺失不阻断） */
export async function openSecretFields<T extends object>(
  namespace: string,
  record: T,
): Promise<T> {
  const out = { ...record } as Record<string, unknown>;
  for (const field of CONNECTION_SECRET_FIELDS) {
    const value = out[field];
    if (typeof value === "string" && value !== "") {
      out[field] =
        (await openSecret(`${namespace}.${field}`, value)) ?? undefined;
    }
  }
  return out as T;
}

/** 单字段密封/解封（e2eKey 私钥、webhook token 等非行集场景） */
export async function sealNamedSecret(
  field: string,
  value: string | null,
): Promise<string | null> {
  return sealSecret(field, value);
}

export async function openNamedSecret(
  field: string,
  stored: string | null,
): Promise<string | null> {
  return openSecret(field, stored);
}
