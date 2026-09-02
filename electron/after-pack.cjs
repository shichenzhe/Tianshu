// eslint-disable-next-line @typescript-eslint/no-require-imports -- electron-builder afterPack 以 CommonJS 加载
const fs = require("node:fs/promises");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- electron-builder afterPack 以 CommonJS 加载
const path = require("node:path");

async function removeIfExists(filePath) {
  try {
    await fs.rm(filePath, { force: true, recursive: true });
  } catch {
    // 清理失败不阻塞打包流程
  }
}

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;

  await removeIfExists(path.join(appOutDir, "vk_swiftshader.dll"));
  await removeIfExists(path.join(appOutDir, "vk_swiftshader_icd.json"));
  await removeIfExists(path.join(appOutDir, "vulkan-1.dll"));
};
