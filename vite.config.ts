import { defineConfig } from "vite";
import path from "node:path";
import electron from "vite-plugin-electron/simple";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs-extra";

function tryCopySync(sourcePath: string, targetPath: string) {
  try {
    fs.copySync(sourcePath, targetPath, { overwrite: true });
  } catch {
    // 拷贝失败不阻塞启动流程
  }
}

function syncElectronAssets() {
  const distElectronDir = path.resolve(__dirname, "./dist-electron");
  fs.ensureDirSync(distElectronDir);

  tryCopySync(
    path.resolve(__dirname, "./electron/infrastructure/script"),
    path.resolve(distElectronDir, "./script"),
  );

  tryCopySync(
    path.resolve(__dirname, "./docs/update-log.md"),
    path.resolve(distElectronDir, "./docs/update-log.md"),
  );

  tryCopySync(
    path.resolve(__dirname, "./electron/resources/builtin-skills"),
    path.resolve(distElectronDir, "./builtin-skills"),
  );
}

export default defineConfig(() => {
  // dev/build 启动都清空产物目录：主进程 chunk 带 hash，dev 反复重启会让旧代产物无限堆积
  fs.emptyDirSync(path.resolve(__dirname, "./dist-electron"));
  syncElectronAssets();

  const appVersion = fs.readJsonSync(path.resolve(__dirname, "package.json"))
    .version as string;

  return {
    base: "./",
    define: {
      // 应用版本号编译期注入（渲染进程用 __APP_VERSION__，与 electron app.getVersion() 同源 package.json）
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src-react"),
        // 共享包（RC-T1 protocol / RC-T3 core）：渲染层构建内联包源码；
        // 主进程构建是 vite-plugin-electron 独立实例，须在下方
        // main.vite.resolve.alias 再登记一份（顶层 alias 不传递）
        "@tianshu/protocol": path.resolve(
          __dirname,
          "packages/tianshu-protocol/src",
        ),
        "@tianshu/core": path.resolve(__dirname, "packages/tianshu-core/src"),
      },
    },
    build: {
      rolldownOptions: {
        // 生产 drop console/debugger（spec §19 项 3）：Vite 8 下根级
        // esbuild.drop 已失效（构建告警 esbuild options ignored），oxc
        // 等效走 rolldown 输出压缩 compress；mangle:true 补齐对象形态下
        // 缺省的标识符压缩，保持与整包 minify:true 同等形态。仅 vite
        // build 产物管线消费（dev 不经 rolldown 输出，console 保留）
        output: {
          minify: {
            compress: { dropConsole: true, dropDebugger: true },
            mangle: true,
          },
        },
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      electron({
        main: {
          entry: "electron/main.ts",
          vite: {
            resolve: {
              alias: {
                // 主进程独立构建实例的共享包登记（顶层 resolve.alias 不
                // 传递到此，缺一即 main 构建解析失败）
                "@tianshu/protocol": path.resolve(
                  __dirname,
                  "packages/tianshu-protocol/src",
                ),
                "@tianshu/core": path.resolve(
                  __dirname,
                  "packages/tianshu-core/src",
                ),
              },
            },
            build: {
              rolldownOptions: {
                // rolldown 对 CJS 依赖的互操作转换在 ESM 产物下有问题，均外部化走 Node 原生 require：
                // 1. moment（winston-daily-rotate-file 依赖）被误转成命名空间对象，
                //    运行时报 "moment is not a function"
                // 2. better-sqlite3（原生模块，经 @prisma/adapter-better-sqlite3 引入）
                //    内部的 bindings 依赖裸 __filename，ESM 作用域未定义
                external: [
                  "moment",
                  "better-sqlite3",
                  // MCP SDK（P2）：外部化走 Node 原生 require（历史结论）
                  "@modelcontextprotocol/sdk",
                  // node-pty（原生模块）：bindings 裸 __filename，同 better-sqlite3
                  // 原因，必须外部化走 Node 原生 require
                  "node-pty",
                ],
              },
            },
          },
        },
        preload: {
          input: path.join(__dirname, "electron/preload.ts"),
        },
        renderer: process.env.NODE_ENV === "test" ? undefined : {},
      }),
    ],
  };
});
