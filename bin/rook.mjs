#!/usr/bin/env node
const args = process.argv.slice(2);
const { main } = await import("../dist/index.js");

main(args).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`rook: ${message}`);
  process.exitCode = 1;
});
