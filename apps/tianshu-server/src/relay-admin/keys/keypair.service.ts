import { Injectable } from '@nestjs/common';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { generateEd25519KeyPems } from '../../relay/jwt-eddsa';

/** relay-admin 数据根 env 名（密钥落盘锚点） */
export const RA_DATA_DIR_ENV = 'RA_DATA_DIR';

/** 缺省数据根：相对 cwd 的 ./data——dist 运行时 cwd 漂移会连带漂移落点
 * （RA_DATABASE_URL 锚 schema 目录的同族注意项），生产部署请显式设
 * RA_DATA_DIR 为绝对路径 */
export const RA_DATA_DIR_DEFAULT = './data';

/** 密钥文件名（私钥 0600；公钥伴随落盘仅供运营方导出配给 relay） */
const PRIVATE_KEY_FILE = 'relay-access.pem';
const PUBLIC_KEY_FILE = 'relay-access.pub.pem';

/** access 签发密钥对（内存态：加载/生成后不再触盘） */
interface AccessKeyMaterial {
  privateKeyPem: string;
  publicKeyPem: string;
  /** kid：公钥指纹（sha256 前 16 hex）——relay 侧多密钥轮换选钥提示（MVP 单密钥） */
  kid: string;
}

/**
 * relay-admin access 签发密钥管理（Task 12，spec §9 密钥物料）：首启生成
 * Ed25519 对，私钥落 {RA_DATA_DIR}/keys/relay-access.pem（0600），此后启动
 * 加载同一把——已签发的 access 不因重启失效（30d TTL 内跨进程稳定）。
 * 公钥自私钥派生（单一事实源），伴随落盘一份仅为运营方导出配给 relay
 * 的便利（spec §9「私钥持控制平面、公钥导出配 relay」）。
 *
 * 加载路径坏 PEM 硬失败（T3 relay 公钥启动校验同款纪律）：静默重生会
 * 孤儿化全部存量 access（relay 侧旧公钥验不过新签发），宁可大声失败。
 */
@Injectable()
export class KeypairService {
  private readonly keysDir: string;
  private key: AccessKeyMaterial | null = null;

  constructor() {
    // env 在构造期（模块编译时）解析——与 RA_DATABASE_URL 的 client 构造
    // 期时序纪律一致
    const dataDir = resolve(
      process.env[RA_DATA_DIR_ENV]?.trim() || RA_DATA_DIR_DEFAULT,
    );
    this.keysDir = join(dataDir, 'keys');
  }

  /** 私钥（仅签发侧——relay-admin 进程内不出圈） */
  getPrivateKeyPem(): string {
    return this.ensureKey().privateKeyPem;
  }

  /** 公钥（派生自私钥；运营方导出配给 relay --auth-pubkey 用） */
  getPublicKeyPem(): string {
    return this.ensureKey().publicKeyPem;
  }

  /** kid：AccessClaims.kid / JWT header 的密钥指纹提示 */
  getKeyId(): string {
    return this.ensureKey().kid;
  }

  /** 首用加载/生成 + 进程内 memoize（幂等，测试与签发热路径共用） */
  private ensureKey(): AccessKeyMaterial {
    if (this.key) return this.key;
    const privateKeyPath = join(this.keysDir, PRIVATE_KEY_FILE);
    if (existsSync(privateKeyPath)) {
      this.key = this.materialFromPrivate(readFileSync(privateKeyPath, 'utf8'));
      // 运营方预置/搬移过来的文件可能权限宽松——加载即收紧（幂等）
      chmodSync(privateKeyPath, 0o600);
      // 伴随公钥缺失则补写（私钥被手动搬移后的自愈，不构成放行面）
      const publicKeyPath = join(this.keysDir, PUBLIC_KEY_FILE);
      if (!existsSync(publicKeyPath)) {
        mkdirSync(this.keysDir, { recursive: true });
        writeFileSync(publicKeyPath, this.key.publicKeyPem, { mode: 0o644 });
      }
      return this.key;
    }
    const generated = generateEd25519KeyPems();
    mkdirSync(this.keysDir, { recursive: true });
    writeFileSync(privateKeyPath, generated.privateKeyPem, { mode: 0o600 });
    // mode 参数仅对新建文件生效：显式 chmod 兜住权限漂移
    chmodSync(privateKeyPath, 0o600);
    writeFileSync(join(this.keysDir, PUBLIC_KEY_FILE), generated.publicKeyPem, {
      mode: 0o644,
    });
    this.key = this.materialFromPrivate(generated.privateKeyPem);
    return this.key;
  }

  /** 私钥 PEM → 完整物料（公钥派生 + kid 指纹；坏 PEM 硬失败） */
  private materialFromPrivate(privateKeyPem: string): AccessKeyMaterial {
    let publicKeyPem: string;
    try {
      // createPrivateKey 即 PEM 解析校验（损坏即抛）
      publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
        .export({ type: 'spki', format: 'pem' })
        .toString();
    } catch {
      throw new Error(
        `relay access 私钥不可解析：${join(this.keysDir, PRIVATE_KEY_FILE)}（损坏请删除后重启重生——重生将使全部存量 access 失效，需先确认）`,
      );
    }
    const kid = createHash('sha256')
      .update(publicKeyPem, 'utf8')
      .digest('hex')
      .slice(0, 16);
    return { privateKeyPem, publicKeyPem, kid };
  }
}
