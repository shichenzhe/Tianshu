import { beforeEach, describe, expect, it, vi } from "vitest";

// ipc-user 依赖 ipcMain（handleUser 注册用）；jwt-secret 依赖 app.getPath：
// 随机目录避免与其他测试文件并行共享密钥文件
vi.mock("electron", () => {
  const dir = `/tmp/tianshu-jwt-secret-test-${Math.random()
    .toString(36)
    .slice(2)}`;
  return {
    ipcMain: { handle: vi.fn() },
    app: { getPath: () => dir },
  };
});

// prisma-client 模块加载有副作用（建目录/连库），测试整体 mock 掉；
// verifyUserId 回查 user 表（用户数据消失后残留 token 不得继续放行）
const prismaMocks = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaMocks,
}));

import * as jwt from "jsonwebtoken";
import {
  getJwtSecret,
  generateUserToken,
  verifyUserId,
} from "../../electron/commons/ipc-user";

describe("ipc-user", () => {
  beforeEach(() => {
    prismaMocks.user.findUnique.mockReset();
    // 缺省：id 命中存在的用户（各用例按需覆盖为 null 模拟数据消失）
    prismaMocks.user.findUnique.mockResolvedValue({ id: 3 });
  });

  it("生成的 token 可解出 userId", async () => {
    const token = generateUserToken({ id: 3, username: "a", nickname: "甲" });
    await expect(verifyUserId(token)).resolves.toBe(3);
  });

  it("空串/非字符串 token 拒绝并提示重新登录", async () => {
    await expect(verifyUserId("")).rejects.toThrow("未登录或登录态已失效");
    await expect(verifyUserId(undefined)).rejects.toThrow(
      "未登录或登录态已失效",
    );
    await expect(verifyUserId(123)).rejects.toThrow("未登录或登录态已失效");
  });

  it("篡改的 token 拒绝", async () => {
    const token = generateUserToken({ id: 3, username: "a" });
    await expect(verifyUserId(`${token}x`)).rejects.toThrow("登录态已失效");
  });

  it("未签 id 的旧版 token（v12 前签发）拒绝，提示重新登录", async () => {
    const legacy = jwt.sign({ username: "a" }, getJwtSecret(), {
      expiresIn: "1h",
    });
    await expect(verifyUserId(legacy)).rejects.toThrow("登录态版本过旧");
  });

  it("签名有效但用户数据已不存在时拒绝（幻影用户防护）", async () => {
    // 场景：user 表数据消失（删行/换库/快照重放/恢复备份），
    // 残留 token 验签仍通过——必须回查 user 表拦下
    prismaMocks.user.findUnique.mockResolvedValue(null);
    const token = generateUserToken({ id: 3, username: "a" });
    await expect(verifyUserId(token)).rejects.toThrow("登录态已失效");
  });

  it("用户存在性回查按 token 中的 id 精确查主键", async () => {
    const token = generateUserToken({ id: 42, username: "a" });
    await verifyUserId(token);
    expect(prismaMocks.user.findUnique).toHaveBeenCalledWith({
      where: { id: 42 },
      select: { id: true },
    });
  });
});
