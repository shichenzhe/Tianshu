// apps/tianshu-server/scripts/build-bundle.mjs
// 镜像瘦身（2026-11-09 批）：tsc 产物二次打包单文件——装饰器 metadata 由
// tsc 阶段保真（esbuild 不支持 emitDecoratorMetadata，两段式绕开），本步
// 只做 CJS 依赖合并。external 白名单 = 引擎/原生/CLI/可选驱动/生成物：
// 进 bundle 必坏（engine 二进制不可包、__dirname 坍缩破坏路径解析、
// prisma CLI 由启动脚本子进程调用不参与打包）。
//
// 产物落位 dist/src/main.js（原位替换，tsc 的 main.js 先移临时名避免
// in-place 读写）。运行时资源锚点随 bundle 位置坍缩为单文件 __dirname
// （=dist/src）：config.yml 解析 '../../../' → <prefix>/config/config.yml、
// PrismaService require('../../generated/prisma-pg') → <prefix>/generated/
// prisma-pg——Dockerfile 配套拷贝位见其注释；本地直跑需同构落位。
import { build } from "esbuild";
import { rename, rm, stat } from "node:fs/promises";

const OUT_TMP = "dist/src/main.bundle.tmp.js";

// tsc 产物守卫：无产物（忘跑 nest build）提前失败
try {
  await stat("dist/src/main.js");
} catch {
  console.error("[build-bundle] dist/src/main.js 不存在——先跑 npm run build");
  process.exit(1);
}

const result = await build({
  entryPoints: ["dist/src/main.js"],
  outfile: OUT_TMP,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  metafile: true,
  minify: false, // 保留可读性（体积收益 <5MB，排障代价高）
  legalComments: "none",
  logLevel: "warning",
  external: [
    // —— Prisma 链：CLI（子进程 migrate deploy）+ client/engine 二进制 ——
    "prisma",
    "@prisma/client",
    "@prisma/client/*",
    "@prisma/engines",
    "@prisma/engines/*",
    ".prisma/*",
    // —— 生成物（JS 可包但 engine 路径基于 __dirname 解析，包入必坏）——
    "*generated/prisma-pg",
    // —— 原生二进制包（.node 加载路径基于 __dirname，包入必坏；runner
    //    层 npm ci 本就装，含平台预编译）——
    "bcrypt",
    "bcrypt/*",
    // —— 幽灵可选依赖（源码动态 require 但未在 server package.json 声明
    //    ——desktop 的依赖靠 workspace 提升侥幸；镜像 context 无 desktop
    //    必失败。external 保运行时惰性语义=旧镜像行为：对应节点/能力被
    //    用到才 require，不用不炸。全集经 dist 产物 require 扫描收口
    //    （2026-11-09），新增动态 require 包时同规则补此处）——
    "exceljs",
    "nodemailer",
    "better-sqlite3",
    "pdf-parse",
    "mammoth",
    "wx-server-sdk",
    // —— Nest/Fastify 生态可选伴生探测（未安装态正常；注意 fastify 的
    //    真实运行树 fast-json-stringify/ajv/ajv-formats 不在此列——它们
    //    被 bundle 内 fastify 子路径 require，external 即运行时崩，
    //    2026-11-10 实测）——
    "express",
    "express-rate-limit",
    "helmet",
    "bufferutil",
    "utf-8-validate",
    "#main-entry-point",
    // —— 可选数据库驱动（动态 import，未安装态运行时才触发）——
    "pg",
    "mysql2",
    "mysql2/*",
    "oracledb",
    "mssql",
    // —— Nest 生态「未安装可选集成」的运行时探测式 require（lazy require
    //    找不到即走 fallback 分支，未装是正常态；external 保原语义）——
    "@fastify/view",
    "class-transformer/storage",
    "@nestjs/microservices",
    "@nestjs/microservices/*",
    "@nestjs/platform-express",
    "@nestjs/websockets",
    "@nestjs/websockets/*",
    "@nestjs/sequelize",
    "@nestjs/sequelize/*",
    "@nestjs/typeorm",
    "@nestjs/typeorm/*",
    "@nestjs/mongoose",
    "@mikro-orm/*",
  ],
});

// 产物体量报告（metafile 汇总）
const outputs = Object.entries(result.metafile.outputs);
const total = outputs.reduce((s, [, o]) => s + o.bytes, 0);
console.log(
  `[build-bundle] 产物 ${outputs.length} 文件，共 ${(total / 1024 / 1024).toFixed(1)}MB`,
);

await rm("dist/src/main.js", { force: true });
await rename(OUT_TMP, "dist/src/main.js");
// sourcemap 同名配套（esbuild 产出 .tmp.js.map——main.js 加载时按
// main.js.map 找，名不对则静默失联）
await rm("dist/src/main.js.map", { force: true });
await rename(`${OUT_TMP}.map`, "dist/src/main.js.map").catch(() => {});
console.log("[build-bundle] dist/src/main.js 已原位替换为 bundle 产物");
