#!/usr/bin/env node
/**
 * SK 终审 F1：SDK 产物新鲜度门禁（pretest 钩子）——openapi.json 落后于
 * dist/src 编译产物（重建过 dist 但未重跑 sdk:generate）即 fail-fast，
 * 防「陈旧产物静默绿」（sdk-contract 对着旧 openapi.json 跑绿）。
 * 不自动重生：test 不应隐式触发 build；openapi.json 不存在时跳过
 * （SKIP 语义与 sdk-contract.spec 既有门禁一致——fresh clone 零产物可测）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const openapiPath = join(rootDir, 'openapi.json');
const distSrcDir = join(rootDir, 'dist', 'src');

if (!existsSync(openapiPath) || !existsSync(distSrcDir)) {
  process.exit(0);
}

let newestJsMtime = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) {
      newestJsMtime = Math.max(newestJsMtime, statSync(full).mtimeMs);
    }
  }
};
walk(distSrcDir);

if (statSync(openapiPath).mtimeMs < newestJsMtime) {
  console.error(
    '[pretest] openapi.json 落后于 dist/src 编译产物（DTO 已变更）——请先 npm run sdk:generate 再测试；' +
      '只想跑非 SDK 用例可删除 openapi.json 后重试（契约测试转为 SKIP）',
  );
  process.exit(1);
}
