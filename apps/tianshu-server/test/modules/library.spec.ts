/**
 * library 批（spec 2026-10-26 §2）：资料库十七端点 service/controller
 * 用例——真 tmp 磁盘 + Prisma 内存替身（skills-tail 先例）。重点：
 * delete/move 目录级联与撞名磁盘双写、归属拒（存在性不泄露）、DTO 无
 * storagePath/originalPath 泄漏、read/readImage/writeContent 守卫边界、
 * subtreeCount 聚合、addFiles 复制入库/递归导入跳隐藏。
 */
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LibraryDiskRepository } from 'src/core/library/library-disk.repository';
import {
  LibraryService,
  toLibraryItemDto,
} from 'src/modules/library/library.service';
import { LibraryController } from 'src/modules/library/library.controller';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import type { LibraryItemDto } from '@tianshu/protocol';

let libraryRoot: string;

beforeEach(() => {
  libraryRoot = mkdtempSync(path.join(tmpdir(), 'tianshu-library-'));
});

afterEach(() => {
  rmSync(libraryRoot, { recursive: true, force: true });
});

/* ── Prisma 内存替身（libraryItem 表，覆盖 repo 用到的 where 子集）── */

type Row = Record<string, unknown> & { id: number; userId: number };

function matches(
  row: Row,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'id' && cond !== null && typeof cond === 'object') {
      const list = (cond as { in: number[] }).in;
      if (!list.includes(row.id)) return false;
      continue;
    }
    if (key === 'name' && cond !== null && typeof cond === 'object') {
      const clause = cond as { contains?: string };
      if (
        clause.contains !== undefined &&
        !String(row.name).toLowerCase().includes(clause.contains.toLowerCase())
      ) {
        return false;
      }
      continue;
    }
    if (key === 'lastViewedAt' && cond !== null && typeof cond === 'object') {
      if ((cond as { not: null }).not === null && row.lastViewedAt === null) {
        return false;
      }
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

function makePrismaDouble() {
  const rows: Row[] = [];
  let nextId = 1;
  const prisma = {
    libraryItem: {
      findMany: jest.fn(
        async (args: { where?: Record<string, unknown> }) =>
          rows.filter((row) => matches(row, args.where)) as Row[],
      ),
      findFirst: jest.fn(
        async (args: { where?: Record<string, unknown> }) =>
          (rows.find((row) => matches(row, args.where)) ?? null) as Row | null,
      ),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const now = new Date();
        const row = {
          id: nextId++,
          parentId: null,
          fileType: null,
          mimeType: null,
          size: null,
          originalPath: null,
          url: null,
          favorite: false,
          lastViewedAt: null,
          createdAt: now,
          updatedAt: now,
          ...args.data,
        } as unknown as Row;
        rows.push(row);
        return row;
      }),
      update: jest.fn(
        async (args: {
          where: { id: number };
          data: Record<string, unknown>;
        }) => {
          const row = rows.find((r) => r.id === args.where.id) as Row;
          Object.assign(row, args.data, { updatedAt: new Date() });
          return row;
        },
      ),
      deleteMany: jest.fn(async (args: { where: { id: { in: number[] } } }) => {
        const ids = new Set(args.where.id.in);
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (ids.has(rows[i].id)) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
    },
  };
  return { prisma, rows };
}

type PrismaDouble = ReturnType<typeof makePrismaDouble>['prisma'];

function makeService(prisma: PrismaDouble) {
  return new LibraryService(
    new LibraryDiskRepository(prisma as never, libraryRoot),
  );
}

/** 断言 DTO 绝不携带本机路径（storagePath/originalPath 键与根目录值） */
function expectNoPathLeak(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain('storagePath');
  expect(text).not.toContain('originalPath');
  expect(text).not.toContain(libraryRoot);
}

async function expectBiz(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(BusinessException);
  expect((error as BusinessException).code).toBe(code);
}

/* ── 元数据面：list/tree/search/创建/重命名/移动/删除/收藏 ── */

describe('LibraryService 元数据面', () => {
  it('createFolder → list 单层（folder 置前）+ 面包屑；DTO 无路径泄漏', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const folder = await svc.createFolder('文档', null);
    await svc.createFolder('笔记', null);
    await svc.createFile('a.md', folder.id);

    const root = await svc.list(null);
    expect(root.items.map((i) => i.name)).toEqual(['文档', '笔记']);
    expect(root.breadcrumbs).toEqual([]);

    const inner = await svc.list(folder.id);
    expect(inner.items.map((i) => i.name)).toEqual(['a.md']);
    expect(inner.breadcrumbs.map((b) => b.name)).toEqual(['文档']);
    expect(inner.items[0].parentId).toBe(folder.id);
    expectNoPathLeak(root);
    expectNoPathLeak(inner);
  });

  it('重名清洗与同层序号：非法字符剥离、重名加 " (2)"', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const a = await svc.createFolder('报告', null);
    const b = await svc.createFolder('报告', null);
    expect(a.name).toBe('报告');
    expect(b.name).toBe('报告 (2)');
  });

  it('createFile 落盘空文件（{root}/{id}/{name}，size 0）', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const file = await svc.createFile('新文档.md', null);
    expect(file.size).toBe(0);
    expect(file.kind).toBe('file');
    expect(file.mimeType).toBe('text/markdown');
    const onDisk = path.join(libraryRoot, String(file.id), '新文档.md');
    expect(readFileSync(onDisk, 'utf8')).toBe('');
    expectNoPathLeak(file);
  });

  it('tree 平铺全量（folder+file+link）；search 仅 file 跨层', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const folder = await svc.createFolder('资料', null);
    await svc.createFile('readme.md', folder.id);
    await svc.addLink('https://example.com/x', '示例', null);

    const tree = await svc.tree();
    expect(tree).toHaveLength(3);
    expect(tree.map((t) => t.kind).sort()).toEqual(['file', 'folder', 'link']);

    const hits = await svc.search('readme');
    expect(hits).toHaveLength(1);
    expect(hits[0].location).toEqual(['资料']);
    expect(await svc.search('资料')).toEqual([]); // folder 不参与搜索
    expect(await svc.search('   ')).toEqual([]); // 空白返空
  });

  it('addLink 仅 http(s)；标题缺省取域名', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const link = await svc.addLink('https://example.com/a', null, null);
    expect(link.name).toBe('example.com');
    expect(link.kind).toBe('link');
    const titled = await svc.addLink('http://a.com/b', '  标题  ', null);
    expect(titled.name).toBe('标题');
    await expect(svc.addLink('ftp://x.com', null, null)).rejects.toThrow(
      '链接地址无效',
    );
  });

  it('rename file：磁盘文件名同步改（storagePath 不断裂）', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const file = await svc.createFile('旧名.md', null);
    const before = path.join(libraryRoot, String(file.id), '旧名.md');
    expect(existsSync(before)).toBe(true);

    const renamed = await svc.rename(file.id, '新名.md');
    expect(renamed.name).toBe('新名.md');
    expect(existsSync(before)).toBe(false);
    expect(existsSync(path.join(libraryRoot, String(file.id), '新名.md'))).toBe(
      true,
    );
  });

  it('move 撞名 file 磁盘双写序号；folder 纯 DB', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const src = await svc.createFolder('源', null);
    const dst = await svc.createFolder('目标', null);
    const f1 = await svc.createFile('同名.md', src.id);
    const f2 = await svc.createFile('同名.md', dst.id);

    await svc.move([f1.id], dst.id);
    // 撞名 → "同名 (2).md"，磁盘文件同步改名
    const moved = (await svc.list(dst.id)).items.find(
      (i) => i.id === f1.id,
    ) as LibraryItemDto;
    expect(moved.name).toBe('同名 (2).md');
    expect(
      existsSync(path.join(libraryRoot, String(f1.id), '同名 (2).md')),
    ).toBe(true);
    expect(f2.id).not.toBe(f1.id);
  });

  it('move 循环防护：拒绝移入自身/后代；目标非 folder 拒', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const parent = await svc.createFolder('父', null);
    const child = await svc.createFolder('子', parent.id);
    await expect(svc.move([parent.id], child.id)).rejects.toThrow(
      '不能移动到自身或其子文件夹内',
    );
    const file = await svc.createFile('a.md', null);
    // file 作目标：先撞 kind 校验（与 mirror repo 判定序一致）
    await expect(svc.move([child.id], file.id)).rejects.toThrow(
      '目标必须是文件夹',
    );
  });

  it('delete 级联：子树记录全删 + 磁盘目录清盘（folder 无磁盘实体）', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const folder = await svc.createFolder('根', null);
    const sub = await svc.createFolder('子', folder.id);
    const file = await svc.createFile('deep.md', sub.id);
    const keep = await svc.createFile('keep.md', null);
    const fileDir = path.join(libraryRoot, String(file.id));
    const keepDir = path.join(libraryRoot, String(keep.id));
    expect(existsSync(fileDir)).toBe(true);

    await svc.delete([folder.id]);
    expect(await svc.tree()).toHaveLength(1);
    // folder 本身无磁盘实体（纯 DB）；后代 file 目录级联清盘
    expect(existsSync(fileDir)).toBe(false);
    expect(existsSync(keepDir)).toBe(true);
  });

  it('subtreeCount 聚合：含全部后代不含自身；他人条目不计', async () => {
    const { prisma, rows } = makePrismaDouble();
    const svc = makeService(prisma);
    const folder = await svc.createFolder('根', null);
    await svc.createFolder('a', folder.id);
    const b = await svc.createFolder('b', folder.id);
    await svc.createFile('x.md', b.id);
    // 他用户条目挂同 parentId——不构成伴生用户子树
    rows.push({
      id: 999,
      parentId: folder.id,
      name: 'other.md',
      kind: 'file',
      userId: 2,
    } as Row);

    expect(await svc.subtreeCount(folder.id)).toBe(3);
    await expect(svc.subtreeCount(999)).rejects.toThrow('条目不存在');
  });

  it('toggleFavorite/markViewed/listRecent/listFavorites 语义', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const f1 = await svc.createFile('one.md', null);
    const f2 = await svc.createFile('two.md', null);
    await svc.createFolder('文件夹不参与', null);

    const fav = await svc.toggleFavorite(f1.id);
    expect(fav.favorite).toBe(true);
    expect((await svc.listFavorites()).map((i) => i.id)).toEqual([f1.id]);

    await svc.markViewed(f2.id);
    await svc.markViewed(f1.id);
    const recent = await svc.listRecent();
    expect(recent.map((i) => i.id)).toEqual([f1.id, f2.id]); // 倒序
    expectNoPathLeak(recent);
  });

  it('归属拒：他用户条目不存在同报错（不泄露存在性）', async () => {
    const { prisma, rows } = makePrismaDouble();
    const svc = makeService(prisma);
    rows.push({
      id: 42,
      parentId: null,
      name: 'secret.md',
      kind: 'file',
      userId: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Row);
    await expect(svc.rename(42, 'x.md')).rejects.toThrow('条目不存在');
    await expect(svc.subtreeCount(42)).rejects.toThrow('条目不存在');
    // 内容面守卫：稳定码 LIBRARY_NOT_FOUND（存在性不泄露）
    await expectBiz(svc.read(42), 'LIBRARY_NOT_FOUND');
    await expectBiz(svc.readImage(42), 'LIBRARY_NOT_FOUND');
    // 元数据面：mirror 同口径——原生错误走通用信封
    await expect(svc.toggleFavorite(42)).rejects.toThrow('条目不存在');
  });
});

