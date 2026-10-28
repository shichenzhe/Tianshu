import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../commons/auth/guard/jwt-auth.guard';
import { Roles } from '../../commons/auth/roles.decorator';
import { RolesGuard } from '../../commons/auth/roles.guard';
import { UserService } from './user.service';
import { UserDto } from './dto/user.dto';
import { UserQueryFilter } from './entity/user.queryfilter';
import { QueryResult } from 'src/commons/query/query-result';
import { UserType } from '@prisma/client';
import { UserEntity } from './entity/user.entity';
import { AccessContext } from 'src/commons/auth/decorator/access-context.decorator';
import { OperateContext } from 'src/commons/entity/operate-context.entity';
import { UserCreateDto } from './dto/user-create.dto';
import { UserUpdateDto } from './dto/user-update.dto';
import { UserActiveDto } from './dto/user-active.dto';
import { Entity } from 'src/commons/entity/entity';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * 创建用户（仅管理员）
   */
  @Post('create')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.admin)
  async create(
    @Body() createUserDto: UserCreateDto,
    @AccessContext() operateContext: OperateContext,
  ): Promise<UserDto> {
    const userEntity: UserEntity = await this.userService.create(
      createUserDto,
      operateContext,
    );
    return UserDto.create(userEntity);
  }

  /**
   * 获取用户列表（仅管理员）
   */
  @Post('query')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.admin)
  async query(@Body() params: UserQueryFilter): Promise<QueryResult<UserDto>> {
    const qr = await this.userService.query(params);
    return {
      ...qr,
      records: qr.records.map((user) => UserDto.create(user)),
    };
  }

  /**
   * 获取用户详情
   */
  @Post('getById')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.admin)
  async getById(@Body() params: Entity): Promise<UserDto | null> {
    const userEntity = await this.userService.getById(params.id);
    if (!userEntity) {
      return null;
    }
    return UserDto.create(userEntity);
  }

  /**
   * 更新用户信息
   */
  @Post('update')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.admin)
  async update(
    @Body() updateUserDto: UserUpdateDto,
    @AccessContext() operateContext: OperateContext,
  ): Promise<UserDto> {
    const userEntity: UserEntity = await this.userService.update(
      updateUserDto,
      operateContext,
    );
    return UserDto.create(userEntity);
  }

  /**
   * 启用/禁用用户（仅管理员）
   */
  @Post('active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.admin)
  async active(
    @Body() updateUserActiveDto: UserActiveDto,
    @AccessContext() operateContext: OperateContext,
  ): Promise<void> {
    await this.userService.active(
      updateUserActiveDto.id,
      updateUserActiveDto.isActive,
      operateContext,
    );
  }

  /**
   * 重置用户密码（仅管理员）
   */
  @Post('resetPassword')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.admin)
  async resetPassword(
    @Body() entity: Entity,
    @AccessContext() operateContext: OperateContext,
  ): Promise<void> {
    await this.userService.resetPassword(entity.id, operateContext);
  }

  /**
   * 物理删除用户（仅管理员）
   */
  @Post('delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.admin)
  async delete(@Body() params: Entity): Promise<void> {
    await this.userService.delete(params.id);
  }
}
