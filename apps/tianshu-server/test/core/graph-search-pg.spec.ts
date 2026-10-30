// apps/tianshu-server/test/core/graph-search-pg.spec.ts
/**
 * search-pg 纯函数层：FTS 查询串（OR 连接/词元直传——词元已过 tokenize
 * 白名单无需转义）、向量字面量、DDL/SQL 生成（collection 可选段与占位
 * 序号正确性）。
 */
import {
  PG_DDL, buildFtsQuery, buildFtsSql, buildVectorSql,
  buildVectorLiteral, buildUpsertInsertSql,
} from '../../src/core/graph/search-pg';

describe('buildFtsQuery', () => {
  it('词元 OR 连接（to_tsquery 形态）', () => {
    expect(buildFtsQuery(['容', '错', '设计'])).toBe('容 | 错 | 设计');
  });
  it('空词元产出空串（调用侧短路前置防御）', () => {
    expect(buildFtsQuery([])).toBe('');
  });
});

describe('buildVectorLiteral', () => {
  it('JSON 数组字面量（pgvector 输入形态）', () => {
    expect(buildVectorLiteral([0.1, -0.2, 0.3])).toBe('[0.1,-0.2,0.3]');
  });
});

describe('SQL 生成（占位序号随 collection 段偏移）', () => {
  it('FTS：无 collection 段 $1=匹配串 $2=userId $3=limit', () => {
    const { sql } = buildFtsSql(false);
    expect(sql).toContain('to_tsquery(\'simple\', $1)');
    expect(sql).toContain('user_id = $2');
    expect(sql).toContain('LIMIT $3');
    expect(sql).not.toContain('collection = ');
  });
  it('FTS：有 collection 段占位顺延', () => {
    const { sql } = buildFtsSql(true);
    expect(sql).toContain('user_id = $2');
    expect(sql).toContain('collection = $3');
    expect(sql).toContain('LIMIT $4');
  });
  it('向量：无 collection 段 $1=向量 $2=model $3=userId $4=limit，余弦距离排序 + score 取 1-距离', () => {
    const { sql } = buildVectorSql(false);
    expect(sql).toContain('$1::vector');
    expect(sql).toContain('model = $2');
    expect(sql).toContain('user_id = $3');
    expect(sql).toContain('ORDER BY vector <=> $1::vector');
    expect(sql).toContain('1 - (vector <=> $1::vector) AS score');
    expect(sql).toContain('LIMIT $4');
    expect(sql).toContain('vector IS NOT NULL');
  });
  it('向量：有 collection 段占位顺延', () => {
    const { sql } = buildVectorSql(true);
    expect(sql).toContain('collection = $4');
    expect(sql).toContain('LIMIT $5');
  });
});

describe('PG_DDL 与 upsert 语句', () => {
  it('DDL 含扩展/表/GIN/复合索引且全部 IF NOT EXISTS 幂等', () => {
    expect(PG_DDL.join('\n')).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(PG_DDL.join('\n')).toContain('CREATE TABLE IF NOT EXISTS vector_chunk');
    expect(PG_DDL.join('\n')).toContain('USING gin(text_tsv)');
    expect(PG_DDL.join('\n')).toContain('(user_id, collection)');
    expect(PG_DDL.join('\n')).toContain('text_tsv tsvector NOT NULL');
    expect(PG_DDL.join('\n')).toContain('vector vector');
  });
  it('upsert INSERT：multi-VALUES 含 to_tsvector(simple) 与 ::vector 转换', () => {
    const sql = buildUpsertInsertSql(2);
    expect(sql).toContain("to_tsvector('simple', $6)"); // 每块 8 参：user/coll/source/seq/text/分词/向量/model
    expect(sql).toContain('$7::vector');
    expect(sql).toMatch(/VALUES \(.+\), \(.+\)/); // 两行 VALUES
    expect(sql).toContain('INSERT INTO vector_chunk');
  });
});
