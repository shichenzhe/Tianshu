const fs = require("node:fs/promises");
const path = require("node:path");

async function removeIfExists(filePath) {
  try {
    await fs.rm(filePath, { force: true, recursive: true });
  } catch (_e) {
  }
}

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;

  await removeIfExists(path.join(appOutDir, "vk_swiftshader.dll"));
  await removeIfExists(path.join(appOutDir, "vk_swiftshader_icd.json"));
  await removeIfExists(path.join(appOutDir, "vulkan-1.dll"));
};

