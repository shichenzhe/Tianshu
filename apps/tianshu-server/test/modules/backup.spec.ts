// 无头端 backup 模块（spec 2026-10-27 §2）：create/chunk/commit/list/
// download/delete service 面单测（controller 薄，HTTP 面由 starter 管道保障）。
// 全程复用同一 service 实例——cursor（已收块游标）是实例内状态，每次
// 新建实例会丢分块进度；备份根经 TIANSHU_BACKUP_DIR 指临时目录注入。
// owner 隔离（spec 2026-10-28）：identity 贯穿六方法——既有用例以
// IDENTITY_ADMIN 走原语义，追加用例组覆盖 client 视图/归属校验/trim 分组。
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupService } from 'src/modules/backup/backup.service';
import { BACKUP_ADMIN_OWNER } from '@tianshu/protocol';

const prismaStub = {
  option: { findUnique: jest.fn(), upsert: jest.fn() },
};
jest.mock('src/commons/database/prisma.service', () => ({
  PrismaService: jest.fn(() => prismaStub),
}));

// 备份根注入：TIANSHU_BACKUP_DIR 指临时目录（容器卷映射同口径）
const backupRoot = mkdtempSync(path.join(os.tmpdir(), 'backup-svc-'));
process.env.TIANSHU_BACKUP_DIR = backupRoot;
delete process.env.TIANSHU_DATA_ROOT;
prismaStub.option.findUnique.mockResolvedValue(null); // maxKeep 走默认 10

const service = new BackupService(prismaStub as never);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const IDENTITY_ADMIN = { kind: 'admin' } as const;
const IDENTITY_A = { kind: 'client', clientId: 'client-a' } as const;
const IDENTITY_B = { kind: 'client', clientId: 'client-b' } as const;

