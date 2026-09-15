/**
 * 审计日志服务（SP1 spec §6.2）：append 同步入队（调用方零成本），
 * ≥50 条或 500ms 触发 flush——逐条编 sequence/hash 批量落库、
 * 超 5000 条裁剪最旧；clear 全清后留痕 audit.cleared 为新链头
 * （sequence 全程单调，仅链首 prevHash 归零）。
 * 查询倒序分页 + keyword（截 200 字符）。
 */
import { app, dialog, ipcMain, shell } from "electron";
import Log from "../../../commons/Log";
import prisma from "../../../commons/prisma-client";
import type {
  AuditCategory,
  AuditEntry,
  AuditListParams,
  AuditListResult,
  SecurityEvent,
} from "../../../../src-react/domains/security/model/types";
import { computeEntryHash } from "./hash-chain";
import { writeAuditExport } from "./audit-export";

const FLUSH_BATCH = 50;
const FLUSH_INTERVAL_MS = 500;
const MAX_ENTRIES = 5000;
const KEYWORD_SLICE = 200;
const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 500;

/** eventType 前缀 → category 映射（缺省 config） */
function categoryOf(eventType: string): AuditCategory {
  const prefix = eventType.split(".")[0] as AuditCategory;
  const known: AuditCategory[] = [
    "command-safety",
    "file-safety",
    "network",
    "data-safety",
    "config",
  ];
  return known.includes(prefix) ? prefix : "config";
}

