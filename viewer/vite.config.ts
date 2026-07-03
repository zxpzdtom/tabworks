import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const UNIFIED_PORT = Number(process.env.TABWORKS_PORT || "9527");
const STANDALONE_VIEWER_PORT = Number(
  process.env.TABWORKS_VIEWER_DEV_PORT || "5174",
);
const LOGS_API_TARGET = `http://127.0.0.1:${UNIFIED_PORT}`;
const BRIDGE_TARGET = LOGS_API_TARGET;
const BRIDGE_HTTP_ROUTES = [
  "/status",
  "/shutdown",
  "/logs",
  "/pages",
  "/open",
  "/goto",
  "/close",
  "/inspect",
  "/run-js",
  "/tap",
  "/input",
  "/move",
  "/capture",
  "/request",
  "/cookies",
  "/sessions",
];

const proxy = Object.fromEntries(
  BRIDGE_HTTP_ROUTES.map((route) => [route, BRIDGE_TARGET]),
);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: STANDALONE_VIEWER_PORT,
    proxy: {
      "/api": LOGS_API_TARGET,
      "/ext": {
        target: BRIDGE_TARGET,
        ws: true,
      },
      ...proxy,
    },
  },
});
