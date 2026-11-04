// packages 单测全局 setup：数据根重定向临时目录（对齐桌面端
// tests/setup.ts 的隔离意图——jwt-secret 等落盘副作用不污染真实 ~/.tianshu）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-pkgs-"));
process.env.TIANSHU_DATA_ROOT = testRoot;

process.on("exit", () => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});
