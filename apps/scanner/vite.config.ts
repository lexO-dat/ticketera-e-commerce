import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * App de validación en puerta. Se publica en https://localhost:8443/scanner/ (Nginx), mismo origen
 * que /api: no necesita CORS ni guarda tokens fuera de la memoria de la pestaña.
 */
export default defineConfig({
  base: "/scanner/",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: process.env["GATEWAY_URL"] ?? "http://127.0.0.1:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
