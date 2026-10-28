/**
 * UserRepository.login 契约测试：
 * 凭证无效时返回 null（前端据此提示「用户名或密码错误」），
 * 而非抛异常（IPC 异常会让前端落到「登录失败，请重试」兜底文案）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// repo 构造注册 handler 需 ipcMain；token 签发经 jwt-secret 依赖 app.getPath
vi.mock("electron", () => {
  const dir = `/tmp/tianshu-user-repo-test-${Math.random()
    .toString(36)
    .slice(2)}`;
  return {
    ipcMain: { handle: vi.fn() },
    app: { getPath: () => dir },
  };
});

// prisma-client 模块加载有副作用（建目录/连库），测试整体 mock 掉
const prismaMocks = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), update: vi.fn() },
}));
vi.mock("../../../electron/commons/prisma-client", () => ({
  default: prismaMocks,
}));

import UserRepository from "../../../electron/domains/user/user.repo";
import { hashPassword } from "../../../electron/domains/user/password";
import { verifyUserId } from "../../../electron/commons/ipc-user";

const repo = new UserRepository();

describe("UserRepository.login", () => {
  beforeEach(() => {
    prismaMocks.user.findFirst.mockReset();
  });

  it("用户不存在时返回 null，不抛异常", async () => {
    prismaMocks.user.findFirst.mockResolvedValue(null);

    await expect(
      repo.login({ username: "nobody", password: "whatever" }),
    ).resolves.toBeNull();
  });

  it("密码错误时返回 null，不抛异常", async () => {
    prismaMocks.user.findFirst.mockResolvedValue({
      id: 1,
      username: "alice",
      nickname: null,
      email: null,
      password: hashPassword("right-password"),
    });

    await expect(
      repo.login({ username: "alice", password: "wrong-password" }),
    ).resolves.toBeNull();
  });

  it("凭证正确时返回用户信息并签发可解出 userId 的 token", async () => {
    prismaMocks.user.findFirst.mockResolvedValue({
      id: 7,
      username: "alice",
      nickname: "爱丽丝",
      email: null,
      password: hashPassword("right-password"),
    });

    const auth = await repo.login({
      username: "alice",
      password: "right-password",
    });

    expect(auth?.id).toBe(7);
    expect(auth?.username).toBe("alice");
    expect(verifyUserId(auth?.token as string)).toBe(7);
  });
});
