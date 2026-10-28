// 无头端 files 模块（FA-T1，spec §3.1）：files/list|read|uploadImage
// 三端点 service 面单测（controller 薄，HTTP 面由 starter 管道保障）。
// workspace 行按 directoryPath 注入临时目录；dataRoot 构造注入隔离落盘。
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilesService } from 'src/modules/files/files.service';
import { PrismaService } from 'src/commons/database/prisma.service';

const prismaStub = {
  workspace: { findFirst: jest.fn() },
};
jest.mock('src/commons/database/prisma.service', () => ({
  PrismaService: jest.fn(() => prismaStub),
}));

const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'files-svc-'));
process.env.TIANSHU_DATA_ROOT = dataRoot;
// dataRoot 经环境变量注入（Nest DI 不解析普通构造参——服务同口径）
const svc = () => new FilesService(prismaStub as never);

function bindWorkspace(directoryPath: string | null) {
  prismaStub.workspace.findFirst.mockResolvedValue(
    directoryPath ? { id: 1, directoryPath, userId: null } : null,
  );
}

describe('FilesService', () => {
  it('list：directoryPath 相对路径清单（排除口径走 core 共享函数）', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'files-list-'));
    writeFileSync(path.join(root, 'a.ts'), 'x');
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'sub', 'b.md'), 'y');
    bindWorkspace(root);
    expect(await svc().list(1)).toEqual(['a.ts', 'sub/b.md']);
  });

  it('list：workspace 不存在或未绑目录 → FILES_NO_WORKSPACE', async () => {
    bindWorkspace(null);
    await expect(svc().list(99)).rejects.toThrow('未绑定工作空间目录');
    prismaStub.workspace.findFirst.mockResolvedValue(null);
    await expect(svc().list(1)).rejects.toThrow('未绑定工作空间目录');
  });

  it('read：文本 ok；越界路径拒 FILES_PATH_ESCAPE；守卫拒绝原样透 reason', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'files-read-'));
    writeFileSync(path.join(root, 't.txt'), 'hi');
    bindWorkspace(root);
    expect(await svc().read(1, 't.txt')).toEqual({ content: 'hi' });
    await expect(svc().read(1, '../../etc/passwd')).rejects.toThrow('路径越界');
    const bin = path.join(root, 'b.bin');
    writeFileSync(bin, Buffer.from([0x01, 0x00]));
    await expect(svc().read(1, 'b.bin')).rejects.toThrow('二进制文件');
    await expect(svc().read(1, 'none.txt')).rejects.toThrow('读取失败');
  });

  it('uploadImage：base64 落数据根 attachments/，返回相对路径且盘上可读', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'files-up-'));
    bindWorkspace(root);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await svc().uploadImage({
      workspaceId: 1,
      name: 'p.png',
      base64: bytes.toString('base64'),
    });
    expect(result.imagePath).toMatch(/^attachments\//);
    expect(result.imagePath).toMatch(/^attachments\/[^/]+\/p.png$/);
    const abs = path.join(dataRoot, result.imagePath);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs)).toEqual(bytes);
  });

  it('uploadImage：超 3MB 拒 FILES_IMAGE_TOO_LARGE', async () => {
    bindWorkspace('/tmp');
    const big = Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64');
    await expect(
      svc().uploadImage({ workspaceId: 1, name: 'p.png', base64: big }),
    ).rejects.toThrow('图片超过 3MB 上限');
  });

  it('uploadImage：name 归一（路径分隔剥离，防目录逃逸）', async () => {
    bindWorkspace('/tmp');
    const result = await svc().uploadImage({
      workspaceId: 1,
      name: '../../evil.png',
      base64: Buffer.from('x').toString('base64'),
    });
    expect(result.imagePath).not.toContain('..');
    // 目录化命名（冲突隔离）：attachments/<唯一目录>/<剥路径后的名>
    expect(result.imagePath).toMatch(/^attachments\/[^/]+\/evil\.png$/);
  });
});
