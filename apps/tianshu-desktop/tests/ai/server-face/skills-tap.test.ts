// A3 技能批（spec 2026-10-26 §3）：skills-tap 用例——skills/query 扩展段
// （scenarios/source/builtin）/setScenarios 三值过滤与 NOT_FOUND/uninstall
// builtin 拒；skillhub-tap 四端点转发（mock client 成功透传 + 远端不可用
// SKILLHUB_UNAVAILABLE）。内存替身直测，错误码经 code 属性钉。
import { describe, expect, it, vi } from "vitest";

import { createSkillsFace } from "../../../electron/domains/server-face/skills-tap";
import { createSkillHubFace } from "../../../electron/domains/server-face/skillhub-tap";
import type { SkillRepository } from "../../../electron/domains/ai/skill/skill.repo";
import type { SkillRecord } from "../../../src-react/domains/ai/skills/api/skill.api";
import type { SkillHubPage } from "../../../electron/domains/ai/skill/skillhub-client";
import {
  mapHubDetail,
  mapHubSkill,
  normalizeHubSecurity,
} from "../../../electron/domains/ai/skill/skillhub-mapping";

const UID = 7;

function skillRow(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: 1,
    name: "alpha",
    slug: "alpha",
    version: "1.0.0",
    source: "market",
    dir: "/skills/alpha",
    description: "desc-a",
    enabled: true,
    installedAt: "2026-10-26T00:00:00.000Z",
    scenarios: null,
    ...overrides,
  };
}

/** 内存仓储替身（SkillRepository 结构子集） */
class SkillsRepoDouble {
  rows: SkillRecord[];
  lastScenarios: string[] | null = null;

  constructor(rows: SkillRecord[] = [skillRow()]) {
    this.rows = rows;
  }

  async list(): Promise<SkillRecord[]> {
    return this.rows;
  }

  async readSkill(name: string): Promise<{ content: string }> {
    return { content: `body:${name}` };
  }

  async setEnabled(name: string, enabled: boolean): Promise<null> {
    const row = this.rows.find((r) => r.name === name);
    if (row) row.enabled = enabled;
    return null;
  }

  async setScenarios(name: string, scenarios: string[]): Promise<null> {
    this.lastScenarios = scenarios;
    const row = this.rows.find((r) => r.name === name);
    if (!row) throw new Error("SKILL_NOT_FOUND");
    row.scenarios = scenarios;
    return null;
  }

  async uninstall(name: string): Promise<null> {
    const row = this.rows.find((r) => r.name === name);
    if (row?.source === "builtin") {
      throw new Error("系统内置技能不支持卸载");
    }
    this.rows = this.rows.filter((r) => r.name !== name);
    return null;
  }

  // skillhub 四端点（mock 值由用例注入）
  listHubSkills = vi.fn(async (): Promise<SkillHubPage> => ({
    total: 0,
    skills: [],
  }));
  listHubTop = vi.fn(async () => []);
  listHubCategories = vi.fn(async () => []);
  installFromHub = vi.fn(async () => ({
    status: "conflict" as const,
    name: "alpha",
  }));
  getHubSkillDetail = vi.fn(async () => ({
    skill: { slug: "slug-a" },
    owner: null,
    latestVersion: null,
    security: "benign",
  }));

  // A3 尾：stats 聚合替身（行由用例注入）+ installUpload buffer 直装替身
  statRows: Array<Record<string, unknown>> = [];
  lastUploadBuf: Buffer | null = null;
  lastUploadOverwrite: boolean | null = null;

  async stats(): Promise<{ items: Array<Record<string, unknown>> }> {
    return { items: this.statRows };
  }

  async installFromUpload(buf: Buffer, overwrite = false): Promise<unknown> {
    this.lastUploadBuf = buf;
    this.lastUploadOverwrite = overwrite;
    return { status: "installed", record: { id: 1, name: "alpha" } };
  }
}

type RepoDouble = SkillsRepoDouble &
  Pick<
    SkillRepository,
    | "list"
    | "readSkill"
    | "setEnabled"
    | "setScenarios"
    | "uninstall"
    | "stats"
    | "installFromUpload"
    | "listHubSkills"
    | "listHubTop"
    | "listHubCategories"
    | "installFromHub"
  >;

function makeSkillsFace(rows?: SkillRecord[]) {
  const repo = new SkillsRepoDouble(rows) as unknown as RepoDouble;
  return { face: createSkillsFace(repo), repo };
}

