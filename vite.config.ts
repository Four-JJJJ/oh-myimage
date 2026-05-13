import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": "/src/client",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
