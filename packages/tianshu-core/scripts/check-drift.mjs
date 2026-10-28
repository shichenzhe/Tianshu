#!/usr/bin/env node
/**
 * RC-T7 双仓漂移巡检：mirror（tianshu）与 server（tianshu-server）仍双份文件的
 * manifest 守护——漂移即警，不自动同步（同步决策归人）。
 *
 * 用法：
 *   npm run check:drift              例行巡检：增长超容差 exit 1；减少仅警告
 *   npm run check:drift -- --rebase  重置基线（归一化差异行数回写 manifest）
 *
 * 归一化（逐行 diff 前处理，两侧同规则）：
 *   去注释（// 行注释与跨行块注释，字符串内引用不误伤）→ 引号统一（' ↔ "，
 *   转义对齐；模板字符串保留原样）→ 去 import 语句整段（静态 import，
 *   含多行，路径必不同）与 export … from 再导出行（对称规则）→ 去空行
 *   → 行尾分号剥离 → trim。之后按行 LCS 计差异行数
 *   （removed + added）。
 *
 * 判定（每对独立）：
 *   current > baseline + tolerance（默认 2）→ ALERT，exit 1
 *   current < baseline → WARN（exit 0——减少可能是收编机会，提示人工复核）
 *   其余 OK。serverRoot 可经环境变量 TIANSHU_SERVER_ROOT 覆盖
 *   （默认取 manifest.serverRoot，相对 mirror 仓根解析）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const mirrorRoot = path.resolve(scriptDir, "..", "..", "..");
const manifestPath = path.join(scriptDir, "drift-manifest.json");
const DEFAULT_TOLERANCE = 2;
const rebase = process.argv.includes("--rebase");

/* ---------- 归一化 ---------- */

