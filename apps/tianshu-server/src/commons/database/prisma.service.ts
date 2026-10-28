import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { dbUrlOptions, ensureDatabase } from './db-url';
import { ensureGraphRunNodeTable } from './ensure-graph-run-node-table';

type PrismaClientOptions = ConstructorParameters<typeof PrismaClient>[0];

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  // options 供测试注入临时库（test/support/test-db.ts 同款 datasources 覆盖）；
  // DI 无参构造 → env 覆盖（TIANSHU_DB_URL，打包态桌面端注入——缺省走 schema
  // 字面量 url，dev 态零改动）。@Optional 防 Nest 对 Object 参数token 解析报错
  constructor(@Optional() options?: PrismaClientOptions) {
    super(options ?? dbUrlOptions());
  }

  async onModuleInit() {
    // 首启建库须先于连接（env 注入态 + dev 态：目录确保 + 缺库/空壳
    // db push，见 db-url.ts）
    ensureDatabase();
    await this.$connect();
    // 存量升级库幂等补建 graphRunNode（db push 只覆盖缺库/空壳首启，
    // 见 ensure-graph-run-node-table.ts 头注释）
    await ensureGraphRunNodeTable(this);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
