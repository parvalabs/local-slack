import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Dev server proxies the backend surfaces so the browser talks to a single origin.
// The production build inlines everything into one index.html so the server (and the
// compiled single-file binary) only needs to embed/serve a single asset.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/_control": "http://localhost:3000",
      "/emoji": "http://localhost:3000",
      "/ui": { target: "ws://localhost:3000", ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
