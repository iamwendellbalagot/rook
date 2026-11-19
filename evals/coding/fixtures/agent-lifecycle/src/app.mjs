import { sendToGateway } from "./gateway.mjs";

export function submitPrompt(gateway, prompt, mode) {
  return sendToGateway(gateway, prompt, mode);
}