describe('BackupService', () => {
  const payload = Buffer.alloc(5 * 1024 * 1024, 7); // 5MB → 2 块
  const chunks = [
    payload.subarray(0, 4 * 1024 * 1024),
    payload.subarray(4 * 1024 * 1024),
  ];

  it('create→chunks→commit 全链路：终验落盘 + meta 定稿', async () => {
    const { id } = await service.create(
      {
        appVersion: '1.0.0',
        schemaVersion: 1,
        fileSize: payload.length,
        sha256: sha256(payload),
        chunkCount: 2,
      },
      IDENTITY_ADMIN,
    );
    expect(id).toBeTruthy();
    // admin 上下文建档落管理员占位归属（ownerOf admin 分支首次直接断言
    // ——T4 审查收口：ownerOf admin 分支此前仅经旧档兜底间接触达）
    expect(
      (await service.list(IDENTITY_ADMIN)).backups.find((b) => b.id === id)
        ?.owner,
    ).toBe(BACKUP_ADMIN_OWNER);
    for (let seq = 0; seq < 2; seq++) {
      await service.putChunk(
        {
          id,
          seq,
          data: chunks[seq].toString('base64'),
          chunkSha256: sha256(chunks[seq]),
        },
        IDENTITY_ADMIN,
      );
    }
    const committed = await service.commit(id, IDENTITY_ADMIN);
    expect(committed.fileSize).toBe(payload.length);
    expect(committed.sha256).toBe(sha256(payload));
    // 落盘对拍
    const onDisk = readFileSync(path.join(backupRoot, id, 'data.tar.gz'));
    expect(onDisk.equals(payload)).toBe(true);
    expect(existsSync(path.join(backupRoot, id, 'meta.json'))).toBe(true);
  });

  it('seq 跳号拒绝 BACKUP_BAD_SEQ', async () => {
    const { id } = await service.create(
      {
        appVersion: '1',
        schemaVersion: 1,
        fileSize: 10,
        sha256: '0'.repeat(64),
        chunkCount: 2,
      },
      IDENTITY_ADMIN,
    );
    await service.putChunk(
      {
        id,
        seq: 0,
        data: Buffer.from('a').toString('base64'),
        chunkSha256: sha256(Buffer.from('a')),
      },
      IDENTITY_ADMIN,
    );
    await expect(
      service.putChunk(
        {
          id,
          seq: 2,
          data: 'YQ==',
          chunkSha256: sha256(Buffer.from('a')),
        },
        IDENTITY_ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'BACKUP_BAD_SEQ' });
  });

  it('块 hash 不符拒绝 BACKUP_CHUNK_HASH（可重传本块）', async () => {
    const { id } = await service.create(
      {
        appVersion: '1',
        schemaVersion: 1,
        fileSize: 1,
        sha256: '0'.repeat(64),
        chunkCount: 1,
      },
      IDENTITY_ADMIN,
    );
    await expect(
      service.putChunk(
        {
          id,
          seq: 0,
          data: 'YQ==',
          chunkSha256: 'f'.repeat(64),
        },
        IDENTITY_ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'BACKUP_CHUNK_HASH' });
  });

  it('整包 sha256 不符 commit 拒绝 BACKUP_HASH_MISMATCH', async () => {
    const buf = Buffer.from('hello');
    const { id } = await service.create(
      {
        appVersion: '1',
        schemaVersion: 1,
        fileSize: 5,
        sha256: 'd'.repeat(64),
        chunkCount: 1,
      },
      IDENTITY_ADMIN,
    );
    await service.putChunk(
      {
        id,
        seq: 0,
        data: buf.toString('base64'),
        chunkSha256: sha256(buf),
      },
      IDENTITY_ADMIN,
    );
    await expect(service.commit(id, IDENTITY_ADMIN)).rejects.toMatchObject({
      code: 'BACKUP_HASH_MISMATCH',
    });
  });

  it('超单备份上限拒绝 BACKUP_TOO_LARGE', async () => {
    await expect(
      service.create(
        {
          appVersion: '1',
          schemaVersion: 1,
          fileSize: 3 * 1024 * 1024 * 1024,
          sha256: '0'.repeat(64),
          chunkCount: 1,
        },
        IDENTITY_ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'BACKUP_TOO_LARGE' });
  });

  it('download 分块下行：块大小对齐上行 + totalChunks', async () => {
    const list = await service.list(IDENTITY_ADMIN);
    const ready = list.backups.find((b) => b.status === 'ready');
    expect(ready).toBeTruthy();
    const r = await service.download({ id: ready!.id, seq: 0 }, IDENTITY_ADMIN);
    expect(r.totalChunks).toBe(2);
    expect(Buffer.from(r.data, 'base64').equals(chunks[0])).toBe(true);
  });

  it('uploading 态档 list 可见且可 delete', async () => {
    const { id } = await service.create(
      {
        appVersion: '1',
        schemaVersion: 1,
        fileSize: 1,
        sha256: '0'.repeat(64),
        chunkCount: 1,
      },
      IDENTITY_ADMIN,
    );
    const seen = (await service.list(IDENTITY_ADMIN)).backups.find(
      (b) => b.id === id,
    );
    expect(seen?.status).toBe('uploading');
    await service.remove(id, IDENTITY_ADMIN);
    const after = (await service.list(IDENTITY_ADMIN)).backups.find(
      (b) => b.id === id,
    );
    expect(after).toBeUndefined();
    expect(existsSync(path.join(backupRoot, id))).toBe(false);
  });

  it('delete 后 list 不见 + 目录移除', async () => {
    const list0 = await service.list(IDENTITY_ADMIN);
    const target = list0.backups.find((b) => b.status === 'ready')!;
    await service.remove(target.id, IDENTITY_ADMIN);
    const list1 = await service.list(IDENTITY_ADMIN);
    expect(list1.backups.find((b) => b.id === target.id)).toBeUndefined();
    expect(existsSync(path.join(backupRoot, target.id))).toBe(false);
  });

  it('未知 id 报 BACKUP_NOT_FOUND', async () => {
    await expect(service.remove('nope', IDENTITY_ADMIN)).rejects.toMatchObject({
      code: 'BACKUP_NOT_FOUND',
    });
  });

  it('保留策略：maxKeep=2 时 commit 定稿裁最旧', async () => {
    prismaStub.option.findUnique.mockResolvedValue({ value: '2' });
    const mk = async (tag: string) => {
      // createdAt 毫秒精度：错峰防排序平局（trim 以 createdAt 定新旧）
      await new Promise((r) => setTimeout(r, 2));
      const buf = Buffer.from(tag);
      const { id } = await service.create(
        {
          appVersion: '1',
          schemaVersion: 1,
          fileSize: buf.length,
          sha256: sha256(buf),
          chunkCount: 1,
        },
        IDENTITY_ADMIN,
      );
      await service.putChunk(
        {
          id,
          seq: 0,
          data: buf.toString('base64'),
          chunkSha256: sha256(buf),
        },
        IDENTITY_ADMIN,
      );
      await service.commit(id, IDENTITY_ADMIN);
      return id;
    };
    const ids = [await mk('a'), await mk('b'), await mk('c')];
    // 早前用例遗留的 uploading 档不参与保留裁剪——只看 ready
    const ready = (await service.list(IDENTITY_ADMIN)).backups.filter(
      (b) => b.status === 'ready',
    );
    expect(ready).toHaveLength(2);
    expect(ready.find((b) => b.id === ids[0])).toBeUndefined();
    prismaStub.option.findUnique.mockResolvedValue(null);
  });

  it('create chunkCount=0 拒绝 BACKUP_BAD_SEQ（防零块 commit 裸 ENOENT）', async () => {
    await expect(
      service.create(
        {
          appVersion: '1',
          schemaVersion: 1,
          fileSize: 0,
          sha256: '0'.repeat(64),
          chunkCount: 0,
        },
        IDENTITY_ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'BACKUP_BAD_SEQ' });
  });

  it('download seq 越界（负 seq / seq >= chunkCount）拒绝 BACKUP_BAD_SEQ', async () => {
    const ready = (await service.list(IDENTITY_ADMIN)).backups.find(
      (b) => b.status === 'ready',
    );
    expect(ready).toBeTruthy();
    await expect(
      service.download(
        { id: ready!.id, seq: ready!.chunkCount },
        IDENTITY_ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'BACKUP_BAD_SEQ' });
    await expect(
      service.download({ id: ready!.id, seq: -1 }, IDENTITY_ADMIN),
    ).rejects.toMatchObject({ code: 'BACKUP_BAD_SEQ' });
  });

  it('BACKUP_BAD_STATE：commit 二次调用 / putChunk 对 ready 档 / download 未定稿档', async () => {
    const buf = Buffer.from('state');
    const { id } = await service.create(
      {
        appVersion: '1',
        schemaVersion: 1,
        fileSize: buf.length,
        sha256: sha256(buf),
        chunkCount: 1,
      },
      IDENTITY_ADMIN,
    );
    // 未定稿档 download 先拒（状态检查先于 seq 守卫）
    await expect(
      service.download({ id, seq: 0 }, IDENTITY_ADMIN),
    ).rejects.toMatchObject({ code: 'BACKUP_BAD_STATE' });
    await service.putChunk(
      {
        id,
        seq: 0,
        data: buf.toString('base64'),
        chunkSha256: sha256(buf),
      },
      IDENTITY_ADMIN,
    );
    await service.commit(id, IDENTITY_ADMIN);
    await expect(service.commit(id, IDENTITY_ADMIN)).rejects.toMatchObject({
      code: 'BACKUP_BAD_STATE',
    });
    await expect(
      service.putChunk(
        {
          id,
          seq: 1,
          data: buf.toString('base64'),
          chunkSha256: sha256(buf),
        },
        IDENTITY_ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'BACKUP_BAD_STATE' });
  });

  it('分块超 4MB 拒 BACKUP_TOO_LARGE（超限≠hash，重传不可恢复）', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1);
    const { id } = await service.create(
      {
        appVersion: '1',
        schemaVersion: 1,
        fileSize: big.length,
        sha256: sha256(big),
        chunkCount: 2,
      },
      IDENTITY_ADMIN,
    );
    // hash 本身算对——命中的一定是超限分支而非 hash 分支
    await expect(
      service.putChunk(
        {
          id,
          seq: 0,
          data: big.toString('base64'),
          chunkSha256: sha256(big),
        },
        IDENTITY_ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'BACKUP_TOO_LARGE' });
  });

  it('坏 meta.json 档被 list 跳过（不抛、不卡 trim 链）', async () => {
    const badId = '0'.repeat(36); // uuid 形名，meta 内容坏
    mkdirSync(path.join(backupRoot, badId), { recursive: true });
    writeFileSync(path.join(backupRoot, badId, 'meta.json'), '{oops');
    const list = await service.list(IDENTITY_ADMIN); // 坏档不炸 list
    expect(list.backups.find((b) => b.id === badId)).toBeUndefined();
    expect(list.backups.length).toBeGreaterThan(0); // 好档不受牵连
    // trim（经 commit 触发）遇坏档不卡死，commit 正常定稿
    const buf = Buffer.from('after-bad');
    const { id } = await service.create(
      {
        appVersion: '1',
        schemaVersion: 1,
        fileSize: buf.length,
        sha256: sha256(buf),
        chunkCount: 1,
      },
      IDENTITY_ADMIN,
    );
    await service.putChunk(
      {
        id,
        seq: 0,
        data: buf.toString('base64'),
        chunkSha256: sha256(buf),
      },
      IDENTITY_ADMIN,
    );
    await expect(service.commit(id, IDENTITY_ADMIN)).resolves.toBeTruthy();
  });
});

