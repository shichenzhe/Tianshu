import { QueryDecoder } from 'src/commons/query/query-decoder.interface';
import { UserQueryFilter } from './user.queryfilter';
import { QueryFilter, QuerySort } from 'src/commons/query/query-filter';

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

    if (params.username) {
      where.username = {
        contains: params.username,
      };
    }

    if (params.name) {
      where.name = {
        contains: params.name,
      };
    }

    if (params.email) {
      where.email = {
        contains: params.email,
      };
    }

    if (params.phone) {
      where.phone = {
        contains: params.phone,
      };
    }

    if (params.keyword) {
      where.OR = [
        {
          username: {
            contains: params.keyword,
          },
        },
        {
          name: {
            contains: params.keyword,
          },
        },
        {
          email: {
            contains: params.keyword,
          },
        },
        {
          phone: {
            contains: params.keyword,
          },
        },
      ];
    }

    return where;
  }
}
