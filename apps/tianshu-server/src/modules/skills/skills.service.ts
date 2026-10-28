import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from 'src/commons/database/prisma.service';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';
import { installSkillZip } from 'src/core/tools/skill-installer';

/** A3 尾：base64 zip 上传上限（与 mirror files/uploadImage 3MB 同口径，
 *  relay 单帧 4MiB 余量约束） */
const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;

/** A3 尾：skills/stats 统计项（与协议 SkillStatItem 同形） */
export interface SkillStatItem {
  name: string;
  usedCount: number;
  lastUsedAt: string | null;
}

/**
 * 技能面（AL 批）：清单（联想候选）+ 读全文（发送前并入消息文本——
 * mirror ⚡token 机制同构，技能正文由调用方拼进 content 发送）。
 * 数据源与 chat-runner 同一 loadSkills（skillsDir 技能目录）。
 */
@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

  private async listSkills(): Promise<
    Array<{
      name: string;
      description: string;
      bodyPath: string;
      dir: string;
    }>
  > {
    const { loadSkills } = await import('src/core/tools/skill-loader');
    const { resolveDataRoot } = await import('src/core/chat-runner.service');
    // 与 chat-runner collectSkills 同口径（用户级目录；enabled 过滤由
    // 调用方 skillRecord 过滤——联想清单展示全部，禁用技能发送侧拒）
    const skills = loadSkills([
      { dir: path.join(resolveDataRoot('.'), 'skills'), source: 'user' },
    ]);
    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      bodyPath: skill.bodyPath,
      dir: skill.dir,
    }));
  }

  /** 清单（联想候选＋启停管理＋扩展字段；enabled 经 skillRecord 对账——
   *  扫描态无记录视为启用，chat-runner 过滤口径一致；scenarios/source/
   *  builtin 为 A3 批契约扩展：行存在才出 scenarios/source，builtin 恒判
   *  source 字面值——见 skill-contract.ts SkillBriefExtension） */
  async query(): Promise<
    Array<{
      name: string;
      description: string | null;
      enabled: boolean;
      scenarios?: string[];
      source?: string;
      builtin?: boolean;
    }>
  > {
    const skills = await this.listSkills();
    const records = await this.prisma.skillRecord.findMany({
      select: { name: true, enabled: true, scenarios: true, source: true },
    });
    const byName = new Map(records.map((row) => [row.name, row]));
    return skills.map((skill) => {
      const record = byName.get(skill.name);
      return {
        name: skill.name,
        description: skill.description,
        enabled: record ? record.enabled : true,
        ...(record?.scenarios
          ? { scenarios: JSON.parse(record.scenarios) as string[] }
          : {}),
        ...(record ? { source: record.source } : {}),
        builtin: record?.source === 'builtin',
      };
    });
  }

  /** 启停切换（＋菜单技能子菜单多选——upsert skillRecord 行） */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const skills = await this.listSkills();
    const hit = skills.find((skill) => skill.name === name);
    if (!hit) {
      throw new BusinessException('技能不存在', ErrorCodeEnum.NOT_FOUND);
    }
    await this.prisma.skillRecord.upsert({
      where: { name },
      update: { enabled },
      create: {
        name,
        slug: hit.name,
        version: null as unknown as string,
        source: 'user',
        dir: hit.dir,
        description: hit.description,
        enabled,
      },
    });
  }

  /** 读技能全文（SKILL.md 正文） */
  async read(name: string): Promise<{ content: string }> {
    const skills = await this.listSkills();
    const hit = skills.find((skill) => skill.name === name);
    if (!hit) {
      throw new BusinessException('技能不存在', ErrorCodeEnum.NOT_FOUND);
    }
    return { content: await readFile(hit.bodyPath, 'utf-8') };
  }

  /** A3 尾：base64 zip 直装——解码 ≤3MB 校验 → installSkillZip 落盘安装
   *  （校验链/冲突/staging 语义与桌面 golden 同构）；包不合法/超上限
   *  SKILL_UPLOAD_INVALID（与桌面被控面同码，控制端统一判） */
  async installUpload(input: {
    name: string;
    base64: string;
    overwrite?: boolean;
  }): Promise<unknown> {
    const buf = Buffer.from(input.base64, 'base64');
    if (buf.length > UPLOAD_MAX_BYTES) {
      throw new BusinessException('zip 超过 3MB 上限', 'SKILL_UPLOAD_INVALID');
    }
    const { resolveDataRoot } = await import('src/core/chat-runner.service');
    const skillsRoot = path.join(resolveDataRoot('.'), 'skills');
    try {
      return await installSkillZip(buf, {
        skillsRoot,
        prisma: this.prisma.skillRecord,
        stat: this.prisma.skillStat,
        overwrite: input.overwrite === true,
      });
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      throw new BusinessException(
        error instanceof Error ? error.message : String(error),
        'SKILL_UPLOAD_INVALID',
      );
    }
  }

  /** A3 尾：skillStat 事件表聚合——usedCount = 该技能全部事件计数合计
   *  （install/create/enable/disable/uninstall/batch_*），lastUsedAt = 最新
   *  事件 ISO（无事件 null）；SQL groupBy 下推（与桌面 repo.stats 同口径） */
  async stats(): Promise<SkillStatItem[]> {
    const groups = await this.prisma.skillStat.groupBy({
      by: ['name', 'event'],
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const byName = new Map<string, SkillStatItem>();
    for (const group of groups) {
      const item = byName.get(group.name) ?? {
        name: group.name,
        usedCount: 0,
        lastUsedAt: null,
      };
      item.usedCount += group._count._all;
      const latest = group._max.createdAt;
      if (
        latest &&
        (item.lastUsedAt === null || latest > new Date(item.lastUsedAt))
      ) {
        item.lastUsedAt = latest.toISOString();
      }
      byName.set(group.name, item);
    }
    return [...byName.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }
}
