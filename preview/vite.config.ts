import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 视觉验证页（不进插件产物）：真实 chip/面板 + 罐头聚合器数据，浅色
 * （速度面板）与深色（用量面板）并排。从插件根跑：
 *   pnpm exec vite build --config preview/vite.config.ts
 * tailwind 插件只为编译宿主 index.css 的 @theme token（与宿主实际加载
 * 顺序一致），不影响 vite build 的 lib 产物。
 */
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
