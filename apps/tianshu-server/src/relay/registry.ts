import type { WebSocket } from 'ws';
import type { RelayFrame } from '@tianshu/protocol';

// 老 import 链（relay-main 等）经本模块取型保持不变
export type { RelayFrame } from '@tianshu/protocol';

/** 有界缓冲默认值：积压超过该帧数即拆连接（慢消费者防内存膨胀） */
export const DEFAULT_MAX_BUFFER_FRAMES = 200;

/** 中继帧类型单源自 @tianshu/protocol（判别联合含 ping/pong 活性帧）：
 *  曾本地定义六值宽松联合（无 ping/pong）——wire 契约双份分叉，
 *  protocol 加 kind 时 server 无编译反馈（2026-11-01 审查架构债项）。
 *  relay 为透传面不解释业务负载，转发逻辑不依赖 kind 白名单
 *  （relay-main 的 kind !== 'register' 兜底），联合收窄零行为变化 */

/** registry 依赖的最小 socket 面（ws.WebSocket 结构满足；单测可注入假 socket） */
export interface PeerSocket {
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

const SEND_FAIL_CODE = 1011;

/** 租户连接计数（server/client 分计——配额闸数据面，Task 4）。
 *  键名与角色字面量一致（'server' | 'client'），adjustTenant/
 *  tenantConnCount 按角色直接索引 */
interface TenantCount {
  server: number;
  client: number;
}

/** 配对注册表：connectionId → server ws + 已配对 client ws 集合。
 *  多租户批 Task 4 起内嵌租户簿记（顶号归属 + 连接计数），relay-main
 *  只消费三校验点返回值，不感知簿记细节；tenantId 缺省（static 模式）
 *  时三校验全旁路，行为与单租户现状逐字节一致 */
export class RelayRegistry {
  private servers = new Map<string, PeerSocket>();
  private clients = new Map<string, Set<PeerSocket>>();
  private buffered = new Map<PeerSocket, number>();
  /** connectionId → 注册 server 的租户（顶号归属判定） */
  private serverTenants = new Map<string, string | undefined>();
  /** client ws → 其 attach 记账租户（notifyClose/dropServer 回落用） */
  private clientTenants = new Map<PeerSocket, string | undefined>();
  /** connectionId → 注册 server 的 access key（kick 按 ak 反查） */
  private serverAks = new Map<string, string | undefined>();
  /** client ws → 其 attach 记账 ak（kick 按 ak 反查） */
  private clientAks = new Map<PeerSocket, string | undefined>();
  /** tenantId → 在线连接计数（配额闸门） */
  private tenantCounts = new Map<string, TenantCount>();

  constructor(
    private readonly maxBufferFrames: number = DEFAULT_MAX_BUFFER_FRAMES,
  ) {}

  hasServer(connectionId: string): boolean {
    return this.servers.has(connectionId);
  }

  /** 注册被控端；同租户（或租户缺省）同 id 重复注册视为重连，顶掉旧连接
   *  （先占位再关旧，杜绝 close 事件抢跑）；异租户已占 id → id-conflict
   *  （顶号防护，不动现有注册——relay 映射 close 4006）；ak 为该连接的
   *  凭证维度（kick 按 ak 反查用，缺省不记账） */
  registerServer(
    connectionId: string,
    ws: PeerSocket,
    tenantId?: string,
    ak?: string,
  ): 'ok' | 'id-conflict' {
    const previous = this.servers.get(connectionId);
    const previousTenant = this.serverTenants.get(connectionId);
    // 顶号闸：双方租户均在场且不同 → 拒绝（单侧缺省 = static 旁路）
    if (
      previous &&
      tenantId !== undefined &&
      previousTenant !== undefined &&
      previousTenant !== tenantId
    )
      return 'id-conflict';
    if (previous === ws) return 'ok'; // 同连接重复注册幂等（不重复记账）
    this.servers.set(connectionId, ws);
    this.serverTenants.set(connectionId, tenantId);
    this.serverAks.set(connectionId, ak);
    if (tenantId !== undefined) this.adjustTenant(tenantId, 'server', 1);
    if (previous) {
      // 旧连接被顶号：其 close 事件的 dropServer 会被身份守卫拦截，
      // 计数回落在此承担（previousTenant 与新租户不同的旁路替换同路径）
      if (previousTenant !== undefined)
        this.adjustTenant(previousTenant, 'server', -1);
      previous.close(4000, 'replaced');
    }
    return 'ok';
  }

