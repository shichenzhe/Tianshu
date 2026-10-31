/**
 * Proxy 门面双 client：scheme 分支装载、属性转发、非法 scheme 报错、
 * options 注入（测试临时库通道）语义保留。
 */
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(function (this: any, options?: unknown) {
    return { __engine: 'sqlite', options, $connect: jest.fn(), $disconnect: jest.fn() };
  }),
}));
// 路径须与实现侧 require 解析到同一模块：jest.mock 相对 spec 文件
// （test/core/），实现相对 src/commons/database/——即本文件加 src/ 前缀
// （virtual：无生成物的新 clone 也能注册桩，Artifact 存在时被工厂替换）
jest.mock('../../src/generated/prisma-pg', () => ({
  PrismaClient: jest.fn(function (this: any, options?: unknown) {
    return { __engine: 'postgres', options, $connect: jest.fn(), $disconnect: jest.fn() };
  }),
}), { virtual: true });

import { PrismaService } from '../../src/commons/database/prisma.service';

describe('PrismaService 双引擎门面', () => {
  const OLD = process.env.TIANSHU_DB_URL;
  // 原值未设时须 delete 复原：`env.X = undefined` 会落字符串 "undefined"
  // （jest worker 内跨 spec 文件共享 process.env，泄漏即后续套件误判引擎）
  afterEach(() => {
    if (OLD === undefined) {
      delete process.env.TIANSHU_DB_URL;
    } else {
      process.env.TIANSHU_DB_URL = OLD;
    }
  });

  it('未设 env → SQLite client（现状）', () => {
    delete process.env.TIANSHU_DB_URL;
    const svc = new PrismaService() as any;
    expect(svc.__engine).toBe('sqlite');
  });
  it('postgres env → PG client，属性转发（model 代理/raw 事务同面）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/d';
    const svc = new PrismaService() as any;
    expect(svc.__engine).toBe('postgres');
  });
  it('非法 scheme → 人话报错', () => {
    process.env.TIANSHU_DB_URL = 'mysql://h/d';
    expect(() => new PrismaService()).toThrow(/TIANSHU_DB_URL/);
  });
  it('options 注入优先于 env（测试临时库通道保留）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/d';
    const svc = new PrismaService({ datasources: { db: { url: 'file:/tmp/test.db' } } } as any) as any;
    expect(svc.__engine).toBe('sqlite');
  });
});
