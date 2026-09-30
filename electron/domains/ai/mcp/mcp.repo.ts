import { shell } from "electron";
import { handleUser } from "../../../commons/ipc-user";
import prisma from "../../../commons/prisma-client";
import type { PrismaClient } from "../../../generated/prisma/client";
import { McpManager, parseMcpRow } from "../agent/mcp-manager";
import { syncParamsChanged } from "../../../../src-react/domains/ai/mcp/lib/mcp-json";
import type { McpServerSyncEntry } from "../../../../src-react/domains/ai/mcp/lib/mcp-json";
import type {
  McpServerCreateParams,
  McpServerRecord,
  McpServerStatus,
  McpServerSyncResult,
  McpServerUpdateParams,
} from "../../../../src-react/domains/ai/api/mcp.api";

/** MCP Hub 外链地址（spec 假设：占位可替换；渲染层不传 URL 防任意跳转） */
const MCP_HUB_URL = "https://mcp.so";

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
    handleUser(
      "mcpServer:sync",
      (_, userId, entries: Record<string, McpServerSyncEntry>) =>
        this.sync(entries, userId),
    );
    handleUser("mcpServer:openHub", () => this.openHub());
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

  /** MCP Hub 外链（主进程写死地址，渲染层不可传 URL） */
  private async openHub(): Promise<void> {
    await shell.openExternal(MCP_HUB_URL);
  }

  /**
   * JSON 编辑器保存：与本人现有行按 name 全量 diff——
   * JSON 有/库无→create（enabled: true）；JSON 无/库有→delete；
   * 同名参数变→update（enabled 保留库值，参数变更不自动重连，语义同 update）。
   * 逐条复用 create/update/delete（内含 userId 归属校验与 McpManager 联动）；
   * 不包 $transaction——create 的 connect 为 fire-and-forget 不入事务，
   * 中途失败由下次 sync 重新 diff 自愈（编辑器内容即用户意图）
   */
  async sync(
    entries: Record<string, McpServerSyncEntry>,
    userId: number,
  ): Promise<McpServerSyncResult> {
    const rows = await this.prismaClient.mcpServer.findMany({
      where: { userId },
    });
    const byName = new Map(rows.map((row) => [row.name, row]));
    let created = 0;
    let updated = 0;
    let deleted = 0;
    for (const [name, entry] of Object.entries(entries)) {
      const existing = byName.get(name);
      if (!existing) {
        await this.create({ name, ...entry, enabled: true }, userId);
        created += 1;
        continue;
      }
      if (syncParamsChanged(existing, entry)) {
        await this.update(
          {
            id: existing.id,
            name,
            transport: entry.transport,
            // 可空字段缺省显式置 null：undefined 会被 Prisma 跳过致旧值残留
            // （对齐 McpServerDialog 编辑态清空传 null 的差量语义）
            command: entry.command ?? null,
            args: entry.args ?? null,
            env: entry.env ?? null,
            url: entry.url ?? null,
            headers: entry.headers ?? null,
            enabled: existing.enabled,
          },
          userId,
        );
        updated += 1;
      }
      byName.delete(name);
    }
    for (const row of byName.values()) {
      await this.delete(row.id, userId);
      deleted += 1;
    }
    return { created, updated, deleted };
  }
}
