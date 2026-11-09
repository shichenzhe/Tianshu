/**
 * @tianshu/core 导入守卫（RN bundle 兼容性前置检查）。
 * 背景（2026-11-06 实证）：core 主 barrel（dist/index.js）聚合
 * workspace-files-scan（node:fs/promises）、e2e-crypto/
 * backup-archive-crypto/crypto-envelope（node:crypto）、graph-http-guard
 * 等 Node-only 模块，RN runtime 无 Node 标准库，Metro 打包必炸；mobile
 * vitest 跑 node 环境（node: 可解析）对此零覆盖——本守卫把拦截提前到单测。
 * 规则：
 * 1. 业务源码（非 *.test.ts）禁止裸导入 @tianshu/core（主入口）——纯函数
 *    请深路径导入（如 @tianshu/core/dist/model-type）；Node-only 模块请
 *    本地实现（先例 src/transport/e2e-crypto.ts，expo-crypto 版 wire
 *    兼容 core 原实现）；
 * 2. 深路径导入的 dist 模块递归检查依赖闭包（require 相对链），出现
 *    require("node: 即 fail——防未来新加深路径时把 Node 依赖拖进 RN
 *    bundle。bare require（@tianshu/protocol、@langchain/* 等）不追：
 *    protocol 为纯类型+常量包，其余第三方包由 Metro 自行按 exports 解析。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";

const srcRoot = fileURLToPath(new URL("./", import.meta.url));
// 指向包根（非 dist/）：深路径 specifier（dist/<mod>）与包内路径一一直拼
const corePkgRoot = fileURLToPath(
  new URL("../../../packages/tianshu-core/", import.meta.url),
);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
      out.push(full);
  }
  return out;
}

/** 抓 from "…" / import("…") / 副作用 import "…" 三形态的 specifier */
const IMPORT_SPECIFIER_RE =
  /(?:\bfrom\s+|^import\s*\(\s*|^import\s+)(["'])([^"']+)\1/gm;

interface DeepImport {
  file: string;
  subpath: string;
}

function scanImports(): { bare: string[]; deep: DeepImport[] } {
  const bare: string[] = [];
  const deep: DeepImport[] = [];
  for (const file of listSourceFiles(srcRoot)) {
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = match[2];
      if (specifier === "@tianshu/core") {
        bare.push(`${file.replace(srcRoot, "src/")} → 裸主入口导入`);
      } else if (specifier.startsWith("@tianshu/core/")) {
        deep.push({
          file: file.replace(srcRoot, "src/"),
          subpath: specifier.slice("@tianshu/core/".length),
        });
      }
    }
  }
  return { bare, deep };
}

/** dist 模块依赖闭包内不得出现 require("node:…") */
function collectNodeBuiltins(entry: string): string[] {
  const offenders: string[] = [];
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const file = current.endsWith(".js") ? current : `${current}.js`;
    const full = join(corePkgRoot, file);
    if (!existsSync(full)) {
      offenders.push(`dist/${file} 不存在（深路径写错或未重建 dist）`);
      continue;
    }
    const code = readFileSync(full, "utf8");
    for (const hit of code.matchAll(/require\(["'](node:[^"']+)["']\)/g)) {
      offenders.push(`dist/${file} → ${hit[1]}`);
    }
    for (const hit of code.matchAll(/require\(["'](\.\/[^"']+)["']\)/g)) {
      const target = hit[1].endsWith(".js") ? hit[1] : `${hit[1]}.js`;
      queue.push(posix.join(posix.dirname(file), target));
    }
  }
  return offenders;
}

describe("@tianshu/core 导入守卫（RN bundle 兼容）", () => {
  it("业务源码不得裸导入 @tianshu/core 主入口", () => {
    const { bare } = scanImports();
    expect(
      bare,
      "主 barrel 聚合 node:fs/node:crypto 等 Node-only 模块，RN 打包必炸；" +
        "纯函数改深路径导入（@tianshu/core/dist/<mod>），Node-only 模块本地实现" +
        "（先例 src/transport/e2e-crypto.ts）",
    ).toEqual([]);
  });

  it("深路径导入的 dist 模块依赖闭包不含 Node 标准库", () => {
    const { deep } = scanImports();
    const problems = deep.flatMap((item) => {
      const offenders = collectNodeBuiltins(item.subpath);
      return offenders.map(
        (offender) => `${item.file} → @tianshu/core/${item.subpath}：${offender}`,
      );
    });
    expect(problems).toEqual([]);
  });
});
