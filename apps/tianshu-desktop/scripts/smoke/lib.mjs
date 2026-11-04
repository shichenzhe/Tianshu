/**
 * 天枢 GUI 冒烟共享库（Node ESM，需仓库 node_modules 内 playwright-core）
 *
 * 收编历次冒烟驱动（/tmp/tsdriver* 各 ~150 行重复）的公共部分：
 * dev 检活保活复用、Electron 拉起、固定冒烟用户登录、冒烟空间/会话准备、
 * IPC 直调（token 自动注入）、截图、sqlite3 只读查询、主进程改动后重启。
 *
 * 用法与设计要点见同目录 README.md；最小可运行示例见 example.mjs。
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

/** 仓库根（scripts/smoke 的上上级） */
export const REPO = path.resolve(import.meta.dirname, "..", "..");

/** 冒烟输出根（日志/截图/进程信息） */
export const OUT_ROOT = "/tmp/ts-smoke";
export const SHOTS_DIR = path.join(OUT_ROOT, "shots");

/** 保活 dev 实例的 vite 端口（与自用 dev 5173/5174 错开） */
export const DEFAULT_PORT = 5199;

/** dev 库路径（数据根收敛 ~/.tianshu，未打包实例归 dev 组；TIANSHU_DATA_ROOT 覆盖时跟随） */
function devDbPath() {
  const root =
    process.env.TIANSHU_DATA_ROOT ?? path.join(os.homedir(), ".tianshu");
  return path.join(root, "dev", "database", "local.db");
}
export const DB_PATH = devDbPath();

/** 固定冒烟用户（数据保留不清理——历次冒烟复用同一身份与空间） */
export const SMOKE_USER = {
  username: "smoke",
  nickname: "smoke",
  email: "smoke@tianshu.local",
  password: "Smoke#2026ok",
};

/** 冒烟工作空间名（目录绑定 ~/.tianshu/smoke-ws） */
const SMOKE_WS_NAME = "smoke-ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[smoke]", ...a);

/** 模块级运行态（restartApp/killDev 复用 withApp 的上下文） */
const state = { port: null, app: null, didLogin: false };

/** 加载仓库 node_modules 里的 playwright-core（npm i --no-save，不进 package.json） */
function loadPlaywright() {
  try {
    return createRequire(path.join(REPO, "package.json"))("playwright-core");
  } catch {
    throw new Error(
      "缺少 playwright-core：请在仓库根执行 `npm i --no-save playwright-core`（不改动 package.json）后重试",
    );
  }
}

/** vite 探活：HTTP GET 127.0.0.1:port（只认 IPv4；vite 默认 localhost 可能仅听 ::1） */
export async function probeVite(port, { timeoutMs = 1500, tries = 2 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return true;
    } catch {
      // 端口无响应/超时 → 继续重试
    }
    if (i < tries - 1) await sleep(400);
  }
  return false;
}

/** detached 拉起 npm run dev（独立端口；进程组存活于本脚本之外 = 保活载体） */
function startDev(port) {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const logFd = fs.openSync(`${OUT_ROOT}/dev-${port}.log`, "a");
  const bootTs = Date.now();
  const child = spawn(
    "npm",
    [
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: REPO,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    },
  );
  child.unref();
  fs.writeFileSync(
    `${OUT_ROOT}/dev-${port}.json`,
    JSON.stringify({ pid: child.pid, port, bootTs }, null, 1),
  );
  log(
    `npm run dev 已拉起（pid=${child.pid}，日志 ${OUT_ROOT}/dev-${port}.log）`,
  );
  return bootTs;
}

