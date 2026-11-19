export function toolsForMode(mode) {
  return mode === "build" ? ["read", "edit", "bash"] : ["read", "search"];
}
