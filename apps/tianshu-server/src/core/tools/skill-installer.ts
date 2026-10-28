/**
 * 技能 zip 安装（A3 尾）——按 mirror 桌面 golden
 * electron/domains/ai/skill/skill-installer.ts 的 installFromBuffer 语义
 * 移植（无头端无 installer 先例，留档）：解压校验链（噪音过滤 →
 * validateArchiveEntries → locateSkillRoot → validateSkillMd → name 可作
 * 目录名）→ 冲突检测 → staging 中转落盘（isInsideDir 复核 + 实际字节
 * 限额）→ upsert skillRecord → install 埋点（fire-and-forget）。
 * 市场下载通道（downloadAndInstall）不移植——skillhub 为桌面被控面专属。
 * 纯 Node fs + adm-zip；skillsRoot/prisma/stat 注入可测。
 */
import AdmZip from 'adm-zip';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  ARCHIVE_DEFAULTS,
  isInsideDir,
  locateSkillRoot,
  validateArchiveEntries,
  validateSkillMd,
} from './skill-archive';

export type SkillInstallResult =
  | {
      status: 'installed';
      record: {
        id: number;
        name: string;
        source: string;
        slug: string | null;
        version: string | null;
      };
    }
  | { status: 'conflict'; name: string };

/** prisma skillRecord 结构子集（注入 stub/真实客户端均可） */
export interface SkillRecordPrismaLike {
  findFirst(args: {
    where: { name: string };
  }): Promise<{ id: number; name: string } | null>;
  upsert(args: {
    where: { name: string };
    create: {
      name: string;
      slug: string | null;
      version: string | null;
      source: string;
      dir: string;
      description: string;
      enabled: boolean;
    };
    update: {
      slug: string | null;
      version: string | null;
      source: string;
      dir: string;
      description: string;
    };
  }): Promise<{ id: number; name: string; source: string }>;
}

/** prisma skillStat 结构子集（install 埋点；缺席静默跳过） */
export interface SkillStatPrismaLike {
  create(args: { data: { name: string; event: string } }): Promise<unknown>;
}

/** zip 统一条目模型：目录条目 name 以 / 结尾；read 惰性取实际字节 */
interface ArchiveItem {
  name: string;
  isDirectory: boolean;
  read: () => Buffer;
}

/** Windows 盘符绝对路径原语（如 C:/x；posix.isAbsolute 放行，须此层兜底） */
const DRIVE_LETTER_RE = /^[A-Za-z]:[\\/]/;

/** macOS 打包产物噪音：__MACOSX/ 前缀(AppleDouble)与 .DS_Store */
function isNoiseEntry(name: string): boolean {
  return name
    .split('/')
    .some((segment) => segment === '__MACOSX' || segment === '.DS_Store');
}

/** frontmatter name 作为落盘目录名必须是无害单段路径 */
function isSafeDirName(name: string): boolean {
  return (
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.includes(':')
  );
}

/** 条目名统一 posix 风格（Windows zip 常用反斜杠分隔） */
function toPosix(entryName: string): string {
  return entryName.replace(/\\/g, '/');
}

/**
 * zip buffer 安装（skills/installUpload 宿主侧真身）：
 * 冲突 = 目标目录已存在 或 DB 有同名记录（返回 {status:"conflict"}，
 * 与桌面导入弹窗覆写确认口径一致；overwrite 由调用方定）。
 */
