import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

// Electron 主进程打包：core/provider 包导出的是 TS 源码，esbuild 原生编译打包。
// 必须输出 CJS（.cjs，规避 package.json type:module）——依赖树里的 CJS 包
// （fast-glob 等）动态 require 内置模块，在 ESM 产物下会抛
// "Dynamic require of 'os' is not supported"。
await build({
  entryPoints: ["src/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist/main/index.cjs",
  sourcemap: "inline",
});

// preload 必须保持沙箱可用的纯 CJS 脚本，直接拷贝不做打包
await mkdir("dist/preload", { recursive: true });
await cp("src/preload/index.cjs", "dist/preload/index.cjs");