/* ── 内容面守卫：read / readImage / writeContent ── */

describe('LibraryService 内容面守卫', () => {
  it('read 文本 ok；folder/link 拒（LIBRARY_NOT_FILE）', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const file = await svc.createFile('a.md', null);
    writeFileSync(path.join(libraryRoot, String(file.id), 'a.md'), '你好');

    const read = await svc.read(file.id);
    expect(read).toEqual({ kind: 'text', content: '你好' });

    const folder = await svc.createFolder('d', null);
    await expectBiz(svc.read(folder.id), 'LIBRARY_NOT_FILE');
    const link = await svc.addLink('https://example.com', null, null);
    await expectBiz(svc.read(link.id), 'LIBRARY_NOT_FILE');
  });

  it('read >512KiB → LIBRARY_TOO_LARGE；NUL → LIBRARY_BINARY', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const big = await svc.createFile('big.md', null);
    writeFileSync(
      path.join(libraryRoot, String(big.id), 'big.md'),
      Buffer.alloc(512 * 1024 + 1, 65),
    );
    await expectBiz(svc.read(big.id), 'LIBRARY_TOO_LARGE');

    const bin = await svc.createFile('bin.md', null);
    writeFileSync(
      path.join(libraryRoot, String(bin.id), 'bin.md'),
      Buffer.from([0x41, 0x00, 0x42]),
    );
    await expectBiz(svc.read(bin.id), 'LIBRARY_BINARY');
  });

  it('readImage：白名单+base64、非图片 LIBRARY_BINARY、>10MB TOO_LARGE', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const png = await svc.createFile('图.png', null);
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(path.join(libraryRoot, String(png.id), '图.png'), pngBytes);
    const img = await svc.readImage(png.id);
    expect(img.mime).toBe('image/png');
    expect(img.dataBase64).toBe(pngBytes.toString('base64'));

    const txt = await svc.createFile('b.txt', null);
    await expectBiz(svc.readImage(txt.id), 'LIBRARY_BINARY');

    const huge = await svc.createFile('h.jpg', null);
    writeFileSync(
      path.join(libraryRoot, String(huge.id), 'h.jpg'),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    );
    await expectBiz(svc.readImage(huge.id), 'LIBRARY_TOO_LARGE');
  });

  it('writeContent：覆写+size 刷新；超限 TOO_LARGE；写盘失败 WRITE_FAILED', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const file = await svc.createFile('w.md', null);

    const updated = await svc.writeContent(file.id, '新内容');
    expect(updated.size).toBe(Buffer.byteLength('新内容'));
    expect(
      readFileSync(path.join(libraryRoot, String(file.id), 'w.md'), 'utf8'),
    ).toBe('新内容');
    expectNoPathLeak(updated);

    await expectBiz(
      svc.writeContent(file.id, 'x'.repeat(512 * 1024 + 1)),
      'LIBRARY_TOO_LARGE',
    );

    // 写盘失败：库目录被同名常规文件占位 → mkdir 失败
    rmSync(libraryRoot, { recursive: true, force: true });
    writeFileSync(libraryRoot, '占位');
    await expectBiz(svc.writeContent(file.id, 'y'), 'LIBRARY_WRITE_FAILED');

    const folder = await svc.createFolder('d2', null);
    await expectBiz(svc.writeContent(folder.id, 'y'), 'LIBRARY_NOT_FILE');
  });
});

