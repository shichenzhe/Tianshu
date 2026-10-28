import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOperation,
  ApiProperty,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt } from 'class-validator';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import {
  ApiWrappedOk,
  inlineSchemas,
} from 'src/commons/swagger/wrapped-response';
import {
  PermissionFullGrantWireDto,
  PermissionFullGrantsWireDto,
  PermissionRememberedWireDto,
} from './dto/permission-wire.dto';
import { PermissionService } from './permission.service';

class PermissionRevokeRememberedDto {
  @ApiProperty({
    description: '记忆行 id（正整数；非正整数 PERMISSION_INVALID）',
  })
  @Type(() => Number)
  @IsInt({ message: 'id 必须是整数' })
  id: number;
}

/**
 * 审批记忆面控制器（A10 批，spec 2026-10-26 §1.1）：permission 五端点——
 * remembered 面（toolPermission 表读删）+ full 面（会话级运行态列表/清空）。
 * `@Public` 豁免 JWT；静态 token 守卫仍生效（与 workspace/files 面同口径）；
 * PERMISSION_INVALID 稳定码经异常过滤器入 message 信封（单条撤销幂等
 * no-op 不报错——桌面既定语义）。
 */
@ApiTags('审批记忆')
@Public()
@ApiExtraModels(
  PermissionRememberedWireDto,
  PermissionFullGrantWireDto,
  PermissionFullGrantsWireDto,
)
@Controller('permission')
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  @Post('listRemembered')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '已记住工具审批列表（本人空间，createdAt 倒序）' })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(PermissionRememberedWireDto) },
  })
  async listRemembered() {
    return await this.permissionService.listRemembered();
  }

  @Post('revokeRemembered')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '撤销单条工具记忆（幂等 no-op）' })
  @ApiWrappedOk()
  async revokeRemembered(@Body() dto: PermissionRevokeRememberedDto) {
    return await this.permissionService.revokeRemembered(dto.id);
  }

  @Post('revokeAllRemembered')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '全部撤销工具记忆（返回撤销条数）' })
  @ApiWrappedOk(inlineSchemas.revokedCount)
  async revokeAllRemembered() {
    return await this.permissionService.revokeAllRemembered();
  }

  @Post('listFullGrants')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '完全授权会话总览（运行态）' })
  @ApiWrappedOk(PermissionFullGrantsWireDto)
  async listFullGrants() {
    return await this.permissionService.listFullGrants();
  }

  @Post('revokeAllFull')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '一键收回全部完全授权（返回收回条数）' })
  @ApiWrappedOk(inlineSchemas.revokedCount)
  async revokeAllFull() {
    return await this.permissionService.revokeAllFull();
  }
}
