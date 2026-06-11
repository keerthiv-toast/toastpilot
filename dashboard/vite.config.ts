import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const dashboardRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: dashboardRoot,
  resolve: {
    alias: {
      "@agent": join(dashboardRoot, "../agent"),
    },
  },
  server: {
    port: parseInt(process.env.AGENT_DASHBOARD_PORT ?? "5177", 10),
    proxy: {
      "/api": "http://localhost:9477",
      "/ws": { target: "ws://localhost:9477", ws: true },
    },
  },
  build: {
    outDir: join(dashboardRoot, "dist"),
    emptyOutDir: true,
  },
});
