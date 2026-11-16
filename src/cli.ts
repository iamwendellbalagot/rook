import { main } from "./index.js";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`rook: ${message}`);
  process.exitCode = 1;
});
