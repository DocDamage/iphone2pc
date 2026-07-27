import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@core": path.resolve(__dirname, "electron/core")
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true
  }
});