/* ── 上传面：uploadFile（spec 2026-10-26 §1.3）── */

describe('LibraryService 上传面 uploadFile', () => {
  it('tmp 磁盘落盘 + 建行：{root}/{id}/{name} 内容一致、size/分类推断', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const content = '上传内容 hello';
    const item = await svc.uploadFile({
      name: '报告.txt',
      base64: Buffer.from(content, 'utf8').toString('base64'),
    });
    expect(item.kind).toBe('file');
    expect(item.name).toBe('报告.txt');
    expect(item.size).toBe(Buffer.byteLength(content, 'utf8'));
    expect(item.fileType).toBe('text');
    expect(item.mimeType).toBe('text/plain');
    expect(item.parentId).toBeNull();
    expect(
      readFileSync(path.join(libraryRoot, String(item.id), '报告.txt'), 'utf8'),
    ).toBe(content);
    expectNoPathLeak(item);
  });

  it('分类推断：png → image/image/png；pdf → pdf/application/pdf', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const b64 = Buffer.from('x').toString('base64');
    const png = await svc.uploadFile({ name: '图.png', base64: b64 });
    expect(png.fileType).toBe('image');
    expect(png.mimeType).toBe('image/png');
    const pdf = await svc.uploadFile({ name: '数据.pdf', base64: b64 });
    expect(pdf.fileType).toBe('pdf');
    expect(pdf.mimeType).toBe('application/pdf');
  });

  it('文件名清洗 + 同层重名序号（非法字符剥离、重名 " (2)"）', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const b64 = Buffer.from('x').toString('base64');
    const dirty = await svc.uploadFile({ name: 'a<b>c:d.txt', base64: b64 });
    expect(dirty.name).toBe('abcd.txt');
    const again = await svc.uploadFile({ name: 'abcd.txt', base64: b64 });
    expect(again.name).toBe('abcd (2).txt');
  });

  it('folder 内上传：parentId 落库；根目录不传 parentId', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    const folder = await svc.createFolder('收件箱', null);
    const item = await svc.uploadFile({
      name: 'in.txt',
      base64: Buffer.from('i').toString('base64'),
      parentId: folder.id,
    });
    expect(item.parentId).toBe(folder.id);
    expect(
      existsSync(path.join(libraryRoot, String(item.id), 'in.txt')),
    ).toBe(true);
  });

  it('超限拒：解码 >3MB → LIBRARY_UPLOAD_INVALID（建行前拦截）', async () => {
    const { prisma, rows } = makePrismaDouble();
    const svc = makeService(prisma);
    const big = Buffer.alloc(3 * 1024 * 1024 + 1, 65);
    await expectBiz(
      svc.uploadFile({ name: 'big.bin', base64: big.toString('base64') }),
      'LIBRARY_UPLOAD_INVALID',
    );
    expect(rows).toHaveLength(0); // 未建行
    expect(existsSync(path.join(libraryRoot, '1'))).toBe(false);
  });

  it('坏 base64 拒：非法字符/长度不对齐 → LIBRARY_UPLOAD_INVALID', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    await expectBiz(
      svc.uploadFile({ name: 'x.txt', base64: '!!!not-base64' }),
      'LIBRARY_UPLOAD_INVALID',
    );
    await expectBiz(
      svc.uploadFile({ name: 'x.txt', base64: 'abc' }), // 长度 % 4 ≠ 0
      'LIBRARY_UPLOAD_INVALID',
    );
    await expectBiz(svc.uploadFile({ name: 'x.txt', base64: '  ' }),
      'LIBRARY_UPLOAD_INVALID',
    );
  });

  it('文件名全非法：清洗后为空 → LIBRARY_UPLOAD_INVALID', async () => {
    const { prisma } = makePrismaDouble();
    const svc = makeService(prisma);
    await expectBiz(
      svc.uploadFile({ name: '???', base64: Buffer.from('x').toString('base64') }),
      'LIBRARY_UPLOAD_INVALID',
    );
  });

  it('归属拒：parentId 不存在/非 folder/他人条目 → LIBRARY_NOT_FOUND', async () => {
    const { prisma, rows } = makePrismaDouble();
    const svc = makeService(prisma);
    const b64 = Buffer.from('x').toString('base64');
    rows.push({
      id: 42,
      parentId: null,
      name: 'other.md',
      kind: 'file',
      userId: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Row);
    const file = await svc.createFile('plain.md', null);
    await expectBiz(
      svc.uploadFile({ name: 'x.txt', base64: b64, parentId: 42 }),
      'LIBRARY_NOT_FOUND',
    );
    await expectBiz(
      svc.uploadFile({ name: 'x.txt', base64: b64, parentId: 9999 }),
      'LIBRARY_NOT_FOUND',
    );
    await expectBiz(
      svc.uploadFile({ name: 'x.txt', base64: b64, parentId: file.id }),
      'LIBRARY_NOT_FOUND',
    );
  });
});

