/**
 * vitest 全局 setup：把天枢数据根重定向到临时目录。路径解析
 * （commons/paths）经 os.homedir() 落真实 ~/.tianshu——jwt-secret
 * 落盘、日志等副作用会污染用户数据根，测试必须隔离。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-test-"));
process.env.TIANSHU_DATA_ROOT = testRoot;

process.on("exit", () => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});
