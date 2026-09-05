/**
 * skill-installer 单测:安装编排(解压/校验/冲突覆盖/落盘/入库 upsert 语义)
 * 纯 Node:mkdtempSync 临时 skillsRoot + adm-zip 构造 zip + 内存 Map stub prisma
 */
import AdmZip from "adm-zip";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// skill-stats recorder 静态 import commons/Log(winston/electron 副作用),
// 模块级 mock 隔离(参照 chat.service.test.ts 的 mock 边界先例)
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  SkillInstaller,
  type SkillRecordDbRow,
  type SkillRecordPrismaLike,
} from "../../electron/domains/ai/skill/skill-installer";
import type { SkillStatPrismaLike } from "../../electron/domains/ai/skill/skill-stats";

const MB = 1024 * 1024;

const SKILL_MD = (name: string, description = "示例技能") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n正文内容`;

/** 常规 zip:addFile 构造(目录条目以 / 结尾) */
function makeZip(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(
      name,
      Buffer.isBuffer(content) ? content : Buffer.from(content),
    );
  }
  return zip.toBuffer();
}

/**
 * 构造带"危险条目名"的 zip:addFile 会归一化 ..(zipnamefix),
 * 须在入站后改写 entryName 再序列化(模拟攻击者手工构造的 zip)
 */
function makeZipWithEntryName(
  original: string,
  renamed: string,
  files: Record<string, string | Buffer>,
): Buffer {
  const zip = new AdmZip(makeZip(files));
  const entry = zip.getEntries().find((e) => e.entryName === original);
  if (!entry) throw new Error(`测试构造失败:条目不存在 ${original}`);
  entry.entryName = renamed;
  return zip.toBuffer();
}

interface Seed {
  name: string;
  id?: number;
  slug?: string | null;
  version?: string;
  source?: string;
  dir?: string;
  enabled?: boolean;
  installedAt?: Date;
}

interface UpsertArgs {
  where: { name: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/** prisma skillRecord 结构子集 stub:内存 Map;upsert 语义对齐真实 Prisma(update 只合并给出字段) */
function createPrismaStub(seed: Seed[] = []) {
  const rows = new Map<string, SkillRecordDbRow>();
  let nextId = 1;
  for (const item of seed) {
    rows.set(item.name, {
      id: item.id ?? nextId++,
      name: item.name,
      slug: item.slug ?? null,
      version: item.version ?? null,
      source: item.source ?? "local",
      dir: item.dir ?? "",
      description: null,
      enabled: item.enabled ?? true,
      installedAt: item.installedAt ?? new Date(0),
    });
  }
  const upsertCalls: UpsertArgs[] = [];
  const findFirstCalls: Array<{ where: { name: string } }> = [];
  const prisma: SkillRecordPrismaLike = {
    async findFirst(args) {
      findFirstCalls.push(args);
      return rows.get(args.where.name) ?? null;
    },
    async upsert(args) {
      upsertCalls.push(args as UpsertArgs);
      const existing = rows.get(args.where.name);
      if (existing) {
        const updated = { ...existing, ...args.update };
        rows.set(args.where.name, updated);
        return updated;
      }
      const created: SkillRecordDbRow = {
        ...(args.create as unknown as SkillRecordDbRow),
        // 模拟 @default(true)/@default(now):仅 create 分支生效
        id: nextId++,
        enabled: true,
        installedAt: new Date(),
      };
      rows.set(args.where.name, created);
      return created;
    },
    async delete(args) {
      for (const [name, row] of rows) {
        if (row.id === args.where.id) rows.delete(name);
      }
    },
  };
  return { prisma, rows, upsertCalls, findFirstCalls };
}

const createdDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-installer-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeInstaller(
  options: {
    seed?: Seed[];
    limits?: Partial<{ maxFileBytes: number; maxTotalBytes: number }>;
    fetchImpl?: typeof fetch;
    download?: (slug: string) => Promise<ArrayBuffer>;
    getVersion?: (slug: string) => Promise<string>;
    statRecord?: SkillStatPrismaLike;
  } = {},
) {
  const root = makeTmpDir();
  const stub = createPrismaStub(options.seed ?? []);
  const installer = new SkillInstaller({
    skillsRoot: root,
    prisma: stub.prisma,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.download ? { download: options.download } : {}),
    ...(options.getVersion ? { getVersion: options.getVersion } : {}),
    ...(options.statRecord ? { statRecord: options.statRecord } : {}),
  });
  return { root, installer, ...stub };
}

/** staging 中转目录必须被清理(成功与失败路径都不残留) */
function expectNoStaging(root: string) {
  expect(readdirSync(root).filter((n) => n.startsWith(".staging-"))).toEqual(
    [],
  );
}

describe("installFromBuffer", () => {
  it("新装:zip 根含 SKILL.md → installed + 落盘 + upsert(source local)", async () => {
    const { root, installer, upsertCalls } = makeInstaller();
    const result = await installer.installFromBuffer(
      makeZip({ "SKILL.md": SKILL_MD("demo"), "assets/a.png": "x" }),
      "local",
    );
    expect(result).toEqual({
      status: "installed",
      record: {
        id: 1,
        name: "demo",
        source: "local",
        slug: null,
        version: null,
      },
    });
    expect(readFileSync(path.join(root, "demo", "SKILL.md"), "utf8")).toBe(
      SKILL_MD("demo"),
    );
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.create).toEqual({
      name: "demo",
      slug: null,
      version: null,
      source: "local",
      dir: path.join(root, "demo"),
      description: "示例技能",
    });
    expectNoStaging(root);
  });

  it("单层子目录 zip(pkg/SKILL.md)→ 子目录内容平移到 <name>/", async () => {
    const { root, installer } = makeInstaller();
    const result = await installer.installFromBuffer(
      makeZip({
        "pkg/": Buffer.alloc(0),
        "pkg/SKILL.md": SKILL_MD("demo"),
        "pkg/scripts/run.py": "print('hi')",
        "pkg/assets/x.txt": "x",
      }),
      "local",
    );
    expect(result.status).toBe("installed");
    expect(existsSync(path.join(root, "demo", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(root, "demo", "scripts", "run.py"))).toBe(true);
    // 不应残留压缩包内层目录名
    expect(existsSync(path.join(root, "pkg"))).toBe(false);
  });

  it("子目录根 zip 的顶层散落文件不属于技能内容:跳过且不被截断误写", async () => {
    const { root, installer } = makeInstaller();
    const result = await installer.installFromBuffer(
      makeZip({
        "pkg/SKILL.md": SKILL_MD("demo"),
        "README.txt": "顶层散落文件",
      }),
      "local",
    );
    expect(result.status).toBe("installed");
    expect(readdirSync(path.join(root, "demo"))).toEqual(["SKILL.md"]);
  });

  it("冲突:同名目录已存在 → conflict、原目录内容未动、无 upsert", async () => {
    const { root, installer, upsertCalls } = makeInstaller();
    mkdirSync(path.join(root, "demo"));
    writeFileSync(
      path.join(root, "demo", "SKILL.md"),
      SKILL_MD("demo", "旧描述"),
    );
    writeFileSync(path.join(root, "demo", "extra.txt"), "旧文件");
    const result = await installer.installFromBuffer(
      makeZip({ "SKILL.md": SKILL_MD("demo", "新描述") }),
      "local",
    );
    expect(result).toEqual({ status: "conflict", name: "demo" });
    expect(readFileSync(path.join(root, "demo", "SKILL.md"), "utf8")).toBe(
      SKILL_MD("demo", "旧描述"),
    );
    expect(readFileSync(path.join(root, "demo", "extra.txt"), "utf8")).toBe(
      "旧文件",
    );
    expect(upsertCalls).toHaveLength(0);
    expectNoStaging(root);
  });

  it("冲突:目录不存在但 DB 有同名记录 → conflict 且不建目录", async () => {
    const { root, installer, upsertCalls, findFirstCalls } = makeInstaller({
      seed: [{ name: "demo", slug: "demo", source: "market" }],
    });
    const result = await installer.installFromBuffer(
      makeZip({ "SKILL.md": SKILL_MD("demo") }),
      "market",
    );
    expect(result).toEqual({ status: "conflict", name: "demo" });
    expect(existsSync(path.join(root, "demo"))).toBe(false);
    expect(upsertCalls).toHaveLength(0);
    expect(findFirstCalls.map((c) => c.where.name)).toEqual(["demo"]);
  });

  it("overwrite=true → 旧目录替换(多余旧文件消失)、upsert 更新 version 且 enabled/installedAt 保留", async () => {
    const oldDate = new Date("2020-01-01T00:00:00Z");
    // seed.dir 依赖 root,须先建目录再拼装 stub(root 来自 makeInstaller 返回值)
    const root = makeTmpDir();
    const stub = createPrismaStub([
      {
        name: "demo",
        slug: "demo",
        version: "0.9",
        source: "market",
        dir: path.join(root, "demo"),
        enabled: false,
        installedAt: oldDate,
      },
    ]);
    const installer = new SkillInstaller({
      skillsRoot: root,
      prisma: stub.prisma,
    });
    const { rows, upsertCalls } = stub;
    mkdirSync(path.join(root, "demo"));
    writeFileSync(
      path.join(root, "demo", "SKILL.md"),
      SKILL_MD("demo", "旧描述"),
    );
    writeFileSync(path.join(root, "demo", "extra.txt"), "旧文件");
    const result = await installer.installFromBuffer(
      makeZip({ "SKILL.md": SKILL_MD("demo", "新描述") }),
      "market",
      { slug: "demo", version: "1.2" },
      true,
    );
    expect(result).toEqual({
      status: "installed",
      record: {
        id: 1,
        name: "demo",
        source: "market",
        slug: "demo",
        version: "1.2",
      },
    });
    // 旧文件被清掉、新文件就位
    expect(existsSync(path.join(root, "demo", "extra.txt"))).toBe(false);
    expect(readFileSync(path.join(root, "demo", "SKILL.md"), "utf8")).toBe(
      SKILL_MD("demo", "新描述"),
    );
    // upsert:update 只写 source/slug/version/dir/description
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.update).toEqual({
      source: "market",
      slug: "demo",
      version: "1.2",
      dir: path.join(root, "demo"),
      description: "新描述",
    });
    expect(upsertCalls[0]!.update).not.toHaveProperty("enabled");
    expect(upsertCalls[0]!.update).not.toHaveProperty("installedAt");
    // create 默认分支不触发,原记录 enabled/installedAt 原样
    const row = rows.get("demo")!;
    expect(row.enabled).toBe(false);
    expect(row.installedAt).toEqual(oldDate);
    expectNoStaging(root);
  });

  it("坏包:无 SKILL.md → throw 未找到 SKILL.md;不落盘不写库", async () => {
    const { root, installer, upsertCalls } = makeInstaller();
    await expect(
      installer.installFromBuffer(makeZip({ "README.md": "x" }), "local"),
    ).rejects.toThrow("SKILL.md");
    expect(readdirSync(root)).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
    expectNoStaging(root);
  });

  it("坏包:含 evil.sh → throw 不允许的可执行文件", async () => {
    const { root, installer, upsertCalls } = makeInstaller();
    await expect(
      installer.installFromBuffer(
        makeZip({ "SKILL.md": SKILL_MD("demo"), "evil.sh": "rm -rf" }),
        "local",
      ),
    ).rejects.toThrow("不允许的可执行文件");
    expect(readdirSync(root)).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
  });

  it("__MACOSX/ 与 .DS_Store 条目被过滤,macOS 打包 zip 不再被误判多顶层目录", async () => {
    const { root, installer } = makeInstaller();
    const result = await installer.installFromBuffer(
      makeZip({
        "SKILL.md": SKILL_MD("demo"),
        "__MACOSX/": Buffer.alloc(0),
        "__MACOSX/pkg/._SKILL.md": "junk",
        ".DS_Store": "junk",
        "pkg/.DS_Store": "junk",
      }),
      "local",
    );
    expect(result.status).toBe("installed");
    expect(readdirSync(path.join(root, "demo"))).toEqual(["SKILL.md"]);
  });

  it("zip-slip 兜底:T1 放行的 '..' 条目在落盘前被拒", async () => {
    const { root, installer, upsertCalls } = makeInstaller();
    await expect(
      installer.installFromBuffer(
        makeZipWithEntryName("payload.txt", "..", {
          "SKILL.md": SKILL_MD("demo"),
          "payload.txt": "evil",
        }),
        "local",
      ),
    ).rejects.toThrow("不安全路径");
    expect(readdirSync(root)).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
    expectNoStaging(root);
  });

  it("zip-slip 兜底:pkg/../evil.txt 组合段逃逸 staging → 拒绝且不落 skillsRoot 任何位置", async () => {
    const { root, installer, upsertCalls } = makeInstaller();
    await expect(
      installer.installFromBuffer(
        makeZipWithEntryName("payload.txt", "pkg/../evil.txt", {
          "pkg/SKILL.md": SKILL_MD("demo"),
          "payload.txt": "evil",
        }),
        "local",
      ),
    ).rejects.toThrow("不安全路径");
    // evil.txt 恰会落在 skillsRoot 顶层(root 为空目录,空清单即"任何位置都没有")
    expect(readdirSync(root)).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
    expectNoStaging(root);
  });

  it("zip-slip 兜底:pkg/../demo/SKILL.md 不得覆盖已安装技能", async () => {
    const { root, installer } = makeInstaller();
    await installer.installFromBuffer(
      makeZip({ "SKILL.md": SKILL_MD("demo", "原版") }),
      "local",
    );
    await expect(
      installer.installFromBuffer(
        makeZipWithEntryName("payload.md", "pkg/../demo/SKILL.md", {
          "pkg/SKILL.md": SKILL_MD("evil"),
          "payload.md": "hacked",
        }),
        "local",
      ),
    ).rejects.toThrow("不安全路径");
    expect(readFileSync(path.join(root, "demo", "SKILL.md"), "utf8")).toBe(
      SKILL_MD("demo", "原版"),
    );
    expect(existsSync(path.join(root, "evil"))).toBe(false);
    expectNoStaging(root);
  });

  it("zip-slip 兜底:Windows 盘符条目 C:/evil.txt 在落盘前被拒", async () => {
    const { root, installer, upsertCalls } = makeInstaller();
    await expect(
      installer.installFromBuffer(
        makeZip({ "SKILL.md": SKILL_MD("demo"), "C:/evil.txt": "evil" }),
        "local",
      ),
    ).rejects.toThrow("不安全路径");
    expect(readdirSync(root)).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
  });

  it("解压后按实际字节复验:单文件超 10MB 拒绝", async () => {
    const { root, installer, upsertCalls } = makeInstaller();
    await expect(
      installer.installFromBuffer(
        makeZip({
          "SKILL.md": SKILL_MD("demo"),
          "big.bin": Buffer.alloc(10 * MB + 1),
        }),
        "local",
      ),
    ).rejects.toThrow("单文件超过大小上限");
    expect(readdirSync(root)).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
    expectNoStaging(root);
  });

  it("解压后按实际字节复验:总量超上限拒绝(注入收紧限额)", async () => {
    const { root, installer, upsertCalls } = makeInstaller({
      limits: { maxFileBytes: 800, maxTotalBytes: 1000 },
    });
    await expect(
      installer.installFromBuffer(
        makeZip({
          "SKILL.md": SKILL_MD("demo"),
          "a.bin": Buffer.alloc(600),
          "b.bin": Buffer.alloc(600),
        }),
        "local",
      ),
    ).rejects.toThrow("总量超过大小上限");
    expect(readdirSync(root)).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
    expectNoStaging(root);
  });

  it("SKILL.md 的 name 含路径分隔符/盘符 → 拒绝(防 frontmatter 层逃逸)", async () => {
    const { root, installer } = makeInstaller();
    for (const evil of ["../evil", "a/b", "C:evil"]) {
      await expect(
        installer.installFromBuffer(
          makeZip({ "SKILL.md": SKILL_MD(evil) }),
          "local",
        ),
      ).rejects.toThrow("不能用作目录名");
    }
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("importDirectory", () => {
  it("源目录(SKILL.md + scripts/)复制安装,源目录保留不 move", async () => {
    const srcDir = makeTmpDir();
    writeFileSync(path.join(srcDir, "SKILL.md"), SKILL_MD("demo"));
    mkdirSync(path.join(srcDir, "scripts"));
    writeFileSync(path.join(srcDir, "scripts", "run.py"), "print('hi')");
    const { root, installer } = makeInstaller();
    const result = await installer.importDirectory(srcDir);
    expect(result.status).toBe("installed");
    expect(existsSync(path.join(root, "demo", "scripts", "run.py"))).toBe(true);
    expect(readFileSync(path.join(srcDir, "SKILL.md"), "utf8")).toBe(
      SKILL_MD("demo"),
    );
    expectNoStaging(root);
  });

  it("源目录唯一子目录含 SKILL.md → 内容平移到 <name>/", async () => {
    const srcDir = makeTmpDir();
    mkdirSync(path.join(srcDir, "pkg"), { recursive: true });
    writeFileSync(path.join(srcDir, "pkg", "SKILL.md"), SKILL_MD("demo"));
    const { root, installer } = makeInstaller();
    const result = await installer.importDirectory(srcDir);
    expect(result.status).toBe("installed");
    expect(existsSync(path.join(root, "demo", "SKILL.md"))).toBe(true);
  });

  it("源目录含 .DS_Store/__MACOSX → 过滤后安装", async () => {
    const srcDir = makeTmpDir();
    writeFileSync(path.join(srcDir, "SKILL.md"), SKILL_MD("demo"));
    writeFileSync(path.join(srcDir, ".DS_Store"), "junk");
    const { root, installer } = makeInstaller();
    const result = await installer.importDirectory(srcDir);
    expect(result.status).toBe("installed");
    expect(readdirSync(path.join(root, "demo"))).toEqual(["SKILL.md"]);
  });

  it("冲突 → conflict,源目录与目标都不动", async () => {
    const srcDir = makeTmpDir();
    writeFileSync(path.join(srcDir, "SKILL.md"), SKILL_MD("demo", "新描述"));
    const { root, installer, upsertCalls } = makeInstaller();
    mkdirSync(path.join(root, "demo"));
    writeFileSync(
      path.join(root, "demo", "SKILL.md"),
      SKILL_MD("demo", "旧描述"),
    );
    const result = await installer.importDirectory(srcDir);
    expect(result).toEqual({ status: "conflict", name: "demo" });
    expect(readFileSync(path.join(root, "demo", "SKILL.md"), "utf8")).toBe(
      SKILL_MD("demo", "旧描述"),
    );
    expect(upsertCalls).toHaveLength(0);
  });

  it("路径不存在 → throw", async () => {
    const { installer } = makeInstaller();
    await expect(
      installer.importDirectory(path.join(tmpdir(), "no-such-dir-xyz")),
    ).rejects.toThrow();
  });
});

describe("downloadAndInstall", () => {
  it("详情取 version + 下载 zip → installed 且 slug/version 落库", async () => {
    const zipBuf = makeZip({ "SKILL.md": SKILL_MD("demo") });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            skill: { slug: "demo" },
            latestVersion: { version: "1.0.2" },
          }),
        );
      }
      return new Response(zipBuf);
    }) as unknown as typeof fetch;
    const { root, installer, upsertCalls } = makeInstaller({ fetchImpl });
    const result = await installer.downloadAndInstall("demo");
    expect(result).toEqual({
      status: "installed",
      record: {
        id: 1,
        name: "demo",
        source: "market",
        slug: "demo",
        version: "1.0.2",
      },
    });
    expect(calls[0]).toContain("/api/v1/skills/demo");
    expect(calls[1]).toContain("/api/v1/download?slug=demo");
    expect(upsertCalls[0]!.create).toMatchObject({
      source: "market",
      slug: "demo",
      version: "1.0.2",
    });
    expect(existsSync(path.join(root, "demo", "SKILL.md"))).toBe(true);
  });

  it("详情非 2xx → throw {error} 文案", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "skill not found" }), {
        status: 404,
      })) as unknown as typeof fetch;
    const { installer } = makeInstaller({ fetchImpl });
    await expect(installer.downloadAndInstall("nope")).rejects.toThrow(
      "skill not found",
    );
  });

  it("下载非 2xx → throw {error} 文案", async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).includes("/api/v1/skills/")
        ? new Response(
            JSON.stringify({
              skill: { slug: "demo" },
              latestVersion: { version: "1.0.2" },
            }),
          )
        : new Response(JSON.stringify({ error: "download failed" }), {
            status: 500,
          })) as unknown as typeof fetch;
    const { installer } = makeInstaller({ fetchImpl });
    await expect(installer.downloadAndInstall("demo")).rejects.toThrow(
      "download failed",
    );
  });

  it("注入 download/getVersion 时优先使用,内部 fetch 不被调用", async () => {
    const zipBuf = makeZip({ "SKILL.md": SKILL_MD("injected") });
    const downloadCalls: string[] = [];
    const versionCalls: string[] = [];
    const fetchImpl = (async () => {
      throw new Error("内部 fetch 不应被调用");
    }) as unknown as typeof fetch;
    const { root, installer, upsertCalls } = makeInstaller({
      fetchImpl,
      download: async (slug) => {
        downloadCalls.push(slug);
        return Uint8Array.from(zipBuf).buffer;
      },
      getVersion: async (slug) => {
        versionCalls.push(slug);
        return "2.0.0";
      },
    });
    const result = await installer.downloadAndInstall("injected");
    expect(result).toEqual({
      status: "installed",
      record: {
        id: 1,
        name: "injected",
        source: "market",
        slug: "injected",
        version: "2.0.0",
      },
    });
    expect(versionCalls).toEqual(["injected"]);
    expect(downloadCalls).toEqual(["injected"]);
    expect(upsertCalls[0]!.create).toMatchObject({
      source: "market",
      slug: "injected",
      version: "2.0.0",
    });
    expect(existsSync(path.join(root, "injected", "SKILL.md"))).toBe(true);
  });
});

describe("inspectFromPath(dryRun:不落盘不写库)", () => {
  function writeZipFile(files: Record<string, string | Buffer>): string {
    const dir = makeTmpDir();
    const zipPath = path.join(dir, "pkg.zip");
    writeFileSync(zipPath, makeZip(files));
    return zipPath;
  }

  it("zip 形态:返回 name/description,不落盘不写库", async () => {
    const zipPath = writeZipFile({ "SKILL.md": SKILL_MD("demo") });
    const { root, installer, upsertCalls } = makeInstaller();
    const result = await installer.inspectFromPath(zipPath);
    expect(result).toEqual({
      status: "ok",
      name: "demo",
      description: "示例技能",
    });
    expect(readdirSync(root)).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
  });

  it("目录形态:返回 name/description", async () => {
    const srcDir = makeTmpDir();
    writeFileSync(path.join(srcDir, "SKILL.md"), SKILL_MD("demo"));
    const { installer } = makeInstaller();
    await expect(installer.inspectFromPath(srcDir)).resolves.toEqual({
      status: "ok",
      name: "demo",
      description: "示例技能",
    });
  });

  it("单层子目录 zip 形态同样可识别", async () => {
    const zipPath = writeZipFile({ "pkg/SKILL.md": SKILL_MD("demo") });
    const { installer } = makeInstaller();
    await expect(installer.inspectFromPath(zipPath)).resolves.toEqual({
      status: "ok",
      name: "demo",
      description: "示例技能",
    });
  });

  it("冲突 → {status:'conflict', name}", async () => {
    const zipPath = writeZipFile({ "SKILL.md": SKILL_MD("demo") });
    const { root, installer } = makeInstaller();
    mkdirSync(path.join(root, "demo"));
    await expect(installer.inspectFromPath(zipPath)).resolves.toEqual({
      status: "conflict",
      name: "demo",
    });
  });

  it("坏包 → throw;不落盘不写库", async () => {
    const zipPath = writeZipFile({ "README.md": "x" });
    const { root, installer, upsertCalls } = makeInstaller();
    await expect(installer.inspectFromPath(zipPath)).rejects.toThrow(
      "SKILL.md",
    );
    expect(readdirSync(root)).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("P-E 埋点(install 事件)", () => {
  function statStub() {
    const create = vi.fn().mockResolvedValue({});
    return { statRecord: { create } as SkillStatPrismaLike, create };
  }

  it("安装成功(市场/本地同流 installItems)→ 记 {name, install}", async () => {
    const { statRecord, create } = statStub();
    const { installer } = makeInstaller({ statRecord });
    await installer.installFromBuffer(
      makeZip({ "SKILL.md": SKILL_MD("demo") }),
      "local",
    );
    await vi.waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        data: { name: "demo", event: "install" },
      }),
    );
  });

  it("目录导入成功 → 同样记 install", async () => {
    const { statRecord, create } = statStub();
    const src = makeTmpDir();
    writeFileSync(path.join(src, "SKILL.md"), SKILL_MD("from-dir"));
    const { installer } = makeInstaller({ statRecord });
    await installer.importDirectory(src);
    await vi.waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        data: { name: "from-dir", event: "install" },
      }),
    );
  });

  it("冲突 → 不记;埋点 delegate 抛错 → 安装仍成功(DoD 主流程不受影响)", async () => {
    const conflictStat = statStub();
    const { root, installer } = makeInstaller({
      statRecord: conflictStat.statRecord,
    });
    mkdirSync(path.join(root, "demo"));
    await expect(
      installer.installFromBuffer(
        makeZip({ "SKILL.md": SKILL_MD("demo") }),
        "local",
      ),
    ).resolves.toEqual({ status: "conflict", name: "demo" });
    expect(conflictStat.create).not.toHaveBeenCalled();

    const failingCreate = vi.fn().mockRejectedValue(new Error("table locked"));
    const ok = await makeInstaller({
      statRecord: { create: failingCreate } as SkillStatPrismaLike,
    }).installer.installFromBuffer(
      makeZip({ "SKILL.md": SKILL_MD("demo2") }),
      "local",
    );
    expect(ok).toMatchObject({ status: "installed" });
  });
});
