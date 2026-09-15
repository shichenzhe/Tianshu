/**
 * AuditLogService 单测（SP1 spec §6.2）：append 同步入队、flush 编链落库、
 * init 恢复链尾、clear 清空留痕（sequence 单调、链头归零）、list 分页 +
 * keyword 过滤、超 5000 条滚动裁剪。
 * 依赖经 vi.mock 替换（electron / prisma client），沿用 security-service.test.ts 模式。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { on: vi.fn(), getPath: vi.fn(() => "/tmp") },
  dialog: {},
  shell: {},
  ipcMain: { handle: vi.fn() },
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {},
}));

import AuditLogService, {
  normalizeAuditListParams,
} from "../../electron/domains/security/audit/audit-log.service";
import { computeEntryHash } from "../../electron/domains/security/audit/hash-chain";

/** 内存 stub：AuditPrismaLike 最小实现（行按 sequence 排序取出，支持 skip/where.OR/sequence 范围） */
function makeDb() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const d of data) rows.push({ ...d, id: rows.length + 1 });
      return { count: data.length };
    },
    findMany: async (args: {
      where?: Record<string, unknown>;
      orderBy?: Array<Record<string, string>>;
      take?: number;
      skip?: number;
    }) => {
      let out = [...rows];
      const where = args.where as
        | {
            sequence?: { gt?: number; lt?: number };
            OR?: Array<Record<string, { contains: string }>>;
          }
        | undefined;
      if (where?.sequence?.gt !== undefined) {
        out = out.filter(
          (r) => Number(r.sequence) > (where.sequence!.gt as number),
        );
      }
      if (where?.sequence?.lt !== undefined) {
        out = out.filter(
          (r) => Number(r.sequence) < (where.sequence!.lt as number),
        );
      }
      if (where?.OR) {
        const kw = where.OR[0].detail.contains;
        out = out.filter(
          (r) =>
            String(r.detail ?? "").includes(kw) ||
            String(r.commandPreview ?? "").includes(kw),
        );
      }
      const desc = args.orderBy?.[0]?.sequence === "desc";
      out.sort((a, b) =>
        desc
          ? Number(b.sequence) - Number(a.sequence)
          : Number(a.sequence) - Number(b.sequence),
      );
      const skip = args.skip ?? 0;
      const take = args.take ?? out.length;
      return out.slice(skip, skip + take);
    },
    count: async (args?: { where?: Record<string, unknown> }) => {
      if (!args?.where?.OR) return rows.length;
      const kw = (
        args.where.OR as Array<Record<string, { contains: string }>>
      )[0].detail.contains;
      return rows.filter(
        (r) =>
          String(r.detail ?? "").includes(kw) ||
          String(r.commandPreview ?? "").includes(kw),
      ).length;
    },
    deleteMany: async (args?: { where?: Record<string, unknown> }) => {
      const before = rows.length;
      if (args?.where === undefined) {
        rows.length = 0;
      } else if ("sequence" in args.where) {
        const lt = (args.where.sequence as { lt?: number }).lt;
        if (lt !== undefined) {
          for (let i = rows.length - 1; i >= 0; i--) {
            if (Number(rows[i].sequence) < lt) rows.splice(i, 1);
          }
        }
      }
      return { count: before - rows.length };
    },
  };
}