/** 等 dev 就绪：vite HTTP 200 且 dist-electron/main.js 已产出（供并行 Electron 实例加载） */
async function waitDevReady(port, bootTs, { timeoutMs = 180_000 } = {}) {
  const mainJs = path.join(REPO, "dist-electron", "main.js");
  const t0 = Date.now();
  let viteUpAt = 0;
  for (;;) {
    if (Date.now() - t0 > timeoutMs)
      throw new Error(
        `dev 启动超时（${timeoutMs / 1000}s），查 ${OUT_ROOT}/dev-${port}.log`,
      );
    if (!viteUpAt && (await probeVite(port, { tries: 1 })))
      viteUpAt = Date.now();
    if (viteUpAt) {
      let mtime = 0;
      try {
        mtime = fs.statSync(mainJs).mtimeMs;
      } catch {
        /* 尚未产出 */
      }
      // main.js 是本次启动新写出的 → 就绪；等 20s 仍只有旧产物也放行（源码未变时插件可能不重写）
      if (mtime >= bootTs - 2000 || Date.now() - viteUpAt > 20_000) {
        if (!mtime)
          throw new Error(
            `dev 就绪但缺 ${mainJs}，查 ${OUT_ROOT}/dev-${port}.log`,
          );
        log(
          `dev 就绪 127.0.0.1:${port}（${((Date.now() - t0) / 1000).toFixed(1)}s）`,
        );
        return;
      }
    }
    await sleep(1000);
  }
}

/** 取（并缓存）驱动实例主窗口；.setDefaultTimeout 统一 20s */
export async function firstWindow(app) {
  if (!app.__smokeWin) {
    const win = await app.firstWindow();
    win.setDefaultTimeout(20_000);
    app.__smokeWin = win;
  }
  return app.__smokeWin;
}

/** 拉起驱动用 Electron 实例（dev 无单实例锁，与 vite 插件自己的实例并存，SQLite WAL 双进程可接受） */
async function launchApp(port) {
  const { _electron } = loadPlaywright();
  const darwinBin = path.join(
    REPO,
    "node_modules",
    "electron",
    "dist",
    "Electron.app",
    "Contents",
    "MacOS",
    "Electron",
  );
  const app = await _electron.launch({
    executablePath: fs.existsSync(darwinBin)
      ? darwinBin
      : path.join(REPO, "node_modules", ".bin", "electron"),
    args: [REPO],
    env: {
      ...process.env,
      NODE_ENV: "development", // dev 数据组 ~/.tianshu/dev + 解除单实例锁
      VITE_DEV_SERVER_URL: `http://127.0.0.1:${port}`,
    },
  });
  state.app = app;
  const win = await firstWindow(app);
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  return app;
}

/**
 * 冒烟驱动主入口：dev 检活复用 + fn 执行 + 默认保活
 *
 * @param opts {port?: number, kill?: boolean, timeoutMs?: number}
 *   port  缺省读 TIANSHU_SMOKE_PORT 环境变量，再缺省 5199
 *   kill  true 时 fn 结束（含异常）后终止保活 dev（killDev）
 * @param fn (app) => any  app 为 playwright Electron 实例
 * @returns fn 的返回值
 */
export async function withApp(opts = {}, fn) {
  const t0 = Date.now();
  const port =
    opts.port || Number(process.env.TIANSHU_SMOKE_PORT) || DEFAULT_PORT;
  state.port = port;
  state.didLogin = false;
  let booted = false;
  if (await probeVite(port)) {
    log(`复用保活 dev 实例 127.0.0.1:${port}`);
  } else {
    log(`端口 ${port} 无存活 dev，冷启动 npm run dev`);
    const bootTs = startDev(port);
    await waitDevReady(port, bootTs, { timeoutMs: opts.timeoutMs });
    booted = true;
  }
  const app = await launchApp(port);
  const bootLabel = booted ? "本次冷启动并保活" : "复用既有保活";
  try {
    return await fn(app);
  } finally {
    await app.close().catch(() => {});
    state.app = null;
    if (opts.kill) await killDev(port);
    log(
      `withApp 结束：${((Date.now() - t0) / 1000).toFixed(1)}s（dev ${bootLabel}）`,
    );
  }
}

/**
 * IPC invoke 直调：token 自动从页面 localStorage 读取并末位追加
 * （handleUser 通道解出 userId；login/create 等匿名通道忽略该参数）
 */
