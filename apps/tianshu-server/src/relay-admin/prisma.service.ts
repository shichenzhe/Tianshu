import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from './generated/prisma';

/** relay-admin 独立库落点 env 名（schema datasource url 即 env("RA_DATABASE_URL")） */
export const RA_DATABASE_URL_ENV = 'RA_DATABASE_URL';

/** 缺省落点：相对 schema 目录（prisma/relay-admin/）解析——Prisma 对 file:
 * 相对路径以 schema 位置为锚（CLI 与生成 client 一致），即物理落点
 * prisma/relay-admin/data/relay-admin.db，与被控端业务库 prisma/local.db 物理隔离 */
export const RA_DATABASE_URL_DEFAULT = 'file:./data/relay-admin.db';

/** env 兜底：未设置时设缺省值并返回生效值。必须在 PrismaClient 构造前调用
 * （super() 前）——client 构造期即解析 datasource env，缺 env 直接抛
 * validation error，构造后再设不生效（db-url.ts 头注释时序坑同族）。
 * dist 运行（dist/src/relay-admin/main.js）时相对缺省仍锚到生成时 schema
 * 目录（源码树 prisma/relay-admin/data/）——生产部署/dist 冒烟请显式设
 * RA_DATABASE_URL 为绝对路径，勿依赖缺省落点 */
export function ensureRaDatabaseUrl(): string {
  if (!process.env[RA_DATABASE_URL_ENV]) {
    process.env[RA_DATABASE_URL_ENV] = RA_DATABASE_URL_DEFAULT;
  }
  return process.env[RA_DATABASE_URL_ENV] as string;
}

/** relay-admin 独立库 client（生成物 prisma:generate:ra 产出，git-ignored）：
 * 模型面 raUser/raAccessKey/raAuditLog/raAdminUser 与业务库 PrismaService 完全
 * 独立——单库单 client，无业务库的双引擎 Proxy（PG 变体随脚手架 derive 机制
 * 后续需要时再引入） */
@Injectable()
export class RaPrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // 兜底须先于 super()：见 ensureRaDatabaseUrl 头注释
    ensureRaDatabaseUrl();
    super();
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
