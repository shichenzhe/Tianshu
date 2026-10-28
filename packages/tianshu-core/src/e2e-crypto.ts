/**
 * relay 端到端加密核心（spec：2026-10-18-relay-e2e-design §2/§3.1）。
 *
 * 纯 node:crypto 实现，零 Electron、零第三方依赖（三方消费：mirror
 * RelayTransport 控制端 / server-face relay-client 被控端 / headless
 * relay-client 经 file: dist）。
 *
 * 密码件：
 * - 密钥协商 X25519（静态身份对持久化 + 每连接临时对）；
 * - HKDF-SHA256 派生双向会话密钥（info 绑定 connectionId + 两公钥 +
 *   方向标签——双向密钥不同，跨方向密文互不可解）；
 * - AES-256-GCM 信封（nonce = 4B 会话随机前缀 + 8B 计数器；aad =
 *   方向 + 计数器，防帧重排序注入；接收端 64 滑动窗口拒重放）。
 *
 * 信封与握手帧 kind 常量为跨仓单份 wire 契约（tianshu-server 经 dist
 * 消费同一份），改动必须双仓同步评审。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/** 握手帧 kind（spec §2.2，明文经 relay 照转发）——跨仓单份 */
export const E2E_HANDSHAKE_HELLO = "e2e-hello";
export const E2E_HANDSHAKE_ACK = "e2e-ack";
/** 密文信封帧 kind（spec §2.3，包装一切后续业务帧） */
export const E2E_SECURE_KIND = "e2e-secure";

/** 接收端滑动窗口宽度（计数器记忆数；窗口语义见 {@link createE2ESession}） */
export const E2E_REPLAY_WINDOW = 64;

/** 原始 X25519 密钥对（公/私钥均为 32B 原始字节） */
export type E2EKeyPair = {
  publicKey: Buffer;
  privateKey: Buffer;
};

/** 双向会话密钥（各 32B，AES-256） */
export type E2ESessionKeys = {
  clientToServer: Buffer;
  serverToClient: Buffer;
};

/** 会话角色：client=控制端（临时对持有方），server=被控端（静态对持有方） */
export type E2ERole = "client" | "server";

/** 密文信封（n=12B nonce，ct=密文+16B GCM tag，均 base64） */
export type E2ESecureEnvelope = {
  kind: "e2e-secure";
  n: string;
  ct: string;
};

/** 派生入参：二选一半区——被控端持（临时公钥+静态私钥），控制端持（临时私钥+静态公钥） */
export type E2EDeriveKeys =
  | { ephemeralPublicKey: Buffer; staticPrivateKey: Buffer }
  | { ephemeralPrivateKey: Buffer; staticPublicKey: Buffer };

/** 会话句面：seal 密封本方向出帧，open 校验并解开对向入帧 */
export type E2ESession = {
  seal(plaintext: string | Buffer): E2ESecureEnvelope;
  open(envelope: E2ESecureEnvelope): Buffer;
};

// ---- X25519 原始字节 ↔ KeyObject（DER 定长前缀拼接，免手写 jwk）----

const X25519_RAW_LENGTH = 32;
const X25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);
const X25519_PKCS8_PREFIX = Buffer.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04,
  0x22, 0x04, 0x20,
]);

function assertRawKey(key: Buffer, name: string): void {
  if (!Buffer.isBuffer(key) || key.length !== X25519_RAW_LENGTH) {
    throw new Error(`e2e: ${name} must be a 32-byte raw X25519 key`);
  }
}

function rawToPublicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function rawToPrivateKeyObject(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyObjectToRaw(key: KeyObject): Buffer {
  const der = key.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - X25519_RAW_LENGTH);
}

function privateKeyObjectToRaw(key: KeyObject): Buffer {
  const der = key.export({ type: "pkcs8", format: "der" }) as Buffer;
  return der.subarray(der.length - X25519_RAW_LENGTH);
}

/** 由私钥推导公钥（序列化自检与客户端侧 info 绑定用） */
function publicKeyFromPrivateKey(rawPrivate: Buffer): Buffer {
  return publicKeyObjectToRaw(
    createPublicKey(rawToPrivateKeyObject(rawPrivate)),
  );
}

function generateX25519Pair(): E2EKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKeyObjectToRaw(publicKey),
    privateKey: privateKeyObjectToRaw(privateKey),
  };
}

// ---- 密钥对生成 ----

/** 控制端每连接临时密钥对（连接生命周期，随协商即弃） */
export function generateEphemeralPair(): E2EKeyPair {
  return generateX25519Pair();
}

/** 被控端静态身份密钥对（option 表持久化，指纹带外传递） */
export function generateStaticPair(): E2EKeyPair {
  return generateX25519Pair();
}

