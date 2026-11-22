import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  queryLanguageServer,
  type SemanticAction,
} from "../../src/pi/language-protocol.js";

function exchange(action: SemanticAction) {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const uri = "file:///workspace/main.py";
  const sent: unknown[] = [];
  output.on("data", (chunk: Buffer) =>
    sent.push(JSON.parse(chunk.toString().split("\r\n\r\n")[1]!)),
  );
  const send = (message: unknown, fragmented = false) => {
    const body = JSON.stringify(message);
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    if (fragmented) {
      input.write(frame.slice(0, 13));
      input.write(frame.slice(13));
    } else input.write(frame);
  };
  const pending = queryLanguageServer(
    { input, output },
    {
      action,
      rootUri: "file:///workspace",
      uri,
      languageId: "python",
      text: "f(1)\n",
      position: { line: 0, character: 0 },
      signal: controller.signal,
    },
  );
  return { pending, send, sent, controller, uri };
}

it("queries definitions after initialize and rejects server-initiated edits", async () => {
  const { pending, send, sent, uri } = exchange("definition");
  send({ id: 1, result: { capabilities: {} } }, true);
  send({ id: "edit", method: "workspace/applyEdit", params: {} });
  const definition = { uri, range: { start: { line: 0, character: 0 } } };
  send({ id: 2, result: [definition] });

  await expect(pending).resolves.toEqual([definition]);
  expect(sent).toMatchObject([
    { method: "initialize" },
    { method: "initialized" },
    { method: "textDocument/didOpen" },
    { method: "textDocument/definition" },
    { id: "edit", error: { code: -32601 } },
  ]);
});

it("ignores diagnostics for other documents and times out via cancellation", async () => {
  const { pending, send, sent, controller } = exchange("diagnostics");
  const rejected = expect(pending).rejects.toThrow("cancelled or timed out");
  send({ id: 1, result: { capabilities: {} } });
  send({
    method: "textDocument/publishDiagnostics",
    params: { uri: "file:///etc/config.py", diagnostics: [] },
  });
  controller.abort();
  await rejected;
  expect(sent).toMatchObject([
    { method: "initialize" },
    { method: "initialized" },
    { method: "textDocument/didOpen" },
  ]);
});
