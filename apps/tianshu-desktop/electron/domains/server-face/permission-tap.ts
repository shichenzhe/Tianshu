// A10 审批记忆管理批（spec 2026-10-26 §1.2）：桌面被控面 permission 五段
// 桥——remembered 面（listRemembered/revokeRemembered/revokeAllRemembered）
// 与 full 面（listFullGrants/revokeAllFull）复用 ChatService 单实例
//（Application 注入，严禁 face 侧二次构造——构造函数注册全部 IPC
// handler）；ChatService 五个方法 A10 批已提 public（原 IPC 内联 private）。
// 归属语义全部内聚 ChatService（v12 限定本人空间/单条幂等 no-op），tap
// 只做 DTO 信封：revokeAll 两返回 {revoked: count}（桌面 IPC 返 void 忽略
// 值，被控面增强 spec §1.1）；full 面为全局运行态（与 IPC 全局通道同口径，
// 收回属收紧权限无泄露面），tap 签名带 userId 备用但不作过滤。
import {
  type PermissionErrorCode,
  type PermissionFullGrantsResult,
  type PermissionRememberedItem,
  type PermissionRevokeResult,
} from "@tianshu/protocol";
import type { ServerFacePermissions } from "./deps";

/** permission 面业务错（code 稳定——routes 侧转 bizError 信封，控制端判码） */
export class FacePermissionError extends Error {
  readonly code: PermissionErrorCode;
  constructor(code: PermissionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 桥接的 ChatService 方法子集（ChatService 满足——A10 批提 public） */
export type PermissionChatSubset = {
  listRemembered(userId: number): Promise<PermissionRememberedItem[]>;
  revokeRemembered(id: number, userId: number): Promise<void>;
  revokeAllRemembered(userId: number): Promise<number>;
  listFullGrants(): Promise<Array<{ sessionId: number; title: string }>>;
  revokeAllFull(): number;
};

/** id 语义守卫：非正整数 → PERMISSION_INVALID（不存在/非本人幂等 no-op
 *  不报错——桌面既定语义，守卫只拦参数形态） */
function assertIdValid(id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new FacePermissionError("PERMISSION_INVALID", "id 必须是正整数");
  }
}

/** permission 五段桥工厂：缺 chat（未注入）不装配，routes 侧报未装配 */
export function createPermissionFace(
  chat: PermissionChatSubset,
): ServerFacePermissions {
  return {
    listRemembered: (userId) => chat.listRemembered(userId),
    revokeRemembered: async (userId, id) => {
      assertIdValid(id);
      await chat.revokeRemembered(id, userId);
      return null;
    },
    revokeAllRemembered: async (userId): Promise<PermissionRevokeResult> => ({
      revoked: await chat.revokeAllRemembered(userId),
    }),
    listFullGrants: async (): Promise<PermissionFullGrantsResult> => ({
      grants: await chat.listFullGrants(),
    }),
    revokeAllFull: async (): Promise<PermissionRevokeResult> => ({
      revoked: chat.revokeAllFull(),
    }),
  };
}
