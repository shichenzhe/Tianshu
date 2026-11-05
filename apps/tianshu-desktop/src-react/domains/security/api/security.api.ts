/**
 * 安全中心前端 api（SP1）：全部走 invoke 泛型封装
 */
import { invoke } from "@/lib/ipc";
import type {
  AuditListParams,
  AuditListResult,
  SecurityConfig,
  SecurityConfigKey,
  SecurityConfigState,
} from "../model/types";

export class SecurityApi {
  static getConfig(): Promise<SecurityConfigState> {
    return invoke<SecurityConfigState>("security:getConfig");
  }

  static setConfig(
    key: SecurityConfigKey,
    value: unknown,
  ): Promise<SecurityConfig> {
    return invoke<SecurityConfig>("security:setConfig", key, value);
  }

  static resetCommandRules(): Promise<SecurityConfig> {
    return invoke<SecurityConfig>("security:resetCommandRules");
  }

  static resetFileRules(): Promise<SecurityConfig> {
    return invoke<SecurityConfig>("security:resetFileRules");
  }

  static auditList(params: AuditListParams): Promise<AuditListResult> {
    return invoke<AuditListResult>("security:auditList", params);
  }

  static auditExport(
    format: "json" | "csv",
  ): Promise<{ ok: boolean; filePath?: string }> {
    return invoke<{ ok: boolean; filePath?: string }>(
      "security:auditExport",
      format,
    );
  }

  static auditClear(): Promise<void> {
    return invoke<void>("security:auditClear");
  }

  static openBackupDir(): Promise<void> {
    return invoke<void>("security:openBackupDir");
  }

  /** 加密降级状态（批1A）：主密钥 hex 明文降级（safeStorage 不可用）时
   *  服务商设置页出示警示条 */
  static masterKeyStatus(): Promise<{ degraded: boolean }> {
    return invoke<{ degraded: boolean }>("security:masterKeyStatus");
  }

  static listFullGrants(): Promise<
    Array<{ sessionId: number; title: string }>
  > {
    return invoke("permission:listFullGrants");
  }

  static revokeAllFull(): Promise<void> {
    return invoke<void>("permission:revokeAllFull");
  }

  static listRemembered(): Promise<
    Array<{
      id: number;
      workspaceName: string;
      toolName: string;
      createdAt: string;
    }>
  > {
    return invoke("permission:listRemembered");
  }

  static revokeRemembered(id: number): Promise<void> {
    return invoke<void>("permission:revokeRemembered", id);
  }

  static revokeAllRemembered(): Promise<void> {
    return invoke<void>("permission:revokeAllRemembered");
  }
}
