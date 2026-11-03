// relay E2E 端到端加密——移动端实现（安全批 H：relay e2e 接入）。
// **双份移植声明**（先例 src/logic/plan-view.ts：@tianshu/core 带
// langChain peer 依赖不宜进 metro bundle，纯函数双份落本目录）：
// 桌面/无头端原实现 packages/tianshu-core/src/e2e-crypto.ts
// （node:crypto），本文件是 Uint8Array + @noble 系第二实现——
// **字节级 wire 兼容**，改任一侧的密码学参数/构造必须双侧同步评审：
// - HKDF：sha256，salt = sha256(ephPub‖staticPub)，info = dir +
//   "tianshu-relay-e2e/v1:<connectionId>:" + ephPub + staticPub，32B；
// - GCM：AES-256，nonce = 4B 会话随机前缀 + 8B BE 计数器（从 1 起），
//   AAD = "tianshu-e2e/<dir>:" + 计数器 8B，密文 = ct‖16B tag；
// - 指纹 = sha256(公钥) hex 前 16 字符（小写）；
// - 低阶对端公钥（全零共享秘密）显式拒绝；
// - 接收 64 滑动窗口拒重放（nonce 前缀首帧钉住）。
// 随机源 expo-crypto（Expo Go 可用）；互操作一致性由
// e2e-crypto.test.ts 对 node 原实现的交叉向量锁定。
import { x25519 } from "@noble/curves/ed25519";
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getRandomValues } from "expo-crypto";
import {
  E2E_REPLAY_WINDOW,
  E2E_SECURE_KIND,
  type E2ESecureEnvelope,
} from "@tianshu/protocol";

/** 原始 X25519 密钥对（公/私钥均为 32B 原始字节） */
export type E2EKeyPair = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

/** 双向会话密钥（各 32B，AES-256） */
export type E2ESessionKeys = {
  clientToServer: Uint8Array;
  serverToClient: Uint8Array;
};

/** 会话角色：client=控制端（临时对持有方），server=被控端（静态对持有方） */
export type E2ERole = "client" | "server";

export type { E2ESecureEnvelope };

/** 派生入参：二选一半区（与 core 版同构） */
export type E2EDeriveKeys =
  | { ephemeralPublicKey: Uint8Array; staticPrivateKey: Uint8Array }
  | { ephemeralPrivateKey: Uint8Array; staticPublicKey: Uint8Array };

/** 会话句面：seal 密封本方向出帧，open 校验并解开对向入帧 */
export type E2ESession = {
  seal(plaintext: string | Uint8Array): E2ESecureEnvelope;
  open(envelope: E2ESecureEnvelope): Uint8Array;
};

// ---- 字节工具（Buffer 不可用，最小集自持）----

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  getRandomValues(out);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// base64 实现收编单份至 ./b64（T16：relay-ak 复用且不引 expo 链）；
// 对外 re-export 保持既有 import 面不变
export { bytesToB64, b64ToBytes } from "./b64";
import { bytesToB64, b64ToBytes } from "./b64";

