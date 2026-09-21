import { handleUser } from "../../../commons/ipc-user";
import prisma from "../../../commons/prisma-client";
import type { PrismaClient } from "../../../generated/prisma/client";
import { McpManager, parseMcpRow } from "../agent/mcp-manager";
import type {
  McpServerCreateParams,
  McpServerRecord,
  McpServerStatus,
  McpServerUpdateParams,
} from "../../../../src-react/domains/ai/api/mcp.api";

type McpServerRow = NonNullable<
  Awaited<ReturnType<typeof prisma.mcpServer.findFirst>>
>;

/**
 * mcpServer 仓储：CRUD + IPC，并联动 McpManager（Ruling 3）——
 * create(enabled)→connect；update 前后 enabled 变化→setEnabled；delete→setEnabled(false)；
 * reconnect→查行重连。manager 为 undefined（测试）时退化为纯 CRUD。
 * args/env/headers 为 JSON 字符串列：行与 record 均字符串透传，UI 层 parse/stringify
 */
export class McpRepository {
  constructor(
    private readonly prismaClient: PrismaClient = prisma,
    private readonly manager?: McpManager,
  ) {
    this.registerIpcHandlers();
  }

  private toRecord(row: McpServerRow): McpServerRecord {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport as McpServerRecord["transport"],
      command: row.command ?? undefined,
      args: row.args ?? undefined,
      env: row.env ?? undefined,
      url: row.url ?? undefined,
      headers: row.headers ?? undefined,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private registerIpcHandlers() {
    handleUser("mcpServer:list", (_, userId) => this.list(userId));
    handleUser("mcpServer:create", (_, userId, p: McpServerCreateParams) =>
      this.create(p, userId),
    );
    handleUser("mcpServer:update", (_, userId, p: McpServerUpdateParams) =>
      this.update(p, userId),
    );
    handleUser("mcpServer:delete", (_, userId, id: number) =>
      this.delete(id, userId),
    );
    handleUser("mcpServer:reconnect", (_, userId, id: number) =>
      this.reconnect(id, userId),
    );
    handleUser(
      "mcpServer:setEnabled",
      (_, userId, id: number, enabled: boolean) =>
        this.setEnabled(id, enabled, userId),
    );
    handleUser("mcpServer:statuses", (_, userId) => this.statuses(userId));
  }

  /** 校验服务器记录归当前用户（不存在与他人所有同报错） */
  private async assertOwned(id: number, userId: number): Promise<void> {
    const row = await this.prismaClient.mcpServer.findFirst({
      where: { id, userId },
    });
    if (!row) {
      throw new Error("MCP_SERVER_MISSING");
    }
  }

  async list(userId: number): Promise<McpServerRecord[]> {
    return (
      await this.prismaClient.mcpServer.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      })
    ).map((row) => this.toRecord(row));
  }

  async create(
    p: McpServerCreateParams,
    userId: number,
  ): Promise<McpServerRecord> {
    const row = await this.prismaClient.mcpServer.create({
      data: {
        name: p.name,
        transport: p.transport,
        command: p.command,
        args: p.args,
        env: p.env,
        url: p.url,
        headers: p.headers,
        enabled: p.enabled,
        userId,
      },
    });
    // 新建即启用：立即连接并注册工具（连接失败由 manager 记 error 状态，不阻塞创建）；
    // fire-and-forget——connect 内部不抛错，catch 仅为类型完备
    if (this.manager && row.enabled) {
      void this.manager.connect(parseMcpRow(row)).catch(() => {});
    }
    return this.toRecord(row);
  }

  async update(
    p: McpServerUpdateParams,
    userId: number,
  ): Promise<McpServerRecord> {
    await this.assertOwned(p.id, userId);
    const before = await this.prismaClient.mcpServer.findUnique({
      where: { id: p.id },
    });
    const row = await this.prismaClient.mcpServer.update({
      where: { id: p.id },
      data: {
        name: p.name,
        transport: p.transport,
        command: p.command,
        args: p.args,
        env: p.env,
        url: p.url,
        headers: p.headers,
        enabled: p.enabled,
      },
    });
    // 仅启停联动生命周期；改连接参数后的重连由用户显式 reconnect 触发
    if (this.manager && before && before.enabled !== row.enabled) {
      await this.manager.setEnabled(parseMcpRow(row), row.enabled);
    }
    // 改名后旧前缀工具不再被 connect/setEnabled 触达，显式清理防孤儿注册
    if (this.manager && before && before.name !== row.name) {
      this.manager.unregisterByName(before.name);
    }
    return this.toRecord(row);
  }

  async delete(id: number, userId: number): Promise<void> {
    await this.assertOwned(id, userId);
    const row = await this.prismaClient.mcpServer.delete({ where: { id } });
    // 行已删，停用只为注销工具并断开（unregister + close），防残留子进程
    if (this.manager) {
      await this.manager.setEnabled(parseMcpRow(row), false);
    }
  }

  async setEnabled(
    id: number,
    enabled: boolean,
    userId: number,
  ): Promise<void> {
    await this.assertOwned(id, userId);
    const before = await this.prismaClient.mcpServer.findUnique({
      where: { id },
    });
    const row = await this.prismaClient.mcpServer.update({
      where: { id },
      data: { enabled },
    });
    // 冗余启停短路：目标状态与当前一致时不联动（重复 enable 会经 connect 重注册工具）
    if (this.manager && before && before.enabled !== enabled) {
      await this.manager.setEnabled(parseMcpRow(row), enabled);
    }
  }

  /** 查行重连（连接参数修改后的手动刷新入口） */
  async reconnect(id: number, userId: number): Promise<void> {
    await this.assertOwned(id, userId);
    const row = await this.prismaClient.mcpServer.findUnique({
      where: { id },
    });
    if (!row) {
      throw new Error("MCP_SERVER_MISSING");
    }
    if (this.manager) {
      await this.manager.reconnect(parseMcpRow(row));
    }
  }

  /** 连接进程为主进程级共享池，状态按用户可见的服务器集过滤 */
  async statuses(userId: number): Promise<McpServerStatus[]> {
    if (!this.manager) {
      return [];
    }
    const rows = await this.prismaClient.mcpServer.findMany({
      where: { userId },
      select: { id: true },
    });
    const owned = new Set(rows.map((row) => row.id));
    return this.manager.getStatuses().filter((status) => owned.has(status.id));
  }
}
