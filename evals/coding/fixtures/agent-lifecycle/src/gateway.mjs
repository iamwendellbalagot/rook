import { toolsForMode } from "./policy.mjs";

export function sendToGateway(gateway, prompt, mode) {
  const tools = toolsForMode(mode);
  return gateway.send(prompt, { tools });
}