  /** client open 帧触发配对；server 未注册 not-found（现状 4004）、
   *  跨租户 forbidden（配对授权，relay 映射 4007）、其余 ok；ak 为该
   *  连接的凭证维度（kick 按 ak 反查用，缺省不记账） */
  attachClient(
    connectionId: string,
    ws: PeerSocket,
    callerTenantId?: string,
    ak?: string,
  ): 'ok' | 'not-found' | 'forbidden' {
    if (!this.hasServer(connectionId)) return 'not-found';
    const serverTenant = this.serverTenants.get(connectionId);
    // attach 授权闸：双方租户均在场且不同 → 拒绝（单侧缺省 = 旁路）
    if (
      callerTenantId !== undefined &&
      serverTenant !== undefined &&
      serverTenant !== callerTenantId
    )
      return 'forbidden';
    const set = this.clients.get(connectionId) ?? new Set<PeerSocket>();
    const isNew = !set.has(ws);
    set.add(ws);
    this.clients.set(connectionId, set);
    if (isNew) {
      // 重开已配对目标不重复记账（relay-main 换目标前必经 notifyClose）
      this.clientTenants.set(ws, callerTenantId);
      this.clientAks.set(ws, ak);
      if (callerTenantId !== undefined)
        this.adjustTenant(callerTenantId, 'client', 1);
    }
    return 'ok';
  }

  /** 通知 server：client 已接入（转发其 open 帧） */
  notifyOpen(connectionId: string, frame: RelayFrame): void {
    this.sendTo(this.servers.get(connectionId), frame);
  }

  /** client 断开：摘除配对并通知 server close 帧；实际摘除时回落该
   *  client 的租户计数（未配对目标的迟到通知不动簿记） */
  notifyClose(connectionId: string, ws: PeerSocket, frame: RelayFrame): void {
    const set = this.clients.get(connectionId);
    if (set?.has(ws)) {
      set.delete(ws);
      if (set.size === 0) this.clients.delete(connectionId);
      this.releaseClient(ws);
    }
    this.sendTo(this.servers.get(connectionId), frame);
  }

  /** server 断开：仅当该 id 仍持有此连接（未被重注册顶掉）才通知 client 并清理——
   * F1 身份守卫：旧连接被顶掉后其 close 事件不得误拆新注册下的配对 */
  dropServer(connectionId: string, ws: PeerSocket, reason: string): void {
    if (this.servers.get(connectionId) !== ws) return;
    const frame: RelayFrame = { kind: 'close', connectionId, reason };
    for (const client of this.clients.get(connectionId) ?? []) {
      this.sendTo(client, frame);
      client.close(4003, reason);
      // 被 4003 拆除的 client 其后续 close 事件查不到配对集（已随
      // dropServerOnly 清除），计数回落在此承担
      this.releaseClient(client);
    }
    const tenant = this.serverTenants.get(connectionId);
    this.serverTenants.delete(connectionId);
    this.serverAks.delete(connectionId);
    if (tenant !== undefined) this.adjustTenant(tenant, 'server', -1);
    this.dropServerOnly(connectionId);
  }

  /** 连接关闭后的簿记清理（缓冲计数）。client 租户挂账不在此清——
   *  forget 在 close 事件链先于 notifyClose 触发（handleConnection 先
   *  注册），提前删会让 notifyClose 的计数回落扑空漏账；挂账释放由
   *  notifyClose/dropServer 独占承担 */
  forget(ws: PeerSocket): void {
    this.buffered.delete(ws);
  }

  /** 租户在线连接数（配额闸数据面；未记账租户恒 0） */
  tenantConnCount(tenantId: string, role: 'server' | 'client'): number {
    return this.tenantCounts.get(tenantId)?.[role] ?? 0;
  }

  /** connectionId 现注册归属租户（未注册/无租户记账 → undefined）；
   *  配额闸的同租户重连豁免判定面（Ruling P5——relay-main 消费） */
  serverTenant(connectionId: string): string | undefined {
    return this.serverTenants.get(connectionId);
  }

