import { loadPlythRuntime } from "../src/pi/plyth-runtime.js";

// Core installation/build/tests must not require an unpublished sibling checkout.
const runtime = await loadPlythRuntime(process.cwd(), {
  globalNodeModulesRoot: null,
}).catch(() => undefined);
export const hasPlyth = Boolean(runtime);
export const plyth = runtime ?? {};