describe('BackupService owner 隔离', () => {
  async function makeReadyBackup(owner: string): Promise<string> {
    const buf = Buffer.from(`payload-${owner}`);
    const { id } = await service.create(
      {
        appVersion: '1',
        schemaVersion: 1,
        fileSize: buf.length,
        sha256: sha256(buf),
        chunkCount: 1,
        note: owner,
      },
      { kind: 'client', clientId: owner },
    );
    await service.putChunk(
      {
        id,
        seq: 0,
        data: buf.toString('base64'),
        chunkSha256: sha256(buf),
      },
      { kind: 'client', clientId: owner },
    );
    await service.commit(id, { kind: 'client', clientId: owner });
    return id;
  }

  it('create：owner 随 identity 注入 meta（自报 owner 字段被忽略）', async () => {
    const buf = Buffer.from('x');
    const { id } = await service.create(
      {
        appVersion: '1',
        schemaVersion: 1,
        fileSize: 1,
        sha256: sha256(buf),
        chunkCount: 1,
        // 自报 owner 不透传——服务端显式挑选字段落 meta（spread 穿透已关）
        owner: 'spoofed-owner',
      } as never,
      IDENTITY_A,
    );
    const meta = (await service.list(IDENTITY_A)).backups.find(
      (b) => b.id === id,
    );
    expect(meta?.owner).toBe('client-a');
    // 落盘 meta 同口径：自报 owner 值不透传落盘
    const onDisk = JSON.parse(
      readFileSync(path.join(backupRoot, id, 'meta.json'), 'utf8'),
    );
    expect(onDisk.owner).toBe('client-a');
  });

  it('list：客户端仅见自己 + viewer 回显；admin 全量', async () => {
    await makeReadyBackup('client-a');
    await makeReadyBackup('client-b');
    const a = await service.list(IDENTITY_A);
    expect(a.backups.every((b) => b.owner === 'client-a')).toBe(true);
    expect(a.viewer).toEqual({ kind: 'client', clientId: 'client-a' });
    const admin = await service.list(IDENTITY_ADMIN);
    expect(admin.backups.map((b) => b.owner)).toEqual(
      expect.arrayContaining(['client-a', 'client-b']),
    );
    expect(admin.viewer).toEqual({ kind: 'admin' });
  });

  it('download/remove：他人档 BACKUP_NOT_FOUND（防存在性探测）', async () => {
    const id = await makeReadyBackup('client-a');
    await expect(
      service.download({ id, seq: 0 }, IDENTITY_B),
    ).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
    await expect(service.remove(id, IDENTITY_B)).rejects.toMatchObject({
      code: 'BACKUP_NOT_FOUND',
    });
    // 档还在（B 的尝试不动 A 的数据）
    await expect(
      service.download({ id, seq: 0 }, IDENTITY_A),
    ).resolves.toBeTruthy();
  });

  it('putChunk/commit：client 对他人 uploading 档 NOT_FOUND；admin 可操作任意', async () => {
    const buf = Buffer.from('y');
    const { id } = await service.create(
      {
        appVersion: '1',
        schemaVersion: 1,
        fileSize: 1,
        sha256: sha256(buf),
        chunkCount: 1,
      },
      IDENTITY_A,
    );
    await expect(
      service.putChunk(
        { id, seq: 0, data: 'YQ==', chunkSha256: sha256(Buffer.from('a')) },
        IDENTITY_B,
      ),
    ).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
    await expect(service.commit(id, IDENTITY_B)).rejects.toMatchObject({
      code: 'BACKUP_NOT_FOUND',
    });
    // admin 不受归属限制：代管收块并定稿（块=meta 声明的 y 载荷）
    await service.putChunk(
      {
        id,
        seq: 0,
        data: buf.toString('base64'),
        chunkSha256: sha256(buf),
      },
      IDENTITY_ADMIN,
    );
    await expect(service.commit(id, IDENTITY_ADMIN)).resolves.toBeTruthy();
  });

  it('旧档兜底 __admin__：手写无 owner meta.json 读取期补齐，admin 可见', async () => {
    // 手工落一份无 owner 的旧档（照 backup-root 结构）——存量档（owner
    // 引入前落盘）读取期兜底管理员归属：admin 全量可见；client 因 owner
    // 非己不可见；且兜底只在读取期（盘上 meta 不被回写）
    const legacyId = '1'.repeat(36); // uuid 形名（readMeta 形状校验）
    mkdirSync(path.join(backupRoot, legacyId), { recursive: true });
    const legacyMetaPath = path.join(backupRoot, legacyId, 'meta.json');
    writeFileSync(
      legacyMetaPath,
      JSON.stringify({
        id: legacyId,
        createdAt: new Date().toISOString(),
        appVersion: '1',
        schemaVersion: 1,
        fileSize: 3,
        sha256: '0'.repeat(64),
        chunkCount: 1,
        status: 'ready',
      }),
    );
    const admin = await service.list(IDENTITY_ADMIN);
    expect(admin.backups.find((b) => b.id === legacyId)?.owner).toBe(
      BACKUP_ADMIN_OWNER,
    );
    const clientView = await service.list(IDENTITY_A);
    expect(clientView.backups.find((b) => b.id === legacyId)).toBeUndefined();
    // 读取期兜底不回写——盘上 meta 仍无 owner 字段
    expect(JSON.parse(readFileSync(legacyMetaPath, 'utf8')).owner).toBe(
      undefined,
    );
  });

  it('保留策略按 owner 分组：A 满额被裁不影响 B 的档', async () => {
    // 本组三次 commit 均需命中 maxKeep=1（mockResolvedValueOnce 仅首次
    // 生效），改设基实现并于用例尾恢复（既有保留策略用例同款）
    prismaStub.option.findUnique.mockResolvedValue({ value: '1' });
    await makeReadyBackup('client-a');
    await makeReadyBackup('client-a'); // A 第二档裁掉第一档
    const bId = await makeReadyBackup('client-b'); // B 唯一档保留
    const a = await service.list(IDENTITY_A);
    // 早前用例遗留的 uploading 档不参与保留裁剪——只看 ready
    expect(a.backups.filter((b) => b.status === 'ready')).toHaveLength(1);
    const b = await service.list(IDENTITY_B);
    expect(b.backups.map((x) => x.id)).toContain(bId);
    prismaStub.option.findUnique.mockResolvedValue(null);
  });
});
