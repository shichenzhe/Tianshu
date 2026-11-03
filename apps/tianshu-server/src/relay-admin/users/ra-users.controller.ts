import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AccessContext } from '../../commons/auth/decorator/access-context.decorator';
import { OperateContext } from '../../commons/entity/operate-context.entity';
import { RaUsersService, RaUserCreatedResult } from './ra-users.service';
import { RaUserCreateDto } from './dto/ra-user-create.dto';
import { RaUserDto } from './dto/ra-user.dto';

/**
 * relay-admin 租户用户管理端点（Task 10）：鉴权由 AppModule 全局
 * APP_GUARD（JwtAuthGuard）承担，本控制器无 @Public 即默认受保护。
 * 入口唯一主体是 ra_admin_user 管理员（Task 9：login 只发 'ra-admin' 单
 * 角色，RaJwtStrategy 回查管理员表）——列表对全体已鉴权调用者可见全量，
 * 与 brief「@Roles(admin) 可见全量」语义一致；待引入第二角色时再挂
 * RolesGuard 分档（当前 RolesGuard 校验体在业务端为空实现，挂上仅仪式）。
 */
@ApiTags('relay-admin/users')
@Controller('relay-admin/users')
export class RaUsersController {
  constructor(private readonly raUsersService: RaUsersService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @Body() dto: RaUserCreateDto,
    @AccessContext() operateContext: OperateContext,
  ): Promise<RaUserCreatedResult> {
    return this.raUsersService.create(dto, operateContext.operator.code);
  }

  @Get()
  async list(): Promise<RaUserDto[]> {
    return this.raUsersService.list();
  }

  @Post(':userId/disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @Param('userId') userId: string,
    @AccessContext() operateContext: OperateContext,
  ): Promise<void> {
    await this.raUsersService.disable(userId, operateContext.operator.code);
  }

  /** 恢复用户状态；级联禁用的 AK 不自动恢复（见 service 注释） */
  @Post(':userId/enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @Param('userId') userId: string,
    @AccessContext() operateContext: OperateContext,
  ): Promise<void> {
    await this.raUsersService.enable(userId, operateContext.operator.code);
  }
}