function toHexLower(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// ---- 密钥对 ----

const X25519_RAW_LENGTH = 32;

function assertRawKey(key: Uint8Array, name: string): void {
  if (!(key instanceof Uint8Array) || key.length !== X25519_RAW_LENGTH) {
    throw new Error(`e2e: ${name} must be a 32-byte raw X25519 key`);
  }
}

/** 控制端每连接临时密钥对（连接生命周期，随协商即弃） */
export function generateEphemeralPair(): E2EKeyPair {
  const privateKey = randomBytes(32); // clamp 由 x25519 内部按 RFC 7748 施行
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

// ---- 指纹 ----

/** SHA-256 前 16 hex（小写）；入参兼容 32B 原始公钥与 base64 字符串 */
export function fingerprintOf(publicKey: Uint8Array | string): string {
  const raw =
    typeof publicKey === "string" ? b64ToBytes(publicKey) : publicKey;
  assertRawKey(raw, "publicKey");
  return toHexLower(sha256(raw)).slice(0, 16);
}

// ---- 会话密钥派生 ----

const ZERO32 = new Uint8Array(32);

/**
 * X25519 ECDH → HKDF-SHA256 派生双向会话密钥（绑定串与 core 版逐字节
 * 一致——互操作契约，见文件头）。低阶对端公钥产生全零共享秘密且
 * @noble 不报错——显式拒绝（与 core 版对称）。
 */
export function deriveSessionKeys(
  keys: E2EDeriveKeys & { connectionId: string },
): E2ESessionKeys {
  const connectionId = keys.connectionId;
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    throw new Error("e2e: connectionId must be a non-empty string");
  }
  const ephemeralPublic =
    "ephemeralPublicKey" in keys
      ? keys.ephemeralPublicKey
      : x25519.getPublicKey(keys.ephemeralPrivateKey);
  const staticPublic =
    "staticPublicKey" in keys
      ? keys.staticPublicKey
      : x25519.getPublicKey(keys.staticPrivateKey);
  assertRawKey(ephemeralPublic, "ephemeralPublicKey");
  assertRawKey(staticPublic, "staticPublicKey");

  const sharedSecret =
    "staticPrivateKey" in keys
      ? x25519.getSharedSecret(keys.staticPrivateKey, ephemeralPublic)
      : x25519.getSharedSecret(keys.ephemeralPrivateKey, staticPublic);
  if (bytesEquals(sharedSecret, ZERO32)) {
    throw new Error("E2E: 低阶公钥拒绝（无效对端密钥）");
  }

  const salt = sha256(concatBytes(ephemeralPublic, staticPublic));
  const contextBase = concatBytes(
    utf8(`tianshu-relay-e2e/v1:${connectionId}:`),
    ephemeralPublic,
    staticPublic,
  );
  const derive = (direction: string): Uint8Array =>
    hkdf(
      sha256,
      sharedSecret,
      salt,
      concatBytes(utf8(direction), contextBase),
      32,
    );
  return {
    clientToServer: derive("c2s"),
    serverToClient: derive("s2c"),
  };
}

// ---- 信封会话（seal/open + 重放窗口状态机）----

const GCM_TAG_LENGTH = 16;
const NONCE_PREFIX_LENGTH = 4;
const NONCE_LENGTH = 12;
const WINDOW_MASK_ALL = (1n << BigInt(E2E_REPLAY_WINDOW)) - 1n;

type SendState = {
  key: Uint8Array;
  prefix: Uint8Array;
  counter: number;
};

type RecvState = {
  key: Uint8Array;
  prefix: Uint8Array | null;
  highest: number;
  seenMask: bigint;
};

function counterToBytes(counter: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(counter), false);
  return out;
}

function aadFor(direction: "c2s" | "s2c", counter: Uint8Array): Uint8Array {
  return concatBytes(utf8(`tianshu-e2e/${direction}:`), counter);
}

/**
 * 创建加解密会话：role 决定发送/接收各走哪个方向密钥。重放窗口语义
 * 与 core 版一致（64 滑动：窗口内已见拒/未见收/低于下沿拒）。
 */
