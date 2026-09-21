import { describe, expect, it, vi } from "vitest";

// ipc-user 依赖 ipcMain（handleUser 注册用）；纯函数测试仅需空实现
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import * as jwt from "jsonwebtoken";
import {
  JWT_SECRET,
  generateUserToken,
  verifyUserId,
} from "../../electron/commons/ipc-user";

describe("ipc-user", () => {
  it("生成的 token 可解出 userId", () => {
    const token = generateUserToken({ id: 3, username: "a", nickname: "甲" });
    expect(verifyUserId(token)).toBe(3);
  });

  it("空串/非字符串 token 拒绝并提示重新登录", () => {
    expect(() => verifyUserId("")).toThrow("未登录或登录态已失效");
    expect(() => verifyUserId(undefined)).toThrow("未登录或登录态已失效");
    expect(() => verifyUserId(123)).toThrow("未登录或登录态已失效");
  });

  it("篡改的 token 拒绝", () => {
    const token = generateUserToken({ id: 3, username: "a" });
    expect(() => verifyUserId(`${token}x`)).toThrow("登录态已失效");
  });

  it("未签 id 的旧版 token（v12 前签发）拒绝，提示重新登录", () => {
    const legacy = jwt.sign({ username: "a" }, JWT_SECRET, {
      expiresIn: "1h",
    });
    expect(() => verifyUserId(legacy)).toThrow("登录态版本过旧");
  });
});
