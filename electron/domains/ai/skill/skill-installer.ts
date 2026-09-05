/**
 * 技能安装编排(P-C spec §2.2):解压/校验/冲突覆盖/落盘/入库。
 * 纯 Node fs + adm-zip(禁 import electron),skillsRoot/prisma/fetch 注入可测。
 * 安全模型双层:T1 纯函数层(validateArchiveEntries)先查路径与数量;
 * 落盘前逐条 isInsideDir(resolve 型,以 staging 目录为界)复核 +
 * Windows 盘符原语拒绝,解压后按实际字节数复验单文件/总量上限(纯函数层拿不到大小)。
 */
import AdmZip from "adm-zip";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  DEFAULTS,
  locateSkillRoot,
  validateArchiveEntries,
  validateSkillMd,
} from "./skill-archive";
import { isInsideDir } from "./skill-sync";

export type InstallResult =
  | {
      status: "installed";
      record: {
        id: number;
        name: string;
        source: string;
        slug: string | null;
        version: string | null;
      };
    }
  | { status: "conflict"; name: string };

export type InspectResult =
  | { status: "ok"; name: string; description: string }
  | { status: "conflict"; name: string };

export interface SkillRecordDbRow {
  id: number;
  name: string;
  slug: string | null;
  version: string | null;
  source: string;
  dir: string;
  description: string | null;
  enabled: boolean;
  installedAt: Date;
}

export interface SkillRecordUpsertData {
  name: string;
  slug: string | null;
  version: string | null;
  source: string;
  dir: string;
  description: string;
}

/** prisma skillRecord 结构子集(注入 stub/真实客户端均可) */
export interface SkillRecordPrismaLike {
  findFirst(args: {
    where: { name: string };
  }): Promise<SkillRecordDbRow | null>;
  upsert(args: {
    where: { name: string };
    create: SkillRecordUpsertData;
    update: Omit<SkillRecordUpsertData, "name">;
  }): Promise<SkillRecordDbRow>;
  delete(args: { where: { id: number } }): Promise<unknown>;
}

/** zip/目录统一条目模型:目录条目 name 以 / 结尾;read 惰性取实际字节 */
interface ArchiveItem {
  name: string;
  isDirectory: boolean;
  read: () => Buffer;
}

/** Windows 盘符绝对路径原语(如 C:/x;T1 posix.isAbsolute 放行,须此层兜底) */
const DRIVE_LETTER_RE = /^[A-Za-z]:[\\/]/;

/** macOS 打包产物噪音:__MACOSX/ 前缀(AppleDouble)与 .DS_Store,定位/落盘前过滤 */
function isNoiseEntry(name: string): boolean {
  return name
    .split("/")
    .some((segment) => segment === "__MACOSX" || segment === ".DS_Store");
}

/** frontmatter name 作为落盘目录名必须是无害单段路径 */
function isSafeDirName(name: string): boolean {
  return (
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !name.includes(":")
  );
}

/** 条目名统一 posix 风格(Windows zip 常用反斜杠分隔) */
function toPosix(entryName: string): string {
  return entryName.replace(/\\/g, "/");
}

export class SkillInstaller {
  private readonly skillsRoot: string;
  private readonly prisma: SkillRecordPrismaLike;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly limits: { maxFileBytes: number; maxTotalBytes: number };
  private readonly download?: (slug: string) => Promise<ArrayBuffer>;
  private readonly getVersion?: (slug: string) => Promise<string>;

  constructor(deps: {
    skillsRoot: string;
    prisma: SkillRecordPrismaLike;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    limits?: Partial<{ maxFileBytes: number; maxTotalBytes: number }>;
    /** 市场下载注入(优先于内部 fetch):SkillHubClient.downloadZip,带鉴权与重试 */
    download?: (slug: string) => Promise<ArrayBuffer>;
    /** 版本查询注入(优先于内部 fetch):SkillHubClient.getDetail → latestVersion.version */
    getVersion?: (slug: string) => Promise<string>;
  }) {
    this.skillsRoot = deps.skillsRoot;
    this.prisma = deps.prisma;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.baseUrl = deps.baseUrl ?? "https://api.skillhub.cn";
    this.limits = {
      maxFileBytes: DEFAULTS.maxFileBytes,
      maxTotalBytes: DEFAULTS.maxTotalBytes,
      ...deps.limits,
    };
    this.download = deps.download;
    this.getVersion = deps.getVersion;
  }

  async installFromBuffer(
    buf: Buffer,
    source: "market" | "local",
    meta?: { slug?: string; version?: string },
    overwrite = false,
  ): Promise<InstallResult> {
    const zip = new AdmZip(buf);
    const items: ArchiveItem[] = zip.getEntries().map((entry) => ({
      name: toPosix(entry.entryName),
      isDirectory: entry.isDirectory,
      read: () => entry.getData(),
    }));
    return this.installItems(items, source, meta, overwrite);
  }

