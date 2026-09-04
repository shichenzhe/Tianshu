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
}

export default defineConfig(({ command }) => {
  if (command === "build") {
    fs.emptyDirSync(path.resolve(__dirname, "./dist-electron"));
  }
  syncElectronAssets();

  return {
    base: "./",
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src-react"),
      },
    },
    esbuild: {
      drop: ["console", "debugger"],
    },
    plugins: [
      react(),
      tailwindcss(),
      electron({
        main: {
          entry: "electron/main.ts",
          vite: {
            build: {
              rolldownOptions: {
                // rolldown 对 CJS 依赖的互操作转换在 ESM 产物下有问题，均外部化走 Node 原生 require：
                // 1. moment（winston-daily-rotate-file 依赖）被误转成命名空间对象，
                //    运行时报 "moment is not a function"
                // 2. better-sqlite3（原生模块，经 @prisma/adapter-better-sqlite3 引入）
                //    内部的 bindings 依赖裸 __filename，ESM 作用域未定义
                // 3. ai 系列（Vercel AI SDK）：内联后破坏 node 环境清理钩子状态，
                //    流式调用时 better_sqlite3.node 析构断言崩溃（env != nullptr），
                //    原生 require 直载经并发实验验证无此问题
                external: [
                  "moment",
                  "better-sqlite3",
                  "ai",
                  "@ai-sdk/anthropic",
                  "@ai-sdk/google",
                  "@ai-sdk/openai-compatible",
                  "ai-sdk-ollama",
                  // MCP SDK（P2）：与 ai 系列同样外部化走 Node 原生 require
                  "@modelcontextprotocol/sdk",
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