/** 单引号字符串字面量统一为双引号（转义对齐；双引号串仅还原 \'） */
function unifyQuotes(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let body = "";
      while (j < line.length) {
        if (line[j] === "\\" && j + 1 < line.length) {
          body += line.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (line[j] === quote) break;
        body += line[j];
        j += 1;
      }
      const unified =
        quote === "'"
          ? body.replace(/\\'/g, "'").replace(/"/g, '\\"')
          : body.replace(/\\'/g, "'");
      out += `"${unified}"`;
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 去注释 + 去空行 + 去 import 整段 + 引号统一 + 行尾分号剥离后的代码行数组 */
function normalizeSource(source) {
  const lines = [];
  let inBlockComment = false;
  let skippingImport = false;
  for (const rawLine of source.split(/\r?\n/)) {
    // 1) 去注释（块注释状态跨行；字符串内的 // 与 /* 不误伤）
    let stripped = "";
    let i = 0;
    let strCh = null;
    while (i < rawLine.length) {
      const ch = rawLine[i];
      const next = rawLine[i + 1];
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (strCh) {
        if (ch === "\\") {
          stripped += rawLine.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === strCh) strCh = null;
        stripped += ch;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        strCh = ch;
        stripped += ch;
        i += 1;
        continue;
      }
      stripped += ch;
      i += 1;
    }
    // 2) 引号统一 + trim
    let line = unifyQuotes(stripped).trim();
    // 3) import 语句整段丢弃（多行：进入后遇 " from " 或行尾 ";" 收口）。
    //    仅匹配静态 import（^import\s）——行首动态 import( 是运行时
    //    表达式，误入跳段会连吞后续代码行（终审备案项 C3）
    if (skippingImport) {
      if (line.includes(" from ") || line.endsWith(";")) skippingImport = false;
      continue;
    }
    if (/^import\s/.test(line) || line === "import") {
      if (!(line.includes(" from ") || line.endsWith(";")))
        skippingImport = true;
      continue;
    }
    // export … from "…" 再导出行同款剔除（路径必不同，对称规则）：仅认
    // export 后紧跟 {…}/type {…}/* [as ns] 再接 from 的再导出形，不误伤
    // export const/function（含 " from " 字面量的普通导出不在此形）
    if (
      /^export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s+from\s/.test(
        line,
      )
    ) {
      continue;
    }
    // 4) 空行丢弃 + 行尾分号剥离
    line = line.replace(/;+$/, "").trim();
    if (line) lines.push(line);
  }
  return lines;
}

/* ---------- 差异计数（轻量 LCS，精确到行数不追求算法最优） ---------- */

function diffLineCount(a, b) {
  const n = a.length;
  const m = b.length;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array(m + 1).fill(0);
    const ai = a[i - 1];
    for (let j = 1; j <= m; j += 1) {
      cur[j] =
        ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const lcs = prev[m];
  return { removed: n - lcs, added: m - lcs, total: n + m - 2 * lcs };
}

/* ---------- 主流程 ---------- */

function main() {
  if (!existsSync(manifestPath)) {
    console.error(`[FATAL] manifest 不存在：${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // pairs 结构守卫（终审备案项 C1）：非数组/缺失时裸抛 "not iterable" 栈
  // 无从排查——FATAL 优雅退出（JSON 本身非法仍由 parse 抛出，栈可定位）
  if (!Array.isArray(manifest.pairs)) {
    console.error(
      `[FATAL] manifest.pairs 缺失或非数组（实际 ${typeof manifest.pairs}）：${manifestPath}`,
    );
    process.exit(1);
  }
  const serverRoot = process.env.TIANSHU_SERVER_ROOT
    ? path.resolve(process.env.TIANSHU_SERVER_ROOT)
    : path.resolve(mirrorRoot, manifest.serverRoot || "apps/tianshu-server");
  if (!existsSync(serverRoot)) {
    console.error(
      `[FATAL] server 仓不可达：${serverRoot}（可用环境变量 TIANSHU_SERVER_ROOT 覆盖）`,
    );
    process.exit(1);
  }

  let manifestDirty = false;
  let alertCount = 0;
  let errorCount = 0;
  console.log(
    `双仓漂移巡检：mirror=${mirrorRoot}\n              server=${serverRoot}` +
      (rebase ? "\n模式：--rebase（重置基线）" : ""),
  );

  for (const pair of manifest.pairs) {
    const mirrorAbs = path.join(mirrorRoot, pair.mirrorPath);
    const serverAbs = path.join(serverRoot, pair.serverPath);
    if (!existsSync(mirrorAbs) || !existsSync(serverAbs)) {
      const missing = [
        !existsSync(mirrorAbs) ? `mirror:${pair.mirrorPath}` : null,
        !existsSync(serverAbs) ? `server:${pair.serverPath}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      console.error(`[ERROR] ${pair.id} 文件缺失 → ${missing}`);
      errorCount += 1;
      continue;
    }
    if (pair.skip) {
      console.log(`[SKIP]  ${pair.id}（${pair.note || "skip"}）`);
      continue;
    }

    const a = normalizeSource(readFileSync(mirrorAbs, "utf8"));
    const b = normalizeSource(readFileSync(serverAbs, "utf8"));
    const diff = diffLineCount(a, b);
    const tolerance = Number.isFinite(pair.tolerance)
      ? pair.tolerance
      : DEFAULT_TOLERANCE;

    if (rebase || pair.baselineLines == null) {
      pair.baselineLines = diff.total;
      pair.baselineDiff = diff.total > 0;
      manifestDirty = true;
      console.log(
        `[FIXED] ${pair.id} 基线固化：diff ${diff.total}（-removed ${diff.removed}/+added ${diff.added}）`,
      );
      continue;
    }
    const baseline = pair.baselineLines;
    if (diff.total > baseline + tolerance) {
      alertCount += 1;
      console.error(
        `[ALERT] ${pair.id} 漂移增长：diff ${diff.total} > 基线 ${baseline} + 容差 ${tolerance}（-removed ${diff.removed}/+added ${diff.added}）`,
      );
    } else if (diff.total < baseline) {
      console.warn(
        `[WARN]  ${pair.id} 差异减少：diff ${diff.total} < 基线 ${baseline}（减少可能是收编机会，请人工复核）`,
      );
    } else {
      console.log(
        `[OK]    ${pair.id} diff ${diff.total}（基线 ${baseline}，容差 ${tolerance}）`,
      );
    }
  }

  if (manifestDirty) {
    writeFileSync(
      manifestPath,
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
    console.log(`manifest 已回写基线：${manifestPath}`);
  }

  alertCount += checkPeerVersions(serverRoot);

  const total = manifest.pairs.length;
  console.log(
    `巡检完成：${total} 对（告警 ${alertCount} / 错误 ${errorCount}）` +
      (alertCount || errorCount ? "——漂移即警不自动同步，处置决策归人" : ""),
  );
  if (alertCount || errorCount) process.exit(1);
}

/* ---------- 双仓 peer 版本对齐（@langchain 双副本消漂，终审建议落地） ----------
 * 共享包运行时经 realpath 解析实际生效副本；monorepo workspace 化后
 * server 依赖多提升至根 node_modules（与 mirror 同一副本——hoist 本身即
 * 消双副本），故定位走 node 解析规则（createRequire 自 serverRoot 起
 * 解析），而非字面 serverRoot/node_modules 直读。版本不等即双副本
 * 隐患（跨副本 instanceof / 行为分叉），对齐后重装。 */
const PEER_PACKAGES = ["@langchain/core", "@langchain/langgraph"];

function checkPeerVersions(serverRoot) {
  let mismatch = 0;
  for (const name of PEER_PACKAGES) {
    const read = (root) => {
      try {
        const resolved = createRequire(path.join(root, "package.json")).resolve(
          `${name}/package.json`,
        );
        return JSON.parse(readFileSync(resolved, "utf8")).version;
      } catch {
        return "(未安装)";
      }
    };
    const m = read(mirrorRoot);
    const s = read(serverRoot);
    if (m !== s) {
      mismatch += 1;
      console.error(
        `[ALERT] peer 双副本：${name} mirror=${m} ≠ server=${s}（两仓对齐版本后各自重装）`,
      );
    } else {
      console.log(`[OK]    peer ${name} ${m}（双仓一致）`);
    }
  }
  return mismatch;
}

main();
