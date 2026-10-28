/**
 * 备份多用户注册表（spec 2026-10-28）：客户端设备与邀请码两账本落
 * option 表（type='app'，JSON 数列整存）；claimInvite 核销+注册一步
 * 原子——单进程 serialized 互斥串行读改写（backup.service cursor Map
 * 同先例）。clientToken 明文仅 claim 返回一次，落库仅 sha256 hash。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/commons/database/prisma.service';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import {
  BACKUP_CLIENT_NAME_TAKEN,
  BACKUP_INVITE_ALPHABET,
  BACKUP_INVITE_INVALID,
  BACKUP_INVITE_LENGTH,
  BACKUP_INVITE_PREFIX,
  type BackupClaimResult,
  type BackupClientRecord,
  type BackupCreateInvitesResult,
  type BackupInviteRecord,
} from '@tianshu/protocol';

const CLIENTS_KEY = { type: 'app', name: 'backupClients' } as const;
const INVITES_KEY = { type: 'app', name: 'backupInvites' } as const;

const logger = new Logger('BackupRegistry');

/** 落库形态的客户端行（含 tokenHash，listClients 永不外吐） */
export interface StoredBackupClient {
  clientId: string;
  tokenHash: string;
  createdAt: string;
  invitedNote?: string;
}

/** 单进程互斥：claim/create/remove 的读改写全程串行（server 单进程——
 *  backup.service cursor Map 同先例） */
let registryLock: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = registryLock.then(fn, fn);
  registryLock = next.catch(() => undefined);
  return next;
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomInviteCode(): string {
  const bytes = randomBytes(BACKUP_INVITE_LENGTH);
  let code = '';
  for (let i = 0; i < BACKUP_INVITE_LENGTH; i++) {
    code += BACKUP_INVITE_ALPHABET[bytes[i] % BACKUP_INVITE_ALPHABET.length];
  }
  return `${BACKUP_INVITE_PREFIX}${code}`;
}

/** 空/坏 JSON 容错回落空数组（防单坏行炸全链——坏档防护同思路）；但
 *  原值非空且解析失败/非数组时 Logger.warn 留痕（终审 M4）——静默回落
 *  会在下一次写回时把全部既有行清账（如手工改库写坏 JSON），有痕才可
 *  事后追账。optionName 供日志定位是哪本账。 */
function parseRows<T>(raw: string | undefined, optionName: string): T[] {
  if (raw === undefined) return []; // 无行=新装空账，非异常不告警
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as T[];
    logger.warn(
      `option ${optionName} 值非 JSON 数组，回落空数组（下次写回将覆盖既有值，长度 ${raw.length}）：${raw.slice(0, 80)}`,
    );
    return [];
  } catch {
    logger.warn(
      `option ${optionName} 值 JSON 解析失败，回落空数组（下次写回将覆盖既有值，长度 ${raw.length}）：${raw.slice(0, 80)}`,
    );
    return [];
  }
}

@Injectable()
export class BackupRegistry {
  constructor(private readonly prisma: PrismaService) {}

  async findClientByToken(
    token: string,
  ): Promise<StoredBackupClient | undefined> {
    for (const c of await this.readClients()) {
      if (this.hashEq(token, c.tokenHash)) return c;
    }
    return undefined;
  }

  /** 核销邀请码 + 注册设备（一步原子）：clientToken 明文仅此一次返回 */
  async claimInvite(
    inviteCode: string,
    deviceName: string,
  ): Promise<BackupClaimResult> {
    return serialized(async () => {
      const invites = await this.readInvites();
      const invite = invites.find((i) => i.code === inviteCode);
      if (!invite || invite.usedAt) {
        throw new BusinessException(
          '邀请码无效或已被使用',
          BACKUP_INVITE_INVALID,
        );
      }
      const clients = await this.readClients();
      if (clients.some((c) => c.clientId === deviceName)) {
        throw new BusinessException(
          '设备名已被注册，请更换',
          BACKUP_CLIENT_NAME_TAKEN,
        );
      }
      const clientToken = randomBytes(16).toString('hex'); // 32 hex
      clients.push({
        clientId: deviceName,
        tokenHash: sha256hex(clientToken),
        createdAt: new Date().toISOString(),
        invitedNote: invite.note,
      });
      invite.usedAt = new Date().toISOString();
      invite.usedBy = deviceName;
      await this.writeClients(clients);
      await this.writeInvites(invites);
      return { clientId: deviceName, clientToken };
    });
  }

