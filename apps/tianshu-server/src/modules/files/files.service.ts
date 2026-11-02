/**
 * 文件面服务（FA-T1，spec 2026-10-20 §3.1）：远程文件三端点的业务面——
 * 清单/守卫读取经 @tianshu/core 共享纯函数（mirror file:listWorkspaceFiles
 * 同口径，防双份漂移）；uploadImage 落数据根 attachments/ 返回相对路径
 * （sessionSend images 与 ImageBlock.imagePath 消费同值，远端引擎
 * loadImage 回喂零适配）。
 * 安全：read 的 relPath 经 workspace 根前缀校验（越界 FILES_PATH_ESCAPE）；
 * uploadImage 的 name 剥路径分隔（防目录逃逸）+ 3MB 上限（relay 单帧
 * 4MiB 余量，spec §6 假设 1）。
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listWorkspaceFiles, readTextFileGuarded } from '@tianshu/core';
import { PrismaService } from 'src/commons/database/prisma.service';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
// 数据根 config 口径单点（TIANSHU_DATA_ROOT 覆写链同源）
import { tianshuDataRoot } from 'src/commons/config/tianshu-data-root';
import type {
  RemoteFileContent,
  RemoteFileUploadInput,
  RemoteFileUploadResult,
} from '@tianshu/protocol';

/** realpath 宽松解析（file-tools 同构）：缺失段沿祖先解析——目标
 * 可能尚不存在（读取前校验）场景下以已存在祖先为准 */
function realpathLenient(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(realpathLenient(parent), path.basename(target));
  }
}

/** 图片上传上限（解码前字节；relay 单帧 4MiB 含信封/加密开销的余量） */
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

@Injectable()
export class FilesService {
  private readonly dataRoot: string;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    // dataRoot 走 config tianshu 段（chat/automation 同口径；曾硬编码
    // '~/.tianshu-server' 只认 env，config.yml 调 dataRoot 时上传目录与
    // chat 读写面分裂）。ConfigService 为可 DI 类型，无普通对象构造参问题
    this.dataRoot = tianshuDataRoot(configService);
  }

  /** workspace 绑定目录（未绑/不存在 → FILES_NO_WORKSPACE） */
  private async workspaceRoot(workspaceId: number): Promise<string> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId },
    });
    const root = workspace?.directoryPath?.trim();
    if (!root) {
      throw new BusinessException('未绑定工作空间目录', 'FILES_NO_WORKSPACE');
    }
    return root;
  }

  async list(workspaceId: number): Promise<string[]> {
    const root = await this.workspaceRoot(workspaceId);
    return listWorkspaceFiles(root);
  }

  async read(workspaceId: number, relPath: string): Promise<RemoteFileContent> {
    const root = await this.workspaceRoot(workspaceId);
    const absolute = path.resolve(root, relPath);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new BusinessException('路径越界', 'FILES_PATH_ESCAPE');
    }
    // 安全批 B4：realpath 双检（symlink 跟随后复判根内——resolve 前缀
    // 校验可被工作空间内 ln -s ~/.ssh/id_rsa x 逃逸）
    const realRoot = realpathLenient(root);
    const realAbs = realpathLenient(absolute);
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
      throw new BusinessException('路径越界', 'FILES_PATH_ESCAPE');
    }
    const guarded = await readTextFileGuarded(absolute);
    if (guarded.ok) {
      return { content: guarded.content };
    }
    if (guarded.reason === 'too-large') {
      throw new BusinessException('超过 512KB 上限', 'FILES_TOO_LARGE');
    }
    if (guarded.reason === 'binary') {
      throw new BusinessException('二进制文件', 'FILES_BINARY');
    }
    throw new BusinessException('读取失败', 'FILES_READ_FAILED');
  }

  async uploadImage(
    input: RemoteFileUploadInput,
  ): Promise<RemoteFileUploadResult> {
    const bytes = Buffer.from(input.base64, 'base64');
    if (bytes.length > IMAGE_MAX_BYTES) {
      throw new BusinessException('图片超过 3MB 上限', 'FILES_IMAGE_TOO_LARGE');
    }
    // name 归一：剥路径段（防 ../ 与子目录逃逸），空名兜底；冲突隔离走
    // 唯一子目录——文件保原名（ImageBlock.name/展示名 = 尾段 = 原名）
    const safeName = path.basename(input.name ?? '') || 'image.png';
    const dirName = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const dir = path.join(this.dataRoot, 'attachments', dirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, safeName), bytes);
    return { imagePath: `attachments/${dirName}/${safeName}` };
  }
}
