#!/usr/bin/env node
/**
 * 交互式初始化：替换占位符为用户输入（幂等，可重复运行）
 */
import readline from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import replaceLib from './lib/replace.js';
import { upsertEnvSecret } from './lib/env-file.js';

const { applyPlaceholders } = replaceLib;

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Node v26 实测：非 TTY 输入（echo ... | npm run init）下，readline/promises
// 连续 question() 会丢失已缓冲的行，第二个问题起永远不 resolve（进程静默退出）。
// 改用行队列接管应答，交互式与管道两种输入均可用；stdin 提前关闭时按空行处理。
const pendingLines = [];
let lineWaiter = null;
let inputClosed = false;
rl.on('line', (line) => {
  if (lineWaiter) {
    const resolve = lineWaiter;
    lineWaiter = null;
    resolve(line);
  } else {
    pendingLines.push(line);
  }
});
rl.on('close', () => {
  inputClosed = true;
  if (lineWaiter) {
    const resolve = lineWaiter;
    lineWaiter = null;
    resolve('');
  }
});

const nextLine = () => {
  if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift());
  if (inputClosed) return Promise.resolve('');
  return new Promise((resolve) => {
    lineWaiter = resolve;
  });
};

const ask = async (question, { fallback = '' } = {}) => {
  const suffix = fallback ? ` (${fallback})` : '';
  process.stdout.write(`${question}${suffix}: `);
  let answer = (await nextLine()).trim();
  if (!answer) answer = fallback;
  return answer;
};

/** REPO_URL 留空时从 package.json 删除 repository 字段 */
async function removeRepositoryField() {
  const pkgPath = join(rootDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  delete pkg.repository;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

async function main() {
  console.log('\n=== shu-nestjs-starter 初始化 ===\n');

  const appName = (
    await ask('应用名称（kebab-case，如 my-service）', { fallback: 'my-service' })
  )
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase();

  let jwtSecret = await ask(
    'JWT 签名密钥（留空自动生成随机密钥，生产环境必须替换）',
  );
  if (!jwtSecret) {
    jwtSecret = randomBytes(16).toString('hex');
    console.log(`  已生成随机密钥：${jwtSecret}`);
  }

  const author = await ask('作者');
  const repoUrl = await ask('仓库地址（可留空）');

  const values = {
    APP_NAME: appName,
    JWT_SECRET: jwtSecret,
    AUTHOR: author,
    REPO_URL: repoUrl,
  };

  console.log('\n正在替换占位符…');
  const changed = await applyPlaceholders(rootDir, values);
  if (!repoUrl) {
    await removeRepositoryField();
    console.log('  未填仓库地址：已移除 package.json 的 repository 字段');
  }
  console.log(
    `已更新 ${changed.length} 个文件（本次输入保存在 shu-init.json，重复运行可覆盖更新）`,
  );

  // JWT 密钥外移 .env（spec §13 项 6）：不入库、不进任何被扫描替换的文件
  const envPath = await upsertEnvSecret(rootDir, jwtSecret);
  console.log(`  JWT 密钥已写入 ${envPath}（已 gitignore，请勿提交）`);

  console.log(
    '\n✓ 初始化完成！下一步：\n  npm install\n  npm run prisma:reset\n  npm run start:dev\n',
  );
  rl.close();
}

main().catch((e) => {
  console.error('初始化失败:', e);
  process.exit(1);
});
