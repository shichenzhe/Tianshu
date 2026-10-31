import { QueryDecoder } from 'src/commons/query/query-decoder.interface';
import { UserQueryFilter } from './user.queryfilter';
import { QueryFilter, QuerySort } from 'src/commons/query/query-filter';
import { containsFilter } from 'src/commons/database/db-url';

export class UserQueryDecoder implements QueryDecoder {
  private static instance: UserQueryDecoder;

  private constructor() {}

  public static getInstance(): UserQueryDecoder {
    if (!UserQueryDecoder.instance) {
      UserQueryDecoder.instance = new UserQueryDecoder();
    }
    return UserQueryDecoder.instance;
  }

  sort(params: QueryFilter): any {
    const orderBy: any = {};

    if (params.sorts) {
      params.sorts.forEach((sort: QuerySort) => {
        orderBy[sort.field] = sort.direction;
      });
    } else {
      orderBy.createdAt = 'desc';
    }
    return orderBy;
  }

  condition(params: UserQueryFilter): any {
    const where: any = {};

    if (typeof params.isActive === 'boolean') {
      where.isActive = params.isActive;
    }

    if (params.userType) {
      where.userType = params.userType;
    }

    // 关键词 contains 经 containsFilter 引擎感知构造：PG 补 mode
    // insensitive 对齐 SQLite LIKE 的 ASCII 大小写不敏感（双引擎统一）
    if (params.username) {
      where.username = containsFilter(params.username);
    }

    if (params.name) {
      where.name = containsFilter(params.name);
    }

    if (params.email) {
      where.email = containsFilter(params.email);
    }

    if (params.phone) {
      where.phone = containsFilter(params.phone);
    }

    if (params.keyword) {
      where.OR = [
        { username: containsFilter(params.keyword) },
        { name: containsFilter(params.keyword) },
        { email: containsFilter(params.keyword) },
        { phone: containsFilter(params.keyword) },
      ];
    }

    return where;
  }
}
