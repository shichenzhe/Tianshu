import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { PrismaService } from 'src/commons/database/prisma.service';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBusService,
  ) {}

  /** 批③（2026-11-01）：写后发 workspace.changed 列表级刷新信号（SSE/relay
   *  出口扇出给已连控制端重拉——session.updated 同款先例） */
  private publishChanged(): void {
    this.bus.publish({ type: 'workspace.changed', payload: {} });
  }

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

  /** 新建空间（库行创建，不涉宿主目录——directoryPath 写面属桌面端）。
   *  重名（schema @@unique(userId,name)）收口稳定码：裸 P2002 冒泡经
   *  filter 归 code 5000 + 原始报错文本，移动端不可判读 */
  async create(dto: WorkspaceSaveDto): Promise<WorkspaceBrief> {
    const name = dto.name?.trim();
    if (!name) {
      throw new Error('WORKSPACE_INVALID');
    }
    try {
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
      this.publishChanged();
      return this.toBrief(row);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new Error('WORKSPACE_NAME_DUPLICATE');
      }
      throw error;
    }
  }

  /** 更新（归属校验后全量字段写；未传键保持原值；id 缺省视为载荷不合法；
   *  重名同 create 收口稳定码） */
  async update(dto: WorkspaceSaveDto): Promise<WorkspaceBrief> {
    if (dto.id == null) {
      throw new Error('WORKSPACE_INVALID');
    }
    if (dto.name !== undefined && dto.name.trim() === '') {
      throw new Error('WORKSPACE_INVALID');
    }
    await this.assertOwned(dto.id);
    try {
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
      this.publishChanged();
      return this.toBrief(row);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new Error('WORKSPACE_NAME_DUPLICATE');
      }
      throw error;
    }
  }

  /** 删除：桌面同款硬级联（消息→会话→工作空间行），不删磁盘文件。
   *  事务化（三 delete 中途失败不留半删态）+ 清 toolPermission 记忆行
   *  （防 permission/listRemembered 残留 workspaceName 回落 #id 的孤儿行） */
  async delete(dto: WorkspaceIdDto): Promise<null> {
    await this.assertOwned(dto.id);
    await this.prisma.$transaction(async (tx) => {
      const sessions = await tx.sessionRecord.findMany({
        where: { workspaceId: dto.id },
        select: { id: true },
      });
      await tx.messageRecord.deleteMany({
        where: { sessionId: { in: sessions.map((s) => s.id) } },
      });
      await tx.sessionRecord.deleteMany({
        where: { workspaceId: dto.id },
      });
      await tx.toolPermission.deleteMany({
        where: { workspaceId: dto.id },
      });
      await tx.workspace.delete({ where: { id: dto.id } });
    });
    this.publishChanged();
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
