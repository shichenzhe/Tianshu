// backup 契约编译期断言（protocol-package 契约测试同位惯例）：
// 常量值锁定 + 类型结构编译通过
import { describe, expect, it } from "vitest";
import {
  BACKUP_CHUNK_BYTES,
  DEFAULT_BACKUP_MAX_KEEP,
  DEFAULT_BACKUP_MAX_SIZE_BYTES,
  BACKUP_ADMIN_OWNER,
  BACKUP_INVITE_PREFIX,
  BACKUP_INVITE_ALPHABET,
  BACKUP_INVITE_LENGTH,
  BACKUP_CLIENT_NAME_TAKEN,
  BACKUP_INVITE_INVALID,
  BACKUP_ADMIN_ONLY,
  type BackupMeta,
  type BackupCreateRequest,
  type BackupChunkRequest,
  type BackupDownloadRequest,
  type BackupDownloadResult,
  type BackupCommitResult,
  type BackupListResult,
  type BackupClaimRequest,
  type BackupClaimResult,
  type BackupInviteRecord,
  type BackupCreateInvitesRequest,
  type BackupCreateInvitesResult,
  type BackupClientRecord,
} from "@tianshu/protocol";

describe("backup-contract", () => {
  it("分块与上限常量锁定（协议演化须显式改这里）", () => {
    expect(BACKUP_CHUNK_BYTES).toBe(4 * 1024 * 1024);
    expect(DEFAULT_BACKUP_MAX_KEEP).toBe(10);
    expect(DEFAULT_BACKUP_MAX_SIZE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
  it("BackupMeta 结构编译期断言（status 含 uploading/ready 两态）", () => {
    const meta: BackupMeta = {
      id: "b1",
      createdAt: "2026-10-27T00:00:00.000Z",
      appVersion: "1.0.0",
      schemaVersion: 1,
      fileSize: 100,
      sha256: "a".repeat(64),
      chunkCount: 1,
      status: "ready",
      owner: "test-owner",
    };
    expect(meta.id).toBe("b1");
  });
  it("分块请求形状编译期断言", () => {
    const chunk: BackupChunkRequest = {
      id: "b1",
      seq: 0,
      data: "aGk=",
      chunkSha256: "b".repeat(64),
    };
    const dl: BackupDownloadRequest = { id: "b1", seq: 0 };
    const res: BackupDownloadResult = { data: "aGk=", totalChunks: 1 };
    const commit: BackupCommitResult = {
      fileSize: 100,
      sha256: "a".repeat(64),
    };
    expect([chunk, dl, res, commit]).toHaveLength(4);
  });
  it("create 请求形状编译期断言", () => {
    const req: BackupCreateRequest = {
      appVersion: "1.0.0",
      schemaVersion: 1,
      fileSize: 100,
      sha256: "a".repeat(64),
      chunkCount: 1,
      note: "首档",
      deviceName: "mac",
    };
    expect(req.chunkCount).toBe(1);
  });
});

describe("backup-contract 多用户扩展", () => {
  it("常量锁定", () => {
    expect(BACKUP_ADMIN_OWNER).toBe("__admin__");
    expect(BACKUP_INVITE_PREFIX).toBe("TS-");
    expect(BACKUP_INVITE_ALPHABET).toBe("ABCDEFGHJKMNPQRSTUVWXYZ23456789");
    expect(BACKUP_INVITE_LENGTH).toBe(8);
    expect([
      BACKUP_CLIENT_NAME_TAKEN,
      BACKUP_INVITE_INVALID,
      BACKUP_ADMIN_ONLY,
    ]).toEqual([
      "BACKUP_CLIENT_NAME_TAKEN",
      "BACKUP_INVITE_INVALID",
      "BACKUP_ADMIN_ONLY",
    ]);
  });
  it("BackupMeta.owner 必填 + viewer 结构编译期断言", () => {
    const meta: BackupMeta = {
      id: "b1",
      createdAt: "2026-10-28T00:00:00.000Z",
      appVersion: "1.0.0",
      schemaVersion: 1,
      fileSize: 1,
      sha256: "a".repeat(64),
      chunkCount: 1,
      status: "ready",
      owner: "zhangsan-imac",
    };
    const list: BackupListResult = {
      backups: [meta],
      viewer: { kind: "client", clientId: "zhangsan-imac" },
    };
    const adminView: BackupListResult["viewer"] = { kind: "admin" };
    expect([list, adminView]).toHaveLength(2);
  });
  it("claim/invites/clients DTO 编译期断言", () => {
    const claimReq: BackupClaimRequest = {
      inviteCode: "TS-ABCD2345",
      deviceName: "imac",
    };
    const claimRes: BackupClaimResult = {
      clientId: "imac",
      clientToken: "t".repeat(32),
    };
    const invite: BackupInviteRecord = {
      code: "TS-ABCD2345",
      note: "n",
      createdAt: "2026-10-28T00:00:00.000Z",
    };
    const mk: BackupCreateInvitesRequest = { count: 3, note: "n" };
    const mkRes: BackupCreateInvitesResult = { invites: [invite] };
    const client: BackupClientRecord = {
      clientId: "imac",
      createdAt: "2026-10-28T00:00:00.000Z",
    };
    expect([claimReq, claimRes, mk, mkRes, client]).toHaveLength(5);
  });
});
