import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发期把 API 请求代理到本机 server。
const serverOrigin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/health": serverOrigin,
      "/api": serverOrigin,
    },
  },
});
