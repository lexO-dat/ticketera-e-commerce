import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

/**
 * Dev only: a rejected promise during SSR (e.g. a failing server function) would
 * otherwise kill the Vite process. Log it and keep the dev server alive.
 */
function devKeepAliveOnRejection(): Plugin {
  return {
    name: "dev-keep-alive-on-rejection",
    apply: "serve",
    configureServer(server) {
      const onRejection = (reason: unknown) => {
        server.config.logger.error(`[ssr] Unhandled rejection: ${String(reason)}`, {
          error: reason instanceof Error ? reason : null,
        });
      };
      process.on("unhandledRejection", onRejection);
      server.httpServer?.once("close", () => process.off("unhandledRejection", onRejection));
    },
  };
}

export default defineConfig(({ command }) => ({
  server: {
    host: true,
    port: 8080,
    // Desarrollo sin Nginx: /api/* (p. ej. imágenes del catálogo) va al gateway, igual que en
    // https://localhost:8443.
    proxy: {
      "/api": {
        target: process.env["GATEWAY_URL"] ?? "http://127.0.0.1:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // Formulario del adquirente simulado (webpay-mock publicado en 127.0.0.1:3005).
      "/webpay": { target: process.env["WEBPAY_URL"] ?? "http://127.0.0.1:3005", changeOrigin: true },
    },
  },
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to src/server.ts (SSR error wrapper).
      server: { entry: "server" },
      importProtection: {
        behavior: "error",
        client: {
          files: ["**/server/**"],
          specifiers: ["server-only"],
        },
      },
    }),
    // Self-hosted Node server output (.output/server/index.mjs). Override with NITRO_PRESET.
    ...(command === "build"
      ? [nitro({ preset: process.env["NITRO_PRESET"] ?? "node-server" })]
      : []),
    viteReact(),
    devKeepAliveOnRejection(),
  ],
}));
