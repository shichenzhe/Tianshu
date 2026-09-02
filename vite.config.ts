import { defineConfig } from "vite";
import path from "node:path";
import electron from "vite-plugin-electron/simple";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs-extra";

function tryCopySync(sourcePath: string, targetPath: string) {
  try {
    fs.copySync(sourcePath, targetPath, { overwrite: true });
  } catch (_e) {
  }
}

function syncElectronAssets() {
  const distElectronDir = path.resolve(__dirname, "./dist-electron");
  fs.ensureDirSync(distElectronDir);

  tryCopySync(
    path.resolve(__dirname, "./electron/infrastructure/script"),
    path.resolve(distElectronDir, "./script")
  );

  const prismaSourceDir = path.resolve(
    __dirname,
    "./electron/infrastructure/prisma"
  );
  const prismaTargetDir = path.resolve(distElectronDir, "./prisma");
  fs.ensureDirSync(path.resolve(prismaTargetDir, "./runtime"));

  const prismaFilesToCopy = [
    ["package.json", "package.json"],
    ["index.js", "index.js"],
    ["schema.prisma", "schema.prisma"],
    ["client.js", "client.js"],
    ["default.js", "default.js"],
    ["edge.js", "edge.js"],
    ["wasm.js", "wasm.js"],
    ["query_engine-windows.dll.node", "query_engine-windows.dll.node"],
    ["libquery_engine-darwin.dylib", "libquery_engine-darwin.dylib"],
    ["libquery_engine-darwin-arm64.dylib", "libquery_engine-darwin-arm64.dylib"],
    ["libquery_engine-debian-openssl-3.0.x.so.node", "libquery_engine-debian-openssl-3.0.x.so.node"],
    ["libquery_engine-linux-musl-openssl-3.0.x.so.node", "libquery_engine-linux-musl-openssl-3.0.x.so.node"],
    ["runtime/library.js", "runtime/library.js"]
  ] as const;

  for (const [from, to] of prismaFilesToCopy) {
    tryCopySync(
      path.resolve(prismaSourceDir, from),
      path.resolve(prismaTargetDir, to)
    );
  }

  tryCopySync(
    path.resolve(__dirname, "./docs/update-log.md"),
    path.resolve(distElectronDir, "./docs/update-log.md")
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
        "@": path.resolve(__dirname, "src-react")
      }
    },
    esbuild: {
      drop: ["console", "debugger"]
    },
    plugins: [
      react(),
      tailwindcss(),
      electron({
        main: {
          entry: "electron/main.ts"
        },
        preload: {
          input: path.join(__dirname, "electron/preload.ts")
        },
        renderer: process.env.NODE_ENV === "test" ? undefined : {}
      })
    ]
  };
});
