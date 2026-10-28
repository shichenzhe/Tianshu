// packages/tianshu-protocol/src/workspace-contract.ts
/** A8 工作空间管理批（spec 2026-10-26 §1.1）：workspace/create|update|delete
 *  写面契约——桌面被控面与无头端双端同批落地；不带 directoryPath（绑定
 *  目录留桌面端：系统选择框语义 + 任意路径写面不可远程化，spec §1.4）。 */

/** workspace/create|update 载荷（v1 全量字段传，三态不用——spec §1.1）：
 *  create 需 name；update 需 id、余字段可选 */
export interface WorkspaceSavePayload {
  /** update 必填（目标空间 id）；create 不传 */
  id?: number;
  name?: string;
  icon?: string;
  defaultModelId?: number;
}

/** workspace 写面稳定错误码（两端透传，控制端按码提示）：
 *  WORKSPACE_NOT_FOUND=不存在/归属校验失败（不泄露存在性）；
 *  WORKSPACE_INVALID=name 空等入参语义不合法 */
export const WORKSPACE_ERROR_CODES = [
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_INVALID",
] as const;
export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];