/* ── 磁盘原语（golden 移植随批守护）── */

describe('LibraryDiskRepository 磁盘原语', () => {
  it('addFiles 复制入库（非移动）：源文件仍在，{root}/{id}/{name} 内容一致', async () => {
    const { prisma } = makePrismaDouble();
    const repo = new LibraryDiskRepository(prisma as never, libraryRoot);
    const srcDir = mkdtempSync(path.join(tmpdir(), 'tianshu-src-'));
    try {
      const src = path.join(srcDir, '原始.md');
      writeFileSync(src, '原始内容');
      const result = await repo.addFiles([src], null, 1);
      expect(result.failed).toEqual([]);
      expect(result.added).toHaveLength(1);
      const item = result.added[0];
      expect(existsSync(src)).toBe(true);
      expect(
        readFileSync(
          path.join(libraryRoot, String(item.id), item.name),
          'utf8',
        ),
      ).toBe('原始内容');
      expect(item.originalPath).toBe(src); // 元数据保留（DTO 层不透出）
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('importFolder 递归入库并跳过隐藏文件/目录', async () => {
    const { prisma } = makePrismaDouble();
    const repo = new LibraryDiskRepository(prisma as never, libraryRoot);
    const srcDir = mkdtempSync(path.join(tmpdir(), 'tianshu-import-'));
    try {
      writeFileSync(path.join(srcDir, '可见.md'), 'v');
      writeFileSync(path.join(srcDir, '.隐藏'), 'h');
      const sub = path.join(srcDir, '子目录');
      mkdirSync(sub);
      writeFileSync(path.join(sub, 'nested.md'), 'n');

      const result = await repo.importFolder(srcDir, null, 1);
      expect(result.failed).toEqual([]);
      const names = result.added.map((i) => i.name);
      expect(names).toContain('可见.md');
      expect(names).toContain('nested.md');
      expect(names).not.toContain('.隐藏');
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('rename DB 失败回滚磁盘名（断裂补偿）', async () => {
    const { prisma } = makePrismaDouble();
    const repo = new LibraryDiskRepository(prisma as never, libraryRoot);
    const file = await repo.createFile('a.md', null, 1);
    const update = prisma.libraryItem.update as jest.Mock;
    update.mockRejectedValueOnce(new Error('db down'));

    await expect(repo.rename(file.id, 'b.md', 1)).rejects.toThrow('db down');
    // 磁盘名已回滚——storagePath 不断裂
    expect(existsSync(path.join(libraryRoot, String(file.id), 'a.md'))).toBe(
      true,
    );
  });
});

/* ── 控制器十七端点委托 ── */

describe('LibraryController 十八端点委托', () => {
  function makeController() {
    const service = {
      list: jest.fn(async () => ({ items: [], breadcrumbs: [] })),
      tree: jest.fn(async () => []),
      search: jest.fn(async () => []),
      listRecent: jest.fn(async () => []),
      listFavorites: jest.fn(async () => []),
      createFolder: jest.fn(async () => ({})),
      createFile: jest.fn(async () => ({})),
      addLink: jest.fn(async () => ({})),
      rename: jest.fn(async () => ({})),
      move: jest.fn(async () => null),
      delete: jest.fn(async () => null),
      subtreeCount: jest.fn(async () => 0),
      toggleFavorite: jest.fn(async () => ({})),
      markViewed: jest.fn(async () => ({})),
      read: jest.fn(async () => ({ kind: 'text', content: '' })),
      readImage: jest.fn(async () => ({ mime: 'image/png', dataBase64: '' })),
      writeContent: jest.fn(async () => ({})),
      uploadFile: jest.fn(async () => ({})),
    };
    const controller = new LibraryController(service as never);
    return { controller, service };
  }

  it('list/createFolder 的 parentId 缺省归一为 null', async () => {
    const { controller, service } = makeController();
    await controller.list({});
    expect(service.list).toHaveBeenCalledWith(null);
    await controller.createFolder({ name: 'x' } as never);
    expect(service.createFolder).toHaveBeenCalledWith('x', null);
    await controller.createFolder({ name: 'x', parentId: 3 } as never);
    expect(service.createFolder).toHaveBeenCalledWith('x', 3);
  });

  it('addLink/move/delete/subtreeCount/writeContent 载荷透传', async () => {
    const { controller, service } = makeController();
    await controller.addLink({
      url: 'https://a.com',
      title: undefined,
      parentId: null,
    } as never);
    expect(service.addLink).toHaveBeenCalledWith('https://a.com', null, null);

    await controller.move({ ids: [1, 2], targetParentId: 5 } as never);
    expect(service.move).toHaveBeenCalledWith([1, 2], 5);
    await controller.move({ ids: [1] } as never);
    expect(service.move).toHaveBeenCalledWith([1], null);

    await controller.delete({ ids: [7] } as never);
    expect(service.delete).toHaveBeenCalledWith([7]);

    await controller.subtreeCount({ id: 9 } as never);
    expect(service.subtreeCount).toHaveBeenCalledWith(9);

    await controller.writeContent({ id: 4, content: 'c' } as never);
    expect(service.writeContent).toHaveBeenCalledWith(4, 'c');

    await controller.uploadFile({ name: 'f.txt', base64: 'eA==' } as never);
    expect(service.uploadFile).toHaveBeenCalledWith({
      name: 'f.txt',
      base64: 'eA==',
    });
    await controller.uploadFile({
      name: 'f.txt',
      base64: 'eA==',
      parentId: 7,
    } as never);
    expect(service.uploadFile).toHaveBeenCalledWith({
      name: 'f.txt',
      base64: 'eA==',
      parentId: 7,
    });
  });

  it('rename/toggleFavorite/markViewed/read/readImage/tree/search/listRecent/listFavorites 全委托', async () => {
    const { controller, service } = makeController();
    await controller.rename({ id: 1, name: 'n' } as never);
    expect(service.rename).toHaveBeenCalledWith(1, 'n');
    await controller.toggleFavorite({ id: 2 } as never);
    expect(service.toggleFavorite).toHaveBeenCalledWith(2);
    await controller.markViewed({ id: 3 } as never);
    expect(service.markViewed).toHaveBeenCalledWith(3);
    await controller.read({ id: 4 } as never);
    expect(service.read).toHaveBeenCalledWith(4);
    await controller.readImage({ id: 5 } as never);
    expect(service.readImage).toHaveBeenCalledWith(5);
    await controller.tree();
    expect(service.tree).toHaveBeenCalled();
    await controller.search({ keyword: 'k' } as never);
    expect(service.search).toHaveBeenCalledWith('k');
    await controller.listRecent();
    expect(service.listRecent).toHaveBeenCalled();
    await controller.listFavorites();
    expect(service.listFavorites).toHaveBeenCalled();
    await controller.createFile({ name: 'f.md' } as never);
    expect(service.createFile).toHaveBeenCalledWith('f.md', null);
  });
});

/* ── DTO 转制钉测试 ── */

describe('toLibraryItemDto 路径剔除', () => {
  it('storagePath/originalPath 绝不透出，其余字段全保留', () => {
    const dto = toLibraryItemDto({
      id: 1,
      parentId: null,
      name: 'a.md',
      kind: 'file',
      fileType: 'markdown',
      mimeType: 'text/markdown',
      size: 3,
      originalPath: '/本机/绝对/路径/a.md',
      url: null,
      favorite: true,
      lastViewedAt: null,
      location: [],
      storagePath: path.join(libraryRoot, '1', 'a.md'),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    expect(dto).not.toHaveProperty('storagePath');
    expect(dto).not.toHaveProperty('originalPath');
    expect(JSON.stringify(dto)).not.toContain(libraryRoot);
    expect(dto).toEqual({
      id: 1,
      parentId: null,
      name: 'a.md',
      kind: 'file',
      fileType: 'markdown',
      mimeType: 'text/markdown',
      size: 3,
      url: null,
      favorite: true,
      lastViewedAt: null,
      location: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
  });
});