  async importDirectory(
    dir: string,
    overwrite = false,
  ): Promise<InstallResult> {
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      throw new Error(`目录不存在或不是目录:${dir}`);
    }
    return this.installItems(
      this.itemsFromDir(dir),
      "local",
      undefined,
      overwrite,
    );
  }

  /** zip 文件或目录导入(Task 3 skill:import 实现) */
  async importFromPath(
    filePath: string,
    overwrite = false,
  ): Promise<InstallResult> {
    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat) {
      throw new Error(`路径不存在:${filePath}`);
    }
    return stat.isDirectory()
      ? this.importDirectory(filePath, overwrite)
      : this.installFromBuffer(
          readFileSync(filePath),
          "local",
          undefined,
          overwrite,
        );
  }

  /**
   * 市场安装:详情接口取 version 一次 + 下载 zip(spec §8 决策 5)。
   * 注入 download/getVersion(repo 装配 SkillHubClient)时优先使用,
   * 否则回退内部 fetch(测试/独立使用形态)
   */
  async downloadAndInstall(
    slug: string,
    overwrite = false,
  ): Promise<InstallResult> {
    const version = this.getVersion
      ? await this.getVersion(slug)
      : await this.fetchLatestVersion(slug);
    const buf = this.download
      ? Buffer.from(await this.download(slug))
      : await this.fetchZip(slug);
    return this.installFromBuffer(
      buf,
      "market",
      { slug, version: version ?? undefined },
      overwrite,
    );
  }

  /** dryRun:校验 + 冲突检测,不落盘不写库(Task 5 导入弹窗消费) */
  async inspectFromPath(filePath: string): Promise<InspectResult> {
    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat) {
      throw new Error(`路径不存在:${filePath}`);
    }
    const items = stat.isDirectory()
      ? this.itemsFromDir(filePath)
      : this.itemsFromZip(readFileSync(filePath));
    const { name, description } = this.parseSkill(items);
    const conflict = await this.detectConflict(
      name,
      path.join(this.skillsRoot, name),
    );
    return conflict
      ? { status: "conflict", name }
      : { status: "ok", name, description };
  }

  private itemsFromZip(buf: Buffer): ArchiveItem[] {
    const zip = new AdmZip(buf);
    return zip.getEntries().map((entry) => ({
      name: toPosix(entry.entryName),
      isDirectory: entry.isDirectory,
      read: () => entry.getData(),
    }));
  }

  private itemsFromDir(dir: string): ArchiveItem[] {
    const items: ArchiveItem[] = [];
    const walk = (abs: string, base: string) => {
      for (const dirent of readdirSync(abs, { withFileTypes: true })) {
        const rel = base ? `${base}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) {
          items.push({
            name: `${rel}/`,
            isDirectory: true,
            read: () => Buffer.alloc(0),
          });
          walk(path.join(abs, dirent.name), rel);
        } else if (dirent.isFile()) {
          items.push({
            name: rel,
            isDirectory: false,
            read: () => readFileSync(path.join(abs, dirent.name)),
          });
        }
      }
    };
    walk(dir, "");
    return items;
  }

  /**
   * 校验链(调用顺序固定):过滤噪音 → validateArchiveEntries →
   * locateSkillRoot → validateSkillMd → name 可作目录名
   */
  private parseSkill(items: ArchiveItem[]): {
    name: string;
    description: string;
    entries: ArchiveItem[];
    rootPrefix: string;
  } {
    const entries = items.filter((item) => !isNoiseEntry(item.name));
    const names = entries.map((item) => item.name);
    const check = validateArchiveEntries(names);
    if (!check.ok) throw new Error(check.reason);
    const located = locateSkillRoot(names) as
      { ok: false; reason: string } | { ok: true; root: string };
    if (!located.ok) throw new Error(located.reason);
    const rootPrefix = located.root ? `${located.root}/` : "";
    const skillMdEntry = entries.find(
      (e) => e.name === `${rootPrefix}SKILL.md`,
    );
    if (!skillMdEntry) throw new Error("未找到 SKILL.md");
    // ArchiveCheck 的 {ok:true} 形态混入联合,此处收窄到 validateSkillMd 的 ok 形态
    const skillMd = validateSkillMd(skillMdEntry.read().toString("utf8")) as
      | { ok: false; reason: string }
      | { ok: true; name: string; description: string };
    if (!skillMd.ok) throw new Error(skillMd.reason);
    if (!isSafeDirName(skillMd.name)) {
      throw new Error(`技能名不能用作目录名:${skillMd.name}`);
    }
    return {
      name: skillMd.name,
      description: skillMd.description,
      entries,
      rootPrefix,
    };
  }

  /** 冲突 = 目标目录已存在 或 DB 有同名记录(不落盘不写库) */
  private async detectConflict(
    name: string,
    targetDir: string,
  ): Promise<boolean> {
    if (existsSync(targetDir)) return true;
    const row = await this.prisma.findFirst({ where: { name } });
    return row !== null;
  }

  private async installItems(
    items: ArchiveItem[],
    source: "market" | "local",
    meta: { slug?: string; version?: string } | undefined,
    overwrite: boolean,
  ): Promise<InstallResult> {
    const { name, description, entries, rootPrefix } = this.parseSkill(items);
    const targetDir = path.join(this.skillsRoot, name);
    if (!overwrite && (await this.detectConflict(name, targetDir))) {
      return { status: "conflict", name };
    }
    // 随机后缀防并发 IPC 同毫秒共享 staging 互相覆盖/误清
    mkdirSync(this.skillsRoot, { recursive: true });
    const stagingDir = mkdtempSync(path.join(this.skillsRoot, ".staging-"));
    try {
      this.writeStaging(stagingDir, entries, rootPrefix);
      if (overwrite) {
        rmSync(targetDir, { recursive: true, force: true });
      }
      cpSync(stagingDir, targetDir, { recursive: true });
      const row = await this.prisma.upsert({
        where: { name },
        create: {
          name,
          slug: meta?.slug ?? null,
          version: meta?.version ?? null,
          source,
          dir: targetDir,
          description,
        },
        // update 不写 enabled/installedAt:保留既有记录语义
        update: {
          slug: meta?.slug ?? null,
          version: meta?.version ?? null,
          source,
          dir: targetDir,
          description,
        },
      });
      return {
        status: "installed",
        record: {
          id: row.id,
          name: row.name,
          source: row.source,
          slug: row.slug,
          version: row.version,
        },
      };
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * staging 中转落盘:每条目 isInsideDir(resolve,以 stagingDir 为界)复核 +
   * 实际字节限额。边界必须是 stagingDir:若以 skillsRoot 为界,组合段
   * `pkg/../evil.txt`(T1 normalize 后通过、root=pkg)会落到 skillsRoot
   * 顶层 —— 逃出 staging,finally 清理不掉,可覆盖已安装技能
   */
  private writeStaging(
    stagingDir: string,
    entries: ArchiveItem[],
    rootPrefix: string,
  ): void {
    let totalBytes = 0;
    for (const entry of entries) {
      // 只落技能根下的条目:子目录根定位时,压缩包顶层的散落条目不属技能内容
      if (!entry.name.startsWith(rootPrefix)) continue;
      const rel = entry.name.slice(rootPrefix.length);
      if (!rel || rel === "/") continue; // 技能根目录条目本身
      const dest = path.join(stagingDir, rel);
      // resolve 型兜底:堵 T1 normalize 后仍放行的 ".."(单级组合段)与 Windows 盘符原语
      if (!isInsideDir(dest, stagingDir) || DRIVE_LETTER_RE.test(rel)) {
        throw new Error(`存在不安全路径:${entry.name}`);
      }
      if (entry.isDirectory) {
        mkdirSync(dest, { recursive: true });
        continue;
      }
      const data = entry.read();
      if (data.length > this.limits.maxFileBytes) {
        throw new Error(
          `单文件超过大小上限(${this.limits.maxFileBytes} 字节):${entry.name}`,
        );
      }
      totalBytes += data.length;
      if (totalBytes > this.limits.maxTotalBytes) {
        throw new Error(
          `总量超过大小上限(${this.limits.maxTotalBytes} 字节):${entry.name}`,
        );
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    }
  }

  private async fetchLatestVersion(slug: string): Promise<string | null> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/skills/${encodeURIComponent(slug)}`,
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(pickErrorMessage(body) ?? `HTTP ${res.status}`);
    }
    const detail = unwrapEnvelope(body) as {
      latestVersion?: { version?: string };
      skill?: { version?: string };
    } | null;
    return detail?.latestVersion?.version ?? detail?.skill?.version ?? null;
  }

  private async fetchZip(slug: string): Promise<Buffer> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/download?slug=${encodeURIComponent(slug)}`,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(pickErrorMessage(body) ?? `HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

/** 错误响应 {error: string} 文案(平台侧错误协议);无则 null */
function pickErrorMessage(body: unknown): string | null {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return null;
}

/** 信封 {code,message,data} 解包;裸对象原样返回 */
function unwrapEnvelope(body: unknown): unknown {
  if (body && typeof body === "object" && "code" in body) {
    const envelope = body as { code: number; message?: string; data: unknown };
    if (envelope.code !== 0) {
      throw new Error(envelope.message || `code ${envelope.code}`);
    }
    return envelope.data;
  }
  return body;
}
