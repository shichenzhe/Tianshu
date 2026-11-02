/**
 * library-vectorize 单测（spec 2026-11-02-library-vectorize-server-design）：
 * 文本判定矩阵 + vectorizeLibraryContent 编排全路径（非文本/空内容/无
 * embedding 模型/embed 失败/形状不符均 skip 不炸；正常路径 upsert 参数
 * 断言）。全 deps 注入零 jest.mock（本仓 interop 形态下 partial mock 的
 * named import 取 undefined 实测不可用，注入面即为此设计）。
 */
import {
  isTextualContent,
  vectorizeLibraryContent,
  type LibraryVectorizeDeps,
  type LibraryVectorizePrisma,
} from 'src/core/library/library-vectorize';
import type { EmbedTexts } from 'src/core/library/library-tools';

/** db stub：可控 embedding 模型查询返回 */
function makeDb(model: { id: number } | null): LibraryVectorizePrisma {
  return {
    model: {
      findFirst: async () => model,
    },
  };
}

/** 定长向量 fake embed（每 chunk [1, 0.5]） */
const fakeEmbed: EmbedTexts = async (_modelId, texts) =>
  texts.map(() => [1, 0.5]);

/** upsert spy（deps 注入面） */
type UpsertParams = {
  userId: number;
  collection: string;
  sourceName: string;
  model: string;
  chunks: Array<{ seq: number; text: string; vector: number[] }>;
};
function makeUpsertSpy() {
  const calls: UpsertParams[] = [];
  const deps: LibraryVectorizeDeps = {
    upsert: async (params) => {
      calls.push(params as UpsertParams);
    },
  };
  return { deps, calls };
}

const skips: string[] = [];

afterEach(() => {
  skips.length = 0;
});
describe('isTextualContent 文本判定矩阵', () => {
  it('text/* mime 与白名单 fileType 放行', () => {
    expect(isTextualContent('text/plain', null)).toBe(true);
    expect(isTextualContent('text/markdown', null)).toBe(true);
    expect(isTextualContent(null, 'md')).toBe(true);
    expect(isTextualContent(null, 'code')).toBe(true);
    expect(isTextualContent(null, 'json')).toBe(true);
    expect(isTextualContent(null, 'yaml')).toBe(true);
  });

  it('二进制/图片/空 fileType 拒绝', () => {
    expect(isTextualContent('image/png', null)).toBe(false);
    expect(isTextualContent('application/pdf', null)).toBe(false);
    expect(isTextualContent(null, 'binary')).toBe(false);
    expect(isTextualContent(null, 'png')).toBe(false);
    expect(isTextualContent(null, null)).toBe(false);
  });
});

describe('vectorizeLibraryContent 编排', () => {
  it('非文本内容 skip（onSkip 留观测），不触 embed/upsert', async () => {
    const embed = jest.fn(fakeEmbed);
    const upsert = makeUpsertSpy();
    const out = await vectorizeLibraryContent(
      {
        db: makeDb({ id: 9 }),
        embed,
        upsert: upsert.deps.upsert,
        onSkip: (r) => skips.push(r),
      },
      {
        userId: 1,
        sourceName: '图.png',
        content: 'binary-ish',
        mimeType: 'image/png',
        fileType: 'png',
      },
    );
    expect(out).toBe('skipped');
    expect(skips).toEqual(['library_vectorize_skip_type']);
    expect(embed).not.toHaveBeenCalled();
    expect(upsert.calls).toHaveLength(0);
  });

  it('空白内容（chunkText 空块集）skip', async () => {
    const out = await vectorizeLibraryContent(
      { db: makeDb({ id: 9 }), embed: fakeEmbed, onSkip: (r) => skips.push(r) },
      {
        userId: 1,
        sourceName: '空.md',
        content: '   ',
        mimeType: 'text/markdown',
        fileType: 'md',
      },
    );
    expect(out).toBe('skipped');
    expect(skips).toEqual(['library_vectorize_skip_empty']);
  });

  it('无可用 embedding 模型 skip 不炸（写面语义）', async () => {
    const upsert = makeUpsertSpy();
    const out = await vectorizeLibraryContent(
      {
        db: makeDb(null),
        embed: fakeEmbed,
        upsert: upsert.deps.upsert,
        onSkip: (r) => skips.push(r),
      },
      {
        userId: 1,
        sourceName: '笔记.md',
        content: '有内容',
        mimeType: 'text/markdown',
        fileType: 'md',
      },
    );
    expect(out).toBe('skipped');
    expect(skips).toEqual(['library_vectorize_no_model']);
    expect(upsert.calls).toHaveLength(0);
  });

  it('embed 失败 skip 不炸（fire-and-forget 语义保障）', async () => {
    const out = await vectorizeLibraryContent(
      {
        db: makeDb({ id: 9 }),
        embed: async () => {
          throw new Error('boom');
        },
        onSkip: (r) => skips.push(r),
      },
      {
        userId: 1,
        sourceName: '笔记.md',
        content: '有内容',
        mimeType: 'text/markdown',
        fileType: 'md',
      },
    );
    expect(out).toBe('skipped');
    expect(skips).toEqual(['library_vectorize_embed_failed']);
  });

  it('embed 返回数与块数不符 skip（形状防线）', async () => {
    const out = await vectorizeLibraryContent(
      {
        db: makeDb({ id: 9 }),
        embed: async () => [[1]], // 单向量应对多块
        onSkip: (r) => skips.push(r),
      },
      {
        userId: 1,
        sourceName: '长文.md',
        content: 'a'.repeat(1200), // 500/100 窗口 → 多块
        mimeType: 'text/markdown',
        fileType: 'md',
      },
    );
    expect(out).toBe('skipped');
    expect(skips).toEqual(['library_vectorize_embed_shape']);
  });

  it('正常路径：chunkText 分块 → embed → upsertChunks 参数齐全', async () => {
    const content = '第一段内容足够长'.repeat(100); // 900 字 > 500 窗口 → 多块
    const upsert = makeUpsertSpy();
    const out = await vectorizeLibraryContent(
      {
        db: makeDb({ id: 9 }),
        embed: fakeEmbed,
        upsert: upsert.deps.upsert,
      },
      {
        userId: 1,
        sourceName: '笔记.md',
        content,
        mimeType: 'text/markdown',
        fileType: 'md',
      },
    );
    expect(out).toBe('indexed');
    expect(upsert.calls).toHaveLength(1);
    const params = upsert.calls[0];
    expect(params.userId).toBe(1);
    expect(params.collection).toBe('library');
    expect(params.sourceName).toBe('笔记.md');
    expect(params.model).toBe('9'); // String(modelId) 入库契约
    expect(params.chunks.length).toBeGreaterThan(1);
    expect(params.chunks[0]).toEqual({
      seq: 0,
      text: expect.any(String),
      vector: [1, 0.5],
    });
    expect(params.chunks.map((c) => c.seq)).toEqual(
      params.chunks.map((_, i) => i),
    );
  });
});
