import { Body, Controller, Post, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WorkspaceBriefDto } from './dto/workspace-brief.dto';
import { ApiWrappedOk } from 'src/commons/swagger/wrapped-response';
import { ApiExtraModels, getSchemaPath } from '@nestjs/swagger';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { WorkspaceIdDto } from './dto/workspace-id.dto';
import { WorkspaceSaveDto } from './dto/workspace-save.dto';
import { WorkspaceService } from './workspace.service';

/**
 * 工作空间面控制器（HD-A1 只读列表 + A8 写面三端点，spec 2026-10-26）：
 * 概要四字段透出；写面级联语义与桌面对齐（删 message→session→workspace
 * 行，不删磁盘）；稳定码 WORKSPACE_NOT_FOUND/WORKSPACE_INVALID 经异常
 * 过滤器入 message 信封。`@Public` 豁免 JWT；静态 token 守卫仍生效
 * （与 assistant/skills 面同口径）。
 */
@ApiTags('工作空间')
@Public()
@ApiExtraModels(WorkspaceBriefDto)
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  /**
   * 工作空间全量列表（概要四字段——id/name/directoryPath/defaultModelId）
   */
  @Post('query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '工作空间列表（概要）' })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(WorkspaceBriefDto) },
  })
  async query() {
    return await this.workspaceService.query();
  }

  /**
   * 新建工作空间（库行创建，不涉宿主目录；概要四字段回传）
   */
  @Post('create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '新建工作空间' })
  @ApiWrappedOk(WorkspaceBriefDto)
  async create(@Body() dto: WorkspaceSaveDto) {
    return await this.workspaceService.create(dto);
  }

  /**
   * 更新工作空间（重命名/图标/默认模型；归属校验）
   */
  @Post('update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '更新工作空间' })
  @ApiWrappedOk(WorkspaceBriefDto)
  async update(@Body() dto: WorkspaceSaveDto) {
    return await this.workspaceService.update(dto);
  }

  /**
   * 删除工作空间（硬级联：消息→会话→工作空间行，不删磁盘文件）
   */
  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除工作空间（级联，不可恢复）' })
  @ApiWrappedOk()
  async delete(@Body() dto: WorkspaceIdDto) {
    return await this.workspaceService.delete(dto);
  }
}
