#!/usr/bin/env node
// Renderiza los diagramas UML de docs/uml/src (*.puml) a SVG en docs/uml/svg con PlantUML
// (imagen oficial de Docker, versión fija; no requiere Java ni servicios externos).
//   npm run docs:uml
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLANTUML_IMAGE = "plantuml/plantuml:1.2025.10";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uml = join(root, "docs", "uml");
const sources = readdirSync(join(uml, "src")).filter((file) => file.endsWith(".puml"));

execFileSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${uml}:/data`,
    "-w",
    "/data/src",
    PLANTUML_IMAGE,
    "-tsvg",
    "-charset",
    "UTF-8",
    "-failfast2",
    "-o",
    "../svg",
    ...sources,
  ],
  { stdio: "inherit" },
);
process.stdout.write(`${sources.length} diagramas en docs/uml/svg\n`);
