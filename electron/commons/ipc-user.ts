/**
 * IPC 用户态调用包装：业务通道不信任前端传参，
 * userId 一律由 invoke/send 末尾携带的 JWT token 解出。
 */
import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as jwt from "jsonwebtoken";
import { getJwtSecret } from "./jwt-secret";

export { getJwtSecret };

/** JWT payload 契约（generateUserToken 签发） */
export interface UserTokenPayload extends jwt.JwtPayload {
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
    getJwtSecret(),
    { expiresIn: "30d" },
  );
}

/**
 * 用户存在性回查：prisma 经函数内动态 import 惰性加载——ipc-user 被
 * 全仓业务域传递 import，顶层引入 prisma-client 会把其建目录/连库
 * 副作用传染给全部下游（含不经 token 的 browser/security 模块及其
 * 测试面）。模块缓存命中后开销可忽略。
 */
async function isUserExists(id: number): Promise<boolean> {
  const { default: prisma } = await import("./prisma-client");
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true },
  });
  return user !== null;
}

/**
 * 从 token 解出 userId（无效/过期/用户已不存在直接抛错，提示重新登录）
 *
 * JWT 是无状态凭证，验签通过不等于用户仍在：user 表数据消失（删行/换
 * 数据根/快照守卫重放/恢复备份）后残留 token 在有效期内验签依然通过，
 * 业务会以幻影 userId 落脏数据——重建库后自增 id 复用甚至会身份错位。
 * 故验签后回查 user 表主键确认存在（2026-11-02 修复）。
 * @param token invoke/send 末尾追加的 JWT token
 * @returns 当前用户 id
 */
export async function verifyUserId(token: unknown): Promise<number> {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("未登录或登录态已失效，请重新登录");
  }
  let payload: UserTokenPayload;
  try {
    payload = jwt.verify(token, getJwtSecret()) as UserTokenPayload;
  } catch (error) {
    console.error("Token验证失败:", error);
    throw new Error("登录态已失效，请重新登录", { cause: error });
  }
  if (typeof payload.id !== "number") {
    // v12 前签发的旧 token 未含 id，需重新登录换取新 token
    throw new Error("登录态版本过旧，请重新登录");
  }
  if (!(await isUserExists(payload.id))) {
    throw new Error("登录态已失效，请重新登录");
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
    const userId = await verifyUserId(token);
    return handler(event, userId, ...(args as A));
  });
}
