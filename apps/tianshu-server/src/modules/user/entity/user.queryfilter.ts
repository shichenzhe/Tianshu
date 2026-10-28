import { UserType } from '@prisma/client';
import { QueryFilter } from 'src/commons/query/query-filter';

export class UserQueryFilter extends QueryFilter {
  keyword?: string;
  userType?: UserType;
  isActive?: boolean;
  username?: string;
  name?: string;
  phone?: string;
  email?: string;
}