// ---- 静态对序列化（option 存取）----

const STATIC_PAIR_PREFIX = "tianshu-e2e-static-v1";

/** 序列化为 `tianshu-e2e-static-v1:<b64私钥>:<b64公钥>` 单字符串 */
export function serializeStaticPair(pair: E2EKeyPair): string {
  assertRawKey(pair.privateKey, "privateKey");
  assertRawKey(pair.publicKey, "publicKey");
  return [
    STATIC_PAIR_PREFIX,
    pair.privateKey.toString("base64"),
    pair.publicKey.toString("base64"),
  ].join(":");
}

/** 反序列化静态对；畸形存储/公私钥不一致（损坏）抛错 */
export function parseStaticPair(stored: string): E2EKeyPair {
  if (typeof stored !== "string") {
    throw new Error("e2e: static pair storage must be a string");
  }
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== STATIC_PAIR_PREFIX) {
    throw new Error(
      `e2e: malformed static pair storage (expected ${STATIC_PAIR_PREFIX}:<b64>:<b64>)`,
    );
  }
  const privateKey = Buffer.from(parts[1], "base64");
  const publicKey = Buffer.from(parts[2], "base64");
  assertRawKey(privateKey, "privateKey");
  assertRawKey(publicKey, "publicKey");
  if (!publicKeyFromPrivateKey(privateKey).equals(publicKey)) {
    throw new Error("e2e: static pair corrupted (public/private mismatch)");
  }
  return { publicKey, privateKey };
}

// ---- 指纹 ----

/** SHA-256 前 16 hex（小写）；入参兼容 32B 原始公钥与 base64 字符串（ack 帧） */
export function fingerprintOf(publicKey: Buffer | string): string {
  const raw =
    typeof publicKey === "string"
      ? Buffer.from(publicKey, "base64")
      : publicKey;
  assertRawKey(raw, "publicKey");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ---- 会话密钥派生 ----

/** 全零共享秘密哨兵（X25519 低阶对端公钥的特征产物） */
const X25519_ZERO_SHARED_SECRET = Buffer.alloc(X25519_RAW_LENGTH);

/**
 * X25519 ECDH → HKDF-SHA256 派生双向会话密钥。
 *
 * - ECDH 半区二选一：被控端（临时公钥+静态私钥）与控制端（临时私钥+
 *   静态公钥）算得同一共享秘密；
 * - 低阶对端公钥（如全零公钥/小因子子群点）会产生全零共享秘密且
 *   OpenSSL 不报错——显式拒绝，防小因子子群/恒等点攻击面；
 * - HKDF info 绑定 `方向 + connectionId + 临时公钥 + 静态公钥`（两公钥
 *   固定 32B 尾接，无拼接歧义），salt 为两公钥拼接的 SHA-256——双向
 *   密钥不同，跨协商/跨连接密钥互不可用。
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
      : publicKeyFromPrivateKey(keys.ephemeralPrivateKey);
  const staticPublic =
    "staticPublicKey" in keys
      ? keys.staticPublicKey
      : publicKeyFromPrivateKey(keys.staticPrivateKey);
  assertRawKey(ephemeralPublic, "ephemeralPublicKey");
  assertRawKey(staticPublic, "staticPublicKey");

  const sharedSecret =
    "staticPrivateKey" in keys
      ? diffieHellman({
          privateKey: rawToPrivateKeyObject(keys.staticPrivateKey),
          publicKey: rawToPublicKeyObject(ephemeralPublic),
        })
      : diffieHellman({
          privateKey: rawToPrivateKeyObject(keys.ephemeralPrivateKey),
          publicKey: rawToPublicKeyObject(staticPublic),
        });
  if (sharedSecret.equals(X25519_ZERO_SHARED_SECRET)) {
    throw new Error("E2E: 低阶公钥拒绝（无效对端密钥）");
  }

  const salt = createHash("sha256")
    .update(Buffer.concat([ephemeralPublic, staticPublic]))
    .digest();
  const contextBase = Buffer.concat([
    Buffer.from(`tianshu-relay-e2e/v1:${connectionId}:`, "utf8"),
    ephemeralPublic,
    staticPublic,
  ]);
  const derive = (direction: string): Buffer =>
    Buffer.from(
      hkdfSync(
        "sha256",
        sharedSecret,
        salt,
        Buffer.concat([Buffer.from(direction, "utf8"), contextBase]),
        32,
      ),
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
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const WINDOW_MASK_ALL = (1n << BigInt(E2E_REPLAY_WINDOW)) - 1n;

type SendState = {
  key: Buffer;
  /** 本方向 nonce 的 4B 随机前缀（会话内固定，初始 nonce 随机化） */
  prefix: Buffer;
  /** 已用出的最大计数器（0 = 尚未发送） */
  counter: number;
};

