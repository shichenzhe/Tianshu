#!/usr/bin/env node
/**
 * 原生自愈编排 setup:native（2026-11-04-native-self-heal）：npm reify 后一次
 * 跑齐三件原生/本地状态——分级大声报告，任一 FAIL 即非零退出（让 postinstall
 * 的 warn 段可见触发，也让 npm run setup:native 成为唯一手动修复入口）。
 *
 * 段1 主树 better-sqlite3 必须 Electron ABI（dev/打包消费）：验 = 系统 node
 *     构造实例必须以「目标 ABI = electron ABI」报 NODE_MODULE_VERSION 失败
 *     （能加载即 node-ABI，对 dev 是坏的）；修 = 三级瀑布：冷缓存 → 本机已装
 *     app 的 asar（版本比对一致才抽）→ 源码编译（@electron/rebuild 直引
 *     cli.js，cwd 必须 desktop——依赖发现读 cwd package.json 的 prod deps，
 *     仓库根 package.json 不列 better-sqlite3；主树 build/ 先清，否则可能被
 *     skip 逻辑放过。A1 实证形态，详见批报告）
 * 段2 vitest node-ABI 副本：委托 setup-native-node.mjs（自带构造自检）
 * 段3 mobile 本地 nativewind：先验 require.resolve 落在 mobile node_modules
 *     内（幂等快路径），不健康才跑 restore-local-nativewind.sh（win32 无 bash
 *     则 WARN 跳过）
 *
 * 跨平台：全程 process.execPath 直引脚本/cli.js，不经 npx 与 .bin shim
 * （win32 CVE-2024-27980 后无 shell spawn .cmd 会 EINVAL）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const TAG = "[setup-native]";
const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(desktopDir, "..", "..");
const mobileDir = path.join(repoRoot, "apps", "tianshu-mobile");
const mainSqliteDir = path.join(repoRoot, "node_modules", "better-sqlite3");
const mainBinaryPath = path.join(
  mainSqliteDir,
  "build",
  "Release",
  "better_sqlite3.node",
);
const rootRequire = createRequire(path.join(repoRoot, "package.json"));

/** 从根解析依赖（createRequire，防依赖嵌套化后硬编码路径失配）；失败返回 null */
const resolveFromRoot = (request) => {
  try {
    return rootRequire.resolve(request);
  } catch {
    return null;
  }
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const log = (message) => console.log(`${TAG} ${message}`);

/** electron ABI 号（不硬编码）：node-abi 离线表优先，electron 本体探测兜底 */
const resolveElectronAbi = (electronVersion) => {
  try {
    return String(rootRequire("node-abi").getAbi(electronVersion, "electron"));
  } catch {
    const res = spawnSync(
      rootRequire("electron"),
      ["-p", "process.versions.modules"],
      {
        encoding: "utf8",
        timeout: 120000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    const abi = (res.stdout || "").match(/\d+/);
    return abi ? abi[0] : null;
  }
};

const stage1 = () => {
  const name = "段1 主树 better-sqlite3（Electron ABI）";
  let electronVersion;
  let pkgVersion;
  try {
    electronVersion = readJson(
      rootRequire.resolve("electron/package.json"),
    ).version;
    pkgVersion = readJson(path.join(mainSqliteDir, "package.json")).version;
  } catch (err) {
    return {
      name,
      status: "FAIL",
      note: `前置读取失败（electron/better-sqlite3 实装版）：${err.message}`,
    };
  }
  const electronAbi = resolveElectronAbi(electronVersion);
  if (!electronAbi) {
    return {
      name,
      status: "FAIL",
      note: `无法确定 electron ${electronVersion} 的 ABI 号（node-abi 与 electron 本体探测均失败）`,
    };
  }
  const cachePath = path.join(
    os.homedir(),
    "Library",
    "Caches",
    "tianshu",
    "native",
    `better_sqlite3-${electronVersion}-${pkgVersion}-${process.platform}-${process.arch}.node`,
  );

  // 验：v12 addon 在构造时才懒加载，必须 new Database 才探得出 ABI（裸
  // require 对缺 .node/错 ABI 均假绿）。报文中第一处 NODE_MODULE_VERSION 数字
  // 即二进制目标 ABI。前提假设：系统 node ABI ≠ electron ABI（今日 147≠149）；
  // 未来若撞号，「系统 node 可加载」将不再能区分 node-ABI，本探针会恒判不健康
  // 并走瀑布——届时需引入 electron 本体探针替代判分（防排查困惑，先行注记）。
  const probeMain = () => {
    const res = spawnSync(
      process.execPath,
      [
        "-e",
        `try { new (require(${JSON.stringify(mainSqliteDir)}))(":memory:"); console.log("LOADED"); } catch (err) { console.log("THROW\\n" + err.message); }`,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    const out = res.stdout || "";
    if (out.startsWith("LOADED")) {
      return {
        healthy: false,
        detail: "系统 node 可加载（node-ABI）——dev/打包会炸",
      };
    }
    const message = out.startsWith("THROW")
      ? out.slice(6)
      : res.stderr || "探针无输出";
    const target = message.match(/NODE_MODULE_VERSION (\d+)/);
    if (target) {
      const ok = target[1] === electronAbi;
      return {
        healthy: ok,
        detail: `二进制目标 ABI ${target[1]}（期望 electron ${electronAbi}）`,
      };
    }
    return {
      healthy: false,
      detail: `bindings 缺失/不可构造：${message.split("\n")[0]}`,
    };
  };

  // 修 a：冷缓存命中即回写
  const healFromCache = () => {
    if (!fs.existsSync(cachePath)) return false;
    fs.mkdirSync(path.dirname(mainBinaryPath), { recursive: true });
    fs.copyFileSync(cachePath, mainBinaryPath);
    return true;
  };

  // 修 b：本机已装 app 的 asar 抽二进制（仅 darwin；版本比对一致才动主树）
  const healFromAsar = () => {
    if (process.platform !== "darwin") return false;
    const candidates = [
      path.join(
        "/Applications",
        "天枢.app",
        "Contents",
        "Resources",
        "app.asar",
      ),
      path.join(
        os.homedir(),
        "Applications",
        "天枢.app",
        "Contents",
        "Resources",
        "app.asar",
      ),
    ];
    for (const archive of candidates.filter((p) => fs.existsSync(p))) {
      try {
        const asar = rootRequire("@electron/asar");
        const asarVersion = JSON.parse(
          asar
            .extractFile(archive, "node_modules/better-sqlite3/package.json")
            .toString("utf8"),
        ).version;
        if (asarVersion !== pkgVersion) {
          log(
            `asar ${archive} 内版本 ${asarVersion} ≠ 主树 ${pkgVersion}，跳级`,
          );
          continue;
        }
        const binary = asar.extractFile(
          archive,
          "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        );
        fs.mkdirSync(path.dirname(mainBinaryPath), { recursive: true });
        fs.writeFileSync(mainBinaryPath, binary);
        return true;
      } catch (err) {
        log(`asar ${archive} 抽取失败，跳过该候选：${err.message}`);
      }
    }
    return false;
  };

  // 修 c：源码编译（A1 实证形态：cwd=desktop + -o better-sqlite3 + build/ 先清）
  const resolveRebuildCli = () => {
    const direct = resolveFromRoot("@electron/rebuild/lib/cli.js");
    if (direct) return direct;
    // 包 exports 图只透出 ./lib/main.js——经包入口定位同层 cli.js（bin 即 lib/cli.js）
    const entry = resolveFromRoot("@electron/rebuild");
    const sibling = entry && path.join(path.dirname(entry), "cli.js");
    if (sibling && fs.existsSync(sibling)) return sibling;
    // 终极降级：按根 node_modules 布局直拼，防解析全面失效时段 c 静默跳级
    const legacy = path.join(
      repoRoot,
      "node_modules",
      "@electron",
      "rebuild",
      "lib",
      "cli.js",
    );
    return fs.existsSync(legacy) ? legacy : null;
  };
  const healFromSource = () => {
    const rebuildCli = resolveRebuildCli();
    if (!rebuildCli) {
      log(
        "未找到 @electron/rebuild（createRequire 解析与降级直拼均失败），无法源码编译",
      );
      return false;
    }
    fs.rmSync(path.join(mainSqliteDir, "build"), {
      recursive: true,
      force: true,
    });
    log(
      `源码编译中：@electron/rebuild -f -v ${electronVersion} -o better-sqlite3 …`,
    );
    const res = spawnSync(
      process.execPath,
      [rebuildCli, "-f", "-v", electronVersion, "-o", "better-sqlite3"],
      { cwd: desktopDir, encoding: "utf8", timeout: 600000 },
    );
    const tail = (res.stdout || res.stderr || "")
      .trim()
      .split("\n")
      .slice(-3)
      .join(" | ");
    log(`源码编译退出码 ${res.status}${tail ? `：${tail}` : ""}`);
    return res.status === 0;
  };

  let probe = probeMain();
  log(`验：${probe.healthy ? "健康" : "不健康"}——${probe.detail}`);
  if (probe.healthy) {
    return { name, status: "OK", note: `已健康（${probe.detail}），未动` };
  }
  const stages = [
    ["冷缓存", healFromCache],
    ["app asar", healFromAsar],
    ["源码编译", healFromSource],
  ];
  let healedBy = null;
  for (const [label, heal] of stages) {
    log(`修（${label}）尝试…`);
    let applied = false;
    try {
      applied = heal();
    } catch (err) {
      log(`修（${label}）异常，转下一级：${err.message}`);
    }
    if (!applied) continue;
    probe = probeMain();
    log(
      `验（${label} 后）：${probe.healthy ? "健康" : "仍不健康"}——${probe.detail}`,
    );
    if (probe.healthy) {
      healedBy = label;
      break;
    }
  }
  if (!healedBy) {
    return {
      name,
      status: "FAIL",
      note: `三级瀑布（缓存/asar/源码）均未修好——${probe.detail}；手动指引：装一次同版本桌面端安装包后重跑（补 asar 源），或 cd apps/tianshu-desktop && npx @electron/rebuild -f -v ${electronVersion} -o better-sqlite3`,
    };
  }
  if (healedBy === "冷缓存") {
    return { name, status: "OK", note: `经「冷缓存」秒修（${probe.detail}）` };
  }
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.copyFileSync(mainBinaryPath, cachePath);
  } catch (err) {
    log(`WARN：冷缓存写入失败（不影响本段结果）：${err.message}`);
  }
  return {
    name,
    status: "OK",
    note: `经「${healedBy}」修回（${probe.detail}），冷缓存已写入`,
  };
};

const stage2 = () => {
  const name = "段2 vitest node-ABI 副本（.native-node）";
  const res = spawnSync(
    process.execPath,
    [path.join(desktopDir, "scripts", "setup-native-node.mjs")],
    { stdio: "inherit" },
  );
  return res.status === 0
    ? { name, status: "OK", note: "装配自检通过（构造实例 node-ABI）" }
    : {
        name,
        status: "FAIL",
        note: `setup-native-node.mjs 退出码 ${res.status}`,
      };
};

const stage3 = () => {
  const name = "段3 mobile 本地 nativewind";
  const mobileNodeModules = path.join(mobileDir, "node_modules") + path.sep;
  const declaredRange =
    (readJson(path.join(mobileDir, "package.json")).dependencies || {})
      .nativewind || "*";
  // 验必须在子进程里 resolve：同进程二次 resolve 会命中 Module._pathCache，
  // 修复前「解析到根 hoisted 副本」的结果会把修复后的复验也污染成本地缺失。
  // nativewind 与 react-native-css-interop 双探——恢复脚本头注：两者实体必须
  // 同在 mobile 本地树，缺一即真机 99.9% 卡死
  const resolveLocal = () => {
    const res = spawnSync(
      process.execPath,
      [
        "-e",
        `for (const m of ["nativewind", "react-native-css-interop"]) { try { console.log(m + "=" + require.resolve(m + "/package.json", { paths: [${JSON.stringify(mobileDir)}] })); } catch { console.log(m + "=UNRESOLVED"); } }`,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    const pick = (mod) => {
      const line = (res.stdout || "")
        .split("\n")
        .find((l) => l.startsWith(`${mod}=`));
      const resolved = line ? line.slice(mod.length + 1).trim() : "";
      if (!resolved || resolved === "UNRESOLVED") return null;
      return resolved.startsWith(mobileNodeModules) ? resolved : null;
    };
    return {
      nativewind: pick("nativewind"),
      cssInterop: pick("react-native-css-interop"),
    };
  };
  // semver 陈旧校验（终审 I-1）：还原旧链无条件跑 restore 时的版本语义——本地
  // 幸存副本不满足声明 range（升级依赖但副本幸存场景）也算不健康，交恢复脚本
  // 重拉；判定异常按脚本自身口径（2>/dev/null || yes）放行不拦
  const satisfiesDeclared = (resolved) => {
    try {
      return rootRequire("semver").satisfies(
        readJson(resolved).version,
        declaredRange,
      );
    } catch {
      return true;
    }
  };
  const healthy = (local) =>
    !!local.nativewind &&
    !!local.cssInterop &&
    satisfiesDeclared(local.nativewind);
  const describeGap = (local) => {
    if (!local.nativewind) return "nativewind 未解析到本地树";
    if (!local.cssInterop) return "react-native-css-interop 未解析到本地树";
    if (!satisfiesDeclared(local.nativewind)) {
      return `本地 nativewind ${readJson(local.nativewind).version} 不满足声明 ${declaredRange}`;
    }
    return "";
  };
  const local = resolveLocal();
  if (healthy(local)) {
    return {
      name,
      status: "OK",
      note: "本地树在位（nativewind+css-interop 双探过且版本满足声明），未动",
    };
  }
  log(`验：不健康——${describeGap(local)}`);
  if (process.platform === "win32") {
    return {
      name,
      status: "WARN",
      note: "本地树缺失/陈旧且 win32 无 bash 恢复脚本——手动跑 restore-local-nativewind 的等价步骤",
    };
  }
  const res = spawnSync(
    "bash",
    [
      path.join(
        repoRoot,
        "apps",
        "tianshu-mobile",
        "scripts",
        "restore-local-nativewind.sh",
      ),
    ],
    { stdio: "inherit" },
  );
  const after = resolveLocal();
  if (res.status === 0 && healthy(after)) {
    return {
      name,
      status: "OK",
      note: `restore 后已归位：${path.dirname(path.dirname(after.nativewind))}（nativewind ${readJson(after.nativewind).version}）`,
    };
  }
  return {
    name,
    status: "FAIL",
    note: `恢复后仍不健康（脚本退出码 ${res.status}，${describeGap(after) || "解析未落在本地树"}）`,
  };
};

const results = [stage1(), stage2(), stage3()];
const width = Math.max(...results.map((r) => r.name.length));
log("── 汇总 " + "─".repeat(width));
for (const r of results) {
  console.log(
    `${TAG} ${r.status.padEnd(4)} ${r.name.padEnd(width)}  ${r.note}`,
  );
}
const failed = results.filter((r) => r.status === "FAIL");
if (failed.length > 0) {
  log(`结果：${failed.length} 段 FAIL——原生状态不完整，dev/测试前须修复`);
  process.exit(1);
}
const warned = results.filter((r) => r.status === "WARN");
log(
  `结果：${results.length - failed.length} 段通过${warned.length ? `（含 ${warned.length} 段 WARN）` : ""}`,
);
