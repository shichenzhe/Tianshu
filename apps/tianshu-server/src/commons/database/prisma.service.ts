import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  dbUrlOptions,
  engineOf,
  ensureDatabase,
  overriddenDbUrl,
  type DbEngine,
} from './db-url';
import { ensureGraphRunNodeTable } from './ensure-graph-run-node-table';
import { ensureAutomationRunGraphSnapshotColumn } from './ensure-automation-run-snapshot';
import { ensureAutomationTaskCatchUpLimitColumn } from './ensure-automation-task-catch-up-limit';
import { ensureModelCapabilityColumns } from './ensure-model-capability-columns';
import { ensurePermissionPatternColumns } from './ensure-permission-pattern-columns';

type PrismaClientOptions = ConstructorParameters<typeof PrismaClient>[0];
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

/** 按 engine 装载 client 类：postgres → 派生 PG 生成物（prisma:generate:pg
 * 产出，CJS 同步 require——构建期产物，git-ignored）；sqlite → @prisma/client
 * 本尊。TS 类型面统一用 SQLite 端——两端 schema 同构（表体逐字节钉死，
 * derive-pg.mjs），业务代码零改动。 */
function loadClientClass(
  engine: 'sqlite' | 'postgres',
): new (options?: PrismaClientOptions) => AnyClient {
  if (engine === 'postgres') {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const pg = require('../../generated/prisma-pg');
    return pg.PrismaClient;
  }
  return PrismaClient as new (options?: PrismaClientOptions) => AnyClient;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly engineClient: AnyClient;
  /** 装载引擎（构造期判定）——onModuleInit 传给 ensureGraphRunNodeTable
   * 做 PG 跳过判定；实例自有字段，与 engineClient 同入 get-trap 放行清单 */
  private readonly dbEngine: DbEngine;
  // options 供测试注入临时库（datasources url 优先于 env 判 engine，见
  // test/support/test-db.ts）；DI 无参构造 → env（TIANSHU_DB_URL）判定。
  // 类型面保持 extends PrismaClient（SQLite 端，业务代码零改动）；运行时
  // 构造器返回 Proxy 把 Prisma 面转发到按 scheme 二选一的内部 engineClient
  // ——super() 的 SQLite 实例在两种引擎下都仅作类型占位（未连接、无 IO，
  // 真实连接/查询全走 engineClient）。
  constructor(@Optional() options?: PrismaClientOptions) {
    super(options ?? dbUrlOptions());
    const url = (options as any)?.datasources?.db?.url ?? overriddenDbUrl();
    this.dbEngine = engineOf(url);
    const ClientClass = loadClientClass(this.dbEngine);
    this.engineClient = new ClientClass(options ?? dbUrlOptions());
    // 转发判定须用显式门面自收口清单，不能用 `prop in target`：实测
    // Prisma 6 生成 client 的 model 代理与 $connect 等均为构造器安装的
    // 实例自有属性（非原型成员），`in` 判定会全数劫持回 super 占位实例，
    // PG 态静默落回 SQLite 引擎。symbol/`__proto__`/engineClient 与
    // PrismaService 自身方法（prototype 自有成员：onModuleInit 等）走
    // target，其余 Prisma 面（model 代理/$transaction/raw 事务同面）一律
    // 转发 engineClient。
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (
          typeof prop === 'symbol' ||
          prop === 'engineClient' ||
          prop === 'dbEngine' ||
          prop === '__proto__' ||
          Object.prototype.hasOwnProperty.call(PrismaService.prototype, prop)
        ) {
          return Reflect.get(target, prop, receiver);
        }
        const value = target.engineClient[prop];
        return typeof value === 'function'
          ? value.bind(target.engineClient)
          : value;
      },
    });
  }

  async onModuleInit() {
    // 首启建库须先于连接（env 注入态 + dev 态：目录确保 + 缺库/空壳
    // migrate deploy，见 db-url.ts）
    ensureDatabase();
    await this.engineClient.$connect();
    // 存量升级库幂等补建 graphRunNode（migrate deploy 只覆盖缺库/空壳首启，
    // 见 ensure-graph-run-node-table.ts 头注释）；this 经 Proxy 已具备
    // Prisma 面（$executeRawUnsafe 转发 engineClient，RawExecutor 结构满足）
    await ensureGraphRunNodeTable(this, this.dbEngine);
    // automationRun 快照列同款存量路径（批1C）：快路径库不跑迁移，缺列时
    // 图运行 createRun 100% 失败——探测补列（新库/PG 走 1_ 增量迁移）
    await ensureAutomationRunGraphSnapshotColumn(this, this.dbEngine);
    // automationTask 补跑上限列同款存量路径（批3A）：缺列时保存端点写
    // catchUpLimit 即失败——探测补列（新库/PG 走 2_ 增量迁移）
    await ensureAutomationTaskCatchUpLimitColumn(this, this.dbEngine);
    // model 能力矩阵四列同款存量路径（批5）：缺列时模型 save/读取即失败
    // ——探测补列（新库/PG 走 3_ 增量迁移）
    await ensureModelCapabilityColumns(this, this.dbEngine);
    // toolPermission 参数级审批两列同款存量路径（批7）：缺列时记忆查表
    // 即失败——探测补列 + 唯一索引替换（新库/PG 走 4_ 增量迁移）
    await ensurePermissionPatternColumns(this, this.dbEngine);
  }

  async onModuleDestroy() {
    await this.engineClient.$disconnect();
  }
}
