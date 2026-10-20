import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { renameSync } from "node:fs";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "share-index",
      closeBundle() {
        renameSync("share/public/share.html", "share/public/index.html");
      },
    },
  ],
  build: {
    outDir: "share/public",
    emptyOutDir: true,
    rollupOptions: { input: "share.html" },
  },
});