export function createE2ESession(
  keys: E2ESessionKeys,
  role: E2ERole,
): E2ESession {
  const sendState: SendState = {
    key: role === "client" ? keys.clientToServer : keys.serverToClient,
    prefix: randomBytes(NONCE_PREFIX_LENGTH),
    counter: 0,
  };
  const recvState: RecvState = {
    key: role === "client" ? keys.serverToClient : keys.clientToServer,
    prefix: null,
    highest: 0,
    seenMask: 0n,
  };
  const sendDirection: "c2s" | "s2c" = role === "client" ? "c2s" : "s2c";
  const recvDirection: "c2s" | "s2c" = role === "client" ? "s2c" : "c2s";

  const checkAndRecordCounter = (counter: number): void => {
    if (counter > recvState.highest) {
      const shift = BigInt(counter - recvState.highest);
      recvState.seenMask =
        ((recvState.seenMask << shift) & WINDOW_MASK_ALL) | 1n;
      recvState.highest = counter;
      return;
    }
    const offset = recvState.highest - counter;
    if (offset >= E2E_REPLAY_WINDOW) {
      throw new Error("E2E: 重放帧拒绝（低于窗口下沿）");
    }
    if ((recvState.seenMask >> BigInt(offset)) & 1n) {
      throw new Error(
        `e2e: replay rejected (counter ${counter} duplicated in window)`,
      );
    }
    recvState.seenMask |= 1n << BigInt(offset);
  };

  const parseEnvelope = (envelope: E2ESecureEnvelope) => {
    if (
      !envelope ||
      typeof envelope !== "object" ||
      (envelope as { kind?: unknown }).kind !== E2E_SECURE_KIND
    ) {
      throw new Error("e2e: not a secure envelope frame");
    }
    const { n, ct } = envelope as { n?: unknown; ct?: unknown };
    if (typeof n !== "string" || typeof ct !== "string") {
      throw new Error("e2e: malformed envelope (n/ct must be base64 strings)");
    }
    if (!BASE64_PATTERN.test(n) || !BASE64_PATTERN.test(ct)) {
      throw new Error("e2e: malformed envelope (invalid base64)");
    }
    const nonce = b64ToBytes(n);
    const ciphertext = b64ToBytes(ct);
    if (nonce.length !== NONCE_LENGTH) {
      throw new Error(`e2e: nonce must be ${NONCE_LENGTH} bytes`);
    }
    if (ciphertext.length < GCM_TAG_LENGTH) {
      throw new Error("e2e: ciphertext shorter than GCM tag");
    }
    return { nonce, ciphertext };
  };

  return {
    seal(plaintext) {
      sendState.counter += 1;
      if (sendState.counter > Number.MAX_SAFE_INTEGER) {
        throw new Error("e2e: send counter exhausted (re-handshake required)");
      }
      const counter = counterToBytes(sendState.counter);
      const nonce = concatBytes(sendState.prefix, counter);
      const body =
        typeof plaintext === "string" ? utf8(plaintext) : plaintext;
      const ciphertext = gcm(sendState.key, nonce, aadFor(sendDirection, counter)).encrypt(body);
      return {
        kind: E2E_SECURE_KIND,
        n: bytesToB64(nonce),
        ct: bytesToB64(ciphertext),
      };
    },
    open(envelope) {
      const { nonce, ciphertext } = parseEnvelope(envelope);
      const prefix = nonce.subarray(0, NONCE_PREFIX_LENGTH);
      const counterBytes = nonce.subarray(NONCE_PREFIX_LENGTH);
      if (recvState.prefix !== null && !bytesEquals(prefix, recvState.prefix)) {
        throw new Error(
          "e2e: nonce prefix mismatch (cross direction or stale session)",
        );
      }
      const counter = Number(
        new DataView(
          counterBytes.buffer,
          counterBytes.byteOffset,
          counterBytes.byteLength,
        ).getBigUint64(0, false),
      );
      if (counter < 1 || counter > Number.MAX_SAFE_INTEGER) {
        throw new Error("e2e: invalid nonce counter");
      }
      let plaintext: Uint8Array;
      try {
        plaintext = gcm(recvState.key, nonce, aadFor(recvDirection, counterBytes)).decrypt(ciphertext);
      } catch {
        throw new Error(
          "e2e: envelope authentication failed (tampered or wrong key)",
        );
      }
      if (recvState.prefix === null) {
        recvState.prefix = prefix.slice();
      }
      checkAndRecordCounter(counter);
      return plaintext;
    },
  };
}
