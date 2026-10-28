/**
 * 备份 HTTP 客户端（spec 2026-10-27 §4 + 2026-10-28 多用户扩展）：独立
 * fetch——不走 transport 15s 超时窗，大块传输按块设独立超时
 * （CHUNK_TIMEOUT_MS）；starter 包装体判错（业务错 = HTTP 200 +
 * success:false，与 transport.ts 头注释契约同口径，错码是 server 内联
 * 字符串，客户端不 import 只透传 message）。单块失败重试 ≤3 次后抛最后
 * 错（server 收块即验 hash，重传幂等安全）；create/commit/list/delete
 * 不重试——create 非幂等（重试会重复登记），其余低频直抛。
 * 凭据双轨（多用户批）：token=备份身份（backupToken 语义，数据面用）；
 * gatewayToken=大门 token（claim 申领与 invites/clients 管理面用——
 * 申领时客户端身份尚不存在）。
 */
import { createHash } from "node:crypto";
import { appendFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BACKUP_CHUNK_BYTES } from "@tianshu/protocol";
import type {
  BackupClientRecord,
  BackupClaimResult,
  BackupCommitResult,
  BackupCreateRequest,
  BackupInviteRecord,
  BackupListResult,
  BackupMeta,
} from "@tianshu/protocol";

/** 单块传输独立超时窗（4MB 块 + 慢上行/下行余量；非 transport 全局窗） */
const CHUNK_TIMEOUT_MS = 120_000;
/** 单块失败重试上限（抛最后错） */
const MAX_CHUNK_RETRIES = 3;

/** starter 包装体（ResponseInterceptor 统一包装形状） */
interface WrappedBody {
  code: string;
  success: boolean;
  data: unknown;
  message: string;
}

export class BackupClient {
  constructor(
    private readonly opts: {
      baseUrl: string;
      /** 默认凭据（backupToken 语义——备份数据面身份） */
      token?: string;
      /** 大门 token（claim/管理面用——gatewayToken ?? token；申领时
       * clientToken 尚不存在，凭据必须是连接远控 token 而非备份身份） */
      gatewayToken?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private async post(
    pathSuffix: string,
    body: unknown,
    tokenOverride?: string,
  ): Promise<unknown> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const token = tokenOverride ?? this.opts.token;
    const res = await fetchImpl(`${this.opts.baseUrl}${pathSuffix}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
    });
    const wrapped = (await res.json()) as WrappedBody;
    if (!res.ok || !wrapped.success) {
      throw new Error(
        `backup 请求失败（${pathSuffix}）：HTTP ${res.status} code=${wrapped.code} ${wrapped.message}`,
      );
    }
    return wrapped.data;
  }

  async list(): Promise<BackupMeta[]> {
    const r = (await this.post("/backup/list", {})) as BackupListResult;
    return r.backups;
  }

  /** 列表完整结果（多用户批：viewer 声明查看者身份——UI admin 面板显隐
   *  判定；face 面（BackupMeta[]）与 IPC 面分流见 ipc.ts 注记） */
  async listWithViewer(): Promise<BackupListResult> {
    return (await this.post("/backup/list", {})) as BackupListResult;
  }

  async remove(id: string): Promise<void> {
    await this.post(`/backup/${id}/delete`, {});
  }

  // —— 多用户扩展（spec 2026-10-28 §2）：claim 申领 + invites/clients 管理面 ——

  /** 邀请码申领：authorization 走大门 token（gatewayToken ?? token）——
   *  此刻尚无备份身份（clientToken 是本调用返回值），勿用 token 覆盖 */
  async claim(
    inviteCode: string,
    deviceName: string,
  ): Promise<BackupClaimResult> {
    return (await this.post(
      "/backup/claim",
      { inviteCode, deviceName },
      this.opts.gatewayToken ?? this.opts.token,
    )) as BackupClaimResult;
  }

  async createInvites(
    count?: number,
    note?: string,
  ): Promise<BackupInviteRecord[]> {
    const r = (await this.post("/backup/invites/create", {
      ...(count != null ? { count } : {}),
      ...(note ? { note } : {}),
    })) as { invites: BackupInviteRecord[] };
    return r.invites;
  }

  async listInvites(): Promise<BackupInviteRecord[]> {
    const r = (await this.post("/backup/invites/list", {})) as {
      invites: BackupInviteRecord[];
    };
    return r.invites;
  }

  async removeInvite(code: string): Promise<void> {
    await this.post(`/backup/invites/${code}/delete`, {});
  }

  async listClients(): Promise<BackupClientRecord[]> {
    const r = (await this.post("/backup/clients/list", {})) as {
      clients: BackupClientRecord[];
    };
    return r.clients;
  }

  async removeClient(clientId: string): Promise<void> {
    await this.post(`/backup/clients/${clientId}/delete`, {});
  }

  async uploadArchive(
    archivePath: string,
    meta: BackupCreateRequest,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void,
  ): Promise<BackupCommitResult> {
    const { id } = (await this.post("/backup/create", meta)) as { id: string };
    const buf = await readFile(archivePath);
    let uploaded = 0;
    for (let seq = 0; seq < meta.chunkCount; seq++) {
      const chunk = buf.subarray(
        seq * BACKUP_CHUNK_BYTES,
        (seq + 1) * BACKUP_CHUNK_BYTES,
      );
      const chunkSha256 = createHash("sha256").update(chunk).digest("hex");
      await this.retry(async () => {
        await this.post(`/backup/${id}/chunk`, {
          seq,
          data: chunk.toString("base64"),
          chunkSha256,
        });
      });
      uploaded += chunk.length;
      onProgress?.(uploaded, meta.fileSize);
    }
    return (await this.post(`/backup/${id}/commit`, {
      sha256: meta.sha256,
    })) as BackupCommitResult;
  }

  async downloadArchive(
    id: string,
    destPath: string,
    onProgress?: (downloadedBytes: number, totalBytes: number) => void,
  ): Promise<{ sha256: string }> {
    rmSync(destPath, { force: true });
    let downloaded = 0;
    // eslint-disable-next-line no-useless-assignment -- Infinity 兜底：首块到达前进度未知
    let total = Infinity;
    let seq = 0;
    for (;;) {
      const r = await this.retry(
        async () =>
          (await this.post(`/backup/${id}/download`, { seq })) as {
            data: string;
            totalChunks: number;
          },
      );
      total = r.totalChunks * BACKUP_CHUNK_BYTES;
      const chunk = Buffer.from(r.data, "base64");
      appendFileSync(destPath, chunk);
      downloaded += chunk.length;
      onProgress?.(downloaded, total);
      seq += 1;
      if (seq >= r.totalChunks) break;
    }
    const buf = await readFile(destPath);
    return { sha256: createHash("sha256").update(buf).digest("hex") };
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}
