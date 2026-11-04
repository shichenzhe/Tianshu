/**
 * 记忆整理在途互斥（spec §5.2「定时与手动不并发」）：模块级共享单槽，
 * memory-scheduler 调度触发与 memory.service 手动触发（applyInstruction /
 * compileNow）共用——任意时刻至多一个在途，防双方并发各写 memoryProfile
 * 互相覆盖（参考 automation-inflight 的模块级注册表模式）。acquire 返回
 * 本次执行的 AbortController（占用中返回 null）；执行收口 release（仅
 * 持有者生效，防 quit 清槽后旧执行误清新占用）；应用退出由
 * scheduler.stop 调 abortInflight 统一 abort 在途请求。
 */

/** 当前在途整理的控制器（null = 空闲） */
let controller: AbortController | null = null;

/** 尝试占用在途槽：占用中返回 null，成功返回本次执行的 AbortController */
export function acquire(): AbortController | null {
  if (controller !== null) {
    return null;
  }
  controller = new AbortController();
  return controller;
}

/** 释放在途槽：仅当前持有者生效 */
export function release(owner: AbortController): void {
  if (controller === owner) {
    controller = null;
  }
}

/** 是否有整理在途（scheduler 决策与测试用） */
export function isInflight(): boolean {
  return controller !== null;
}

/** abort 在途请求并清空槽位（应用退出时调用，含手动触发的在途） */
export function abortInflight(): void {
  controller?.abort();
  controller = null;
}