type RecvState = {
  key: Buffer;
  /** 对向 nonce 前缀（首帧认证成功后钉住，变更即拒——计数器空间隔离） */
  prefix: Buffer | null;
  /** 已见最大计数器（0 = 尚未收到） */
  highest: number;
  /** 窗口内已见计数器位图（bit i = highest-i，i ∈ [0,64)） */
  seenMask: bigint;
};

function createSendState(key: Buffer): SendState {
  assertRawKey(key, "session key");
  return { key, prefix: randomBytes(NONCE_PREFIX_LENGTH), counter: 0 };
}

function createRecvState(key: Buffer): RecvState {
  assertRawKey(key, "session key");
  return { key, prefix: null, highest: 0, seenMask: 0n };
}

function counterToBuffer(counter: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  return buffer;
}

function aadFor(direction: "c2s" | "s2c", counter: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`tianshu-e2e/${direction}:`, "utf8"),
    counter,
  ]);
}

/**
 * 创建加解密会话：role 决定发送/接收各走哪个方向密钥
 * （client 发 c2s 收 s2c，server 发 s2c 收 c2s）。
 *
 * 重放窗口语义（64 滑动，窗口 = [highest-63, highest]）：
 * - 窗口内已见计数器 → 拒（重放）；
 * - 窗口内未见计数器 → 收（乱序补投）；
 * - 低于窗口下沿（已被滑过）→ 拒——有序 WS 传输下诚实路径不可达
 *   （单连接帧按序到达，低于下沿必为重放帧），彻底封死重放面。
 */
export function createE2ESession(
  keys: E2ESessionKeys,
  role: E2ERole,
): E2ESession {
  const sendState = createSendState(
    role === "client" ? keys.clientToServer : keys.serverToClient,
  );
  const recvState = createRecvState(
    role === "client" ? keys.serverToClient : keys.clientToServer,
  );
  const sendDirection: "c2s" | "s2c" = role === "client" ? "c2s" : "s2c";
  const recvDirection: "c2s" | "s2c" = role === "client" ? "s2c" : "c2s";

  /** 计数器登记：窗口内未见放行；窗口内已见/低于窗口下沿均拒（重放） */
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
    const nonce = Buffer.from(n, "base64");
    const ciphertext = Buffer.from(ct, "base64");
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
      const counter = counterToBuffer(sendState.counter);
      const nonce = Buffer.concat([sendState.prefix, counter]);
      const cipher = createCipheriv("aes-256-gcm", sendState.key, nonce);
      cipher.setAAD(aadFor(sendDirection, counter));
      const body =
        typeof plaintext === "string"
          ? Buffer.from(plaintext, "utf8")
          : plaintext;
      const ciphertext = Buffer.concat([
        cipher.update(body),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return {
        kind: E2E_SECURE_KIND,
        n: nonce.toString("base64"),
        ct: ciphertext.toString("base64"),
      };
    },
    open(envelope) {
      const { nonce, ciphertext } = parseEnvelope(envelope);
      const prefix = nonce.subarray(0, NONCE_PREFIX_LENGTH);
      const counterBuffer = nonce.subarray(NONCE_PREFIX_LENGTH);
      if (recvState.prefix !== null && !prefix.equals(recvState.prefix)) {
        throw new Error(
          "e2e: nonce prefix mismatch (cross direction or stale session)",
        );
      }
      const counter = Number(counterBuffer.readBigUInt64BE(0));
      if (counter < 1 || counter > Number.MAX_SAFE_INTEGER) {
        throw new Error("e2e: invalid nonce counter");
      }
      const decipher = createDecipheriv("aes-256-gcm", recvState.key, nonce);
      decipher.setAAD(aadFor(recvDirection, counterBuffer));
      decipher.setAuthTag(
        ciphertext.subarray(ciphertext.length - GCM_TAG_LENGTH),
      );
      let plaintext: Buffer;
      try {
        plaintext = Buffer.concat([
          decipher.update(
            ciphertext.subarray(0, ciphertext.length - GCM_TAG_LENGTH),
          ),
          decipher.final(),
        ]);
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- 包 tsconfig lib=ES2020 无 ErrorOptions（cause 无法经构造传，升 lib 属独立决策）；message 已含原错误
        throw new Error(
          `e2e: envelope authentication failed (tampered or wrong key): ${
            (error as Error).message
          }`,
        );
      }
      // 认证成功后才提交接收状态：钉住前缀 + 重放窗口推进（篡改帧
      // 不污染窗口，其后合法帧不受影响）
      if (recvState.prefix === null) {
        recvState.prefix = Buffer.from(prefix);
      }
      checkAndRecordCounter(counter);
      return plaintext;
    },
  };
}
