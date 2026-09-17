import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 渲染层独立构建：产物供 Electron 以 file:// 加载（base ./ 保证相对路径）
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
  server: { port: 4183 },
  preview: { port: 4183 },
});