export interface AuditPrismaLike {
  createMany(args: {
    data: Array<Record<string, unknown>>;
  }): Promise<{ count: number }>;
  findMany(args: {
    where?: Record<string, unknown>;
    orderBy?: Array<Record<string, string>>;
    take?: number;
    skip?: number;
  }): Promise<Array<Record<string, unknown>>>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
  deleteMany(args?: {
    where?: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

/** 查询参数规范化（spec §12：纯函数可单测） */
export function normalizeAuditListParams(params: AuditListParams): {
  page: number;
  pageSize: number;
  keyword: string | undefined;
} {
  const page =
    Number.isInteger(params.page) && (params.page ?? 0) >= 1
      ? (params.page as number)
      : 1;
  const rawSize = params.pageSize ?? PAGE_SIZE_DEFAULT;
  const pageSize = Math.min(
    Math.max(1, Number(rawSize) || PAGE_SIZE_DEFAULT),
    PAGE_SIZE_MAX,
  );
  const keyword = params.keyword?.trim().slice(0, KEYWORD_SLICE) || undefined;
  return { page, pageSize, keyword };
}

export default class AuditLogService {
  private queue: SecurityEvent[] = [];
  private chain = { sequence: 0, lastHash: null as string | null };
  private timer: ReturnType<typeof setInterval> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private quitting = false;

  constructor(private dbOverride?: AuditPrismaLike) {
    // 队列有待写事件时阻止退出、冲刷后再 quit（quitting 标记防
    // preventDefault→quit→will-quit 重入循环）
    app.on("will-quit", (event) => {
      if (this.quitting || this.queue.length === 0) return;
      this.quitting = true;
      event.preventDefault();
      this.flush()
        .catch(() => {})
        .finally(() => app.quit());
    });
    ipcMain.handle("security:auditList", (_, params: AuditListParams) =>
      this.list(params),
    );
    ipcMain.handle("security:auditClear", () => this.clear());
    ipcMain.handle("security:auditExport", (_, format: "json" | "csv") =>
      this.exportToFile(format),
    );
  }

  private get db(): AuditPrismaLike {
    // delegate 的泛型签名与宽松参数的 AuditPrismaLike 互不可赋值，运行时兼容
    return (
      this.dbOverride ?? (prisma.securityAuditLog as unknown as AuditPrismaLike)
    );
  }

  /** 启动恢复链尾（空表 = 新链） */
  async init(): Promise<void> {
    const rows = (await this.db.findMany({
      orderBy: [{ sequence: "desc" }],
      take: 1,
    })) as Array<{ sequence: number; hash: string }>;
    if (rows.length > 0) {
      this.chain = { sequence: rows[0].sequence, lastHash: rows[0].hash };
    }
  }

  /** 同步入队；满批立即 flush，否则起 500ms 定时 */
  append(event: SecurityEvent): void {
    this.queue.push(event);
    if (this.queue.length >= FLUSH_BATCH) {
      void this.flush();
    } else if (this.timer === null) {
      this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  /** 落库队列（失败保留重试，spec §11）；链式串行避免并发批次打乱编链 */
  flush(): Promise<void> {
    this.writeTail = this.writeTail.then(() => this.doFlush());
    return this.writeTail;
  }

  private async doFlush(): Promise<void> {
    if (this.queue.length === 0) return;
    this.stopTimer();
    const batch = this.queue.splice(0, this.queue.length);
    const chainSnapshot = { ...this.chain };
    try {
      await this.db.createMany({ data: this.buildEntries(batch) });
    } catch (e) {
      // 落库失败（原子事务，未落任何行）：还原链状态后批次原样回队重试，
      // 避免重试时以新 sequence 重复写入或 prevHash 接到未落库的幽灵 hash
      this.chain = chainSnapshot;
      this.queue.unshift(...batch);
      Log.error("审计落库失败", e);
      return;
    }
    try {
      await this.prune();
    } catch (e) {
      // 批次已落库：裁剪失败不回滚批次（回滚会重复写入），下轮 flush 再裁
      Log.error("审计裁剪失败", e);
    }
  }

  private buildEntries(batch: SecurityEvent[]): Array<Record<string, unknown>> {
    return batch.map((event) => {
      const base = {
        sequence: ++this.chain.sequence,
        category: categoryOf(event.eventType),
        eventType: event.eventType,
        decision: event.decision,
        detail: event.detail ? JSON.stringify(event.detail) : null,
        commandPreview: event.commandPreview ?? null,
        commandHash: event.commandHash ?? null,
        sessionId: event.sessionId ?? null,
        prevHash: this.chain.lastHash,
        createdAt: new Date().toISOString(),
      };
      const hash = computeEntryHash(base, this.chain.lastHash);
      this.chain.lastHash = hash;
      return { ...base, hash };
    });
  }

  /** 超 5000 条裁最旧（按 sequence 保留最近 MAX_ENTRIES 条）。
   *  cutoff 由最旧行 + 溢出量推导：clear 跨清空保持 sequence 单调，
   *  行号与链尾不再连续，不能从 chain.sequence 倒推 */
  private async prune(): Promise<void> {
    const total = await this.db.count();
    if (total <= MAX_ENTRIES) return;
    const oldest = (
      await this.db.findMany({ orderBy: [{ sequence: "asc" }], take: 1 })
    )[0];
    if (!oldest) return;
    const cutoff = Number(oldest.sequence) + (total - MAX_ENTRIES);
    await this.db.deleteMany({ where: { sequence: { lt: cutoff } } });
  }

  /** 倒序分页 + keyword（detail/commandPreview LIKE） */
  async list(params: AuditListParams): Promise<AuditListResult> {
    const { page, pageSize, keyword } = normalizeAuditListParams(params);
    const where = keyword
      ? {
          OR: [
            { detail: { contains: keyword } },
            { commandPreview: { contains: keyword } },
          ],
        }
      : undefined;
    const [rows, total] = await Promise.all([
      this.db.findMany({
        where,
        orderBy: [{ sequence: "desc" }],
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      this.db.count({ where }),
    ]);
    return {
      entries: rows.map((row) => row as unknown as AuditEntry),
      total,
      page,
      pageSize,
    };
  }

  /** 保存框选路径 → 流式写 → 打开所在目录（取消 = ok:false 静默） */
  async exportToFile(
    format: "json" | "csv",
  ): Promise<{ ok: boolean; filePath?: string }> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const result = await dialog.showSaveDialog({
      defaultPath: `security-audit-log-${date}.${format}`,
    });
    if (result.canceled || !result.filePath) return { ok: false };
    await writeAuditExport(this.db, format, result.filePath);
    shell.showItemInFolder(result.filePath);
    return { ok: true, filePath: result.filePath };
  }

  /** 全清并留痕（清空动作自己成为新链头，sequence 不重置保持单调）。
   *  串行到写入链：在途批次先落库再清，未落库队列丢弃，marker 必为唯一新链头 */
  clear(): Promise<void> {
    const done = this.writeTail.then(() => this.doClear());
    this.writeTail = done.catch(() => {
      /* 链保活：失败结果仅通知本次调用方 */
    });
    return done;
  }

  private async doClear(): Promise<void> {
    await this.db.deleteMany();
    this.chain.lastHash = null;
    this.queue.length = 0; // 清空窗内的未落库事件一并丢弃，避免复活在 marker 之后
    this.append({ eventType: "audit.cleared", decision: "info" });
    await this.doFlush();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
