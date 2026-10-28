import { Injectable } from '@nestjs/common';
import type { AssistantBrief } from '@tianshu/protocol';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { PrismaService } from 'src/commons/database/prisma.service';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';
import {
  dedupeName,
  parseExpertJson,
  serializeExpert,
  type ExpertRowLike,
} from 'src/core/expert-io';

/**
 * 专家服务（只读概要）：无头端专家表现阶段通常为空（写入面后置），
 * 如实返回空列表——控制端 UI 空态即「无可选专家」。
 * systemPrompt 不外露（控制端只需 id/name 选择器）。
 */
/** quickPrompts JSON 字符串列解析（非数组/解析失败回退 null） */
function parseJsonArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : null;
  } catch {
    return null;
  }
}

@Injectable()
export class AssistantService {
  constructor(private readonly prisma: PrismaService) {}

  /** 概要行含 icon/quickPrompts（JSON 列查询期解析）——协议 AssistantBrief
   *  为 wire 出口形状（wire DTO class implements 同源绑定） */
  async query(): Promise<AssistantBrief[]> {
    const rows = await this.prisma.assistant.findMany({
      where: { userId: COMPANION_USER_ID },
      select: { id: true, name: true, icon: true, quickPrompts: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: null,
      icon: row.icon ?? null,
      // JSON 数组字符串列 → string[]（坏数据回退 null）
      quickPrompts: parseJsonArray(row.quickPrompts),
    }));
  }

  /** A2 尾：导出 JSON 文本——伴生用户行归属校验（不存在/越权同 4040 不
   *  泄露存在性）；builtin 同样可导（内容是用户可见的）；纯内容面零路径 */
  async export(id: number): Promise<{ json: string }> {
    const row = await this.prisma.assistant.findFirst({
      where: { id, userId: COMPANION_USER_ID },
    });
    if (!row) {
      throw new BusinessException('专家不存在', ErrorCodeEnum.NOT_FOUND);
    }
    return {
      json: JSON.stringify(serializeExpert(row as ExpertRowLike), null, 2),
    };
  }

  /** A2 尾：导入 JSON 文本——parse 校验（坏 JSON/缺 name/kind 不符 →
   *  ASSISTANT_INVALID 带原因）；重名 dedupeName 后缀；skillNames 仅保留
   *  已安装（skillRecord 表，与桌面过滤同语义）；members 随团 JSON 透传 */
  async import(payload: {
    json: string;
  }): Promise<{ id: number; name: string }> {
    const parsed = parseExpertJson(payload.json);
    if (!parsed.ok) {
      throw new BusinessException(parsed.reason, 'ASSISTANT_INVALID');
    }
    const data = parsed.data;
    const installed = new Set(
      (await this.prisma.skillRecord.findMany({ select: { name: true } })).map(
        (row) => row.name,
      ),
    );
    const skillNames = (data.skillNames ?? []).filter((name) =>
      installed.has(name),
    );
    const name = await dedupeName(data.name, async (candidate) => {
      const hit = await this.prisma.assistant.findFirst({
        where: { name: candidate, userId: COMPANION_USER_ID },
        select: { id: true },
      });
      return hit !== null;
    });
    const created = await this.prisma.assistant.create({
      data: {
        name,
        icon: data.icon,
        systemPrompt: data.systemPrompt,
        description: data.description,
        profession: data.profession,
        categoryId: data.categoryId,
        tags: data.tags ? JSON.stringify(data.tags) : undefined,
        quickPrompts: data.quickPrompts
          ? JSON.stringify(data.quickPrompts)
          : undefined,
        skillNames:
          skillNames.length > 0 ? JSON.stringify(skillNames) : undefined,
        // agent 归一不写列（列契约只存 team|NULL，与桌面 repo.create 同口径）
        expertType: data.expertType === 'team' ? 'team' : undefined,
        members: data.members ? JSON.stringify(data.members) : undefined,
        userId: COMPANION_USER_ID,
      },
    });
    return { id: created.id, name: created.name };
  }
}