export async function api(app, channel, ...args) {
  const win = await firstWindow(app);
  return win.evaluate(
    async ({ channel, args }) => {
      let token = "";
      try {
        token =
          JSON.parse(localStorage.getItem("userInfo") || "").state.user.token ||
          "";
      } catch {
        /* 未登录时为空串 */
      }
      return await window.ipcRenderer.invoke(channel, ...args, token);
    },
    { channel, args },
  );
}

/**
 * 固定冒烟用户登录（不存在则创建）：IPC user:login 直调 + 登录态注入
 * localStorage 后 reload（zustand persist 不热读，必须 reload 生效）。
 * @returns token
 */
export async function ensureLogin(app, creds = SMOKE_USER) {
  const win = await firstWindow(app);
  const loginArgs = { username: creds.username, password: creds.password };
  let auth = await api(app, "user:login", loginArgs);
  if (!auth?.token) {
    // create 返回 -1 表示用户名/邮箱已占用（密码不同会在下方 login 处报错）
    await api(app, "user:create", { ...creds });
    auth = await api(app, "user:login", loginArgs);
  }
  if (!auth?.token) {
    throw new Error(
      `冒烟用户 ${creds.username} 登录失败（若被其他密码占用请检查 user 表）`,
    );
  }
  await win.evaluate(
    (user) => {
      localStorage.setItem(
        "userInfo",
        JSON.stringify({ state: { user }, version: 0 }),
      );
      location.reload();
    },
    { ...auth, expiresAt: null }, // null=会话级，isLoginValid 恒过
  );
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  // 登录生效判定：登录页用户名输入框消失（token 失效会被踢回登录页）
  await win.waitForFunction(() => !document.querySelector("#username"), null, {
    timeout: 15_000,
  });
  state.didLogin = true;
  log(`已登录冒烟用户 ${creds.username}（uid=${auth.id}）`);
  return auth.token;
}

/**
 * 冒烟工作空间（名字固定 smoke-ws，目录绑 ~/.tianshu/smoke-ws，缺目录自动建）：
 * 复用优先，数据保留不清理。注意改绑通道 workspace:bindDirectory 走原生
 * 对话框不可脚本化，既有绑定与期望不一致时仅告警沿用。
 * @returns workspaceId
 */
export async function ensureWorkspace(app, _token, dirPath) {
  const dir = path.resolve(
    dirPath || path.join(os.homedir(), ".tianshu", "smoke-ws"),
  );
  fs.mkdirSync(dir, { recursive: true });
  const found = (await api(app, "workspace:list")).find(
    (w) => w.name === SMOKE_WS_NAME,
  );
  if (!found) {
    const ws = await api(app, "workspace:create", {
      name: SMOKE_WS_NAME,
      directoryPath: dir,
    });
    log(`已建冒烟工作空间 ${SMOKE_WS_NAME}#${ws.id}（绑 ${dir}）`);
    return ws.id;
  }
  if ((found.directoryPath || "") !== dir) {
    log(
      `警告：${SMOKE_WS_NAME} 既有绑定 ${found.directoryPath} ≠ ${dir}，沿用既有（改绑需手工处理）`,
    );
  } else {
    log(`复用冒烟工作空间 ${SMOKE_WS_NAME}#${found.id}`);
  }
  return found.id;
}

/** 冒烟会话（复用最新一条，否则新建）；@returns sessionId */
export async function ensureSession(app, _token, workspaceId) {
  const list = await api(app, "session:listByWorkspace", workspaceId);
  if (list.length > 0) {
    log(`复用冒烟会话 #${list[0].id}（${list[0].title}）`);
    return list[0].id;
  }
  const s = await api(app, "session:create", {
    workspaceId,
    title: "smoke 冒烟会话",
  });
  log(`已建冒烟会话 #${s.id}`);
  return s.id;
}

/** 截图到 /tmp/ts-smoke/shots/<name>.png；@returns 文件路径 */
export async function shot(app, name) {
  const win = await firstWindow(app);
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await win.screenshot({ path: file });
  log(`截图 ${file}`);
  return file;
}

