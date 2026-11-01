/**
 * 统一优雅关闭收口（main.ts 信号入口消费）：可选前置钩子（relay 分支
 * 注入停 relay 客户端）→ app.close()（经 enableShutdownHooks 接通 Nest
 * 生命周期：调度器 abort 在途任务/工具桥收敛/webhook 中止/Prisma
 * $disconnect）→ 退出进程。只跑钩子不关 app 的话 fastify 仍监听，首个
 * Ctrl-C 后进程不退出（T15/T16 minor F2 原症状）；close 异常也保证退出。
 */
export interface ShutdownApp {
  close(): Promise<void>;
}

export async function shutdownAndExit(
  app: ShutdownApp,
  beforeClose?: () => void,
): Promise<void> {
  beforeClose?.();
  try {
    await app.close();
  } catch (error) {
    console.error('[shutdown] 应用关闭异常:', error);
  }
  process.exit(0);
}
