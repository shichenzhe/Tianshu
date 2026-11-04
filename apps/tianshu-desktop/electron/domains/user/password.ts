/**
 * 密码哈希（scrypt，Node 内置无新依赖）：
 * 存储格式 `scrypt$N$r$p$<saltB64>$<hashB64>`；
 * verifyPassword 兼容存量明文行（命中后由调用方升级为哈希，平滑迁移）。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_PREFIX = "scrypt$";
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** 常量时间比较（长度不等直接 false，不泄露时序信息） */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 是否已是哈希形态（否=存量明文，登录命中后应升级） */
export function isHashedPassword(stored: string): boolean {
  return stored.startsWith(SCRYPT_PREFIX);
}

/** 明文密码 → scrypt 哈希串（随机盐） */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
  return `${SCRYPT_PREFIX}${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * 校验密码：哈希形态走 scrypt 重算比对；存量明文做常量时间等值比对
 * （兼容 v13 前建的用户，登录成功后由 repo 升级为哈希存储）
 */
export function verifyPassword(plain: string, stored: string): boolean {
  if (!isHashedPassword(stored)) {
    return safeEqual(plain, stored);
  }
  const parts = stored.split("$");
  // prefix$N$r$p$salt$hash
  if (parts.length !== 6) return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  const actual = scryptSync(plain, salt, expected.length, { N: n, r, p });
  return timingSafeEqual(actual, expected);
}
