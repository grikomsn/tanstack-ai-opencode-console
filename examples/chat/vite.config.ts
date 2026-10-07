import { defineConfig } from "vite";

const proxy = {
  "/api": {
    target: "http://127.0.0.1:3001",
    timeout: 180_000,
    proxyTimeout: 180_000,
  },
};

export default defineConfig({
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy },
});
