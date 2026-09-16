// @vitest-environment jsdom
/**
 * eventMessageKey 纯函数测试：eventType → i18n messageKey 映射。
 * config.<key>.updated 无逐键词条，统一映射 config_updated（{{key}} 由
 * detail.key 插值）；其余 eventType 点换下划线直射。另断言映射结果
 * 在 security 词条中真实存在（防死键回退显示原始 eventType）。
 */
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { eventMessageKey } from "../../src-react/domains/security/components/AuditCenter";

describe("eventMessageKey", () => {
  it("config.<key>.updated 统一映射 config_updated", () => {
    expect(eventMessageKey("config.sandboxEnabled.updated")).toBe(
      "security:audit.events.config_updated",
    );
    expect(eventMessageKey("config.fileBackupMaxSizeMB.updated")).toBe(
      "security:audit.events.config_updated",
    );
  });

  it("其余 eventType 点换下划线直射", () => {
    expect(eventMessageKey("command-safety.blocked")).toBe(
      "security:audit.events.command-safety_blocked",
    );
    expect(eventMessageKey("audit.cleared")).toBe(
      "security:audit.events.audit_cleared",
    );
  });

  it("已知事件词表映射出的 key 均存在于 security 词条", () => {
    const known = [
      "command-safety.blocked",
      "command-safety.approved",
      "command-safety.rejected",
      "command-safety.cwd-fallback",
      "command-safety.needs-approval",
      "command-safety.allow-listed",
      "command-safety.child-blocked",
      "command-safety.remembered",
      "file-safety.approved",
      "file-safety.rejected",
      "file-safety.remembered",
      "file-safety.needs-approval",
      "file-safety.allow-listed",
      "network.blocked",
      "data-safety.backup-created",
      "data-safety.backup-skipped",
      "data-safety.delete-trashed",
      "data-safety.delete-permanent",
      "data-safety.delete-failed",
      "data-safety.bulk-delete-needs-approval",
      "data-safety.bulk-delete-rejected",
      "config.sandboxEnabled.updated",
      "config.commandRules.reset",
      "config.fileRules.reset",
      "audit.cleared",
    ];
    for (const eventType of known) {
      expect(i18n.exists(eventMessageKey(eventType)), eventType).toBe(true);
    }
  });
});