  /** 租户在线连接统计快照（stats 端点数据面）：按 tenantId 字典序排列
   *  保证输出稳定；static 模式无租户记账 → 恒空数组 */
  tenantStats(): Array<{ tenantId: string; servers: number; clients: number }> {
    return [...this.tenantCounts]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tenantId, count]) => ({
        tenantId,
        servers: count.server,
        clients: count.client,
      }));
  }

  /** 按租户/ak 拆除在线匹配连接（kick 端点数据面，Task 5）：反查
   *  serverTenants/serverAks 与 clientTenants/clientAks，簿记经正常断开
   *  同路径回落（notifyClose/dropServer）——计数零泄漏；socket 拆除经
   *  sendClose 回调（relay 侧 terminate 立断）。返回匹配拆除数——
   *  server 拆除时被 dropServer 连带 4003 的配对 client 非目标匹配，
   *  随断开路径清理但不计入。client 先于 server：租户级 kick 逐个拆
   *  配对（server 侧先收 close 帧）再拆 server，计数语义完整 */
  kickTenant(
    target: { tenantId?: string; ak?: string },
    sendClose: (ws: PeerSocket) => void,
  ): number {
    let kicked = 0;
    for (const [connectionId, set] of [...this.clients]) {
      for (const client of [...set]) {
        if (
          !this.matchesKickTarget(
            this.clientTenants.get(client),
            this.clientAks.get(client),
            target,
          )
        )
          continue;
        this.notifyClose(connectionId, client, {
          kind: 'close',
          connectionId,
          reason: 'kicked',
        });
        sendClose(client);
        kicked += 1;
      }
    }
    for (const [connectionId, ws] of [...this.servers]) {
      if (
        !this.matchesKickTarget(
          this.serverTenants.get(connectionId),
          this.serverAks.get(connectionId),
          target,
        )
      )
        continue;
      this.dropServer(connectionId, ws, 'kicked');
      sendClose(ws);
      kicked += 1;
    }
    return kicked;
  }

  /** kick 目标匹配：tenantId 或 ak 任一命中即为目标连接；双缺省不匹配
   *  任何连接（kick 必须指名至少一个维度，空目标不得拆全量） */
  private matchesKickTarget(
    tenantId: string | undefined,
    ak: string | undefined,
    target: { tenantId?: string; ak?: string },
  ): boolean {
    if (target.tenantId === undefined && target.ak === undefined) return false;
    if (target.tenantId !== undefined && tenantId === target.tenantId)
      return true;
    return target.ak !== undefined && ak === target.ak;
  }

  forwardToServer(connectionId: string, frame: RelayFrame): void {
    this.sendTo(this.servers.get(connectionId), frame);
  }

  /** res/event 广播至该 server 的全部已配对 client（当前用法单 client） */
  forwardToClients(connectionId: string, frame: RelayFrame): void {
    for (const client of this.clients.get(connectionId) ?? []) {
      this.sendTo(client, frame);
    }
  }

  /** 有界缓冲：发出后挂账、回调确认落盘后递减；积压超限即拆连接。
   * T2 F1：send 同步抛错（对端已死等）拆连接，不让异常扩散成转发死循环 */
  private sendTo(ws: PeerSocket | undefined, frame: RelayFrame): void {
    if (!ws) return;
    const pending = (this.buffered.get(ws) ?? 0) + 1;
    this.buffered.set(ws, pending);
    if (pending > this.maxBufferFrames) {
      ws.close(4002, 'buffer-overflow');
      return;
    }
    try {
      ws.send(JSON.stringify(frame), (err) => {
        if (err) return;
        this.buffered.set(ws, Math.max(0, (this.buffered.get(ws) ?? 1) - 1));
      });
    } catch {
      this.buffered.delete(ws);
      ws.close(SEND_FAIL_CODE, 'send-failed');
    }
  }

  private dropServerOnly(connectionId: string): void {
    this.servers.delete(connectionId);
    this.clients.delete(connectionId);
  }

  /** client 挂账回落：清 attach 租户/ak 记录并递减计数 */
  private releaseClient(ws: PeerSocket): void {
    const tenant = this.clientTenants.get(ws);
    this.clientTenants.delete(ws);
    this.clientAks.delete(ws);
    if (tenant !== undefined) this.adjustTenant(tenant, 'client', -1);
  }

  /** 租户计数增减；两角色归零即摘除记账（防长期驻留的空条目） */
  private adjustTenant(
    tenantId: string,
    role: 'server' | 'client',
    delta: 1 | -1,
  ): void {
    const count = this.tenantCounts.get(tenantId) ?? { server: 0, client: 0 };
    count[role] = Math.max(0, count[role] + delta);
    if (count.server === 0 && count.client === 0)
      this.tenantCounts.delete(tenantId);
    else this.tenantCounts.set(tenantId, count);
  }
}
