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
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const mainVersion = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "node_modules", "better-sqlite3", "package.json"),
    "utf8",
  ),
).version;

// 副本目录预置 package.json：npm 11 install-scripts 白名单按安装根判定，
// 预置同名条目防止 --prefix 安装把 prebuild-install 拦在门外（拿不到
// node-ABI 预编译产物）
fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(
  path.join(targetDir, "package.json"),
  JSON.stringify(
    {
      name: "tianshu-native-node",
      private: true,
      allowScripts: { [`better-sqlite3@${mainVersion}`]: true },
    },
    null,
    2,
  ) + "\n",
);

console.log(`[setup-native-node] better-sqlite3@${mainVersion} → ${targetDir}`);
execFileSync(
  npmCmd,
  [
    "install",
    "--prefix",
    targetDir,
    `better-sqlite3@${mainVersion}`,
    "--no-save",
    "--no-audit",
    "--no-fund",
  ],
  { stdio: "inherit", cwd: repoRoot },
);

// 装配自检：副本必须在系统 node 下可加载（node-ABI）；失败即非零退出，
// 让 postinstall 的 warn 段与 setup:native-node 修复入口接手
execFileSync(
  "node",
  [
    "-e",
    `require(${JSON.stringify(path.join(targetDir, "node_modules", "better-sqlite3"))}); console.log("[setup-native-node] 副本 node-ABI 自检通过")`,
  ],
  { stdio: "inherit" },
);
