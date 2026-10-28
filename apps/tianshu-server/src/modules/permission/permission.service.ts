/**
 * 审批记忆服务（A10 批，spec 2026-10-26 §1.2）：permission 五端点业务面——
 * remembered 面（toolPermission 表读删，按伴生用户空间过滤/级联全删）+
 * full 面（会话级运行态列表/一键清空，ChatRunnerService 同源 PermissionStore）。
 * 语义与桌面被控面对齐：单条撤销不存在/非本人幂等成功（桌面 no-op 既定
 * 语义，无 NOT_FOUND）；revokeAll 返回实际撤销条数（桌面 IPC 返 void，
 * 远端面增强 spec §1.1）；full grants 形状 {sessionId,title}（标题查询
 * 缺行回落「会话 #id」，桌面口径）。
 */
import { Injectable } from '@nestjs/common';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { PrismaService } from 'src/commons/database/prisma.service';
import { ChatRunnerService } from 'src/core/chat-runner.service';
import type {
  PermissionFullGrantsResult,
  PermissionRememberedItem,
  PermissionRevokeResult,
} from '@tianshu/protocol';

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chatRunner: ChatRunnerService,
  ) {}

  /** 已记住工具列表：仅伴生用户空间，createdAt 倒序；空间名 join 缺行
   *  回落 `#workspaceId`（桌面口径） */
  async listRemembered(): Promise<PermissionRememberedItem[]> {
    const workspaces = await this.ownedWorkspaces();
    const nameById = new Map(workspaces.map((w) => [w.id, w.name]));
    const rows = await this.prisma.toolPermission.findMany({
      where: { workspaceId: { in: workspaces.map((w) => w.id) } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      workspaceName: nameById.get(row.workspaceId) ?? `#${row.workspaceId}`,
      toolName: row.toolName,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** 单条撤销：不存在/非本人空间幂等成功返 null（桌面既定语义） */
  async revokeRemembered(id: number): Promise<null> {
    this.assertPositiveId(id);
    const workspaces = await this.ownedWorkspaces();
    await this.prisma.toolPermission.deleteMany({
      where: { id, workspaceId: { in: workspaces.map((w) => w.id) } },
    });
    return null;
  }

  /** 全部撤销：按伴生用户全部空间 deleteMany，返回实际撤销条数 */
  async revokeAllRemembered(): Promise<PermissionRevokeResult> {
    const workspaces = await this.ownedWorkspaces();
    const { count } = await this.prisma.toolPermission.deleteMany({
      where: { workspaceId: { in: workspaces.map((w) => w.id) } },
    });
    return { revoked: count };
  }

  /** 完全授权总览：会话级运行态（全局，与桌面被控面同口径），标题缺行
   *  回落「会话 #id」 */
  async listFullGrants(): Promise<PermissionFullGrantsResult> {
    const sessionIds = this.chatRunner.listFullGrantSessionIds();
    const rows = await this.prisma.sessionRecord.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, title: true },
    });
    const titleById = new Map(rows.map((r) => [r.id, r.title]));
    return {
      grants: sessionIds.map((sessionId) => ({
        sessionId,
        title: titleById.get(sessionId) ?? `会话 #${sessionId}`,
      })),
    };
  }

  /** 一键收回全部 full 会话（收紧无泄露面），返回实际收回条数 */
  async revokeAllFull(): Promise<PermissionRevokeResult> {
    return { revoked: this.chatRunner.revokeAllFullGrants() };
  }

  /** 入参语义守卫：非正整数 → PERMISSION_INVALID（稳定码经 message 信封，
   *  与桌面 face 同码） */
  private assertPositiveId(id: number): void {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('PERMISSION_INVALID');
    }
  }

  /** 伴生用户全部工作空间（id/name——记忆归属过滤 + 取名数据源） */
  private ownedWorkspaces(): Promise<Array<{ id: number; name: string }>> {
    return this.prisma.workspace.findMany({
      where: { userId: COMPANION_USER_ID },
      select: { id: true, name: true },
    });
  }
}
