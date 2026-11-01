/**
 * F3：resolveAutomationPermissions 接 toolPermission 查表——注入查表时
 * default 档命中记忆免审（true）、未命中 false；缺席装配保持旧语义
 * （default 恒 false=每 write 必审批、full 恒 true）；autoDenyApprovals
 * 语义不受影响（审批请求仍由 runToolCall 按档位裁定）。
 */
import {
  resolveAutomationPermissions,
} from 'src/core/graph/graph-executor';

describe('resolveAutomationPermissions + toolPermission 查表（F3）', () => {
  it('缺省（未注入查表）：full 恒 true / default 恒 false（旧语义不变）', async () => {
    const full = resolveAutomationPermissions('full');
    const def = resolveAutomationPermissions('default');
    await expect(full.isToolAllowed('run_workflow')).resolves.toBe(true);
    await expect(def.isToolAllowed('run_workflow')).resolves.toBe(false);
    expect(full.fullAccess()).toBe(true);
    expect(def.fullAccess()).toBe(false);
  });

  it('注入查表：default 档按表判定（命中 true / 未命中 false），full 不受影响', async () => {
    const remembered = new Set(['run_workflow', 'create_workflow']);
    const def = resolveAutomationPermissions(
      'default',
      async (toolName) => remembered.has(toolName),
    );
    await expect(def.isToolAllowed('run_workflow')).resolves.toBe(true);
    await expect(def.isToolAllowed('delete_file')).resolves.toBe(false);
    // full 档带查表也保持恒 true（完全访问语义不被记忆表收窄）
    const full = resolveAutomationPermissions(
      'full',
      async () => false,
    );
    await expect(full.isToolAllowed('delete_file')).resolves.toBe(true);
  });

  it('requestApproval 恒按档位（full true / default false）不受查表影响', async () => {
    const def = resolveAutomationPermissions('default', async () => true);
    await expect(def.requestApproval()).resolves.toBe(false);
    const full = resolveAutomationPermissions('full', async () => true);
    await expect(full.requestApproval()).resolves.toBe(true);
  });
});
