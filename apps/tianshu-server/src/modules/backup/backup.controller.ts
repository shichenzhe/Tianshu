import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsBase64,
  IsHexadecimal,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ApiOperation,
  ApiProperty,
  ApiTags,
  type SchemaObject,
} from '@nestjs/swagger';
import {
  BACKUP_ADMIN_ONLY,
  type BackupChunkRequest,
  type BackupClaimRequest,
  type BackupCreateInvitesRequest,
  type BackupCreateRequest,
  type BackupDownloadRequest,
} from '@tianshu/protocol';
import { ApiWrappedOk } from 'src/commons/swagger/wrapped-response';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { BackupService } from './backup.service';
import { BackupGuard, type BackupIdentity } from './backup.guard';
import { BackupRegistry } from './backup-registry';

/** guard 注入身份的读取口（BackupGuard 已保证非 claim 路径必注入） */
const identityOf = (req: unknown): BackupIdentity =>
  (req as { backupIdentity: BackupIdentity }).backupIdentity;

/** sha256 hex 定长（整包与分块同规） */
const sha256Schema = { type: 'string', example: 'e3b0c442...' };

class CreateDto implements BackupCreateRequest {
  @ApiProperty({ description: '应用版本' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  appVersion: string;

  @ApiProperty({ description: '桌面端数据库 schema 版本' })
  @IsInt()
  @Min(1)
  schemaVersion: number;

  @ApiProperty({ description: '整包字节数（≤2GB 由 service 终验）' })
  @IsInt()
  @Min(1)
  fileSize: number;

  @ApiProperty({ description: '整包 sha256（hex 64 位）' })
  @IsString()
  @Length(64, 64)
  @IsHexadecimal()
  sha256: string;

  @ApiProperty({ description: '分块总数（≥1，service 层同校验双保险）' })
  @IsInt()
  @Min(1)
  chunkCount: number;

  @ApiProperty({ description: '备注', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;

  @ApiProperty({ description: '设备名', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceName?: string;
}

class ChunkDto implements Omit<BackupChunkRequest, 'id'> {
  @ApiProperty({ description: '分块序号（0 起，须连续提交）' })
  @IsInt()
  @Min(0)
  seq: number;

  @ApiProperty({ description: '原始字节 base64（≤4MB 解码前）' })
  @IsBase64()
  data: string;

  @ApiProperty({ description: '分块 sha256（hex 64 位）' })
  @IsString()
  @Length(64, 64)
  @IsHexadecimal()
  chunkSha256: string;
}

class DownloadDto implements Omit<BackupDownloadRequest, 'id'> {
  @ApiProperty({ description: '分块序号（0 起）' })
  @IsInt()
  @Min(0)
  seq: number;
}

/** 邀请码申领（spec 2026-10-28 §2）：claim 走 guard 豁免路径，单凭一次性
 *  邀请码自鉴权（正则 [A-Z2-9] 宽于生成字符集——格式只挡明显垃圾，伪码
 *  由 registry 核销时 BACKUP_INVITE_INVALID 自拒）；导出供端点直测验
 *  装饰器在场 */
export class ClaimDto implements BackupClaimRequest {
  @ApiProperty({ description: '邀请码（TS- 前缀 8 位防混淆字符集）' })
  @IsString()
  @Matches(/^TS-[A-Z2-9]{8}$/)
  inviteCode: string;

  @ApiProperty({ description: '设备名（1-64 位字母数字下划线连字符）' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  deviceName: string;
}

/** 批量生成邀请码（admin）：count 缺省 1 由 handler 收敛（spec §2） */
export class CreateInvitesDto implements BackupCreateInvitesRequest {
  @ApiProperty({ description: '生成数量（1-50）', required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  count?: number;

  @ApiProperty({ description: '备注', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

/** 邀请码记录行（create/list 共用；明文存 option 表——admin 需复看未用
 *  码，能读库者即 server 主人级威胁，spec §2 裁定） */
const inviteRecordSchema: SchemaObject = {
  type: 'object',
  properties: {
    code: { type: 'string', example: 'TS-AB2XYZ9H' },
    note: { type: 'string', nullable: true },
    createdAt: { type: 'string' },
    usedAt: { type: 'string', nullable: true },
    usedBy: { type: 'string', nullable: true },
  },
  required: ['code', 'createdAt'],
};

/** 已申领设备行（tokenHash 永不外吐——registry.listClients 收口） */
const clientRecordSchema: SchemaObject = {
  type: 'object',
  properties: {
    clientId: { type: 'string' },
    createdAt: { type: 'string' },
    invitedNote: { type: 'string', nullable: true },
  },
  required: ['clientId', 'createdAt'],
};

/** 撤销/踢除统一回执 */
const removedResultSchema: SchemaObject = {
  type: 'object',
  properties: { removed: { type: 'boolean', example: true } },
  required: ['removed'],
};

/**
 * 备份控制器（spec 2026-10-27 §2 + 2026-10-28 多用户扩展）：全 POST——
 * 备份六端点 service 直透（业务错由 BackupService 抛 BusinessException
 * 兜底）；claim/invites/clients 直透 BackupRegistry：claim 走 guard 豁免
 * 路径（单要素一次性邀请码自鉴权，无 identity 注入——勿用 identityOf），
 * invites/clients 管理面 requireAdmin 门禁。三层鉴权实况（终审 C1）：
 * 出厂 config.yml auth.global=true 注册全局 JwtAuthGuard——类级 @Public()
 * 豁免 JWT 层（session/provider/graph/webhook 同先例），缺它则静态 token
 * （TIANSHU_TOKEN/TIANSHU_BACKUP_TOKEN）与 clientToken 全被 401「登录已
 * 过期」拦死；第一层 StaticTokenGuard 对 `${contextPath}/backup/` 前缀
 * 豁免（token.guard.ts）；第二层 BackupGuard fail-closed 兜底（注入
 * backupIdentity，备份六端点透传 service 做 owner 隔离）：
 * TIANSHU_BACKUP_TOKEN 设置时只认它，未设回落 TIANSHU_TOKEN，注册表
 * clientToken 优先识别。
 */
@ApiTags('备份')
@Public()
@UseGuards(BackupGuard)
@Controller('backup')
export class BackupController {
  constructor(
    private readonly backupService: BackupService,
    private readonly registry: BackupRegistry,
  ) {}

  /** 管理面门禁（spec 2026-10-28 §2）：非 admin 一律 BACKUP_ADMIN_ONLY */
  private requireAdmin(identity: BackupIdentity): void {
    if (identity.kind !== 'admin') {
      throw new BusinessException('仅管理员可操作', BACKUP_ADMIN_ONLY);
    }
  }

  @Post('create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登记备份（服务端生成 id）' })
  @ApiWrappedOk({
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid' } },
    required: ['id'],
  })
  create(@Req() req: unknown, @Body() dto: CreateDto) {
    return this.backupService.create(dto, identityOf(req));
  }

  @Post(':id/chunk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '上传分块（收块即验 hash）' })
  @ApiWrappedOk({
    type: 'object',
    properties: { received: { type: 'number' } },
    required: ['received'],
  })
  chunk(@Req() req: unknown, @Param('id') id: string, @Body() dto: ChunkDto) {
    return this.backupService.putChunk({ id, ...dto }, identityOf(req));
  }

  @Post(':id/commit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '终验定稿' })
  @ApiWrappedOk({
    type: 'object',
    properties: {
      fileSize: { type: 'number' },
      sha256: sha256Schema,
    },
    required: ['fileSize', 'sha256'],
  })
  commit(@Req() req: unknown, @Param('id') id: string) {
    return this.backupService.commit(id, identityOf(req));
  }

  @Post('list')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '备份列表' })
  @ApiWrappedOk({
    type: 'object',
    properties: {
      backups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            createdAt: { type: 'string' },
            appVersion: { type: 'string' },
            schemaVersion: { type: 'number' },
            fileSize: { type: 'number' },
            sha256: sha256Schema,
            chunkCount: { type: 'number' },
            note: { type: 'string', nullable: true },
            deviceName: { type: 'string', nullable: true },
            status: { type: 'string', enum: ['uploading', 'ready'] },
          },
          required: [
            'id',
            'createdAt',
            'appVersion',
            'schemaVersion',
            'fileSize',
            'sha256',
            'chunkCount',
            'status',
          ],
        },
      },
    },
    required: ['backups'],
  })
  list(@Req() req: unknown) {
    return this.backupService.list(identityOf(req));
  }

  @Post(':id/download')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '分块下载' })
  @ApiWrappedOk({
    type: 'object',
    properties: {
      data: { type: 'string' },
      totalChunks: { type: 'number' },
    },
    required: ['data', 'totalChunks'],
  })
  download(
    @Req() req: unknown,
    @Param('id') id: string,
    @Body() dto: DownloadDto,
  ) {
    return this.backupService.download({ id, seq: dto.seq }, identityOf(req));
  }

  @Post(':id/delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除备份' })
  @ApiWrappedOk({
    type: 'object',
    properties: { deleted: { type: 'boolean', example: true } },
    required: ['deleted'],
  })
  delete(@Req() req: unknown, @Param('id') id: string) {
    return this.backupService.remove(id, identityOf(req));
  }

  // —— 多用户扩展（spec 2026-10-28）：claim 申领 + invites/clients 管理面 ——

  /** claim 不取 identity（guard 豁免路径不注入——identityOf 非空假设在
   *  此不成立）：鉴权即单要素一次性邀请码核销本身（正则 [A-Z2-9] 容收
   *  34 字符宽于生成集 31 字符——伪码由 registry 核销时自拒；31^8≈8.5e11
   *  组合空间、核销即死） */
  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '邀请码申领设备身份（clientToken 仅此一次回显）' })
  @ApiWrappedOk({
    type: 'object',
    properties: {
      clientId: { type: 'string' },
      clientToken: { type: 'string', description: '后续调用凭据（不再回显）' },
    },
    required: ['clientId', 'clientToken'],
  })
  claim(@Body() dto: ClaimDto) {
    return this.registry.claimInvite(dto.inviteCode, dto.deviceName);
  }

  @Post('invites/create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '批量生成邀请码（admin）' })
  @ApiWrappedOk({
    type: 'object',
    properties: { invites: { type: 'array', items: inviteRecordSchema } },
    required: ['invites'],
  })
  async createInvites(@Req() req: unknown, @Body() dto: CreateInvitesDto) {
    this.requireAdmin(identityOf(req));
    return this.registry.createInvites(dto.count ?? 1, dto.note);
  }

  @Post('invites/list')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '邀请码列表（admin，含核销状态）' })
  @ApiWrappedOk({
    type: 'object',
    properties: { invites: { type: 'array', items: inviteRecordSchema } },
    required: ['invites'],
  })
  async listInvites(@Req() req: unknown) {
    this.requireAdmin(identityOf(req));
    return { invites: await this.registry.listInvites() };
  }

  @Post('invites/:code/delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '撤销邀请码（admin，不拒删已用码）' })
  @ApiWrappedOk(removedResultSchema)
  async deleteInvite(@Req() req: unknown, @Param('code') code: string) {
    this.requireAdmin(identityOf(req));
    return this.registry.removeInvite(code);
  }

  @Post('clients/list')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '已申领设备列表（admin，不回显 token）' })
  @ApiWrappedOk({
    type: 'object',
    properties: { clients: { type: 'array', items: clientRecordSchema } },
    required: ['clients'],
  })
  async listClients(@Req() req: unknown) {
    this.requireAdmin(identityOf(req));
    return { clients: await this.registry.listClients() };
  }

  @Post('clients/:clientId/delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '踢除设备（admin，该设备名可重新申领）' })
  @ApiWrappedOk(removedResultSchema)
  async deleteClient(@Req() req: unknown, @Param('clientId') clientId: string) {
    this.requireAdmin(identityOf(req));
    return this.registry.removeClient(clientId);
  }
}