/**
 * sqlite3 只读查询（dev 库，-json 输出解析为数组；空结果为 []）。
 * 只放行 select/with/pragma；确需写库造数用 sqlWrite（历次冒烟插入
 * assistant 消息块的既有模式）。
 * 前缀校验仅防误写，非安全边界（多语句可绕，如 select 1;delete ...）。
 */
export function sql(query) {
  const head = String(query).trimStart().toLowerCase();
  if (!/^(select|with|pragma)/.test(head)) {
    throw new Error(
      "sql() 默认只读（select/with/pragma）；写库请用 sqlWrite()",
    );
  }
  return runSqlite(query);
}

export function sqlWrite(query) {
  return runSqlite(query);
}

function runSqlite(query) {
  const out = execFileSync("/usr/bin/sqlite3", ["-json", DB_PATH, query], {
    timeout: 10_000,
  })
    .toString()
    .trim();
  return out ? JSON.parse(out) : [];
}

/** 调窗口内容尺寸（默认 1440x900；默认 910x700 截图偏窄） */
export async function resize(app, width = 1440, height = 900) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
      if (win) win.setContentSize(size.width, size.height);
    },
    { width, height },
  );
}

/**
 * 主进程改动后重启驱动实例：先等 vite 重建 dist-electron/main.js 落盘
 * （mtime 稳定），再拉起新 Electron；此前登录过则自动恢复登录态。
 * 注意：旧 app 句柄失效，后续操作请用返回的新 app。
 * @returns 新 app
 */
export async function restartApp() {
  if (!state.port) throw new Error("restartApp() 需在 withApp 回调内调用");
  await state.app?.close().catch(() => {});
  state.app = null;
  await waitMainSettled();
  const app = await launchApp(state.port);
  if (state.didLogin) await ensureLogin(app);
  log("驱动实例已重启（主进程新构建已加载）");
  return app;
}

/** 等 dist-electron/main.js mtime 稳定（vite watch 重建完成）。
 *  注意：并行自用 dev（5173）也在重建同一 dist-electron，活跃开发期
 *  mtime 可能持续变化——稳定窗最多等 20s 即按现状继续，不无限等。 */
async function waitMainSettled(timeoutMs = 20_000) {
  const mainJs = path.join(REPO, "dist-electron", "main.js");
  const t0 = Date.now();
  let last = 0;
  let lastChange = Date.now();
  for (;;) {
    let mtime = 0;
    try {
      mtime = fs.statSync(mainJs).mtimeMs;
    } catch {
      /* 极端：被清空 */
    }
    if (mtime !== last) {
      last = mtime;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= 1200) return; // 1.2s 无变化 = 重建结束
    if (Date.now() - t0 > timeoutMs) {
      log("警告：main.js 未观察到稳定，按现状继续");
      return;
    }
    await sleep(400);
  }
}

/** 终止保活 dev（进程组杀 + 端口残留兜底）；一般留给 withApp({kill:true}) 调 */
export async function killDev(port = state.port || DEFAULT_PORT) {
  let pid = null;
  try {
    pid = JSON.parse(
      fs.readFileSync(`${OUT_ROOT}/dev-${port}.json`, "utf8"),
    ).pid;
  } catch {
    /* 无记录 → 端口兜底 */
  }
  if (pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* 组已不存在 */
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 主进程已退 */
    }
  }
  try {
    execFileSync(
      "/bin/sh",
      ["-c", `lsof -ti tcp:${port} | xargs kill 2>/dev/null || true`],
      { timeout: 5000 },
    );
  } catch {
    /* lsof 不可用等，忽略 */
  }
  for (let i = 0; i < 20; i++) {
    if (!(await probeVite(port, { tries: 1 }))) {
      log(`保活 dev（:${port}）已终止`);
      return;
    }
    await sleep(500);
  }
  log(`警告：端口 ${port} 仍被占用，请手工检查`);
}

export { sleep, log as smokeLog };
