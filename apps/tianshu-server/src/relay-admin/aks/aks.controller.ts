import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AccessContext } from '../../commons/auth/decorator/access-context.decorator';
import { OperateContext } from '../../commons/entity/operate-context.entity';
import { AksService, RaAkIssuedResult } from './aks.service';
import { RaAkCreateDto } from './dto/ra-ak-create.dto';
import { RaAkExtendDto } from './dto/ra-ak-extend.dto';
import { RaAkListQueryDto } from './dto/ra-ak-query.dto';
import { RaAkDto } from './dto/ra-ak.dto';

/**
 * relay-admin AK 生命周期端点（Task 11）：鉴权由 AppModule 全局 APP_GUARD
 * （JwtAuthGuard）承担，本控制器无 @Public 即默认受保护（与 users 同款——
 * 入口唯一主体是 ra_admin_user 管理员）。isAkUsable 无 HTTP 面：Task 12
 * token 端点（Basic AK 鉴权，不走管理员 JWT）在服务层消费。
 */
@Controller('relay-admin/aks')
export class AksController {
  constructor(private readonly aksService: AksService) {}

  /** 签发：akSecret 明文仅本次响应返回一次（库内只存 sha256 摘要） */
  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @Body() dto: RaAkCreateDto,
    @AccessContext() operateContext: OperateContext,
  ): Promise<RaAkIssuedResult> {
    return this.aksService.create(dto, operateContext.operator.code);
  }

  /** 列表：按 userId 过滤，白名单 DTO 不透出 secretHash */
  @Get()
  async list(@Query() query: RaAkListQueryDto): Promise<RaAkDto[]> {
    return this.aksService.list(query.userId);
  }

  @Post(':akId/disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @Param('akId') akId: string,
    @AccessContext() operateContext: OperateContext,
  ): Promise<void> {
    await this.aksService.disable(akId, operateContext.operator.code);
  }

  /** 恢复：所属用户仍禁用时拒绝（见 service 注释——须先恢复用户） */
  @Post(':akId/enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @Param('akId') akId: string,
    @AccessContext() operateContext: OperateContext,
  ): Promise<void> {
    await this.aksService.enable(akId, operateContext.operator.code);
  }

  /** 轮换 secret：旧 secret 即刻失效，新明文仅本次响应返回一次 */
  @Post(':akId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  async rotateSecret(
    @Param('akId') akId: string,
    @AccessContext() operateContext: OperateContext,
  ): Promise<RaAkIssuedResult> {
    return this.aksService.rotateSecret(akId, operateContext.operator.code);
  }

  /** 续期：expireAt 只能延后不能提前（提前 BusinessException） */
  @Post(':akId/extend')
  @HttpCode(HttpStatus.OK)
  async extend(
    @Param('akId') akId: string,
    @Body() dto: RaAkExtendDto,
    @AccessContext() operateContext: OperateContext,
  ): Promise<void> {
    await this.aksService.extend(akId, dto, operateContext.operator.code);
  }
}
