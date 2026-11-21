import { resolve } from "node:path";

export function resolveChild(root, child) {
  return resolve(root, child);
}
