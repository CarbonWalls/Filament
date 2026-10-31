import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  build: {
    target: "es2022",
    cssCodeSplit: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // Keep the shell in one chunk; every plugin becomes its own file
        // (they are loaded with dynamic import on first use).
        manualChunks: (id) =>
          id.includes("node_modules/solid-js") ? "runtime" : undefined,
      },
    },
  },
});