export async function installSkillZip(
  buf: Buffer,
  deps: {
    skillsRoot: string;
    prisma: SkillRecordPrismaLike;
    stat?: SkillStatPrismaLike;
    overwrite?: boolean;
    limits?: Partial<
      Pick<typeof ARCHIVE_DEFAULTS, 'maxFileBytes' | 'maxTotalBytes'>
    >;
  },
): Promise<SkillInstallResult> {
  const { prisma, skillsRoot, stat } = deps;
  const overwrite = deps.overwrite ?? false;
  const limits = {
    maxFileBytes: ARCHIVE_DEFAULTS.maxFileBytes,
    maxTotalBytes: ARCHIVE_DEFAULTS.maxTotalBytes,
    ...deps.limits,
  };
  const zip = new AdmZip(buf);
  const items: ArchiveItem[] = zip.getEntries().map((entry) => ({
    name: toPosix(entry.entryName),
    isDirectory: entry.isDirectory,
    read: () => entry.getData(),
  }));
  const parsed = parseSkill(items);
  const { name, description, entries, rootPrefix } = parsed;
  const targetDir = path.join(skillsRoot, name);
  if (!overwrite && (await detectConflict(prisma, name, targetDir))) {
    return { status: 'conflict', name };
  }
  // 随机后缀防并发同毫秒共享 staging 互相覆盖/误清
  mkdirSync(skillsRoot, { recursive: true });
  const stagingDir = mkdtempSync(path.join(skillsRoot, '.staging-'));
  try {
    writeStaging(stagingDir, entries, rootPrefix, limits);
    if (overwrite) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    cpSync(stagingDir, targetDir, { recursive: true });
    const row = await prisma.upsert({
      where: { name },
      create: {
        name,
        slug: null,
        version: null,
        source: 'local',
        dir: targetDir,
        description,
        enabled: true,
      },
      // update 不写 enabled/installedAt：保留既有记录语义（桌面同口径）
      update: {
        slug: null,
        version: null,
        source: 'local',
        dir: targetDir,
        description,
      },
    });
    // install 埋点：fire-and-forget，失败静默（埋点不影响安装结果）
    if (stat) {
      stat.create({ data: { name, event: 'install' } }).catch(() => undefined);
    }
    return {
      status: 'installed',
      record: {
        id: row.id,
        name: row.name,
        source: row.source,
        slug: null,
        version: null,
      },
    };
  } finally {
    // 清理失败（EBUSY/EPERM）静默吞：残留 .staging-* 点前缀不被扫成技能
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // 吞错：残留 staging 无害
    }
  }
}

/**
 * 校验链（调用顺序固定）：过滤噪音 → validateArchiveEntries →
 * locateSkillRoot → validateSkillMd → name 可作目录名
 */
function parseSkill(items: ArchiveItem[]): {
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
  const rootPrefix = located.root ? `${located.root}/` : '';
  const skillMdEntry = entries.find((e) => e.name === `${rootPrefix}SKILL.md`);
  if (!skillMdEntry) throw new Error('未找到 SKILL.md');
  const skillMd = validateSkillMd(skillMdEntry.read().toString('utf8')) as
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

/** 冲突 = 目标目录已存在 或 DB 有同名记录（不落盘不写库） */
async function detectConflict(
  prisma: SkillRecordPrismaLike,
  name: string,
  targetDir: string,
): Promise<boolean> {
  if (existsSync(targetDir)) return true;
  const row = await prisma.findFirst({ where: { name } });
  return row !== null;
}

/**
 * staging 中转落盘：每条目 isInsideDir(resolve，以 stagingDir 为界)复核 +
 * 实际字节限额。边界必须是 stagingDir（若以 skillsRoot 为界，组合段
 * `pkg/../evil.txt` 会逃出 staging）——桌面 golden 注释同案
 */
function writeStaging(
  stagingDir: string,
  entries: ArchiveItem[],
  rootPrefix: string,
  limits: { maxFileBytes: number; maxTotalBytes: number },
): void {
  let totalBytes = 0;
  for (const entry of entries) {
    // 只落技能根下的条目：子目录根定位时，压缩包顶层的散落条目不属技能内容
    if (!entry.name.startsWith(rootPrefix)) continue;
    const rel = entry.name.slice(rootPrefix.length);
    if (!rel || rel === '/') continue; // 技能根目录条目本身
    const dest = path.join(stagingDir, rel);
    // resolve 型兜底：堵 normalize 后仍放行的 '..'（单级组合段）与盘符原语
    if (!isInsideDir(dest, stagingDir) || DRIVE_LETTER_RE.test(rel)) {
      throw new Error(`存在不安全路径:${entry.name}`);
    }
    if (entry.isDirectory) {
      mkdirSync(dest, { recursive: true });
      continue;
    }
    const data = entry.read();
    if (data.length > limits.maxFileBytes) {
      throw new Error(
        `单文件超过大小上限(${limits.maxFileBytes} 字节):${entry.name}`,
      );
    }
    totalBytes += data.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(
        `总量超过大小上限(${limits.maxTotalBytes} 字节):${entry.name}`,
      );
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  }
}