  async createInvites(
    count: number,
    note?: string,
  ): Promise<BackupCreateInvitesResult> {
    return serialized(async () => {
      const invites = await this.readInvites();
      const created: BackupInviteRecord[] = Array.from(
        { length: count },
        () => ({
          code: randomInviteCode(),
          note,
          createdAt: new Date().toISOString(),
        }),
      );
      invites.push(...created);
      await this.writeInvites(invites);
      return { invites: created };
    });
  }

  async listInvites(): Promise<BackupInviteRecord[]> {
    return this.readInvites();
  }

  /** 撤销语义含清理已用码（不拒删已用），不存在才抛 */
  async removeInvite(code: string): Promise<{ removed: true }> {
    return serialized(async () => {
      const invites = await this.readInvites();
      const rest = invites.filter((i) => i.code !== code);
      if (rest.length === invites.length) {
        throw new BusinessException('邀请码不存在', 'BACKUP_NOT_FOUND');
      }
      await this.writeInvites(rest);
      return { removed: true };
    });
  }

  /** 列表永不返回 tokenHash（敏感面收口，findClientByToken 内部专用） */
  async listClients(): Promise<BackupClientRecord[]> {
    const clients = await this.readClients();
    return clients.map(({ tokenHash: _tokenHash, ...record }) => record);
  }

  async removeClient(clientId: string): Promise<{ removed: true }> {
    return serialized(async () => {
      const clients = await this.readClients();
      const rest = clients.filter((c) => c.clientId !== clientId);
      if (rest.length === clients.length) {
        throw new BusinessException('设备不存在', 'BACKUP_NOT_FOUND');
      }
      await this.writeClients(rest);
      return { removed: true };
    });
  }

  /** 摘后 timingSafeEqual（token.guard.ts 同思路防时序侧信道）——存侧
   *  是 hash 不是明文：token 侧定长摘、存侧 hex 解码，两侧恒 32 字节，
   *  勿对存侧再摘（双摘只适用明文对明文，hash 对 hash 永假） */
  private hashEq(token: string, tokenHash: string): boolean {
    const expected = Buffer.from(tokenHash, 'hex');
    if (expected.length !== 32) return false; // 坏行防御（非 64hex 不等长）
    return timingSafeEqual(
      createHash('sha256').update(token).digest(),
      expected,
    );
  }

  private async readClients(): Promise<StoredBackupClient[]> {
    const row = await this.prisma.option.findUnique({
      where: { type_name: CLIENTS_KEY },
    });
    return parseRows<StoredBackupClient>(row?.value, CLIENTS_KEY.name);
  }

  private async writeClients(clients: StoredBackupClient[]): Promise<void> {
    await this.prisma.option.upsert({
      where: { type_name: CLIENTS_KEY },
      update: { value: JSON.stringify(clients) },
      create: {
        type: CLIENTS_KEY.type,
        name: CLIENTS_KEY.name,
        value: JSON.stringify(clients),
      },
    });
  }

  private async readInvites(): Promise<BackupInviteRecord[]> {
    const row = await this.prisma.option.findUnique({
      where: { type_name: INVITES_KEY },
    });
    return parseRows<BackupInviteRecord>(row?.value, INVITES_KEY.name);
  }

  private async writeInvites(invites: BackupInviteRecord[]): Promise<void> {
    await this.prisma.option.upsert({
      where: { type_name: INVITES_KEY },
      update: { value: JSON.stringify(invites) },
      create: {
        type: INVITES_KEY.type,
        name: INVITES_KEY.name,
        value: JSON.stringify(invites),
      },
    });
  }
}
