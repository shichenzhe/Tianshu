/**
 * 占位符替换核心（纯函数，被 init.mjs 与单测共用）
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const PLACEHOLDERS = [
  "APP_NAME",
  "APP_ID",
  "UPDATE_SERVER_URL",
  "AUTHOR",
  "REPO_URL"
];

const CONFIG_FILE = "shu-init.json";
const TARGET_EXT = new Set([
  ".json", ".json5", ".ts", ".tsx", ".md", ".html", ".mjs", ".cjs", ".css", ".svg", ".txt", ""
]);
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "dist-electron", "release", "database", "logs", ".github", "scripts"
]);

async function walkFiles(root) {
  const out = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) out.push(...(await walkFiles(full)));
    } else {
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot);
      if (TARGET_EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

/**
 * 将 values 中每个键的占位符（与上次 init 写入的旧值）替换为新值。
 * @param {string} rootDir 项目根目录
 * @param {Record<string,string>} values 占位符键 → 新值（可为空字符串）
 * @returns {Promise<string[]>} 被修改的文件路径
 */
export async function applyPlaceholders(rootDir, values) {
  const configPath = join(rootDir, CONFIG_FILE);
  let oldValues = {};
  try {
    oldValues = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    // 首次 init，无旧配置
  }

  const files = await walkFiles(rootDir);
  const changed = [];

  for (const file of files) {
    let content = await readFile(file, "utf8");
    const original = content;
    for (const key of PLACEHOLDERS) {
      const next = values[key] ?? "";
      content = content.split(`{{${key}}}`).join(next);
      const old = oldValues[key];
      if (old && old !== next) {
        content = content.split(old).join(next);
      }
    }
    if (content !== original) {
      await writeFile(file, content, "utf8");
      changed.push(file);
    }
  }

  await writeFile(configPath, JSON.stringify(values, null, 2) + "\n", "utf8");
  return changed;
}
