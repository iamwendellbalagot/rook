import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = resolve(root, "../src/tui/assets");
const destination = resolve(root, "../dist/tui/assets");

mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination, { recursive: true });
