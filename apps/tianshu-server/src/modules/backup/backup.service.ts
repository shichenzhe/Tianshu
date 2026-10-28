/**
 * 备份服务（spec 2026-10-27 §2）：桌面端全量备份六端点业务面——
 * create 建档（服务端生成 uuid 恒新档）→ putChunk 连续 seq 追加落盘
 * （块 sha256 终验，坏块可原块重传）→ commit 整包 size+sha256 双终验
 * 后 .part rename 定稿 + 保留策略裁最旧。产物落 <备份根>/<id>/
 * （meta.json + data.tar.gz[.part]）；cursor（id→已收块游标）为进程
 * 内存态——server 单进程，重启后 uploading 档重新 create 新档即可。
 * owner 隔离（spec 2026-10-28）：identity 贯穿六方法——client 仅见/操作
 * 名下档（非己档一律 NOT_FOUND 防存在性探测），admin 全量；存量无
 * owner 旧档读取期兜底 BACKUP_ADMIN_OWNER；保留策略按 owner 分组各裁。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/commons/database/prisma.service';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { resolveBackupRoot } from './backup-root';
import type { BackupIdentity } from './backup.guard';
import {
  BACKUP_ADMIN_OWNER,
  BACKUP_CHUNK_BYTES,
  DEFAULT_BACKUP_MAX_KEEP,
  DEFAULT_BACKUP_MAX_SIZE_BYTES,
  type BackupCreateRequest,
  type BackupChunkRequest,
  type BackupCommitResult,
  type BackupDeleteResult,
  type BackupDownloadRequest,
  type BackupDownloadResult,
  type BackupListResult,
  type BackupMeta,
  type BackupViewer,
} from '@tianshu/protocol';

@Injectable()
export class BackupService {
  /** 已收块游标（id → 期望下一 seq） */
  private readonly cursor = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  private dir(id: string) {
    return path.join(resolveBackupRoot(), id);
  }
  private partPath(id: string) {
    return path.join(this.dir(id), 'data.tar.gz.part');
  }
  private metaPath(id: string) {
    return path.join(this.dir(id), 'meta.json');
  }

  /** identity → 归属 owner：admin 落管理员占位；client 落其 clientId
   *  （guard 保证 client 必带 clientId，非空断言成立） */
  private ownerOf(identity: BackupIdentity): string {
    return identity.kind === 'admin' ? BACKUP_ADMIN_OWNER : identity.clientId!;
  }

  /** 归属校验：client 仅可操作名下档——非己档一律 NOT_FOUND 而非 403
   *  （档 id 是否存在本身不外泄，防存在性探测）；admin 不受限 */
  private assertOwner(meta: BackupMeta, identity: BackupIdentity): void {
    if (identity.kind === 'client' && meta.owner !== identity.clientId) {
      throw new BusinessException('备份不存在', 'BACKUP_NOT_FOUND');
    }
  }

  /** 建档：uuid 服务端生成恒新档，客户端仅持返回 id 引用（同设备断点
   *  续传=同 meta 再 create 新 id，旧 uploading 档由保留策略/手动清） */
  async create(
    req: BackupCreateRequest,
    identity: BackupIdentity,
  ): Promise<{ id: string }> {
    if (req.fileSize > DEFAULT_BACKUP_MAX_SIZE_BYTES) {
      throw new BusinessException('备份超过 2GB 上限', 'BACKUP_TOO_LARGE');
    }
    // 零块档在 commit 会过「cursor===chunkCount」校验后裸 ENOENT——入口拒
    if (req.chunkCount < 1) {
      throw new BusinessException('分块数至少为 1', 'BACKUP_BAD_SEQ');
    }
    const id = randomUUID();
    mkdirSync(this.dir(id), { recursive: true });
    // 显式挑选字段落 meta（非 spread req）——owner 一律自 identity 注入，
    // 客户端自报 owner 等多余字段不透传落盘（spread 穿透已关）
    const meta: BackupMeta = {
      id,
      createdAt: new Date().toISOString(),
      status: 'uploading',
      appVersion: req.appVersion,
      schemaVersion: req.schemaVersion,
      fileSize: req.fileSize,
      sha256: req.sha256,
      chunkCount: req.chunkCount,
      ...(req.note !== undefined ? { note: req.note } : {}),
      ...(req.deviceName !== undefined ? { deviceName: req.deviceName } : {}),
      owner: this.ownerOf(identity),
    };
    writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2));
    this.cursor.set(id, 0);
    return { id };
  }

  async putChunk(
    req: BackupChunkRequest,
    identity: BackupIdentity,
  ): Promise<{ received: number }> {
    const meta = this.readMeta(req.id); // 未知 id → BACKUP_NOT_FOUND（防裸 ENOENT 500）
    this.assertOwner(meta, identity); // 他人 uploading 档同拒（归属先于状态）
    if (meta.status !== 'uploading') {
      throw new BusinessException('备份状态不允许该操作', 'BACKUP_BAD_STATE');
    }
    const expect = this.cursor.get(req.id) ?? 0;
    if (req.seq !== expect) {
      throw new BusinessException('分块序号不连续', 'BACKUP_BAD_SEQ');
    }
    const buf = Buffer.from(req.data, 'base64');
    // 超限用 TOO_LARGE 而非 CHUNK_HASH——hash 语义=可重传本块，超限重传
    // 永不成功会把客户端锁进重传死循环
    if (buf.length > BACKUP_CHUNK_BYTES) {
      throw new BusinessException('分块超过 4MB 上限', 'BACKUP_TOO_LARGE');
    }
    if (createHash('sha256').update(buf).digest('hex') !== req.chunkSha256) {
      throw new BusinessException('分块 sha256 不符', 'BACKUP_CHUNK_HASH');
    }
    // 追加写（测试/生产同态）
    appendFileSync(this.partPath(req.id), buf);
    this.cursor.set(req.id, req.seq + 1);
    return { received: req.seq };
  }

  async commit(
    id: string,
    identity: BackupIdentity,
  ): Promise<BackupCommitResult> {
    const meta = this.readMeta(id);
    this.assertOwner(meta, identity);
    if (meta.status !== 'uploading') {
      throw new BusinessException('备份状态不允许该操作', 'BACKUP_BAD_STATE');
    }
    if ((this.cursor.get(id) ?? 0) !== meta.chunkCount) {
      throw new BusinessException('分块未收齐', 'BACKUP_BAD_SEQ');
    }
    const part = this.partPath(id);
    const size = statSync(part).size;
    if (size !== meta.fileSize) {
      throw new BusinessException('整包大小不符', 'BACKUP_HASH_MISMATCH');
    }
    // 流式哈希：readFileSync 整读 2GB 上限包会撑爆容器内存 + 阻塞事件
    // 循环；createReadStream 增量喂 hash 分片消化
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(part)) {
      hash.update(chunk);
    }
    const digest = hash.digest('hex');
    if (digest !== meta.sha256) {
      throw new BusinessException('整包 sha256 不符', 'BACKUP_HASH_MISMATCH');
    }
    renameSync(part, path.join(this.dir(id), 'data.tar.gz'));
    const ready: BackupMeta = { ...meta, status: 'ready' };
    writeFileSync(this.metaPath(id), JSON.stringify(ready, null, 2));
    this.cursor.delete(id);
    await this.trimOldBackups();
    return { fileSize: ready.fileSize, sha256: ready.sha256 };
  }

  async list(identity: BackupIdentity): Promise<BackupListResult> {
    const root = resolveBackupRoot();
    const ids = existsSync(root)
      ? readdirSync(root).filter((d) => existsSync(this.metaPath(d)))
      : [];
    const all = ids
      .map((id) => {
        try {
          return this.readMeta(id);
        } catch {
          return null; // 坏 meta.json 跳过（防单坏档卡死 list→trim→commit 链）
        }
      })
      .filter((m): m is BackupMeta => m !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // client 仅见名下档；admin 全量（owner 隔离主面）
    const backups =
      identity.kind === 'client'
        ? all.filter((m) => m.owner === identity.clientId)
        : all;
    const viewer: BackupViewer =
      identity.kind === 'client'
        ? { kind: 'client', clientId: identity.clientId }
        : { kind: 'admin' };
    return { backups, viewer };
  }

  async download(
    req: BackupDownloadRequest,
    identity: BackupIdentity,
  ): Promise<BackupDownloadResult> {
    const meta = this.readMeta(req.id);
    this.assertOwner(meta, identity);
    if (meta.status !== 'ready') {
      throw new BusinessException('备份尚未定稿', 'BACKUP_BAD_STATE');
    }
    // seq 越界不设守卫会让 createReadStream 构造即抛 ERR_OUT_OF_RANGE 裸 500
    if (req.seq < 0 || req.seq >= meta.chunkCount) {
      throw new BusinessException('分块序号越界', 'BACKUP_BAD_SEQ');
    }
    const fd = createReadStream(path.join(this.dir(req.id), 'data.tar.gz'), {
      start: req.seq * BACKUP_CHUNK_BYTES,
      end: Math.min((req.seq + 1) * BACKUP_CHUNK_BYTES, meta.fileSize) - 1,
    });
    const chunks: Buffer[] = [];
    for await (const c of fd) chunks.push(c as Buffer);
    return {
      data: Buffer.concat(chunks).toString('base64'),
      totalChunks: meta.chunkCount,
    };
  }

  async remove(
    id: string,
    identity: BackupIdentity,
  ): Promise<BackupDeleteResult> {
    const meta = this.readMeta(id); // 未知 id → BACKUP_NOT_FOUND
    this.assertOwner(meta, identity);
    rmSync(this.dir(id), { recursive: true, force: true });
    this.cursor.delete(id);
    return { deleted: true };
  }

  /** 保留策略：各 owner 独立计数，超 maxKeep 删组内最旧（option 表
   *  app/backupMaxKeep，坏值回落默认）——某 owner 满额被裁不波及其他
   *  owner 的档；取全量用 admin 视角（组内序即全局 createdAt 新旧序） */
  private async trimOldBackups(): Promise<void> {
    const row = await this.prisma.option.findUnique({
      where: { type_name: { type: 'app', name: 'backupMaxKeep' } },
    });
    const maxKeep = Math.max(
      1,
      Number.parseInt(row?.value ?? '', 10) || DEFAULT_BACKUP_MAX_KEEP,
    );
    const ready = (await this.list({ kind: 'admin' })).backups.filter(
      (b) => b.status === 'ready',
    );
    const byOwner = new Map<string, BackupMeta[]>();
    for (const meta of ready) {
      const group = byOwner.get(meta.owner) ?? [];
      group.push(meta);
      byOwner.set(meta.owner, group);
    }
    for (const group of byOwner.values()) {
      for (const victim of group.slice(maxKeep)) {
        rmSync(this.dir(victim.id), { recursive: true, force: true });
      }
    }
  }

  private readMeta(id: string): BackupMeta {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !existsSync(this.metaPath(id))) {
      throw new BusinessException('备份不存在', 'BACKUP_NOT_FOUND');
    }
    const meta = JSON.parse(readFileSync(this.metaPath(id), 'utf8')) as Omit<
      BackupMeta,
      'owner'
    > & { owner?: string };
    // 存量旧档（owner 引入前落盘）读取期兜底管理员归属——不回写盘，
    // 待该档下次定稿等自然落盘时才固化
    return { ...meta, owner: meta.owner ?? BACKUP_ADMIN_OWNER };
  }
}
