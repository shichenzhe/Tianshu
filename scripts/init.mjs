#!/usr/bin/env node
/**
 * 交互式初始化：替换占位符为用户输入（幂等，可重复运行）
 */
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyPlaceholders } from "./lib/replace.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = async (question, { fallback = "" } = {}) => {
  const suffix = fallback ? ` (${fallback})` : "";
  let answer = (await rl.question(`${question}${suffix}: `)).trim();
  if (!answer) answer = fallback;
  return answer;
};

const validateAppId = (appId) =>
  /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/.test(appId);

async function main() {
  console.log("\n=== {{APP_NAME}} 初始化 ===\n");

  const appName = await ask("应用名称", { fallback: "my-app" });

  const sanitized =
    appName.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase() || "my-app";
  let appId = await ask("应用 ID（反域名，如 com.example.myapp）", {
    fallback: `com.example.${sanitized}`,
  });
  while (!validateAppId(appId)) {
    console.error("  ✗ 应用 ID 格式应为反域名（字母开头，至少一段点分）");
    appId = await ask("应用 ID", { fallback: appId });
  }

  const updateServerUrl = await ask("更新服务器 URL（可留空 = 禁用自动更新）");
  const author = await ask("作者");
  const repoUrl = await ask("仓库地址（可留空）");

  const values = {
    APP_NAME: appName,
    APP_ID: appId,
    UPDATE_SERVER_URL: updateServerUrl,
    AUTHOR: author,
    REPO_URL: repoUrl,
  };

  console.log("\n正在替换占位符…");
  const changed = await applyPlaceholders(rootDir, values);
  console.log(
    `已更新 ${changed.length} 个文件（清单见 shu-init.json 同目录提交记录）`,
  );

  if (!updateServerUrl) {
    console.log(
      "ℹ 未配置更新服务器：自动更新已禁用（init-updater 会静默跳过）。",
    );
    console.log("  配置方法见 docs/update-server.md");
  }

  console.log("\n✓ 初始化完成！下一步：\n  npm install\n  npm run dev\n");
  rl.close();
}

main().catch((e) => {
  console.error("初始化失败:", e);
  process.exit(1);
});