describe("skills-tap（A3 技能批）", () => {
  it("list 补 scenarios/source/builtin 扩展段；无打标不落 scenarios 键", async () => {
    const { face } = makeSkillsFace([
      skillRow({ scenarios: ["daily", "coding"] }),
      skillRow({ name: "beta", scenarios: null, source: "builtin" }),
    ]);
    const list = await face.list(UID);
    expect(list[0]).toEqual({
      name: "alpha",
      description: "desc-a",
      enabled: true,
      scenarios: ["daily", "coding"],
      source: "market",
      builtin: false,
    });
    expect(list[1]).toEqual({
      name: "beta",
      description: "desc-a",
      enabled: true,
      source: "builtin",
      builtin: true,
    });
    expect("scenarios" in list[1]).toBe(false);
  });

  it("setScenarios 三值白名单过滤（非法值剔除、去重）", async () => {
    const { face, repo } = makeSkillsFace();
    await face.setScenarios(UID, "alpha", [
      "daily",
      "bogus" as never,
      "design",
      "daily",
    ]);
    expect(repo.lastScenarios).toEqual(["daily", "design"]);
  });

  it("setScenarios 技能不存在报 SKILL_NOT_FOUND", async () => {
    const { face } = makeSkillsFace();
    try {
      await face.setScenarios(UID, "missing", ["daily"]);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("SKILL_NOT_FOUND");
    }
  });

  it("uninstall builtin 拒（SKILL_BUILTIN）；普通技能删除", async () => {
    const { face, repo } = makeSkillsFace([
      skillRow({ source: "builtin" }),
      skillRow({ name: "beta", scenarios: null }),
    ]);
    try {
      await face.uninstall(UID, "alpha");
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("SKILL_BUILTIN");
    }
    await face.uninstall(UID, "beta");
    expect(repo.rows.map((row) => row.name)).toEqual(["alpha"]);
  });
});

describe("skills-tap（A3 尾 zip 上传+统计批）", () => {
  function statRow(overrides: Record<string, unknown> = {}) {
    return {
      name: "alpha",
      installs: 2,
      creates: 1,
      enables: 3,
      disables: 1,
      uninstalls: 0,
      batchOps: 1,
      lastActiveAt: new Date("2026-10-26T08:00:00.000Z"),
      ...overrides,
    };
  }

  it("installUpload base64 解码达 repo buffer 并回传安装结果", async () => {
    const { face, repo } = makeSkillsFace();
    const result = await face.installUpload(UID, {
      name: "a.zip",
      base64: Buffer.from("zip-bytes").toString("base64"),
    });
    expect(repo.lastUploadBuf?.toString()).toBe("zip-bytes");
    expect(repo.lastUploadOverwrite).toBe(false);
    expect(result).toEqual({
      status: "installed",
      record: { id: 1, name: "alpha" },
    });
  });

  it("installUpload overwrite 透传——冲突覆写二次请求达 installer", async () => {
    const { face, repo } = makeSkillsFace();
    await face.installUpload(UID, {
      name: "a.zip",
      base64: Buffer.from("zip-bytes").toString("base64"),
      overwrite: true,
    });
    expect(repo.lastUploadOverwrite).toBe(true);
  });

  it("installUpload 超 3MB 拒 SKILL_UPLOAD_INVALID（不经 repo）", async () => {
    const { face, repo } = makeSkillsFace();
    const big = Buffer.alloc(3 * 1024 * 1024 + 1);
    try {
      await face.installUpload(UID, {
        name: "big.zip",
        base64: big.toString("base64"),
      });
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("SKILL_UPLOAD_INVALID");
    }
    expect(repo.lastUploadBuf).toBeNull();
  });

  it("installUpload repo 安装错误收 SKILL_UPLOAD_INVALID（带原因）", async () => {
    const repo = new SkillsRepoDouble() as unknown as RepoDouble;
    repo.installFromUpload = vi.fn(async () => {
      throw new Error("未找到 SKILL.md");
    });
    const face = createSkillsFace(repo);
    try {
      await face.installUpload(UID, {
        name: "bad.zip",
        base64: Buffer.from("x").toString("base64"),
      });
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("SKILL_UPLOAD_INVALID");
      expect((error as Error).message).toContain("未找到 SKILL.md");
    }
  });

  it("stats 事件桶合计 usedCount，lastUsedAt 取最新事件 ISO", async () => {
    const repo = new SkillsRepoDouble() as unknown as RepoDouble & {
      statRows: Array<Record<string, unknown>>;
    };
    repo.statRows = [
      statRow(),
      statRow({
        name: "beta",
        installs: 0,
        creates: 0,
        enables: 0,
        disables: 0,
        uninstalls: 0,
        batchOps: 0,
        lastActiveAt: new Date("2026-10-25T00:00:00.000Z"),
      }),
    ];
    const stats = await createSkillsFace(repo).stats(UID);
    expect(stats).toEqual([
      {
        name: "alpha",
        usedCount: 8,
        lastUsedAt: "2026-10-26T08:00:00.000Z",
      },
      {
        name: "beta",
        usedCount: 0,
        lastUsedAt: "2026-10-25T00:00:00.000Z",
      },
    ]);
  });
});

