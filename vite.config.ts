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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // Let Rollup place calendar deps next to the lazily loaded Calendar chunk
          // (date-fns helpers used by the app shell are split out automatically).
          if (id.includes("/react-day-picker/") || id.includes("/date-fns/") || id.includes("/@date-fns/")) return undefined;
          return "vendor";
        },
      },
    },
  },
});
