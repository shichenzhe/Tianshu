/**
 * 恢复装配（spec 2026-10-27 §4）：解包到 staging → 备份范围内逐项
 * 三步 rename 原子切换（旧→.restore-old-<stamp>/ 暂存、staging→正式、
 * 清暂存），任一步失败反向恢复已动项（账本逆序：新就位项删除、旧项
 * 归位；直放置项亦记账，失败即删——不留新数据残留）；范围=
 * BACKUP_ASSET_DIRS + database + .jwt-secret，范围外（logs 等）原样
 * 不动。staging 与暂存目录都放 tianshuRoot() 直下（同卷保 rename
 * 原子）。语义裁定：包中无该项→本地保留不动（换机场景旧库可能缺
 * workflow-assets）。测试失败注入：__setFailOnStep(step, occurrence=1)。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { appDataHome, tianshuRoot } from "../../commons/paths";
import {
  BACKUP_ASSET_DIRS,
  createBackupArchive,
  type SnapshotDatabase,
} from "./snapshot";
import { unpackTarGz } from "./ustar-tar";

/** 保护副本目录名（数据根直下、分组外——恢复切换波及不到） */
export const SAFETY_COPY_DIR_NAME = "backups-local";

/**
 * 测试失败注入：step>0 时对应切换步（1=旧→暂存 2=staging→正式 3=清暂存）
 * 第 occurrence 次到达处抛错（默认第 1 次；0=不注入）
 */
let failOnStep = 0;
let failOccurrence = 1;
let failHits = 0;
export function __setFailOnStep(step: number, occurrence = 1): void {
  failOnStep = step;
  failOccurrence = occurrence;
  failHits = 0;
}

/** 注入点：到达次数命中设定序次时抛错（step 1/2 每 staged 目标各一次、3 循环后一次） */
function injectFail(step: 1 | 2 | 3): void {
  if (failOnStep !== step) return;
  failHits += 1;
  if (failHits === failOccurrence)
    throw new Error(`injected fail step ${step}`);
}

/** 回滚账本条目：current=正式位路径；parked=旧数据暂存位（null=直放置项，回滚即删） */
interface MovedItem {
  current: string;
  parked: string | null;
}

/** 切换单元：备份范围内的具名目标（相对 appDataHome；恢复范围=备份范围） */
function switchTargets(): string[] {
  return ["database", ...BACKUP_ASSET_DIRS, ".jwt-secret"];
}

/** 三步切换单遍：范围内逐项 旧→暂存、staging→正式；已动项（含直放置）记入账本 */
function switchIntoPlace(
  home: string,
  staging: string,
  parkedRoot: string,
  moved: MovedItem[],
): void {
  for (const target of switchTargets()) {
    const current = path.join(home, target);
    const staged = path.join(staging, target);
    if (!existsSync(staged)) continue; // 包中无该项→本地保留不动
    injectFail(1);
    let parked: string | null = null;
    if (existsSync(current)) {
      mkdirSync(parkedRoot, { recursive: true });
      parked = path.join(parkedRoot, target);
      renameSync(current, parked);
      moved.push({ current, parked }); // 挪动即记账（含尚未就位——回滚须归位）
    }
    injectFail(2);
    renameSync(staged, current);
    if (parked === null) moved.push({ current, parked: null }); // 直放置项记账：回滚即删
  }
}

/** 回滚：账本逆序——正式位新数据删除、旧项自暂存归位（直放置项仅删）；尽力全量执行，首个错抛出 */
function rollbackMoved(moved: MovedItem[]): void {
  let firstError: unknown;
  for (const item of moved.reverse()) {
    try {
      rmSync(item.current, { recursive: true, force: true });
      if (item.parked !== null) renameSync(item.parked, item.current);
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError !== undefined) throw firstError;
}

/** 切换失败处置：回滚后清暂存；回滚自身异常时保留暂存目录待人工恢复（原始错误挂 cause 保 stack） */
function handleSwitchFailure(
  err: unknown,
  moved: MovedItem[],
  parkedRoot: string,
): never {
  try {
    rollbackMoved(moved);
    rmSync(parkedRoot, { recursive: true, force: true });
  } catch (rollbackErr) {
    throw new Error(
      `恢复失败且回滚异常（暂存目录保留待人工恢复：${parkedRoot}）：` +
        `${String(rollbackErr)}；原始错误：${String(err)}`,
      { cause: rollbackErr },
    );
  }
  throw err;
}

/**
 * 恢复装配入口：staging 解包（数据根直下，同卷）→ 三步原子切换 →
 * 清暂存；坏包在解包步即抛错（现有数据零损伤）；切换步任何异常自动
 * 回滚到恢复前完整旧态（含直放置新数据删除），staging 与暂存目录
 * 始终清理。
 */
export async function restoreArchive(archivePath: string): Promise<void> {
  const staging = mkdtempSync(path.join(tianshuRoot(), ".restore-staging-"));
  const parkedRoot = path.join(tianshuRoot(), `.restore-old-${Date.now()}`);
  const moved: MovedItem[] = [];
  try {
    await unpackTarGz(archivePath, staging);
    try {
      switchIntoPlace(appDataHome(), staging, parkedRoot, moved);
      injectFail(3);
      rmSync(parkedRoot, { recursive: true, force: true });
    } catch (err) {
      handleSwitchFailure(err, moved, parkedRoot);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * 恢复前保护副本：当前数据打 tar.gz 存数据根 backups-local/（不走网络，
 * 分组外目录——恢复切换波及不到）。snapshotDatabase 沿注入透传
 * （vitest 替身，避开 better-sqlite3 ABI）。
 */
export async function createLocalSafetyCopy(
  tempDir: string,
  snapshotDatabase?: SnapshotDatabase,
): Promise<string> {
  const outDir = path.join(tianshuRoot(), SAFETY_COPY_DIR_NAME);
  mkdirSync(outDir, { recursive: true });
  const { archivePath } = await createBackupArchive({
    tempDir,
    appVersion: "safety-copy",
    snapshotDatabase,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(outDir, `safety-${stamp}.tar.gz`);
  renameSync(archivePath, dest);
  return dest;
}
