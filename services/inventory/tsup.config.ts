import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Las librerías del monorepo se exportan como TypeScript: se incluyen en el bundle.
  // Las dependencias npm quedan externas y se instalan en la imagen.
  noExternal: [/^@shared\//],
});
