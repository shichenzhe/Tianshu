/**
 * .env 密钥外移（spec §13 项 6）：JWT_SECRET 写入/更新根目录 .env
 * （已 gitignore）。不走 applyPlaceholders 全仓替换——密钥不应出现在任何
 * 入库文件；纯函数抽出供 init.mjs 与单测共用（先例 lib/replace.js）。
 */
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

// 完整键匹配（F6）：JWT_SECRET 后只容空白再接 '='——不吞 JWT_SECRET_EXTRA
// 等前缀同名键；`.*$` 吃掉整行（含旧值）供原位整行替换
const JWT_LINE_RE = /^[ \t]*JWT_SECRET[ \t]*=.*$/m;

/**
 * 幂等写入 .env 的 JWT_SECRET 行：已有则原位替换，无则追加（保留其余行）
 * @param {string} rootDir 项目根目录
 * @param {string} secret 新密钥
 * @returns {Promise<string>} .env 文件路径（init 输出提示用）
 */
async function upsertEnvSecret(rootDir, secret) {
  const envPath = join(rootDir, '.env');
  let content = '';
  try {
    content = await readFile(envPath, 'utf8');
  } catch {
    // 首次生成（.env 不存在）
  }
  const line = `JWT_SECRET=${secret}`;
  const next = JWT_LINE_RE.test(content)
    ? content.replace(JWT_LINE_RE, line)
    : `${content.replace(/\s+$/, '')}${content.trim() ? '\n' : ''}${line}\n`;
  await writeFile(envPath, next, 'utf8');
  return envPath;
}

module.exports = { upsertEnvSecret };
