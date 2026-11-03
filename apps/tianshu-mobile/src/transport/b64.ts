// base64 编解码（标准字母表 + padding）——传输层共享字节工具。
// 自 e2e-crypto.ts 收编单份（relay 多租户 T16：relay-ak 的 Basic 头编码
// 复用同一实现，且本模块零依赖——expo-crypto 链不得经此扩散到 AK 凭证
// 模块的消费方）；e2e-crypto 对外 re-export 保持既有 import 面不变。

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64（标准字母表+padding）——hello/ack 公钥、Basic 凭证头编码复用 */
export function bytesToB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : "=";
  }
  return out;
}

/** base64 解码（无效字符抛错）——ack 公钥解码复用 */
export function b64ToBytes(s: string): Uint8Array {
  const clean = s.endsWith("=") ? s.slice(0, s.indexOf("=")) : s;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let offset = 0;
  for (const ch of clean) {
    const v = B64_ALPHABET.indexOf(ch);
    if (v === -1) throw new Error("e2e: invalid base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = (acc >> bits) & 0xff;
    }
  }
  return offset === out.length ? out : out.subarray(0, offset);
}
