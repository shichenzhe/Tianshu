import { Injectable } from '@nestjs/common';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { PrismaService } from 'src/commons/database/prisma.service';
import { WorkspaceIdDto } from './dto/workspace-id.dto';
import { WorkspaceSaveDto } from './dto/workspace-save.dto';

/** 工作空间概要四字段（wire 契约——id/name/directoryPath/defaultModelId） */
export interface WorkspaceBrief {
  id: number;
  name: string;
  directoryPath: string | null;
  defaultModelId: number | null;
}

/**
 * 工作空间服务（只读概要 HD-A1 + A8 写面，spec 2026-10-26 §1.2）：单 UI
 * 远程态侧栏分组树数据源 + 移动端管理写面——概要四字段（id/name/
 * directoryPath/defaultModelId），icon/审计字段/writeApprovedAt/projectId
 * 不外露。伴生单用户读写自有行（他人行不透）。写面级联语义与桌面对齐：
 * 删 message→session→workspace 行，不删磁盘。
 * 稳定码沿 graph.service WORKSPACE_NOT_FOUND 先例（裸 Error 码经
 * HttpExceptionFilter 入 message 信封，控制端按码判）：WORKSPACE_INVALID=
 * name 空等语义不合法。
 */
@Injectable()
export class WorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  async query(): Promise<WorkspaceBrief[]> {
    return (
      await this.prisma.workspace.findMany({
        where: { userId: COMPANION_USER_ID },
        select: {
          id: true,
          name: true,
          directoryPath: true,
          defaultModelId: true,
        },
        orderBy: { id: 'asc' },
      })
    ).map((row) => this.toBrief(row));
  }

  /** 新建空间（库行创建，不涉宿主目录——directoryPath 写面属桌面端） */
  async create(dto: WorkspaceSaveDto): Promise<WorkspaceBrief> {
    const name = dto.name?.trim();
    if (!name) {
      throw new Error('WORKSPACE_INVALID');
    }
    const row = await this.prisma.workspace.create({
      data: {
        name,
        userId: COMPANION_USER_ID,
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.defaultModelId !== undefined
          ? { defaultModelId: dto.defaultModelId }
          : {}),
      },
    });
    return this.toBrief(row);
  }

  /** 更新（归属校验后全量字段写；未传键保持原值；id 缺省视为载荷不合法） */
  async update(dto: WorkspaceSaveDto): Promise<WorkspaceBrief> {
    if (dto.id == null) {
      throw new Error('WORKSPACE_INVALID');
    }
    if (dto.name !== undefined && dto.name.trim() === '') {
      throw new Error('WORKSPACE_INVALID');
    }
    await this.assertOwned(dto.id);
    const row = await this.prisma.workspace.update({
      where: { id: dto.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.defaultModelId !== undefined
          ? { defaultModelId: dto.defaultModelId }
          : {}),
      },
    });
    return this.toBrief(row);
  }

  /** 删除：桌面同款硬级联（消息→会话→工作空间行），不删磁盘文件 */
  async delete(dto: WorkspaceIdDto): Promise<null> {
    await this.assertOwned(dto.id);
    const sessions = await this.prisma.sessionRecord.findMany({
      where: { workspaceId: dto.id },
      select: { id: true },
    });
    await this.prisma.messageRecord.deleteMany({
      where: { sessionId: { in: sessions.map((s) => s.id) } },
    });
    await this.prisma.sessionRecord.deleteMany({
      where: { workspaceId: dto.id },
    });
    await this.prisma.workspace.delete({ where: { id: dto.id } });
    return null;
  }

  /** 归属校验：不存在/他人所有同报 WORKSPACE_NOT_FOUND（不泄露存在性） */
  private async assertOwned(id: number): Promise<void> {
    const row = await this.prisma.workspace.findFirst({
      where: { id, userId: COMPANION_USER_ID },
    });
    if (!row) {
      throw new Error('WORKSPACE_NOT_FOUND');
    }
  }

  private toBrief(row: {
    id: number;
    name: string;
    directoryPath: string | null;
    defaultModelId: number | null;
  }): WorkspaceBrief {
    return {
      id: row.id,
      name: row.name,
      directoryPath: row.directoryPath,
      defaultModelId: row.defaultModelId,
    };
  }
}
