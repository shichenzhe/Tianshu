import AdmZip from 'adm-zip';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillsService } from 'src/modules/skills/skills.service';

// A3 尾：skills/installUpload（base64 zip ≤3MB 校验 + installSkillZip 落盘
// 语义——冲突/包结构/staging 落盘断言）与 skills/stats（skillStat groupBy
// 聚合——usedCount 全事件合计、lastUsedAt 最新 ISO、无事件 null）。
// 磁盘扫描替身（skill-loader 不在本文件链路）；数据根指向真实临时目录。

jest.mock('src/core/chat-runner.service', () => ({
  resolveDataRoot: () => mockDataRoot,
}));

let mockDataRoot: string;

/** skillRecord/skillStat 内存替身 */
function makePrismaDouble() {
  const skillRows: Array<Record<string, unknown>> = [];
  const statRows: Array<Record<string, unknown>> = [];
  const prisma = {
    skillRecord: {
      findFirst: jest.fn(
        async (args: { where: { name: string } }) =>
          skillRows.find((row) => row.name === args.where.name) ?? null,
      ),
      upsert: jest.fn(
        async (args: {
          where: { name: string };
          create: Record<string, unknown>;
        }) => {
          const hit = skillRows.find((row) => row.name === args.where.name);
          if (hit) return hit;
          const row = { id: skillRows.length + 1, ...args.create };
          skillRows.push(row);
          return row;
        },
      ),
    },
    skillStat: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        statRows.push({ id: statRows.length + 1, ...args.data });
        return {};
      }),
      groupBy: jest.fn(async () =>
        statRows.reduce(
          (
            groups: Array<{
              __key: string;
              name: unknown;
              event: unknown;
              _count: { _all: number };
              _max: { createdAt: unknown };
            }>,
            row,
          ) => {
            const key = `${row.name}:${row.event}`;
            const group = groups.find((g) => g.__key === key);
            if (group) {
              group._count._all += 1;
              if ((row.createdAt as Date) > (group._max.createdAt as Date)) {
                group._max.createdAt = row.createdAt;
              }
            } else {
              groups.push({
                __key: key,
                name: row.name,
                event: row.event,
                _count: { _all: 1 },
                _max: { createdAt: row.createdAt },
              });
            }
            return groups;
          },
          [],
        ),
      ),
    },
  };
  return { prisma, skillRows, statRows };
}

type PrismaDouble = ReturnType<typeof makePrismaDouble>['prisma'];

function makeService(prisma: PrismaDouble) {
  return new SkillsService(prisma as never);
}

/** 造一个合法技能 zip buffer（根级 SKILL.md） */
function makeSkillZip(name: string, body = '# 技能\n') {
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(`---\nname: ${name}\ndescription: 测试技能\n---\n${body}`),
  );
  return zip.toBuffer();
}

beforeEach(() => {
  mockDataRoot = mkdtempSync(path.join(tmpdir(), 'tianshu-skills-tail-'));
});

afterEach(() => {
  rmSync(mockDataRoot, { recursive: true, force: true });
});

describe('SkillsService.installUpload（A3 尾）', () => {
  it('合法 zip 落盘安装 + upsert 记录 + install 埋点', async () => {
    const { prisma, skillRows, statRows } = makePrismaDouble();
    const result = (await makeService(prisma).installUpload({
      name: 'a.zip',
      base64: makeSkillZip('alpha').toString('base64'),
    })) as { status: string; record: { name: string } };

    expect(result.status).toBe('installed');
    expect(result.record.name).toBe('alpha');
    // 落盘语义：staging 清理后目标目录有 SKILL.md
    const skillMd = readFileSync(
      path.join(mockDataRoot, 'skills', 'alpha', 'SKILL.md'),
      'utf8',
    );
    expect(skillMd).toContain('name: alpha');
    // 无残留 staging
    expect(skillRows).toHaveLength(1);
    expect(statRows).toEqual([
      expect.objectContaining({ name: 'alpha', event: 'install' }),
    ]);
  });

  it('目录/记录已存在返回 conflict（不落盘不覆盖）', async () => {
    const { prisma, skillRows, statRows } = makePrismaDouble();
    const service = makeService(prisma);
    await service.installUpload({
      name: 'a.zip',
      base64: makeSkillZip('alpha').toString('base64'),
    });
    const again = (await service.installUpload({
      name: 'a.zip',
      base64: makeSkillZip('alpha', 'v2').toString('base64'),
    })) as { status: string };
    expect(again.status).toBe('conflict');
    // 原内容未被覆盖
    expect(
      readFileSync(
        path.join(mockDataRoot, 'skills', 'alpha', 'SKILL.md'),
        'utf8',
      ),
    ).not.toContain('v2');
    expect(statRows).toHaveLength(1);
  });

  it('overwrite=true 冲突覆写——内容更新且记录 upsert', async () => {
    const { prisma, statRows } = makePrismaDouble();
    const service = makeService(prisma);
    await service.installUpload({
      name: 'a.zip',
      base64: makeSkillZip('alpha').toString('base64'),
    });
    const result = (await service.installUpload({
      name: 'a.zip',
      base64: makeSkillZip('alpha', 'v2').toString('base64'),
      overwrite: true,
    })) as { status: string };
    expect(result.status).toBe('installed');
    expect(
      readFileSync(
        path.join(mockDataRoot, 'skills', 'alpha', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('v2');
    // install 埋点二次（覆盖也计 install 事件）
    expect(statRows).toHaveLength(2);
  });

  it('包结构不合法（无 SKILL.md）拒 SKILL_UPLOAD_INVALID', async () => {
    const { prisma } = makePrismaDouble();
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('hi'));
    await expect(
      makeService(prisma).installUpload({
        name: 'bad.zip',
        base64: zip.toBuffer().toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPLOAD_INVALID' });
  });

  it('超 3MB 拒 SKILL_UPLOAD_INVALID（不经安装链）', async () => {
    const { prisma } = makePrismaDouble();
    const big = Buffer.alloc(3 * 1024 * 1024 + 1);
    await expect(
      makeService(prisma).installUpload({
        name: 'big.zip',
        base64: big.toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPLOAD_INVALID' });
  });
});

describe('SkillsService.stats（A3 尾）', () => {
  it('事件桶聚合：usedCount 全事件合计、lastUsedAt 最新 ISO', async () => {
    const { prisma, statRows } = makePrismaDouble();
    const at = (iso: string) => new Date(iso);
    statRows.push(
      {
        name: 'alpha',
        event: 'install',
        createdAt: at('2026-10-24T00:00:00Z'),
      },
      { name: 'alpha', event: 'enable', createdAt: at('2026-10-26T08:00:00Z') },
      {
        name: 'alpha',
        event: 'disable',
        createdAt: at('2026-10-25T00:00:00Z'),
      },
      { name: 'beta', event: 'install', createdAt: at('2026-10-20T00:00:00Z') },
    );
    const stats = await makeService(prisma).stats();
    expect(stats).toEqual([
      {
        name: 'alpha',
        usedCount: 3,
        lastUsedAt: '2026-10-26T08:00:00.000Z',
      },
      { name: 'beta', usedCount: 1, lastUsedAt: '2026-10-20T00:00:00.000Z' },
    ]);
  });

  it('空表返回空列表', async () => {
    const { prisma } = makePrismaDouble();
    expect(await makeService(prisma).stats()).toEqual([]);
  });
});
