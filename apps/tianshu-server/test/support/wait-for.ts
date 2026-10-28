/** jest 版轮询等待（审批挂起/SSE 异步时点断言共用） */
export async function waitFor(
  assertion: () => void,
  timeoutMs = 5000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (e) {
      if (Date.now() - startedAt > timeoutMs) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
