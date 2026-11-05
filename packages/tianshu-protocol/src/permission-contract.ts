// packages/tianshu-protocol/src/permission-contract.ts
/** A10 审批记忆管理批（spec 2026-10-26 §1.1）：permission 五段契约——
 *  已记住工具列表/单条撤销/全部撤销（toolPermission 表读删）+ 完全授权
 *  运行态列表/一键清空（会话级内存态）；桌面被控面与无头端双端同批落地。
 *  形状裁定（spec §3：两仓运行态存储不同构，读代码定最小公共形状）：
 *  full grants 双端均为会话级运行态（桌面 PermissionStore / 无头端同源
 *  PermissionStore），无 toolName/createdAt——最小公共形状 =
 *  {sessionId, title}（标题查询失败行回落「会话 #id」，桌面口径）。 */

/** permission/listRemembered 行（仅当前用户空间，createdAt 倒序） */
export interface PermissionRememberedItem {
  id: number;
  /** 空间名（join 失败行回落 `#workspaceId`，桌面口径） */
  workspaceName: string;
  toolName: string;
  /** ISO 8601 字符串 */
  createdAt: string;
  /**
   * 参数级 pattern（审批参数级批，security P1-3）：bash 命令前缀（`git *`）
   * / write·rm 路径 glob（`src/**`）；null = 整工具记忆（旧全等语义）。
   * 可选段——旧端增量兼容。
   */
  pattern?: string | null;
  /**
   * 最近一次命中时间 ISO（记忆直执行/ask 级抑制命中时 fire-and-forget
   * 回写）；null = 落行后从未命中。可选段——旧端增量兼容。
   */
  lastUsedAt?: string | null;
}

/** revokeAllRemembered/revokeAllFull 共用返回：实际撤销条数（空集 0） */
export interface PermissionRevokeResult {
  revoked: number;
}

/** 完全授权行（会话级 full 授权运行态；无 toolName/createdAt 字段——
 *  两仓运行态存储均无此数据，spec §1.1 裁定以桌面实际返回为准） */
export interface PermissionFullGrantItem {
  sessionId: number;
  /** 会话标题（查询失败回落「会话 #id」，桌面口径） */
  title: string;
}

/** permission/listFullGrants 返回信封 */
export interface PermissionFullGrantsResult {
  grants: PermissionFullGrantItem[];
}

/** permission 面稳定错误码（两端透传，控制端按码提示）：
 *  PERMISSION_INVALID=入参语义不合法（revokeRemembered id 非正整数等）；
 *  单条撤销不存在/非本人属幂等 no-op 不报错（桌面既定语义，spec §3） */
export const PERMISSION_ERROR_CODES = ["PERMISSION_INVALID"] as const;
export type PermissionErrorCode = (typeof PERMISSION_ERROR_CODES)[number];
