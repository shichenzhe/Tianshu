/**
 * IPC 用户态调用包装：业务通道不信任前端传参，
 * userId 一律由 invoke/send 末尾携带的 JWT token 解出。
 */
import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as jwt from "jsonwebtoken";

/** JWT 密钥（登录签发与此处校验共用；建议使用环境变量存储） */
export const JWT_SECRET = "3k4jl234jl2kj23423j";

/** JWT payload 契约（generateUserToken 签发） */
interface UserTokenPayload extends jwt.JwtPayload {
  id: number;
  username: string;
  nickname?: string;
}

/** 生成JWT token（登录成功时签发，30 天有效；payload 含 id 供业务 IPC 解 userId） */
export function generateUserToken(user: {
  id: number;
  username: string;
  nickname?: string;
}): string {
  return jwt.sign(
    { id: user.id, username: user.username, nickname: user.nickname },
    JWT_SECRET,
    { expiresIn: "30d" },
  );
}

/**
 * 从 token 解出 userId（无效/过期直接抛错，提示重新登录）
 * @param token invoke/send 末尾追加的 JWT token
 * @returns 当前用户 id
 */
export function verifyUserId(token: unknown): number {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("未登录或登录态已失效，请重新登录");
  }
  let payload: UserTokenPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET) as UserTokenPayload;
  } catch (error) {
    console.error("Token验证失败:", error);
    throw new Error("登录态已失效，请重新登录", { cause: error });
  }
  if (typeof payload.id !== "number") {
    // v12 前签发的旧 token 未含 id，需重新登录换取新 token
    throw new Error("登录态版本过旧，请重新登录");
  }
  return payload.id;
}

/**
 * 注册需要用户身份的 IPC handler：
 * 自动剥掉前端末尾追加的 token 参数，校验后将 userId 作为第一个业务参数传入。
 */
export function handleUser<A extends unknown[]>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, userId: number, ...args: A) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const token = args.pop();
    return handler(event, verifyUserId(token), ...(args as A));
  });
}
