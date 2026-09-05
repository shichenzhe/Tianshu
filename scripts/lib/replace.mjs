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
  "REPO_URL",
];

/**
 * 字面量占位符：非 {{KEY}} 模板，默认值本身即占位形态
 * （如 electron/Constants.ts 的 SkillHub API Key 默认值），init 以真实值整串替换
 */
export const LITERAL_PLACEHOLDERS = [
  { placeholder: "skh-your-api-key", key: "SKILLHUB_API_KEY" },
];

const CONFIG_FILE = "shu-init.json";
const TARGET_EXT = new Set([
  ".json",
  ".json5",
  ".ts",
  ".tsx",
  ".md",
  ".html",
  ".mjs",
  ".cjs",
  ".css",
  ".svg",
  ".txt",
  "",
]);
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "release",
  "database",
  "logs",
  ".github",
  "scripts",
  "electron/generated",
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
 * 统一替换对：[搜索串, values 键]。
 * 模板占位符搜 {{KEY}} 字面量；字面量占位符搜其默认值原样。
 */
const SEARCH_PAIRS = [
  ...PLACEHOLDERS.map((key) => [`{{${key}}}`, key]),
  ...LITERAL_PLACEHOLDERS.map(({ placeholder, key }) => [placeholder, key]),
];

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
    for (const [search, key] of SEARCH_PAIRS) {
      const next = values[key] ?? "";
      content = content.split(search).join(next);
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
