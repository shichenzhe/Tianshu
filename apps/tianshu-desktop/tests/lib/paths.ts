// tests 下沉 apps/tianshu-desktop 后的仓根定位单源：e2e 基建（server
// dist/relay dist 定位）与 drift-manifest.test 此前各自手算上溯层数，
// 迁移后层数 3→5，重复且易错——收敛一处（tests/lib → 上溯四级 = 仓根）。
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIRROR_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