describe("skillhub-tap（A3 技能市场批）", () => {
  it("四端点透传仓储 hub/installer 结果", async () => {
    const repo = new SkillsRepoDouble() as unknown as RepoDouble;
    const face = createSkillHubFace(repo);
    await face.list({ keyword: "k", page: 1 });
    expect(repo.listHubSkills).toHaveBeenCalledWith({
      keyword: "k",
      page: 1,
    });
    await face.top();
    expect(repo.listHubTop).toHaveBeenCalled();
    await face.categories();
    expect(repo.listHubCategories).toHaveBeenCalled();
    const result = await face.install("slug-a", true);
    expect(repo.installFromHub).toHaveBeenCalledWith("slug-a", true);
    expect(result).toEqual({ status: "conflict", name: "alpha" });
    const detail = await face.detail("slug-a");
    expect(repo.getHubSkillDetail).toHaveBeenCalledWith("slug-a");
    expect(detail).toEqual({
      skill: { slug: "slug-a" },
      owner: null,
      latestVersion: null,
      security: "benign",
    });
  });

  it("远端不可用统一收 SKILLHUB_UNAVAILABLE（含安装失败）", async () => {
    const repo = new SkillsRepoDouble() as unknown as RepoDouble;
    repo.listHubTop = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    const face = createSkillHubFace(repo);
    try {
      await face.top();
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("SKILLHUB_UNAVAILABLE");
    }
  });

  it("detail 远端不可用同样收 SKILLHUB_UNAVAILABLE", async () => {
    const repo = new SkillsRepoDouble() as unknown as RepoDouble;
    repo.getHubSkillDetail = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    const face = createSkillHubFace(repo);
    try {
      await face.detail("slug-a");
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("SKILLHUB_UNAVAILABLE");
    }
  });
});

describe("skillhub-mapping（detail 批）", () => {
  it("mapHubSkill 蛇形 created_at 映射 camel 且剔除蛇形键", () => {
    const row = {
      slug: "pdf-reader",
      name: "PDF Reader",
      description: "d",
      description_zh: "d-zh",
      iconUrl: null,
      category: "office",
      version: "1.0.0",
      downloads: 10,
      stars: 2,
      score: 90,
      source: "clawhub",
      created_at: 1791402289536,
    };
    const dto = mapHubSkill(row);
    expect(dto.createdAt).toBe(1791402289536);
    expect(dto).not.toHaveProperty("created_at");
    expect(dto.slug).toBe("pdf-reader");
  });

  it("normalizeHubSecurity 三分支：全 benign / 混非 benign / 无报告", () => {
    expect(
      normalizeHubSecurity({
        keen: { status: "benign" },
        sanbu: { status: "benign", statusText: "安全" },
      }),
    ).toBe("benign");
    expect(
      normalizeHubSecurity({
        keen: { status: "benign" },
        sanbu: { status: "malicious" },
      }),
    ).toBe("caution");
    expect(normalizeHubSecurity(undefined)).toBe("unknown");
    expect(normalizeHubSecurity({ keen: undefined })).toBe("unknown");
  });

  it("mapHubDetail owner/latestVersion 缺失归 null、camel 映射齐", () => {
    const dto = mapHubDetail({
      skill: {
        slug: "pdf-reader",
        displayName: "PDF Reader",
        category: "office-efficiency",
        iconUrl: "https://x/icon.png",
        summary: "s",
        summary_zh: "s-zh",
        overviewMd: "# hi",
        hasOverview: true,
        created_at: 1778626553794,
        source: "clawhub",
        sourceUrl: "https://clawhub.ai/x",
        stats: {
          downloads: 3851,
          installs: 44,
          stars: 1,
          versions: 1,
          comments: 0,
        },
      },
      latestVersion: { version: "1.1.0", created_at: 1778626553794 },
      securityReports: { keen: { status: "benign" } },
    });
    expect(dto.owner).toBeNull();
    expect(dto.latestVersion).toEqual({
      version: "1.1.0",
      changelog: undefined,
      createdAt: 1778626553794,
    });
    expect(dto.security).toBe("benign");
    expect(dto.skill.createdAt).toBe(1778626553794);
    expect(dto.skill.stats?.installs).toBe(44);
  });
});
