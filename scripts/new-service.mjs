#!/usr/bin/env node
// Crea un servicio nuevo a partir de services/template.
//   npm run new:service -- <nombre>        p. ej. npm run new:service -- identity
import { cp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];

if (!name || !/^[a-z][a-z0-9-]{1,30}$/.test(name) || name === "template") {
  console.error(
    "Uso: npm run new:service -- <nombre>  (minúsculas, números y guiones; p. ej. identity)",
  );
  process.exit(1);
}

const source = join(root, "services", "template");
const target = join(root, "services", name);
const exists = await stat(target).then(
  () => true,
  () => false,
);
if (exists) {
  console.error(`Ya existe services/${name}`);
  process.exit(1);
}

const SKIP = new Set(["node_modules", "dist", ".env"]);
await cp(source, target, {
  recursive: true,
  filter: (path) => !SKIP.has(relative(source, path).split(/[\\/]/)[0] ?? ""),
});

const dbName = name.replaceAll("-", "_");
const replacements = [
  [/@services\/template/g, `@services/${name}`],
  [/SERVICE_NAME=template/g, `SERVICE_NAME=${name}`],
  [
    /template:template-dev-password@127\.0\.0\.1:5432\/template/g,
    `${dbName}:${dbName}-dev-password@127.0.0.1:5432/${dbName}`,
  ],
  [/SERVICE=template/g, `SERVICE=${name}`],
  [/services\/template/g, `services/${name}`],
  [/ticketera\/template/g, `ticketera/${name}`],
  [/SERVICE_SOURCE = "template"/g, `SERVICE_SOURCE = "${name}"`],
];

async function rewrite(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewrite(path);
    } else {
      const original = await readFile(path, "utf8");
      let content = original;
      for (const [pattern, value] of replacements) content = content.replace(pattern, value);
      if (content !== original) await writeFile(path, content);
    }
  }
}
await rewrite(target);

// Contrato HTTP inicial.
const contracts = join(root, "packages", "contracts");
const openapi = (await readFile(join(contracts, "openapi", "template.yaml"), "utf8"))
  .replace("title: template-service", `title: ${name}-service`)
  .replace(/description: >\n(?: {4}.*\n)+/, `description: Contrato HTTP de ${name}.\n`);
await writeFile(join(contracts, "openapi", `${name}.yaml`), openapi);
const indexPath = join(contracts, "src", "index.ts");
const index = await readFile(indexPath, "utf8");
await writeFile(
  indexPath,
  index.replace(/export const HttpServices = \[([^\]]*)\] as const;/, (_match, list) => {
    const items = list
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    items.push(`"${name}"`);
    return `export const HttpServices = [${items.join(", ")}] as const;`;
  }),
);

console.log(`Servicio creado en services/${name}. Pasos siguientes:
  1. npm install
  2. Reemplaza el ejemplo "notes" (src/notes, migrations/0002_notes.sql) por el dominio de ${name}
     y actualiza packages/contracts/openapi/${name}.yaml.
  3. Agrega "${dbName}" a SERVICE_DATABASES y el servicio a infra/docker-compose.yml
     (copia el bloque "template"); si el volumen de Postgres ya existe: npm run infra:reset.
  4. Agrega el servicio a la matriz de imágenes de .github/workflows/ci.yml.`);
