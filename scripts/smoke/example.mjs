#!/usr/bin/env node
/**
 * 冒烟共享库自测（最小示例）：登录 → 冒烟空间/会话 → 展开右栏（产物面板）
 * → 截图 → 断言产物 tab 存在。同时顺带验证 sql() 只读通道。
 *
 * 用法：
 *   node scripts/smoke/example.mjs           # 首跑冷启动 dev 并保活，二跑复用
 *   node scripts/smoke/example.mjs --kill    # 跑完顺带终止保活 dev
 */
import {
  withApp,
  ensureLogin,
  ensureWorkspace,
  ensureSession,
  firstWindow,
  resize,
  shot,
  sql,
} from "./lib.mjs";

const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log("  PASS", msg);
};

await withApp({ kill: process.argv.includes("--kill") }, async (app) => {
  // 1) 固定冒烟用户登录（不存在则创建，数据保留）
  const token = await ensureLogin(app);
  assert(typeof token === "string" && token.length > 0, "登录拿到 token");

  // 2) 冒烟工作空间/会话（复用优先）
  const wsId = await ensureWorkspace(app, token);
  const sessionId = await ensureSession(app, token, wsId);
  assert(wsId > 0 && sessionId > 0, `空间 #${wsId} 会话 #${sessionId} 就绪`);

  // 3) sqlite3 只读通道
  const rows = sql(`select id, title from session where id = ${sessionId}`);
  assert(rows.length === 1 && rows[0].id === sessionId, "sql() 读到冒烟会话行");

  // 4) reload 刷新 React Query 缓存（会话经 IPC 直建，首屏 listAll 缓存里没有；
  //    历次驱动同款：ensureSession 后先 reload 再导航）
  const win = await firstWindow(app);
  await resize(app);
  await win.reload();
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  await win.waitForFunction(() => !document.querySelector("#username"), null, {
    timeout: 15_000,
  });

  // 5) 打开会话视图 → 展开「产物面板」右栏（zh/en 双语文案兜底）
  const gotoSession = () =>
    win.evaluate((sid) => {
      location.hash = `#/module/ai?session=${sid}`;
    }, sessionId);
  await gotoSession();
  const toggle = win
    .locator(
      'button[aria-label="产物面板"], button[aria-label="Artifacts panel"]',
    )
    .first();
  let toggleSeen = false;
  for (let i = 0; i < 25 && !toggleSeen; i++) {
    toggleSeen = (await toggle.count()) > 0;
    if (!toggleSeen) {
      await sleep(700);
      if (i === 10) await gotoSession(); // 兜底：路由偶发未生效时重导航（历次驱动同款）
    }
  }
  assert(toggleSeen, "会话视图出现「产物面板」开关");
  await toggle.click();
  await win.waitForSelector("div[data-detail-panel] div[role='tablist']", {
    timeout: 10_000,
  });

  // 6) 断言产物 tab 存在（右栏无 tab 时自动初始化产物 tab）
  const tabs = await win.evaluate(() =>
    [
      ...document.querySelectorAll("div[data-detail-panel] div[role='tab']"),
    ].map((el) => el.textContent.trim()),
  );
  assert(
    tabs.some((t) => t.includes("产物") || /artifacts/i.test(t)),
    `产物 tab 存在（tabs=${JSON.stringify(tabs)}）`,
  );
  await shot(app, "example-detail-panel");
});

console.log(`[smoke-example] 全绿 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
