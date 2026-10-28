import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../commons/database/prisma.service';
import { UserEntity } from './entity/user.entity';
import { QueryResult } from 'src/commons/query/query-result';
import { UserQueryFilter } from './entity/user.queryfilter';
import { UserQueryDecoder } from './entity/user.querydecoder';
import { UserUpdateEntity } from './entity/user-update.entity';
import { UserActiveEntity } from './entity/user-active.entity';
import { UserChangePasswordEntity } from './entity/user-change-password.entity';
import { UserCreateEntity } from './entity/user-create.entity';

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 创建用户
   */
  async create(createUserEntity: UserCreateEntity): Promise<UserEntity> {
    const user = await this.prisma.user.create({
      data: createUserEntity,
    });

    return new UserEntity(user);
  }

  /**
   * 更新用户
   */
  async update(
    id: string,
    updateUserEntity: UserUpdateEntity,
  ): Promise<UserEntity> {
    const user = await this.prisma.user.update({
      where: { id },
      data: updateUserEntity,
    });

    return new UserEntity(user);
  }

  /**
   * 启用/禁用用户
   */
  async active(
    id: string,
    updateUserActiveEntity: UserActiveEntity,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: updateUserActiveEntity,
    });
  }

  /**
   * 根据用户名查找用户
   */
  async getByUsername(username: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findUnique({
      where: { username },
    });

    return user ? new UserEntity(user) : null;
  }

  /**
   * 根据ID查找用户
   */
  async getById(id: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    return user ? new UserEntity(user) : null;
  }

  /**
   * 获取用户列表
   */
  async query(params: UserQueryFilter): Promise<QueryResult<UserEntity>> {
    const where = UserQueryDecoder.getInstance().condition(params);
    const orderBy = UserQueryDecoder.getInstance().sort(params);
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy,
      }),
      this.prisma.user.count({ where }),
    ]);

    return QueryResult.of<UserEntity>(
      users.map((user) => new UserEntity(user)),
      params.page,
      params.pageSize,
      total,
    );
  }

  /**
   * 获取用户列表
   */
  async list(params: UserQueryFilter): Promise<UserEntity[]> {
    const where = UserQueryDecoder.getInstance().condition(params);
    const users = await this.prisma.user.findMany({
      where,
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      orderBy: UserQueryDecoder.getInstance().sort(params),
    });

    return users.map((user) => new UserEntity(user));
  }

  /**
   * 检查用户名是否存在
   */
  async existsByUsername(username: string): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: { username },
    });
    return count > 0;
  }

  /**
   * 物理删除用户
   */
  async delete(id: string): Promise<void> {
    await this.prisma.user.delete({
      where: { id },
    });
  }

  /**
   * 更新用户密码
   */
  async changePassword(
    userId: string,
    updateUserPasswordEntity: UserChangePasswordEntity,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: updateUserPasswordEntity,
    });
  }

  /**
   * 更新用户最后登录时间
   */
  async updateLastLoginTime(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        lastLoginTime: new Date(),
      },
    });
  }
}