describe("AuditLogService", () => {
  let db: ReturnType<typeof makeDb>;
  let svc: AuditLogService;
  beforeEach(async () => {
    db = makeDb();
    svc = new AuditLogService(db as never);
    await svc.init();
  });

  it("append 入队，flush 后逐条编链落库", async () => {
    svc.append({ eventType: "command-safety.blocked", decision: "blocked" });
    svc.append({
      eventType: "config.sandboxEnabled.updated",
      decision: "info",
    });
    await svc.flush();
    expect(db.rows).toHaveLength(2);
    expect(db.rows[0]).toMatchObject({
      sequence: 1,
      category: "command-safety",
      prevHash: null,
    });
    expect(db.rows[1]).toMatchObject({
      sequence: 2,
      category: "config",
      prevHash: db.rows[0].hash,
    });
  });

  it("落库条目 hash 可被 computeEntryHash 复算验证（stub 行含自增 id）", async () => {
    svc.append({ eventType: "audit.cleared", decision: "info" });
    await svc.flush();
    const row = db.rows[0];
    // id 由库端自增分配，落库时不可知；computeEntryHash 自行剔除不参与
    expect(computeEntryHash({ ...row }, null)).toBe(row.hash);
  });

  it("init 从既有行恢复链尾（新条目接续 sequence）", async () => {
    svc.append({ eventType: "command-safety.blocked", decision: "blocked" });
    await svc.flush();
    const svc2 = new AuditLogService(db as never);
    await svc2.init();
    svc2.append({ eventType: "config.x.updated", decision: "info" });
    await svc2.flush();
    expect(db.rows[1]).toMatchObject({
      sequence: 2,
      prevHash: db.rows[0].hash,
    });
  });

  it("clear 清空后留痕 audit.cleared 成为新链头", async () => {
    svc.append({ eventType: "command-safety.blocked", decision: "blocked" });
    await svc.flush();
    await svc.clear();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      eventType: "audit.cleared",
      sequence: 2,
      prevHash: null,
    });
  });

  it("append 后未 flush 直接 clear：待写队列被丢弃，仅剩 marker 新链头", async () => {
    svc.append({ eventType: "command-safety.blocked", decision: "blocked" });
    await svc.clear();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      eventType: "audit.cleared",
      sequence: 1, // 陈旧事件未落库，未消耗 sequence
      prevHash: null,
    });
  });

  it("list 分页 + keyword 过滤 + 参数钳制", async () => {
    for (let i = 0; i < 3; i++) {
      svc.append({
        eventType: "command-safety.blocked",
        decision: "blocked",
        commandPreview: `rm -rf /-${i}`,
      });
    }
    await svc.flush();
    const page = await svc.list({ page: 1, pageSize: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.total).toBe(3);
    const hit = await svc.list({ keyword: "rm -rf /-1", pageSize: 100 });
    expect(hit.total).toBe(1);
  });

  it("keyword 超 200 字符截断：normalize 钳制长度且超长查询不炸", async () => {
    svc.append({
      eventType: "command-safety.blocked",
      decision: "blocked",
      commandPreview: "rm -rf " + "a".repeat(300),
    });
    await svc.flush();
    const long = "rm -rf " + "a".repeat(250);
    expect(normalizeAuditListParams({ keyword: long }).keyword).toHaveLength(
      200,
    );
    expect(
      normalizeAuditListParams({ keyword: "   " }).keyword,
    ).toBeUndefined();
    const hit = await svc.list({ keyword: long });
    expect(hit.total).toBe(1);
  });

  it("超上限裁剪最旧（>5000）", async () => {
    for (let i = 0; i < 5010; i++) {
      svc.append({
        eventType: "command-safety.blocked",
        decision: "blocked",
        detail: { i },
      });
    }
    await svc.flush();
    expect(db.rows.length).toBeLessThanOrEqual(5000);
    expect(Number(db.rows[0].sequence)).toBe(11);
  });

  it("clear 后跨清空滚动裁剪仍生效（cutoff 由最旧行推导）", async () => {
    for (let i = 0; i < 3000; i++) {
      svc.append({ eventType: "command-safety.blocked", decision: "blocked" });
    }
    await svc.flush(); // sequence 1..3000
    await svc.clear(); // 旧行全清，marker sequence 3001 为唯一行
    for (let i = 0; i < 5010; i++) {
      svc.append({
        eventType: "command-safety.blocked",
        decision: "blocked",
        detail: { i },
      });
    }
    await svc.flush(); // sequence 3002..8011，总数 5011 > 5000 触发裁剪
    expect(db.rows.length).toBe(5000);
    // 最旧行仍在清空 marker 之后的实存区间，未越过 marker 裁到空号
    expect(Number(db.rows[0].sequence)).toBeGreaterThanOrEqual(3002);
  });

  it("行号存在空洞时按实存行数裁剪（不从链尾倒推）", async () => {
    for (let i = 0; i < 200; i++) {
      svc.append({ eventType: "command-safety.blocked", decision: "blocked" });
    }
    await svc.flush(); // sequence 1..200，chain.sequence = 200
    // 模拟外部 DB 维护/手工修复抽走中段行：151..160 缺失，
    // 留下 190 行 + 链尾 200——若 cutoff 从 chain.sequence 倒推会越界多裁
    // （原地删减：stub 闭包持有 rows 引用，重赋值会断开）
    for (let i = db.rows.length - 1; i >= 0; i--) {
      const seq = Number(db.rows[i].sequence);
      if (seq > 150 && seq < 161) db.rows.splice(i, 1);
    }
    for (let i = 0; i < 4820; i++) {
      svc.append({ eventType: "command-safety.blocked", decision: "blocked" });
    }
    await svc.flush(); // sequence 201..5020，总数 5010，应裁掉最旧 10 行
    expect(db.rows.length).toBe(5000);
    expect(Number(db.rows[0].sequence)).toBe(11);
  });
});
