const { getDefaultConfig } = require("expo/metro-config");

// monorepo hoist 重定向：nativewind（提升在根 node_modules）内部 bare
// require("tailwindcss"、'tailwindcss/package.json'、'tailwindcss/loadConfig'
// 等）会解析到根上 mirror 的 tailwindcss v4（版本探测报 "NativeWind only
// supports Tailwind CSS v3"，v3 独有子路径则被 v4 exports 拒绝）。在加载
// nativewind 前，把进程内一切 bare tailwindcss(/*) 请求按本 app 的解析链
// （本目录 node_modules 优先——嵌套 3.x）重定向。peer 依赖不受 npm
// overrides 约束、alias 也被提升，故用解析补丁；Metro 本进程内仅本 app
// 消费 tailwind，重定向安全
const Module = require("module");
const origResolveFilename = Module._resolveFilename;
const resolveFromApp = (request) =>
  origResolveFilename(request, {
    id: "metro-tailwind-redirect",
    filename: __filename,
    paths: Module._nodeModulePaths(__dirname),
  });
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "tailwindcss" || request.startsWith("tailwindcss/")) {
    return resolveFromApp(request);
  }
  return origResolveFilename.call(this, request, parent, ...rest);
};

const { withNativeWind } = require("nativewind/metro");
const path = require("node:path");

// ——99.9% fail-fast 自检:上述「物理位置」不变量被破坏(根 npm install 重排、
// postinstall 被拦等)时,与其让 transformer 对 Expo Go 魔法 URL 无报错死锁,
// 不如 config 加载即炸并给出修复命令。校验逻辑与下方 extraNodeModules 的
// 解析手法一致;symlink 实体按不合规处理(误报方向安全)
const localModDir = path.join(__dirname, "node_modules");
for (const pkg of ["nativewind", "react-native-css-interop"]) {
  const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
  if (!pkgDir.startsWith(localModDir)) {
    throw new Error(
      `[99.9% 卡死防御] ${pkg} 不在本 app 的 node_modules(解析到 ${pkgDir})——` +
        `hoist 状态下 transformer 对 Expo Go 魔法 URL 死锁,真机将永卡 99.9%。` +
        `修复:bash apps/tianshu-mobile/scripts/restore-local-nativewind.sh 后重启 expo`,
    );
  }
}

const config = getDefaultConfig(__dirname);

// monorepo 显式锁界（Expo 官方 workspace 手法）：projectRoot 钉死本 app
// （hoist 后 npx 从根解析 expo CLI 时 root 会被误判为仓库根——
// expo-router 的 context module 路由扫描随 root 漂移扫空，bundle 无
// 业务模块、真机加载卡 99.9%）；watchFolders 挂仓库根供协议包
// symlink/共享依赖解析
config.projectRoot = __dirname;
// watchFolders 挂仓库根（0949a292 曾误删——「独立树下无意义」判断错误：
// 实测删除后 15:31/15:36 两个新起实例 root 全部漂回 mirror 根，bundle 报
// Unable to resolve ./index from mirror/.，真机只能跑 Expo Go 缓存旧包；
// 恢复后 root 判定链重新钉死。watch 仓库根同时供协议包 symlink 解析）
config.watchFolders = [path.resolve(__dirname, "../..")];
// expo-router 路由发现依赖 require.context（context module）——SDK 58→57
// 降级后 metro-config 版本错位未自动启用（bundle 内 fallback 抛错、真机
// 永卡 99.9%），显式打开
config.transformer.unstable_allowRequireContext = true;

// react-native-css-interop 被 npm 摆放在根 nativewind 的嵌套 node_modules，
// 而 nativewind babel 在 app 源码生成的 bare 'react-native-css-interop/
// jsx-runtime'（jsxImportSource）按目录向上走查不到它——extraNodeModules
// 把裸名指回 nativewind 名下的实体副本（RN monorepo 经典手法）
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "react-native-css-interop": path.dirname(
    require.resolve("react-native-css-interop/package.json", {
      paths: [path.dirname(require.resolve("nativewind/package.json"))],
    }),
  ),
};

// ——99.9% 卡死修复(2026-10-22):根因是 nativewind 的物理位置。workspace hoist
// 后 nativewind 只在仓库根(node_modules/nativewind),withNativeWind 设置的
// transformerPath(css-interop 自定义 transformer)在「mobile projectRoot + 根位置
// nativewind」组合下,对带 transform.routerRoot 的请求(Expo Go 魔法 URL 必带,路由
// context module 触发)transform 完成后于 transformer 内死锁——全线程 idle、无报错、
// 真机永卡 99.9%。修复 = nativewind + react-native-css-interop 实体放回本 app 的
// node_modules(见 scripts/restore-local-nativewind.sh,根目录 npm install 重排后
// 须重跑)。附带 expo_customTransformerPath=false 关闭 expo 的 transform worker
// supervisor(自定义 transformerPath 会误触发其以 sh -c 重新 spawn 整个 expo 进程,
// 属于叠加死锁源,保守双保险)
config.transformer.expo_customTransformerPath = false;

module.exports = withNativeWind(config, { input: "./src/global.css" });
