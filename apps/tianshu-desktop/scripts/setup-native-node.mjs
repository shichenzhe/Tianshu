#!/usr/bin/env node
/**
 * node-ABI better-sqlite3 副本装配（双 ABI 根治，2026-11-04-abi-dual-copy）：
 * 主 node_modules 的 better-sqlite3 常驻 Electron ABI（dev/打包消费，vite
 * external 原生 require 不经 alias）；本脚本在 .native-node/ 装一份与主树
 * 同版本的 node-ABI 副本供 vitest 经 alias 消费——两端互不干扰，无需来回
 * rebuild。版本读主树实装值，永不漂移。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(desktopDir, "..", "..");
const targetDir = path.join(desktopDir, ".native-node");

// Windows 的 npm 是 npm.cmd——CVE-2024-27980 收紧后无 shell spawn 直接
// EINVAL（.cmd 三元是死码），统一改经 node 自身跑 npm-cli.js。按宿主布局
// 探测：官方 win 包 node_modules 与 node.exe 同层；POSIX shim（homebrew/
// nvm）bin 下的 npm 软链 realpath 直达 cli；official POSIX 包在
// ../lib/node_modules
const resolveNpmCli = () => {
  const nodeBin = path.dirname(fs.realpathSync(process.execPath));
  const direct = path.join(nodeBin, "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(direct)) return direct;
  const shim = path.join(nodeBin, "npm");
  if (fs.existsSync(shim)) {
    const real = fs.realpathSync(shim);
    if (path.basename(real) === "npm-cli.js") return real;
  }
  const posix = path.join(
    nodeBin,
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (fs.existsSync(posix)) return posix;
  throw new Error("未能定位 npm-cli.js——请检查 node 安装布局");
};
const mainVersion = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "node_modules", "better-sqlite3", "package.json"),
    "utf8",
  ),
).version;

// 副本目录预置 package.json（纯占位）。npm 11.19+ 项目作用域安装只认
// 项目根 package.json 的 allowScripts 字段——根白名单已含 better-sqlite3，
// 此处再写 allowScripts 会触发 EALLOWSCRIPTS（"--allow-scripts is not
// allowed in project-scoped installs"）把整段装配打挂（2026-11-17 实测）
fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(
  path.join(targetDir, "package.json"),
  JSON.stringify(
    {
      name: "tianshu-native-node",
      private: true,
    },
    null,
    2,
  ) + "\n",
);

console.log(`[setup-native-node] better-sqlite3@${mainVersion} → ${targetDir}`);
// npm run 上下文会把用户 .npmrc 的 allow-scripts 导出为
// npm_config_allow_scripts——子 npm 视作 --allow-scripts 旗标，在项目
// 作用域安装里直接 EALLOWSCRIPTS（2026-11-17 实测）。装配前剥掉该变量
const childEnv = { ...process.env };
delete childEnv.npm_config_allow_scripts;
execFileSync(
  process.execPath,
  [
    resolveNpmCli(),
    "install",
    "--prefix",
    targetDir,
    `better-sqlite3@${mainVersion}`,
    "--no-save",
    "--no-audit",
    "--no-fund",
  ],
  { stdio: "inherit", cwd: repoRoot, env: childEnv },
);

// 装配自检：副本必须在系统 node 下可加载（node-ABI）；失败即非零退出，
// 让 postinstall 的 warn 段与 setup:native-node 修复入口接手。必须构造
// 实例才有效——v12 的 addon 在 Database 构造时才懒加载，裸 require 对
// 「.node 缺失/错 ABI」都会假绿
execFileSync(
  "node",
  [
    "-e",
    `require(${JSON.stringify(path.join(targetDir, "node_modules", "better-sqlite3"))})(":memory:"); console.log("[setup-native-node] 副本 node-ABI 自检通过")`,
  ],
  { stdio: "inherit" },
);
